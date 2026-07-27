import React, { useEffect, useState } from 'react';
import { FolderPlus, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2, AlertCircle, AlertTriangle, RotateCw, RotateCcw } from 'lucide-react';
import { ScanBatch, Receipt, UserRole, Transaction, EntryType } from '../types';

const NOT_JOURNAL_ENTRY_ERROR = 'The uploaded image is not a journal entry. Please check and try again.';

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

/** Reads an image's pixel dimensions without blocking the upload. */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function getExtractionErrorMessage(error?: string): string {
  if (!error) return 'No transaction data could be extracted from this receipt.';
  if (
    error.includes("'NoneType' object has no attribute 'strip'") ||
    error.includes('not a journal entry')
  ) {
    return NOT_JOURNAL_ENTRY_ERROR;
  }
  return error;
}

interface BatchWorkspaceProps {
  userRole: UserRole;
  onSelectBatch: (batch: ScanBatch, selectedReceipt?: Receipt, extractedTx?: Transaction[], txMap?: Record<string, Transaction[]>) => void;
}

export default function BatchWorkspace({ userRole, onSelectBatch }: BatchWorkspaceProps) {
  const [batches, setBatches] = useState<ScanBatch[]>([
    {
      id: 'batch-001',
      name: 'Scan Batch - July 25, 2026',
      status: 'Active',
      created_at: '2026-07-25 10:15 AM',
      receipts: []
    }
  ]);

  const [activeBatchId, setActiveBatchId] = useState<string>('batch-001');
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [editedBatchName, setEditedBatchName] = useState<string>('');
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  
  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});

  const activeBatch = batches.find(b => b.id === activeBatchId) || batches[0];
  const extractableCount = activeBatch.receipts.filter(r => r.status === 'Pending' || r.status === 'Failed').length;
  const hasFailedExtraction = activeBatch.receipts.some(r => r.status === 'Failed');
  // Only counts receipts still awaiting extraction — no point nagging about
  // photos that have already been processed.
  const lowResPendingCount = activeBatch.receipts.filter(
    r => (r.status === 'Pending' || r.status === 'Failed') && isLowResolution(r)
  ).length;

  useEffect(() => {
    if (!deletingBatchId) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [deletingBatchId]);

  const handleCreateBatch = () => {
    const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const countToday = batches.filter(b => b.name.includes(todayStr)).length;
    const defaultName = `Scan Batch - ${todayStr}${countToday > 0 ? ` (#${countToday + 1})` : ''}`;

    const newBatch: ScanBatch = {
      id: `batch-${Date.now()}`,
      name: defaultName,
      status: 'Active',
      created_at: new Date().toLocaleString(),
      receipts: []
    };

    setBatches([newBatch, ...batches]);
    setActiveBatchId(newBatch.id);
  };

  const handleRenameBatch = (id: string) => {
    if (!editedBatchName.trim()) return;
    setBatches(batches.map(b => b.id === id ? { ...b, name: editedBatchName } : b));
    setEditingBatchId(null);
  };

  const handleDeleteBatch = (id: string) => {
    const remaining = batches.filter(b => b.id !== id);
    setBatches(remaining);
    if (activeBatchId === id) {
      setActiveBatchId(remaining[0]?.id || '');
    }
    setDeletingBatchId(null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement> | { target: { files: FileList | File[] } }) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const newFilesMap: Record<string, File> = { ...uploadedFilesMap };

    const newReceipts: Receipt[] = files.map((file, idx) => {
      const rcptId = `rcpt-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 7)}`;
      newFilesMap[rcptId] = file;
      return {
        id: rcptId,
        filename: file.name,
        status: 'Pending',
        previewUrl: URL.createObjectURL(file)
      };
    });

    setUploadedFilesMap(newFilesMap);

    setBatches(batches.map(b => {
      if (b.id === activeBatchId) {
        return { ...b, receipts: [...b.receipts, ...newReceipts] };
      }
      return b;
    }));

    // Measure in the background so the thumbnails appear immediately. PDFs are
    // skipped — there is no bitmap to measure.
    const batchId = activeBatchId;
    newReceipts.forEach(receipt => {
      const file = newFilesMap[receipt.id];
      if (file?.type === 'application/pdf') return;
      measureImage(receipt.previewUrl).then(size => {
        if (size) {
          updateReceipt(batchId, receipt.id, { image_width: size.width, image_height: size.height });
        }
      });
    });
  };

  const handleDeleteReceipt = (receiptId: string) => {
    const receipt = activeBatch.receipts.find(r => r.id === receiptId);
    if (receipt?.previewUrl) {
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
      if (b.id === activeBatchId) {
        return { ...b, receipts: b.receipts.filter(r => r.id !== receiptId) };
      }
      return b;
    }));
  };

  const updateReceipt = (batchId: string, receiptId: string, patch: Partial<Receipt>) => {
    setBatches(prev => prev.map(b => {
      if (b.id !== batchId) return b;
      return { ...b, receipts: b.receipts.map(r => r.id === receiptId ? { ...r, ...patch } : r) };
    }));
  };

  const extractSingleReceipt = async (batchId: string, receipt: Receipt): Promise<Transaction[] | null> => {
    const actualFile = uploadedFilesMap[receipt.id];

    if (!actualFile) {
      updateReceipt(batchId, receipt.id, { status: 'Failed', error_message: 'Original file is no longer available in this session.' });
      return null;
    }

    // Clear any prior notices up front so a retry never shows stale results.
    updateReceipt(batchId, receipt.id, {
      status: 'Processing',
      error_message: undefined,
      verification_warnings: undefined
    });

    try {
      const formData = new FormData();
      formData.append('file', actualFile);

      const response = await fetch('http://localhost:8000/api/extract-receipt', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        updateReceipt(batchId, receipt.id, { status: 'Failed', error_message: `Extraction server responded with status ${response.status}.` });
        return null;
      }

      const data = await response.json();

      if (data.error || !data.transactions || !data.transactions.length) {
        updateReceipt(batchId, receipt.id, {
          status: 'Failed',
          error_message: getExtractionErrorMessage(data.error)
        });
        return null;
      }

      // Single normalization point for the wire format. Downstream code only
      // ever reads debit_amount / credit_amount — the legacy flat `amount`
      // field is resolved onto the correct side here and never propagated,
      // so row values and running totals can't disagree later.
      const mappedTx: Transaction[] = data.transactions.map((t: any, i: number) => {
        const debit = parseFloat(t.debit_amount) || 0;
        const credit = parseFloat(t.credit_amount) || 0;
        const legacy = parseFloat(t.amount) || 0;
        const entryType: EntryType =
          t.entry_type === 'Dr' || t.entry_type === 'Cr'
            ? t.entry_type
            : (debit || (legacy && !credit)) ? 'Dr' : 'Cr';

        return {
          id: `tx-${receipt.id}-${i}`,
          voucher_date: t.voucher_date || '2083-03-15',
          voucher_type: t.voucher_type || 'Journal',
          entry_type: entryType,
          ledger_name: t.ledger_name || t.debit_ledger || t.credit_ledger || 'General Account',
          debit_amount: entryType === 'Dr' ? (debit || legacy) : 0,
          credit_amount: entryType === 'Cr' ? (credit || legacy) : 0,
          narration: t.narration || '',
          needs_review: t.needs_review === true
        };
      });

      // Reconciliation notices are advisory: the extraction still succeeded, so
      // the receipt stays Extracted and editable — the warning just tells the
      // reviewer which side of the voucher disagrees with its printed total.
      const warnings: string[] = Array.isArray(data.verification?.warnings)
        ? data.verification.warnings
        : [];

      setReceiptTransactionsMap(prev => ({ ...prev, [receipt.id]: mappedTx }));
      updateReceipt(batchId, receipt.id, {
        status: 'Extracted',
        error_message: undefined,
        verification_warnings: warnings.length > 0 ? warnings : undefined
      });
      return mappedTx;
    } catch (err: any) {
      updateReceipt(batchId, receipt.id, {
        status: 'Failed',
        error_message: err?.message || 'Network error while contacting the extraction service.'
      });
      return null;
    }
  };

  const handleTriggerExtraction = async () => {
    setIsProcessing(true);

    // US-25: only process receipts that are new or previously failed —
    // successfully extracted receipts are left untouched.
    const targets = activeBatch.receipts.filter(r => r.status === 'Pending' || r.status === 'Failed');
    let firstSuccess: { receipt: Receipt; transactions: Transaction[] } | null = null;
    const updatedTxMap: Record<string, Transaction[]> = { ...receiptTransactionsMap };

    for (const receipt of targets) {
      // Sequential, not Promise.all: a failure on one receipt must not
      // abort or interfere with the others (US-26).
      const result = await extractSingleReceipt(activeBatch.id, receipt);
      if (result) {
        updatedTxMap[receipt.id] = result;
        if (!firstSuccess) {
          firstSuccess = { receipt, transactions: result };
        }
      }
    }

    setIsProcessing(false);

    // Jump straight into the reviewer for the first successfully extracted
    // receipt so the user doesn't have to click "Review & Edit" manually.
    // If every receipt failed, stay on the workspace so the Failed/Retry
    // rows are visible instead of navigating to an empty reviewer.
    if (firstSuccess) {
      const updatedReceipt: Receipt = { ...firstSuccess.receipt, status: 'Extracted', error_message: undefined };
      const updatedBatch: ScanBatch = {
        ...activeBatch,
        receipts: activeBatch.receipts.map(r => r.id === updatedReceipt.id ? updatedReceipt : r)
      };
      onSelectBatch(updatedBatch, updatedReceipt, firstSuccess.transactions, updatedTxMap);
    }
  };

  const handleRetryReceipt = (receipt: Receipt) => {
    extractSingleReceipt(activeBatchId, receipt);
  };

  const handleReviewSingleReceipt = (receipt: Receipt) => {
    setPreviewRotation(0);
    setPreviewReceipt(receipt);
  };

  const isPdfReceipt = (receipt: Receipt) => {
    const file = uploadedFilesMap[receipt.id];
    return file?.type === 'application/pdf' || receipt.filename.toLowerCase().endsWith('.pdf');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 'calc(100vh - 120px)', position: 'sticky', top: '24px', alignSelf: 'start' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-muted)' }}>Scan Batches</h3>
          <button className="btn btn-primary" onClick={handleCreateBatch} style={{ width: '100%', padding: '12px 16px', fontSize: '0.9rem' }}>
            <FolderPlus size={18} />
            Create New Scan Batch
          </button>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {batches.map(b => (
              <div 
                key={b.id} 
                onClick={() => setActiveBatchId(b.id)}
                style={{
                  padding: '12px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid',
                  borderColor: b.id === activeBatchId ? 'var(--primary)' : 'var(--border-color)',
                  background: b.id === activeBatchId ? 'rgba(99, 102, 241, 0.1)' : 'var(--bg-input)',
                  cursor: 'pointer',
                  transition: 'var(--transition)'
                }}
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{b.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {b.receipts.length} receipts • {b.created_at}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button 
                        className="btn btn-secondary btn-sm" 
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
                        className="btn btn-danger btn-sm" 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (b.receipts.length === 0) {
                            handleDeleteBatch(b.id);
                          } else {
                            setDeletingBatchId(b.id);
                          }
                        }}
                        title="Delete Batch"
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700 }}>{activeBatch.name}</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {activeBatch.receipts.length} total receipt images uploaded
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
                  Extract Data from Image{extractableCount ? ` (${extractableCount})` : ''}
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
              {isProcessing ? 'Extraction in Progress — Uploads Locked' : 'Drag & Drop Handwritten Bill Receipts Here'}
            </h4>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '4px' }}>
              {isProcessing ? 'Please wait for the current batch to finish processing before adding more receipts.' : 'Supports JPG, PNG, WEBP, or PDF paper voucher scans'}
            </p>
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <span className="btn btn-secondary btn-sm">
                <Camera size={14} /> Upload Photo / Browse Files
              </span>
            </div>
          </div>

          <div className="card">
            <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '16px' }}>
              Uploaded Receipt Files ({activeBatch.receipts.length})
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
                                Low resolution ({rcpt.image_width}&times;{rcpt.image_height}) — handwriting may be
                                misread. A clearer, closer photo will extract far better.
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
                            {rcpt.status === 'Extracted' && rcpt.verification_warnings?.map((warning, i) => (
                              <span
                                key={i}
                                style={{ fontSize: '0.72rem', color: '#f59e0b', maxWidth: '320px', display: 'flex', gap: '4px' }}
                              >
                                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                                {warning}
                              </span>
                            ))}
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
