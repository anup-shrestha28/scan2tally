import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Save, CheckCircle2, AlertTriangle, FileSpreadsheet, Plus, Trash2, RotateCcw, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { ScanBatch, Receipt, Transaction } from '../types';

interface SideBySideReviewerProps {
  batch: ScanBatch | null;
  selectedReceipt?: Receipt | null;
  initialTransactions?: Transaction[];
  allReceiptTransactions?: Record<string, Transaction[]>;
  onBack: () => void;
  onExportExcel: (transactions: Transaction[]) => void;
}

function blankRow(date?: string): Transaction {
  return {
    id: `tx-blank-${Date.now()}`,
    voucher_date: date || new Date().toISOString().split('T')[0],
    voucher_type: 'Journal',
    entry_type: 'Dr',
    ledger_name: '',
    debit_amount: 0,
    credit_amount: 0,
    narration: 'Being Expenses paid via cheque no.'
  };
}

export default function SideBySideReviewer({
  batch,
  selectedReceipt,
  initialTransactions,
  allReceiptTransactions = {},
  onBack,
  onExportExcel
}: SideBySideReviewerProps) {
  const receipts = batch?.receipts || [];

  // Find the starting index based on selectedReceipt
  const startIndex = selectedReceipt
    ? receipts.findIndex(r => r.id === selectedReceipt.id)
    : 0;

  const [currentIndex, setCurrentIndex] = useState(Math.max(0, startIndex));

  // Per-receipt transaction memory: receiptId → Transaction[]
  const [txMap, setTxMap] = useState<Record<string, Transaction[]>>(() => {
    const init: Record<string, Transaction[]> = { ...allReceiptTransactions };
    // Seed with initialTransactions for the selectedReceipt if provided
    if (selectedReceipt && initialTransactions) {
      init[selectedReceipt.id] = initialTransactions.length > 0
        ? initialTransactions
        : [blankRow()];
    }
    return init;
  });

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [showImbalanceModal, setShowImbalanceModal] = useState(false);
  const [pendingExportData, setPendingExportData] = useState<Transaction[] | null>(null);

  const currentReceipt = receipts[currentIndex] || null;

  // Get transactions for the currently viewed receipt
  const getTxForReceipt = (receipt: Receipt | null): Transaction[] => {
    if (!receipt) return [blankRow()];
    if (txMap[receipt.id] && txMap[receipt.id].length > 0) return txMap[receipt.id];
    return [blankRow()];
  };

  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    getTxForReceipt(currentReceipt)
  );

  // Save current transactions into the map before navigating
  const saveCurrentTx = (nextIndex: number) => {
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    setCurrentIndex(nextIndex);
    setRotation(0);
  };

  // When currentIndex changes, load that receipt's transactions
  useEffect(() => {
    setTransactions(getTxForReceipt(receipts[currentIndex] || null));
  }, [currentIndex]);

  // When allReceiptTransactions changes (fresh extraction), merge in
  useEffect(() => {
    setTxMap(prev => ({ ...prev, ...allReceiptTransactions }));
  }, [allReceiptTransactions]);

  const rotateLeft = () => setRotation(r => r - 90);
  const rotateRight = () => setRotation(r => r + 90);

  const handleUpdateTransaction = (id: string, field: keyof Transaction, value: any) => {
    setTransactions(transactions.map(t => {
      if (t.id === id) {
        const updated = { ...t, [field]: value };
        if (field === 'ledger_name') {
          if (updated.entry_type === 'Dr') updated.debit_ledger = value;
          else updated.credit_ledger = value;
        }
        if (field === 'entry_type') {
          if (value === 'Dr') {
            updated.debit_amount = updated.credit_amount || updated.debit_amount || 0;
            updated.credit_amount = 0;
          } else {
            updated.credit_amount = updated.debit_amount || updated.credit_amount || 0;
            updated.debit_amount = 0;
          }
        }
        return updated;
      }
      return t;
    }));
  };

  const handleAddTransaction = (entryType: 'Dr' | 'Cr' = 'Dr') => {
    const newTx: Transaction = {
      id: `tx-${Date.now()}`,
      voucher_date: transactions[0]?.voucher_date || new Date().toISOString().split('T')[0],
      voucher_type: 'Journal',
      entry_type: entryType,
      ledger_name: '',
      debit_amount: 0,
      credit_amount: 0,
      narration: ''
    };
    setTransactions([...transactions, newTx]);
  };

  const handleDeleteTransaction = (id: string) => {
    setTransactions(transactions.filter(t => t.id !== id));
  };

  const handleSaveProgress = () => {
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  // Export collects all receipts' transactions merged
  const handleExportAll = () => {
    const saved = currentReceipt ? { ...txMap, [currentReceipt.id]: transactions } : txMap;
    const all = receipts.flatMap(r => (saved[r.id] || []).map(t => ({ ...t, receipt_id: r.id })));
    const exportData = all.length > 0 ? all : transactions.map(t => ({ ...t, receipt_id: currentReceipt?.id }));

    // Check for imbalance across all receipts being exported
    let hasImbalance = false;
    const grouped = exportData.reduce((acc, t) => {
      const key = t.receipt_id || 'default';
      if (!acc[key]) acc[key] = [];
      acc[key].push(t);
      return acc;
    }, {} as Record<string, Transaction[]>);

    for (const group of Object.values(grouped)) {
      const dr = group.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
      const cr = group.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);
      if (Math.abs(dr - cr) > 0.05) {
        hasImbalance = true;
        break;
      }
    }

    if (hasImbalance) {
      setPendingExportData(exportData);
      setShowImbalanceModal(true);
      return;
    }

    onExportExcel(exportData);
  };

  const confirmExport = () => {
    if (pendingExportData) {
      onExportExcel(pendingExportData);
    }
    setShowImbalanceModal(false);
    setPendingExportData(null);
  };

  const cancelExport = () => {
    setShowImbalanceModal(false);
    setPendingExportData(null);
  };

  const totalDebit = transactions.reduce((acc, curr) => acc + (Number(curr.debit_amount) || 0), 0);
  const totalCredit = transactions.reduce((acc, curr) => acc + (Number(curr.credit_amount) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.05;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < receipts.length - 1;

  const btnStyle = (active: boolean) => ({
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border-color)',
    background: active ? 'var(--primary)' : 'var(--bg-card)',
    color: active ? '#fff' : 'var(--text-muted)',
    cursor: active ? 'pointer' : 'not-allowed',
    opacity: active ? 1 : 0.4,
    fontWeight: 600, fontSize: '0.82rem',
    transition: 'all 0.15s ease',
    boxShadow: active ? '0 2px 8px rgba(99,102,241,0.35)' : 'none'
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* Header Bar */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            <ArrowLeft size={16} /> Back to Batches
          </button>
          <div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>
              {batch?.name || 'Scan Batch Review'}
            </h3>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Side-by-Side Goshwara Voucher Verification &amp; Tally Ledger Mapping
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {savedSuccess && (
            <span style={{ color: '#10b981', fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <CheckCircle2 size={16} /> Saved!
            </span>
          )}
          <button className="btn btn-secondary" onClick={handleSaveProgress}>
            <Save size={16} /> Save Progress
          </button>
          <button className="btn btn-primary" onClick={handleExportAll}>
            <FileSpreadsheet size={16} /> Export Tally Excel (.xlsx)
          </button>
        </div>
      </div>

      {/* Navigation Bar */}
      {receipts.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px',
          padding: '10px 20px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <button
            style={btnStyle(hasPrev)}
            disabled={!hasPrev}
            onClick={() => hasPrev && saveCurrentTx(currentIndex - 1)}
          >
            <ChevronLeft size={16} /> Previous
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {receipts.map((r, i) => (
              <button
                key={r.id}
                title={r.filename}
                onClick={() => i !== currentIndex && saveCurrentTx(i)}
                style={{
                  width: '32px', height: '32px', borderRadius: '50%',
                  border: `2px solid ${i === currentIndex ? 'var(--primary)' : 'var(--border-color)'}`,
                  background: i === currentIndex ? 'var(--primary)' : 'var(--bg-card)',
                  color: i === currentIndex ? '#fff' : 'var(--text-muted)',
                  fontWeight: 700, fontSize: '0.8rem',
                  cursor: 'pointer', transition: 'all 0.15s',
                  boxShadow: i === currentIndex ? '0 0 10px rgba(99,102,241,0.5)' : 'none'
                }}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <div style={{ textAlign: 'center', minWidth: '140px' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Viewing receipt</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)' }}>
              {currentIndex + 1} / {receipts.length}
            </div>
          </div>

          <button
            style={btnStyle(hasNext)}
            disabled={!hasNext}
            onClick={() => hasNext && saveCurrentTx(currentIndex + 1)}
          >
            Next <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Split Reviewer Workspace */}
      <div className="split-reviewer">
        {/* Left Panel: Original Receipt Image */}
        <div className="image-panel">
          <div className="panel-header">
            <span>📷 {currentReceipt?.filename || 'Handwritten Voucher'}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                onClick={rotateLeft}
                title="Rotate Left"
                style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: '5px 10px', color: '#fff', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', fontWeight: 600, boxShadow: '0 2px 8px rgba(99,102,241,0.4)', transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={rotateRight}
                title="Rotate Right"
                style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: '5px 10px', color: '#fff', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', fontWeight: 600, boxShadow: '0 2px 8px rgba(99,102,241,0.4)', transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
              >
                <RotateCw size={14} />
              </button>
            </div>
          </div>

          <div className="image-viewer" style={{ overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {currentReceipt?.previewUrl ? (
              <img
                src={currentReceipt.previewUrl}
                alt="Uploaded Handwritten Bill Receipt"
                className="receipt-img"
                style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.3s ease', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No Receipt Image Selected</div>
            )}
          </div>
        </div>

        {/* Right Panel: Extracted Transaction Editor */}
        <div className="data-panel">
          <div className="panel-header">
            <span>✏️ Extracted Tally Transaction Data ({transactions.length} rows)</span>
            <span style={{
              fontSize: '0.85rem',
              color: isBalanced ? '#10b981' : '#f59e0b',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}>
              {isBalanced ? (
                <><CheckCircle2 size={14} /> Total Debit == Total Credit Check Passed</>
              ) : (
                <><AlertTriangle size={14} /> Debit / Credit Imbalance Detected</>
              )}
            </span>
          </div>

          <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', fontSize: '0.95rem' }}>
              <div><strong>Date:</strong> {transactions[0]?.voucher_date || ''}</div>
              <div><strong>Voucher No:</strong> {(transactions[0] as any)?.voucher_no || '-'}</div>
            </div>
            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr>
                    <th style={{ width: '70px' }}>Type</th>
                    <th>Particulars</th>
                    <th style={{ width: '120px', textAlign: 'right' }}>Debit (Rs.)</th>
                    <th style={{ width: '120px', textAlign: 'right' }}>Credit (Rs.)</th>
                    <th style={{ width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id} style={{ background: tx.entry_type === 'Dr' ? 'rgba(99, 102, 241, 0.03)' : 'transparent' }}>
                      <td>
                        <span className={`status-pill ${tx.entry_type === 'Dr' ? 'status-processing' : 'status-extracted'}`} style={{ fontWeight: 700 }}>
                          {tx.entry_type}
                        </span>
                      </td>
                      <td>
                        <input
                          type="text"
                          className="form-input"
                          style={{ padding: '4px 8px', fontSize: '0.85rem', width: '100%', fontWeight: tx.entry_type === 'Dr' ? 600 : 400 }}
                          value={tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'ledger_name', e.target.value)}
                        />
                      </td>
                      <td>
                        {tx.entry_type === 'Dr' ? (
                          <input
                            type="number"
                            className="form-input"
                            style={{ padding: '4px 8px', fontSize: '0.85rem', fontWeight: 600, textAlign: 'right', color: '#818cf8', width: '100%' }}
                            value={tx.debit_amount || tx.amount || ''}
                            onChange={(e) => handleUpdateTransaction(tx.id, 'debit_amount', parseFloat(e.target.value) || 0)}
                          />
                        ) : (
                          <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem', display: 'block', textAlign: 'right' }}>-</span>
                        )}
                      </td>
                      <td>
                        {tx.entry_type === 'Cr' ? (
                          <input
                            type="number"
                            className="form-input"
                            style={{ padding: '4px 8px', fontSize: '0.85rem', fontWeight: 600, textAlign: 'right', color: '#34d399', width: '100%' }}
                            value={tx.credit_amount || ''}
                            onChange={(e) => handleUpdateTransaction(tx.id, 'credit_amount', parseFloat(e.target.value) || 0)}
                          />
                        ) : (
                          <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem', display: 'block', textAlign: 'right' }}>-</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDeleteTransaction(tx.id)}
                          title="Delete Row"
                          style={{ padding: '4px 6px' }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Dr')}>
                  <Plus size={14} /> Add Debit
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Cr')}>
                  <Plus size={14} /> Add Credit
                </button>
              </div>

              <div style={{
                background: isBalanced ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                padding: '10px 16px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${isBalanced ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                display: 'flex',
                gap: '20px'
              }}>
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block' }}>Total Debit:</span>
                  <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#818cf8' }}>
                    Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: '16px' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block' }}>Total Credit:</span>
                  <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#34d399' }}>
                    Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showImbalanceModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          backdropFilter: 'blur(4px)'
        }}>
          <div className="card" style={{
            width: '420px',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
            animation: 'fadeIn 0.2s ease-out'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#f59e0b' }}>
              <AlertTriangle size={24} />
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: 'var(--text-main)' }}>Imbalance Detected</h3>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: 1.5, margin: 0 }}>
              Debit / Credit Imbalance Detected in one or more receipts. Are you sure you want to continue with the export?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
              <button 
                className="btn btn-secondary" 
                onClick={cancelExport}
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button 
                className="btn btn-primary" 
                onClick={confirmExport}
                style={{ padding: '8px 16px', background: '#f59e0b', color: '#fff', border: 'none' }}
              >
                Proceed to Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
