import React, { useState } from 'react';
import { FolderPlus, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2, AlertCircle, RotateCw } from 'lucide-react';
import { ScanBatch, Receipt, UserRole, Transaction } from '../types';

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
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  
  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});

  const activeBatch = batches.find(b => b.id === activeBatchId) || batches[0];
  const extractableCount = activeBatch.receipts.filter(r => r.status === 'Pending' || r.status === 'Failed').length;

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
  };

  const handleDeleteReceipt = (receiptId: string) => {
    setBatches(batches.map(b => {
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

    updateReceipt(batchId, receipt.id, { status: 'Processing', error_message: undefined });

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
          error_message: data.error || 'No transaction data could be extracted from this receipt.'
        });
        return null;
      }

      const mappedTx: Transaction[] = data.transactions.map((t: any, i: number) => ({
        id: `tx-${receipt.id}-${i}`,
        voucher_date: t.voucher_date || '2083-03-15',
        voucher_type: t.voucher_type || 'Journal',
        entry_type: t.entry_type || (t.debit_amount ? 'Dr' : 'Cr'),
        ledger_name: t.ledger_name || t.debit_ledger || t.credit_ledger || 'General Account',
        debit_amount: parseFloat(t.debit_amount) || parseFloat(t.amount) || 0,
        credit_amount: parseFloat(t.credit_amount) || 0,
        narration: t.narration || ''
      }));

      setReceiptTransactionsMap(prev => ({ ...prev, [receipt.id]: mappedTx }));
      updateReceipt(batchId, receipt.id, { status: 'Extracted', error_message: undefined });
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
    const extractedForThisReceipt = receiptTransactionsMap[receipt.id];
    onSelectBatch(activeBatch, receipt, extractedForThisReceipt, receiptTransactionsMap);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Scan Batch Workspace</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Upload handwritten paper bill receipts and trigger Vision AI extraction
          </p>
        </div>

        <button className="btn btn-primary" onClick={handleCreateBatch}>
          <FolderPlus size={18} />
          Create New Scan Batch
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-muted)' }}>Scan Batches</h3>
          
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
                          setDeletingBatchId(b.id);
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
            </div>

            <button
              className="btn btn-primary"
              onClick={handleTriggerExtraction}
              disabled={!extractableCount || isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Running OpenCV & Vision AI...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Run Vision AI Extraction{extractableCount ? ` (${extractableCount})` : ''}
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
              cursor: 'pointer',
              position: 'relative'
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFileUpload({ target: { files: e.dataTransfer.files } });
            }}
          >
            <input 
              type="file" 
              multiple 
              accept="image/*,.pdf" 
              onChange={handleFileUpload}
              style={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                opacity: 0, cursor: 'pointer'
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

            <h4 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Drag & Drop Handwritten Bill Receipts Here</h4>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '4px' }}>
              Supports JPG, PNG, WEBP, or PDF paper voucher scans
            </p>
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <span className="btn btn-secondary btn-sm">
                <Camera size={14} /> Snap Photo / Browse Files
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
                        <td style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 500 }}>
                          <FileText size={16} color="var(--primary)" />
                          {rcpt.filename}
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
                              Review & Edit
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

                            {rcpt.status === 'Pending' && (
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => handleDeleteReceipt(rcpt.id)}
                                title="Delete Pending Receipt"
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
    </div>
  );
}
