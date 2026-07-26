import React, { useState } from 'react';
import { FolderPlus, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2 } from 'lucide-react';
import { ScanBatch, Receipt, UserRole, Transaction } from '../types';

interface BatchWorkspaceProps {
  userRole: UserRole;
  onSelectBatch: (batch: ScanBatch, selectedReceipt?: Receipt, extractedTx?: Transaction[]) => void;
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
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  
  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});

  const activeBatch = batches.find(b => b.id === activeBatchId) || batches[0];

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

  const handleTriggerExtraction = async () => {
    setIsProcessing(true);
    const newTxMap: Record<string, Transaction[]> = { ...receiptTransactionsMap };

    for (const receipt of activeBatch.receipts) {
      const actualFile = uploadedFilesMap[receipt.id];

      if (actualFile) {
        try {
          const formData = new FormData();
          formData.append('file', actualFile);

          const response = await fetch('http://localhost:8000/api/extract-receipt', {
            method: 'POST',
            body: formData,
          });

          if (response.ok) {
            const data = await response.json();
            if (data.transactions && data.transactions.length) {
              newTxMap[receipt.id] = data.transactions.map((t: any, i: number) => ({
                id: `tx-${receipt.id}-${i}`,
                voucher_date: t.voucher_date || '2083-03-15',
                voucher_type: t.voucher_type || 'Journal',
                entry_type: t.entry_type || (t.debit_amount ? 'Dr' : 'Cr'),
                ledger_name: t.ledger_name || t.debit_ledger || t.credit_ledger || 'General Account',
                debit_amount: parseFloat(t.debit_amount) || parseFloat(t.amount) || 0,
                credit_amount: parseFloat(t.credit_amount) || 0,
                narration: t.narration || ''
              }));
            }
          }
        } catch (err) {
          console.warn(`Extraction error for ${receipt.filename}:`, err);
        }
      }
    }

    setReceiptTransactionsMap(newTxMap);

    const updatedBatch: ScanBatch = {
      ...activeBatch,
      receipts: activeBatch.receipts.map(r => ({ ...r, status: 'Extracted' as const }))
    };

    setBatches(batches.map(b => b.id === activeBatchId ? updatedBatch : b));
    setIsProcessing(false);

    const firstReceipt = updatedBatch.receipts[0];
    const firstExtracted = firstReceipt ? newTxMap[firstReceipt.id] : undefined;
    onSelectBatch(updatedBatch, firstReceipt, firstExtracted);
  };

  const handleReviewSingleReceipt = (receipt: Receipt) => {
    const extractedForThisReceipt = receiptTransactionsMap[receipt.id];
    onSelectBatch(activeBatch, receipt, extractedForThisReceipt);
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
                      style={{ padding: '4px 8px', fontSize: '0.85rem' }}
                    />
                    <button className="btn btn-primary btn-sm" onClick={() => handleRenameBatch(b.id)}>Save</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{b.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {b.receipts.length} receipts • {b.created_at}
                      </div>
                    </div>

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
              disabled={!activeBatch.receipts.length || isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Running OpenCV & Vision AI...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Run Vision AI Extraction
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
                          <span className={`status-pill ${
                            rcpt.status === 'Extracted' ? 'status-extracted' :
                            rcpt.status === 'Processing' ? 'status-processing' : 'status-pending'
                          }`}>
                            {rcpt.status === 'Extracted' ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                            {rcpt.status}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button 
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleReviewSingleReceipt(rcpt)}
                            >
                              Review & Edit
                            </button>

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
    </div>
  );
}
