import React, { useEffect, useRef, useState } from 'react';
import { FolderPlus, FolderOpen, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2, AlertCircle, AlertTriangle, RotateCw, RotateCcw } from 'lucide-react';
import { ScanBatch, Receipt, User, UserRole, Transaction } from '../types';
import {
  newId,
  fetchBatches,
  createBatch,
  renameBatch,
  deleteBatch,
  createReceipt,
  updateReceiptRow,
  deleteReceipt,
  uploadReceiptImage,
  getReceiptImageUrl,
  startReceiptExtraction,
  fetchReceiptStates,
  fetchTransactionsForBatch,
} from '../lib/db';

/**
 * How often to re-check receipts the server is still working on.
 *
 * Extraction runs server-side, so this is the only way the page learns that a
 * voucher has finished — including one that was started before the tab was
 * last closed.
 */
const EXTRACTION_POLL_MS = 3000;

/**
 * Minimum short edge, in pixels, for a voucher photo we trust.
 *
 * The vision API works at roughly 768px on the short edge, so anything below
 * that has already lost handwriting detail before extraction even starts. 1000
 * leaves a margin. For reference, vouchers that extract cleanly measure around
 * 1350x1800; a 368x547 photo produced amounts the model could not read
 * consistently and had to flag.
 */
const MIN_IMAGE_SHORT_EDGE = 1000;

function isLowResolution(receipt: Receipt): boolean {
  if (!receipt.image_width || !receipt.image_height) return false;
  return Math.min(receipt.image_width, receipt.image_height) < MIN_IMAGE_SHORT_EDGE;
}

function formatBatchDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Reads an image's pixel dimensions without blocking the upload. */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

interface BatchWorkspaceProps {
  userRole: UserRole;
  currentUser: User;
  onSelectBatch: (batch: ScanBatch, selectedReceipt?: Receipt, extractedTx?: Transaction[], txMap?: Record<string, Transaction[]>) => void;
}

export default function BatchWorkspace({ userRole, currentUser, onSelectBatch }: BatchWorkspaceProps) {
  const [batches, setBatches] = useState<ScanBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [activeBatchId, setActiveBatchId] = useState<string>('');
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const editingBatchRef = useRef<HTMLDivElement | null>(null);
  const [editedBatchName, setEditedBatchName] = useState<string>('');
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [dragOver, setDragOver] = useState<boolean>(false);
  // True only while extraction requests are being handed to the server. Once
  // they are accepted the receipts' own Processing status takes over, so this
  // covers just the brief gap before that shows up.
  const [startingExtraction, setStartingExtraction] = useState<boolean>(false);

  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});

  // The server reads the image out of storage, so an extraction must not be
  // requested until that upload has actually landed.
  const uploadsRef = useRef<Record<string, Promise<void>>>({});
  // Read inside the polling loop, which must not close over a stale render.
  const batchesRef = useRef<ScanBatch[]>([]);
  // Batches whose stored transactions have already been loaded.
  const loadedTxBatchesRef = useRef<Set<string>>(new Set());
  // Set when this tab starts a run, so it can open the reviewer once the batch
  // finishes. A tab that merely finds work already in progress does not jump.
  // The receipt ids are kept too, so it lands on one this run produced rather
  // than on an older extraction that happens to sit earlier in the batch.
  const autoOpenRef = useRef<{ batchId: string; receiptIds: string[] } | null>(null);

  // May be undefined before the first load finishes, or when the user has no
  // batches yet — every read below has to tolerate that.
  const activeBatch: ScanBatch | undefined =
    batches.find(b => b.id === activeBatchId) || batches[0];
  const activeReceipts = activeBatch?.receipts ?? [];
  // Derived from the receipts themselves rather than tracked separately, so a
  // reopened tab shows work still running on the server.
  const batchIsProcessing = (batch: ScanBatch) => batch.receipts.some(r => r.status === 'Processing');
  const isProcessing = startingExtraction || activeReceipts.some(r => r.status === 'Processing');
  const extractableCount = activeReceipts.filter(r => r.status === 'Pending' || r.status === 'Failed').length;
  const hasFailedExtraction = activeReceipts.some(r => r.status === 'Failed');
  // Only counts receipts still awaiting extraction — no point nagging about
  // photos that have already been processed.
  const lowResPendingCount = activeReceipts.filter(
    r => (r.status === 'Pending' || r.status === 'Failed') && isLowResolution(r)
  ).length;

  // Load everything this user is allowed to see. Row-level security decides
  // that server-side, so there is no organisation filter here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchBatches();
        if (cancelled) return;

        // Swap stored paths for signed URLs so thumbnails work after a refresh.
        await Promise.all(
          loaded.flatMap(b =>
            b.receipts.map(async r => {
              if (!r.storage_path) return;
              try {
                r.previewUrl = await getReceiptImageUrl(r.storage_path);
              } catch {
                r.previewUrl = '';
              }
            })
          )
        );

        if (cancelled) return;
        setBatches(loaded);
        setActiveBatchId(prev => prev || loaded[0]?.id || '');
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load your scan batches.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    batchesRef.current = batches;
  }, [batches]);

  // Pull in transactions that were extracted previously. Without this, a batch
  // opened in a new session looks empty even though its rows are safely stored.
  useEffect(() => {
    const batchId = activeBatch?.id;
    if (!batchId || loadedTxBatchesRef.current.has(batchId)) return;
    loadedTxBatchesRef.current.add(batchId);

    fetchTransactionsForBatch(batchId)
      .then(stored => {
        // Anything already in memory is at least as fresh, so it wins.
        setReceiptTransactionsMap(prev => ({ ...stored, ...prev }));
      })
      .catch(() => {
        // Allow a later attempt rather than leaving the batch permanently blank.
        loadedTxBatchesRef.current.delete(batchId);
      });
  }, [activeBatch?.id]);

  // Watch whatever the server is still extracting, wherever it was started
  // from. This is what replaces the old "wait for the HTTP response" flow, and
  // it works just as well for a run that began before this tab existed.
  const processingIds = batches
    .flatMap(b => b.receipts.filter(r => r.status === 'Processing').map(r => r.id))
    .sort();
  const processingKey = processingIds.join(',');

  useEffect(() => {
    if (!processingKey) return;
    const watching = processingKey.split(',');
    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      try {
        const states = await fetchReceiptStates(watching);
        if (cancelled) return;

        const finished = states.filter(s => s.status !== 'Processing');
        if (finished.length) {
          const finishedIds = new Set(finished.map(f => f.id));

          // Load the rows the server saved before flipping the status on
          // screen, so a receipt never appears Extracted with nothing behind it.
          const affectedBatchIds = new Set(
            batchesRef.current
              .filter(b => b.receipts.some(r => finishedIds.has(r.id)))
              .map(b => b.id)
          );
          for (const batchId of affectedBatchIds) {
            try {
              const stored = await fetchTransactionsForBatch(batchId);
              if (cancelled) return;
              setReceiptTransactionsMap(prev => ({ ...prev, ...stored }));
            } catch {
              // The status update below still stands; the rows load on reopen.
            }
          }

          setBatches(prev => prev.map(b => ({
            ...b,
            receipts: b.receipts.map(r => {
              const update = finished.find(f => f.id === r.id);
              return update
                ? {
                    ...r,
                    status: update.status,
                    error_message: update.error_message,
                    verification_warnings: update.verification_warnings,
                  }
                : r;
            }),
          })));
        }
      } catch {
        // Transient — the next tick tries again rather than surfacing a scary
        // error for what is usually a momentary network blip.
      }
      if (!cancelled) timer = window.setTimeout(check, EXTRACTION_POLL_MS);
    };

    timer = window.setTimeout(check, EXTRACTION_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [processingKey]);

  // Open the reviewer once a run this tab started has finished, preserving the
  // old behaviour of not making the user click through manually.
  useEffect(() => {
    const pending = autoOpenRef.current;
    if (!pending || startingExtraction) return;

    const batch = batches.find(b => b.id === pending.batchId);
    if (!batch) {
      autoOpenRef.current = null;
      return;
    }
    if (batch.receipts.some(r => r.status === 'Processing')) return;

    autoOpenRef.current = null;
    const firstExtracted = batch.receipts.find(
      r => pending.receiptIds.includes(r.id) && r.status === 'Extracted'
    );
    // If every receipt failed, stay here so the Failed rows and Retry are visible.
    if (firstExtracted) {
      onSelectBatch(
        batch,
        firstExtracted,
        receiptTransactionsMap[firstExtracted.id] || [],
        receiptTransactionsMap
      );
    }
  }, [batches, startingExtraction, receiptTransactionsMap]);

  useEffect(() => {
    if (!deletingBatchId) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [deletingBatchId]);

  useEffect(() => {
    if (!editingBatchId) return;

    const closeEditOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!editingBatchRef.current?.contains(target)) {
        setEditingBatchId(null);
      }
    };

    document.addEventListener('pointerdown', closeEditOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeEditOnOutsideClick);
  }, [editingBatchId]);

  const handleCreateBatch = async () => {
    if (!currentUser.organization_id) {
      setSaveError('Your account is not linked to an organisation, so batches cannot be created.');
      return;
    }
    const batchNumbers = batches
      .map(b => Number(b.name.match(/^Batch[- ](\d+)/i)?.[1] || 0))
      .filter(Number.isFinite);
    const nextBatchNumber = Math.max(0, ...batchNumbers) + 1;
    const batchDate = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    const defaultName = `Batch ${nextBatchNumber} · ${batchDate}`;

    const newBatch: ScanBatch = {
      // A real UUID, because that is the primary key type in Postgres.
      id: newId(),
      name: defaultName,
      status: 'Active',
      created_at: new Date().toLocaleString(),
      receipts: []
    };

    try {
      await createBatch({
        id: newBatch.id,
        name: newBatch.name,
        organizationId: currentUser.organization_id,
        userId: currentUser.id,
      });
      setBatches(prev => [newBatch, ...prev]);
      setActiveBatchId(newBatch.id);
      setSaveError(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not create the batch.');
    }
  };

  const handleRenameBatch = async (id: string) => {
    if (!editedBatchName.trim()) return;
    const name = editedBatchName.trim();
    const previous = batches.find(b => b.id === id)?.name;
    setBatches(prev => prev.map(b => (b.id === id ? { ...b, name } : b)));
    setEditingBatchId(null);
    try {
      await renameBatch(id, name);
      setSaveError(null);
    } catch (err: any) {
      // Put the old name back rather than leaving the screen disagreeing
      // with what is actually stored.
      setBatches(prev => prev.map(b => (b.id === id && previous ? { ...b, name: previous } : b)));
      setSaveError(err?.message || 'Could not rename the batch.');
    }
  };

  const handleDeleteBatch = async (id: string) => {
    // Extraction runs on the server now, so a batch can be busy even when it is
    // not the one on screen. Deleting it would leave a job writing rows that
    // no longer have anything to belong to.
    const target = batches.find(b => b.id === id);
    if ((target && batchIsProcessing(target)) || (startingExtraction && id === activeBatchId)) {
      setSaveError('This batch cannot be deleted while extraction is in progress.');
      return;
    }
    const snapshot = batches;
    const remaining = batches.filter(b => b.id !== id);
    setBatches(remaining);
    if (activeBatchId === id) {
      setActiveBatchId(remaining[0]?.id || '');
    }
    setDeletingBatchId(null);
    try {
      await deleteBatch(id);
      setSaveError(null);
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not delete the batch.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement> | { target: { files: FileList | File[] } }) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (!activeBatch || !currentUser.organization_id) return;

    const batchId = activeBatch.id;
    const newFilesMap: Record<string, File> = { ...uploadedFilesMap };

    const newReceipts: Receipt[] = files.map(file => {
      const rcptId = newId();
      newFilesMap[rcptId] = file;
      return {
        id: rcptId,
        filename: file.name,
        status: 'Pending',
        previewUrl: URL.createObjectURL(file)
      };
    });

    setUploadedFilesMap(newFilesMap);

    setBatches(prev => prev.map(b => {
      if (b.id === batchId) {
        return { ...b, receipts: [...b.receipts, ...newReceipts] };
      }
      return b;
    }));

    // Persist the row first so the receipt survives a refresh even if the
    // image upload is still running, then attach the stored image. The promise
    // is kept because extraction happens server-side now: the server reads the
    // image from storage, so it cannot be asked to start until this has landed.
    newReceipts.forEach(receipt => {
      const file = newFilesMap[receipt.id];
      uploadsRef.current[receipt.id] = (async () => {
        try {
          await createReceipt({
            id: receipt.id,
            batchId,
            userId: currentUser.id,
            filename: receipt.filename,
          });
          const path = await uploadReceiptImage(file, {
            organizationId: currentUser.organization_id!,
            batchId,
            receiptId: receipt.id,
          });
          await updateReceiptRow(receipt.id, { file_path: path });
          updateReceipt(batchId, receipt.id, { storage_path: path });
          setSaveError(null);
        } catch (err: any) {
          setSaveError(
            `"${receipt.filename}" could not be saved to the server (${err?.message || 'unknown error'}). ` +
            `It cannot be extracted until it uploads successfully.`
          );
        }
      })();
    });

    // Measure in the background so the thumbnails appear immediately. PDFs are
    // skipped — there is no bitmap to measure.
    newReceipts.forEach(receipt => {
      const file = newFilesMap[receipt.id];
      if (file?.type === 'application/pdf') return;
      measureImage(receipt.previewUrl).then(size => {
        if (!size) return;
        updateReceipt(batchId, receipt.id, { image_width: size.width, image_height: size.height });
        updateReceiptRow(receipt.id, {
          image_width: size.width,
          image_height: size.height,
        }).catch(() => { /* dimensions are advisory; a failure here is not worth interrupting for */ });
      });
    });
  };

  const handleDeleteReceipt = async (receiptId: string) => {
    if (!activeBatch) return;
    const batchId = activeBatch.id;
    const receipt = activeBatch.receipts.find(r => r.id === receiptId);
    const snapshot = batches;

    if (receipt?.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(receipt.previewUrl);
    }

    setUploadedFilesMap(prev => {
      const next = { ...prev };
      delete next[receiptId];
      return next;
    });

    setReceiptTransactionsMap(prev => {
      const next = { ...prev };
      delete next[receiptId];
      return next;
    });

    setBatches(prev => prev.map(b => {
      if (b.id === batchId) {
        return { ...b, receipts: b.receipts.filter(r => r.id !== receiptId) };
      }
      return b;
    }));

    try {
      await deleteReceipt(receiptId);
      setSaveError(null);
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not delete the receipt.');
    }
  };

  const updateReceipt = (batchId: string, receiptId: string, patch: Partial<Receipt>) => {
    setBatches(prev => prev.map(b => {
      if (b.id !== batchId) return b;
      return { ...b, receipts: b.receipts.map(r => r.id === receiptId ? { ...r, ...patch } : r) };
    }));
  };

  /**
   * Mirrors a receipt's extraction outcome into the database.
   *
   * Kept separate from updateReceipt so the on-screen state updates instantly
   * while the write happens in the background; a failed write must not wedge
   * the extraction loop, so it only records a message.
   */
  const persistReceiptState = (
    receiptId: string,
    patch: { status?: string; error_message?: string | null; verification_warnings?: string[] }
  ) => {
    updateReceiptRow(receiptId, patch).catch((err: any) => {
      setSaveError(`Could not save extraction status: ${err?.message || 'unknown error'}`);
    });
  };

  /**
   * Hands one receipt to the server and returns once it has been accepted.
   *
   * Nothing here waits for the extraction itself. The server owns the work from
   * this point, which is what lets the tab be closed without losing it — the
   * result is picked up later by watching the receipt's status.
   */
  const beginExtraction = async (batchId: string, receipt: Receipt): Promise<void> => {
    // The server fetches the image from storage, so the upload has to be
    // finished first. Its own failure is reported by the upload itself.
    try {
      await uploadsRef.current[receipt.id];
    } catch {
      /* handled where the upload was started */
    }

    // Shown immediately so the row reacts to the click; the server sets the
    // same status durably, which is what survives a refresh.
    updateReceipt(batchId, receipt.id, {
      status: 'Processing',
      error_message: undefined,
      verification_warnings: undefined,
    });

    try {
      await startReceiptExtraction(receipt.id);
    } catch (err: any) {
      const message = err?.message || 'Could not start extraction on the server.';
      updateReceipt(batchId, receipt.id, { status: 'Failed', error_message: message });
      persistReceiptState(receipt.id, { status: 'Failed', error_message: message });
    }
  };

  const handleTriggerExtraction = async () => {
    if (!activeBatch) return;
    const batchId = activeBatch.id;

    // US-25: only process receipts that are new or previously failed —
    // successfully extracted receipts are left untouched.
    const targets = activeBatch.receipts.filter(r => r.status === 'Pending' || r.status === 'Failed');
    if (!targets.length) return;

    autoOpenRef.current = { batchId, receiptIds: targets.map(r => r.id) };
    setStartingExtraction(true);
    // Queued one at a time so a rejected receipt cannot stop the rest (US-26).
    // The server decides how many it actually reads at once.
    for (const receipt of targets) {
      await beginExtraction(batchId, receipt);
    }
    setStartingExtraction(false);
  };

  const handleRetryReceipt = (receipt: Receipt) => {
    if (!activeBatch) return;
    beginExtraction(activeBatch.id, receipt);
  };

  const handleOpenReviewer = (receipt: Receipt) => {
    if (!activeBatch) return;
    onSelectBatch(
      activeBatch,
      receipt,
      receiptTransactionsMap[receipt.id] || [],
      receiptTransactionsMap
    );
  };

  const handleReviewSingleReceipt = (receipt: Receipt) => {
    setPreviewRotation(0);
    setPreviewReceipt(receipt);
  };

  const isPdfReceipt = (receipt: Receipt) => {
    const file = uploadedFilesMap[receipt.id];
    return file?.type === 'application/pdf' || receipt.filename.toLowerCase().endsWith('.pdf');
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        minHeight: '50vh', color: 'var(--text-muted)'
      }}>
        <Loader2 size={18} className="animate-spin" />
        Loading your scan batches...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card" style={{ maxWidth: '560px', margin: '40px auto', textAlign: 'center' }}>
        <AlertCircle size={28} color="#f43f5e" style={{ marginBottom: '10px' }} />
        <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '6px' }}>
          Could not load your batches
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {saveError && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '8px',
          background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.4)',
          color: '#f59e0b', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: '0.82rem'
        }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span style={{ flex: 1 }}>{saveError}</span>
          <button
            onClick={() => setSaveError(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 'calc(100vh - 120px)', position: 'sticky', top: '24px', alignSelf: 'start' }}>
          <h3 className="batch-sidebar-heading">Your Batches</h3>
          <button className="btn btn-primary" onClick={handleCreateBatch} style={{ width: '100%', padding: '12px 16px', fontSize: '0.9rem' }}>
            <FolderPlus size={18} />
            Create New Batch
          </button>
          
          <div className="batch-list">
            {batches.map(b => (
              <div 
                key={b.id} 
                onClick={() => setActiveBatchId(b.id)}
                ref={editingBatchId === b.id ? editingBatchRef : undefined}
                className={`batch-item${b.id === activeBatchId ? ' batch-item-active' : ''}`}
              >
                {editingBatchId === b.id ? (
                  <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editedBatchName}
                      onChange={e => setEditedBatchName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameBatch(b.id);
                        if (e.key === 'Escape') setEditingBatchId(null);
                      }}
                      style={{ padding: '6px 10px', fontSize: '0.85rem', flex: 1, boxSizing: 'border-box' }}
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="batch-item-content">
                    <div className="batch-item-details">
                      <div className="batch-item-name">
                        <span>{b.name}</span>
                        {b.id === activeBatchId && <span className="batch-current-badge">Current</span>}
                      </div>
                      <div className="batch-item-meta">
                        <span>{b.receipts.length} {b.receipts.length === 1 ? 'receipt' : 'receipts'}</span>
                        <span>•</span>
                        <span>{formatBatchDate(b.created_at)}</span>
                      </div>
                    </div>

                    <div className="batch-actions">
                      <button 
                        className="btn btn-secondary btn-sm batch-action" 
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingBatchId(b.id);
                          setEditedBatchName(b.name);
                        }}
                        title="Rename Batch"
                      >
                        <Edit2 size={12} />
                      </button>
                      <button 
                        className="btn btn-danger btn-sm batch-action"
                        disabled={batchIsProcessing(b) || (startingExtraction && b.id === activeBatchId)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (b.receipts.length === 0) {
                            handleDeleteBatch(b.id);
                          } else {
                            setDeletingBatchId(b.id);
                          }
                        }}
                        title={batchIsProcessing(b) || (startingExtraction && b.id === activeBatchId)
                          ? 'Cannot delete while extraction is in progress'
                          : 'Delete Batch'}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {!activeBatch ? (
          <div className="card empty-batches">
            <div className="empty-batches-art" aria-hidden="true">
              <div className="empty-folder"><FolderOpen size={48} /></div>
              <div className="empty-file empty-file-left"><FileText size={19} /></div>
              <div className="empty-file empty-file-right"><Camera size={18} /></div>
            </div>
            <h3>
              Start your first scan
            </h3>
            <p>
              Create a batch to upload handwritten vouchers.
            </p>
          </div>
        ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="batch-header">
            <div>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700 }}>{activeBatch.name}</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {activeBatch.receipts.length} receipt images · Upload and review files below
              </p>
              {lowResPendingCount > 0 && (
                <p style={{ fontSize: '0.8rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                  {lowResPendingCount === 1
                    ? '1 photo is low resolution — you may want to retake it before extracting.'
                    : `${lowResPendingCount} photos are low resolution — you may want to retake them before extracting.`}
                </p>
              )}
            </div>

            <button
              className="btn btn-primary"
              onClick={handleTriggerExtraction}
              disabled={!extractableCount || isProcessing || hasFailedExtraction}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Extracting details...
                </>
              ) : (
                <>
                  <Play size={16} />
                  {extractableCount
                    ? `Extract ${extractableCount} ${extractableCount === 1 ? 'Receipt' : 'Receipts'}`
                    : 'Extract Receipts'}
                </>
              )}
            </button>
          </div>

          <div 
            className="card"
            style={{
              border: `2px dashed ${dragOver ? 'var(--primary)' : 'var(--border-color)'}`,
              background: dragOver ? 'rgba(99, 102, 241, 0.05)' : 'var(--bg-card)',
              textAlign: 'center',
              padding: '36px',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              position: 'relative',
              opacity: isProcessing ? 0.5 : 1,
              pointerEvents: isProcessing ? 'none' : 'auto'
            }}
            onDragOver={(e) => { e.preventDefault(); if (!isProcessing) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (isProcessing) return;
              handleFileUpload({ target: { files: e.dataTransfer.files } });
            }}
          >
            <input
              type="file"
              multiple
              accept="image/*,.pdf"
              onChange={handleFileUpload}
              disabled={isProcessing}
              style={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                opacity: 0, cursor: isProcessing ? 'not-allowed' : 'pointer'
              }}
            />
            <div style={{
              width: '56px', height: '56px',
              borderRadius: '50%',
              background: 'rgba(99, 102, 241, 0.1)',
              color: 'var(--primary)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: '12px'
            }}>
              <UploadCloud size={28} />
            </div>

            <h4 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
              {isProcessing ? 'Extraction in Progress — Uploads Locked' : `Upload to ${activeBatch.name}`}
            </h4>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '4px' }}>
              {isProcessing ? 'Please wait for the current batch to finish processing before adding more receipts.' : 'Drag and drop handwritten vouchers here, or browse your files'}
            </p>
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <span className="btn btn-secondary btn-sm">
                <Camera size={14} /> Upload Photo / Browse Files
              </span>
            </div>
          </div>

          <div className="card">
            <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '16px' }}>
              Files in {activeBatch.name} ({activeBatch.receipts.length})
            </h4>

            {!activeBatch.receipts.length ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No receipts uploaded in this batch yet. Use the upload box above to add paper receipt photos.
              </div>
            ) : (
              <div className="table-container">
                <table className="custom-table">
                  <thead>
                    <tr>
                      <th>File Name</th>
                      <th>Extraction Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeBatch.receipts.map(rcpt => (
                      <tr key={rcpt.id}>
                        <td style={{ fontWeight: 500 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <FileText size={16} color="var(--primary)" />
                            {rcpt.filename}
                          </div>
                          {isLowResolution(rcpt) && (
                            <div
                              style={{ fontSize: '0.72rem', color: '#f59e0b', display: 'flex', gap: '4px', marginTop: '4px', fontWeight: 400 }}
                              title={`This photo is ${rcpt.image_width}x${rcpt.image_height}. Vouchers read reliably at about 1350x1800.`}
                            >
                              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                              <span>
                                This photo may be difficult to read. Try uploading a closer, clearer photo.
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span className={`status-pill ${
                              rcpt.status === 'Extracted' ? 'status-extracted' :
                              rcpt.status === 'Processing' ? 'status-processing' :
                              rcpt.status === 'Failed' ? 'status-failed' : 'status-pending'
                            }`}>
                              {rcpt.status === 'Extracted' ? <CheckCircle2 size={12} /> :
                               rcpt.status === 'Failed' ? <AlertCircle size={12} /> : <Clock size={12} />}
                              {rcpt.status}
                            </span>
                            {rcpt.status === 'Failed' && rcpt.error_message && (
                              <span style={{ fontSize: '0.72rem', color: '#f43f5e', maxWidth: '260px' }}>
                                {rcpt.error_message}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleReviewSingleReceipt(rcpt)}
                            >
                              Preview Image
                            </button>

                            {/* The way back into extracted rows on a later
                                visit — without this the reviewer is reachable
                                only in the session that ran the extraction. */}
                            {rcpt.status === 'Extracted' && (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleOpenReviewer(rcpt)}
                                title="Review and edit the extracted rows"
                              >
                                Review &amp; Edit
                              </button>
                            )}

                            {rcpt.status === 'Failed' && (
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleRetryReceipt(rcpt)}
                                title="Retry Extraction"
                                disabled={isProcessing}
                              >
                                <RotateCw size={13} /> Retry
                              </button>
                            )}

                            {rcpt.status !== 'Processing' && (
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => handleDeleteReceipt(rcpt.id)}
                                title="Delete Receipt"
                                disabled={isProcessing}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deletingBatchId && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            background: 'var(--card-bg, #1e1e2e)',
            border: '1px solid var(--border-color)',
            borderRadius: '16px',
            padding: '32px 36px',
            maxWidth: '420px',
            width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            textAlign: 'center',
            animation: 'fadeIn 0.2s ease'
          }}>
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%',
              background: 'rgba(239,68,68,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px auto'
            }}>
              <Trash2 size={24} style={{ color: '#ef4444' }} />
            </div>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '8px' }}>Delete Batch?</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px', lineHeight: 1.5 }}>
              Are you sure you want to delete <strong style={{ color: 'var(--text)' }}>"{batches.find(b => b.id === deletingBatchId)?.name}"</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setDeletingBatchId(null)}
                style={{ minWidth: '110px' }}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDeleteBatch(deletingBatchId)}
                style={{ minWidth: '110px', background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.4)', color: '#ffffff', fontWeight: 600, transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.06)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 18px rgba(239,68,68,0.65)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(239,68,68,0.4)'; }}
              >
                <Trash2 size={15} /> Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {previewReceipt && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
          onClick={() => setPreviewReceipt(null)}
        >
          <div
            className="card"
            style={{
              width: 'min(920px, 96vw)',
              maxHeight: '92vh',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              padding: '18px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Image Preview</h3>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{previewReceipt.filename}</span>
            </div>

            <div
              style={{
                border: '1px solid var(--border-color)',
                borderRadius: '10px',
                overflow: 'hidden',
                background: 'var(--bg-input)',
                minHeight: '360px',
                height: '68vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative'
              }}
            >
              {isPdfReceipt(previewReceipt) ? (
                <iframe
                  src={previewReceipt.previewUrl}
                  title={previewReceipt.filename}
                  style={{ width: '100%', height: '100%', border: 'none' }}
                />
              ) : (
                <img
                  src={previewReceipt.previewUrl}
                  alt={previewReceipt.filename}
                  style={{
                    transform: `rotate(${previewRotation}deg)`,
                    transition: 'transform 0.3s ease',
                    maxWidth: Math.abs(previewRotation % 180) === 90 ? '68vh' : '100%',
                    maxHeight: Math.abs(previewRotation % 180) === 90 ? '100%' : '68vh',
                    objectFit: 'contain',
                    display: 'block'
                  }}
                />
              )}

              {!isPdfReceipt(previewReceipt) && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '16px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    gap: '10px',
                    zIndex: 2
                  }}
                >
                  <button
                    type="button"
                    title="Rotate Left"
                    onClick={() => setPreviewRotation(r => r - 90)}
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(15, 23, 42, 0.75)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
                    }}
                  >
                    <RotateCcw size={22} />
                  </button>
                  <button
                    type="button"
                    title="Rotate Right"
                    onClick={() => setPreviewRotation(r => r + 90)}
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(15, 23, 42, 0.75)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
                    }}
                  >
                    <RotateCw size={22} />
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setPreviewReceipt(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
