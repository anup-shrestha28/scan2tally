import React, { useState, useEffect } from 'react';
import { ArrowLeft, Save, CheckCircle2, AlertTriangle, FileSpreadsheet, Plus, Trash2, RotateCcw, RotateCw } from 'lucide-react';
import { ScanBatch, Receipt, Transaction } from '../types';

interface SideBySideReviewerProps {
  batch: ScanBatch | null;
  selectedReceipt?: Receipt | null;
  initialTransactions?: Transaction[];
  onBack: () => void;
  onExportExcel: (transactions: Transaction[]) => void;
}

export default function SideBySideReviewer({ batch, selectedReceipt, initialTransactions, onBack, onExportExcel }: SideBySideReviewerProps) {
  // Standard Nepalese Goshwara Voucher 1 Default Data with Dr/Cr separation
  const defaultGoshwaraVoucher1: Transaction[] = [
    { id: 'tx-1', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Dr', ledger_name: 'Freight outward', debit_amount: 1237.35, credit_amount: 0, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-2', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Dr', ledger_name: 'Carriage outward - Transportation', debit_amount: 6000.00, credit_amount: 0, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-3', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Dr', ledger_name: 'Carriage outward - Labor', debit_amount: 7171.00, credit_amount: 0, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-4', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'TDS payable', debit_amount: 0, credit_amount: 16.42, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-5', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'VAT payable', debit_amount: 0, credit_amount: 690.00, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-6', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'TDS payable', debit_amount: 0, credit_amount: 71.00, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-7', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'Krishna Transport', debit_amount: 0, credit_amount: 1020.23, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-8', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'New subhash Carriers', debit_amount: 0, credit_amount: 200.70, narration: 'Being Expenses paid via cheque no.' },
    { id: 'tx-9', voucher_date: '2083-03-15', voucher_type: 'Journal', entry_type: 'Cr', ledger_name: 'Sundry payable', debit_amount: 0, credit_amount: 12410.00, narration: 'Being Expenses paid via cheque no.' }
  ];

  const getInitialState = () => {
    if (!initialTransactions) return defaultGoshwaraVoucher1;
    if (initialTransactions.length > 0) return initialTransactions;
    return [{
      id: `tx-blank-1`,
      voucher_date: new Date().toISOString().split('T')[0],
      voucher_type: 'Journal',
      entry_type: 'Dr',
      ledger_name: '',
      debit_amount: 0,
      credit_amount: 0,
      narration: 'Being Expenses paid via cheque no.'
    }];
  };

  const [transactions, setTransactions] = useState<Transaction[]>(getInitialState());

  useEffect(() => {
    setTransactions(getInitialState());
  }, [initialTransactions]);

  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);
  const [rotation, setRotation] = useState<number>(0);

  const rotateLeft = () => setRotation(r => r - 90);
  const rotateRight = () => setRotation(r => r + 90);

  const handleUpdateTransaction = (id: string, field: keyof Transaction, value: any) => {
    setTransactions(transactions.map(t => {
      if (t.id === id) {
        const updated = { ...t, [field]: value };
        // Sync legacy ledger fields for backward compatibility
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
      voucher_date: transactions[0]?.voucher_date || '2083-03-15',
      voucher_type: 'Journal',
      entry_type: entryType,
      ledger_name: entryType === 'Dr' ? 'New Expense Ledger' : 'New Payable Ledger',
      debit_amount: entryType === 'Dr' ? 0.00 : 0,
      credit_amount: entryType === 'Cr' ? 0.00 : 0,
      narration: ''
    };
    setTransactions([...transactions, newTx]);
  };

  const handleDeleteTransaction = (id: string) => {
    setTransactions(transactions.filter(t => t.id !== id));
  };

  const handleSaveProgress = () => {
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  // Compute Total Debit & Total Credit separately
  const totalDebit = transactions.reduce((acc, curr) => acc + (Number(curr.debit_amount) || 0), 0);
  const totalCredit = transactions.reduce((acc, curr) => acc + (Number(curr.credit_amount) || 0), 0);
  
  // Check double-entry balance (allowing tiny rounding threshold 0.05)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.05;

  const currentReceiptImage = selectedReceipt?.previewUrl || batch?.receipts?.[0]?.previewUrl || null;
  const currentReceiptName = selectedReceipt?.filename || batch?.receipts?.[0]?.filename || 'Handwritten Voucher';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* Header Bar */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to Batches
          </button>

          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
              {batch?.name || 'Scan Batch Review'} - {currentReceiptName}
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Side-by-Side Goshwara Voucher Verification & Tally Ledger Mapping
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {savedSuccess && (
            <span style={{ color: '#10b981', fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <CheckCircle2 size={16} /> Saved!
            </span>
          )}

          <button className="btn btn-secondary" onClick={handleSaveProgress}>
            <Save size={16} />
            Save Progress
          </button>

          <button className="btn btn-primary" onClick={() => onExportExcel(transactions)}>
            <FileSpreadsheet size={16} />
            Generate Tally Excel (.xlsx)
          </button>
        </div>
      </div>

      {/* Split Reviewer Workspace */}
      <div className="split-reviewer">
        {/* Left Panel: Original Receipt Image */}
        <div className="image-panel">
          <div className="panel-header">
            <span>📷 {currentReceiptName}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                onClick={rotateLeft}
                title="Rotate Left"
                style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: '5px 10px', color: '#fff', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', fontWeight: 600, boxShadow: '0 2px 8px rgba(99,102,241,0.4)', transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 14px rgba(99,102,241,0.6)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(99,102,241,0.4)'; }}
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={rotateRight}
                title="Rotate Right"
                style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none', borderRadius: '8px', cursor: 'pointer', padding: '5px 10px', color: '#fff', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', fontWeight: 600, boxShadow: '0 2px 8px rgba(99,102,241,0.4)', transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 14px rgba(99,102,241,0.6)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(99,102,241,0.4)'; }}
              >
                <RotateCw size={14} />
              </button>
            </div>
          </div>

          <div className="image-viewer" style={{ overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {currentReceiptImage ? (
              <img 
                src={currentReceiptImage} 
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
                <>
                  <CheckCircle2 size={14} /> Total Debit == Total Credit Check Passed
                </>
              ) : (
                <>
                  <AlertTriangle size={14} /> Debit / Credit Imbalance Detected
                </>
              )}
            </span>
          </div>

          <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', fontSize: '0.95rem' }}>
              <div>
                <strong>Date:</strong> {transactions[0]?.voucher_date || ''}
              </div>
              <div>
                <strong>Voucher No:</strong> { (transactions[0] as any)?.voucher_no || '-' }
              </div>
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
    </div>
  );
}
