import React, { useEffect, useRef, useState } from 'react';
import { FolderPlus, FolderOpen, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2, AlertCircle, AlertTriangle, RotateCw, RotateCcw, Archive, ArchiveRestore, FileSpreadsheet } from 'lucide-react';
import { ScanBatch, Receipt, User, Transaction } from '../types';
import {
  newId,
  fetchBatches,
  createBatch,
  renameBatch,
  deleteBatch,
  setBatchStatus,
  createReceipt,
  updateReceiptRow,
  deleteReceipt,
  uploadReceiptImage,
  getReceiptImageUrl,
  startReceiptExtraction,
  fetchReceiptStates,
  fetchTransactionsForBatch,
  fetchExportsForBatch,
  ExportRecord,
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
  currentUser: User;
  onSelectBatch: (batch: ScanBatch, selectedReceipt?: Receipt, extractedTx?: Transaction[], txMap?: Record<string, Transaction[]>) => void;
}

export default function BatchWorkspace({ currentUser, onSelectBatch }: BatchWorkspaceProps) {
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

  // Archived batches are hidden rather than deleted: last quarter's work is
  // still needed for its records, it just should not sit between an operator and
  // this morning's batch.
  const [showArchived, setShowArchived] = useState<boolean>(false);

  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);

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

  const wantedStatus = showArchived ? 'Archived' : 'Active';
  const visibleBatches = batches.filter(b => b.status === wantedStatus);
  const archivedCount = batches.filter(b => b.status === 'Archived').length;

  // May be undefined before the first load finishes, or when the user has no
  // batches yet — every read below has to tolerate that.
  const activeBatch: ScanBatch | undefined =
    visibleBatches.find(b => b.id === activeBatchId) || visibleBatches[0];
  const activeReceipts = activeBatch?.receipts ?? [];
  // An archived batch is a record, not a workspace. It stays fully readable and
  // exportable; what stops is adding to it.
  const isArchived = activeBatch?.status === 'Archived';
  // Derived from the receipts themselves rather than tracked separately, so a
  // reopened tab shows work still running on the server.
  const batchIsProcessing = (batch: ScanBatch) => batch.receipts.some(r => r.status === 'Processing');
  const isProcessing = startingExtraction || activeReceipts.some(r => r.status === 'Processing');
  const uploadsLocked = isProcessing || isArchived;
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

  // Which Tally spreadsheets this batch has already produced. Kept beside the
  // batch because the question it answers — "was this already posted?" — comes
  // up while looking at the batch, not somewhere else.
  useEffect(() => {
    const batchId = activeBatch?.id;
    if (!batchId) { setExportHistory([]); return; }

    let cancelled = false;
    fetchExportsForBatch(batchId)
      .then(records => { if (!cancelled) setExportHistory(records); })
      .catch(() => { if (!cancelled) setExportHistory([]); });
    return () => { cancelled = true; };
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

  /**
   * Archives or restores a batch.
   *
   * Nothing is destroyed — the receipts, rows and export history stay exactly
   * where they are, which is what makes this the safe alternative to the delete
   * button people would otherwise reach for to tidy up.
   */
  const handleToggleArchive = async (batch: ScanBatch) => {
    if (batchIsProcessing(batch)) {
      setSaveError('This batch cannot be archived while extraction is in progress.');
      return;
    }
    const next = batch.status === 'Archived' ? 'Active' : 'Archived';
    const snapshot = batches;
    setBatches(prev => prev.map(b => (b.id === batch.id ? { ...b, status: next } : b)));
    if (activeBatchId === batch.id) setActiveBatchId('');

    try {
      await setBatchStatus(batch.id, next);
      setSaveError(null);
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not update that batch.');
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
      <div className="loading-state loading-state-tall">
        <Loader2 size={18} className="animate-spin" />
        Loading your scan batches...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card panel-message">
        <AlertCircle size={28} className="panel-message-icon tone-rose" />
        <h3>Could not load your batches</h3>
        <p>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="page">
      {saveError && (
        <div className="alert alert-warning alert-top text-xs">
          <AlertTriangle size={15} className="alert-icon" />
          <span className="alert-body">{saveError}</span>
          <button className="alert-dismiss" onClick={() => setSaveError(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}
      <div className="workspace-grid">
        <div className="card batch-sidebar">
          <h3 className="batch-sidebar-heading">
            {showArchived ? 'Archived Batches' : 'Your Batches'}
          </h3>
          {!showArchived && (
            <button className="btn btn-primary btn-block-lg" onClick={handleCreateBatch}>
              <FolderPlus size={18} />
              Create New Batch
            </button>
          )}

          {(archivedCount > 0 || showArchived) && (
            <button
              className="btn btn-secondary btn-sm btn-block"
              onClick={() => { setShowArchived(v => !v); setActiveBatchId(''); }}
            >
              {showArchived
                ? <><ArchiveRestore size={14} /> Back to active batches</>
                : <><Archive size={14} /> View archived ({archivedCount})</>}
            </button>
          )}

          <div className="batch-list">
            {!visibleBatches.length && (
              <div className="batch-list-empty">
                {showArchived ? 'Nothing archived yet.' : 'No active batches.'}
              </div>
            )}
            {visibleBatches.map(b => (
              <div 
                key={b.id} 
                onClick={() => setActiveBatchId(b.id)}
                ref={editingBatchId === b.id ? editingBatchRef : undefined}
                className={`batch-item${b.id === activeBatchId ? ' batch-item-active' : ''}`}
              >
                {editingBatchId === b.id ? (
                  <div className="row-xs" onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      className="form-input batch-rename-input"
                      value={editedBatchName}
                      onChange={e => setEditedBatchName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameBatch(b.id);
                        if (e.key === 'Escape') setEditingBatchId(null);
                      }}
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
                        className="btn btn-secondary btn-sm batch-action"
                        disabled={batchIsProcessing(b)}
                        onClick={(e) => { e.stopPropagation(); handleToggleArchive(b); }}
                        title={b.status === 'Archived'
                          ? 'Restore this batch to the active list'
                          : 'Archive — keeps everything, just moves it out of the way'}
                      >
                        {b.status === 'Archived' ? <ArchiveRestore size={12} /> : <Archive size={12} />}
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
              {showArchived ? 'Nothing archived' : 'Start your first scan'}
            </h3>
            <p>
              {showArchived
                ? 'Batches you archive are kept here, out of the way but never deleted.'
                : 'Create a batch to upload handwritten vouchers.'}
            </p>
          </div>
        ) : (
        <div className="batch-panel">
          <div className="batch-header">
            <div>
              <h3>{activeBatch.name}</h3>
              <p>
                {activeBatch.receipts.length} receipt images · Upload and review files below
              </p>
              {lowResPendingCount > 0 && (
                <p className="batch-lowres-warning">
                  <AlertTriangle size={14} />
                  {lowResPendingCount === 1
                    ? '1 photo is low resolution — you may want to retake it before extracting.'
                    : `${lowResPendingCount} photos are low resolution — you may want to retake them before extracting.`}
                </p>
              )}
            </div>

            <button
              className="btn btn-primary"
              onClick={handleTriggerExtraction}
              disabled={!extractableCount || uploadsLocked || hasFailedExtraction}
              title={isArchived ? 'This batch is archived. Restore it to extract more receipts.' : undefined}
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
            className={`card dropzone${dragOver ? ' dropzone-active' : ''}${uploadsLocked ? ' dropzone-locked' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!uploadsLocked) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (uploadsLocked) return;
              handleFileUpload({ target: { files: e.dataTransfer.files } });
            }}
          >
            <input
              type="file"
              className="dropzone-input"
              multiple
              accept="image/*,.pdf"
              onChange={handleFileUpload}
              disabled={uploadsLocked}
            />
            <div className="dropzone-icon">
              <UploadCloud size={28} />
            </div>

            <h4 className="dropzone-title">
              {isArchived ? 'This Batch is Archived'
                : isProcessing ? 'Extraction in Progress — Uploads Locked'
                : `Upload to ${activeBatch.name}`}
            </h4>
            <p className="dropzone-text">
              {isArchived ? 'Everything in it is still readable and exportable. Restore it to add more receipts.'
                : isProcessing ? 'Please wait for the current batch to finish processing before adding more receipts.'
                : 'Drag and drop handwritten vouchers here, or browse your files'}
            </p>
            <div className="dropzone-cta">
              <span className="btn btn-secondary btn-sm">
                <Camera size={14} /> Upload Photo / Browse Files
              </span>
            </div>
          </div>

          <div className="card">
            <h4 className="section-title">
              Files in {activeBatch.name} ({activeBatch.receipts.length})
            </h4>

            {!activeBatch.receipts.length ? (
              <div className="table-empty text-sm" style={{ padding: '24px' }}>
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
                          <div className="file-cell">
                            <FileText size={16} color="var(--primary)" />
                            {rcpt.filename}
                          </div>
                          {isLowResolution(rcpt) && (
                            <div
                              className="file-warning"
                              title={`This photo is ${rcpt.image_width}x${rcpt.image_height}. Vouchers read reliably at about 1350x1800.`}
                            >
                              <AlertTriangle size={12} />
                              <span>
                                This photo may be difficult to read. Try uploading a closer, clearer photo.
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="stack-xs">
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
                              <span className="receipt-error">{rcpt.error_message}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="row-actions">
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
                                disabled={uploadsLocked}
                              >
                                <RotateCw size={13} /> Retry
                              </button>
                            )}

                            {rcpt.status !== 'Processing' && !isArchived && (
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

          {/* The spreadsheet is imported into Tally by hand, so this is the only
              record that it happened — and the only way to answer "has this
              already been posted?" before someone posts it twice. */}
          {exportHistory.length > 0 && (
            <div className="card">
              <h4 className="section-title">
                <FileSpreadsheet size={17} color="var(--primary)" />
                Tally exports from this batch ({exportHistory.length})
              </h4>
              <div className="table-container">
                <table className="custom-table">
                  <thead>
                    <tr><th>File Name</th><th>Rows</th><th>Generated By</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {exportHistory.map(record => (
                      <tr key={record.id}>
                        <td style={{ fontWeight: 500 }}>{record.file_name}</td>
                        <td>{record.record_count}</td>
                        <td className="text-muted">{record.generated_by_name || '—'}</td>
                        <td className="text-muted text-xs">{record.created_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deletingBatchId && (
        <div className="modal-overlay">
          <div className="modal modal-confirm">
            <div className="modal-icon modal-icon-danger">
              <Trash2 size={24} />
            </div>
            <h3 className="modal-title">Delete Batch?</h3>
            <p className="modal-text">
              Are you sure you want to delete <strong>"{batches.find(b => b.id === deletingBatchId)?.name}"</strong>? This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeletingBatchId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-danger-solid"
                onClick={() => handleDeleteBatch(deletingBatchId)}
              >
                <Trash2 size={15} /> Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {previewReceipt && (
        <div className="modal-overlay modal-overlay-top" onClick={() => setPreviewReceipt(null)}>
          <div className="card preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="row row-between">
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Image Preview</h3>
              <span className="text-muted text-xs">{previewReceipt.filename}</span>
            </div>

            <div className="preview-stage">
              {isPdfReceipt(previewReceipt) ? (
                <iframe
                  className="preview-frame"
                  src={previewReceipt.previewUrl}
                  title={previewReceipt.filename}
                />
              ) : (
                <img
                  className="preview-img"
                  src={previewReceipt.previewUrl}
                  alt={previewReceipt.filename}
                  // Rotation swaps which axis is constrained, so these two are
                  // genuinely dynamic and stay inline.
                  style={{
                    transform: `rotate(${previewRotation}deg)`,
                    maxWidth: Math.abs(previewRotation % 180) === 90 ? '68vh' : '100%',
                    maxHeight: Math.abs(previewRotation % 180) === 90 ? '100%' : '68vh',
                  }}
                />
              )}

              {!isPdfReceipt(previewReceipt) && (
                <div className="rotate-bar">
                  <button
                    type="button"
                    className="rotate-btn"
                    title="Rotate Left"
                    onClick={() => setPreviewRotation(r => r - 90)}
                  >
                    <RotateCcw size={22} />
                  </button>
                  <button
                    type="button"
                    className="rotate-btn"
                    title="Rotate Right"
                    onClick={() => setPreviewRotation(r => r + 90)}
                  >
                    <RotateCw size={22} />
                  </button>
                </div>
              )}
            </div>

            <div className="row row-end">
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
