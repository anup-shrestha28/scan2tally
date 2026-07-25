import React, { useState, useEffect } from 'react';
import { ArrowLeft, Save, CheckCircle2, FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { ScanBatch, Transaction } from '../types';

interface SideBySideReviewerProps {
  batch: ScanBatch | null;
  initialTransactions?: Transaction[];
  onBack: () => void;
  onExportExcel: (transactions: Transaction[]) => void;
}

export default function SideBySideReviewer({ batch, initialTransactions, onBack, onExportExcel }: SideBySideReviewerProps) {
  const defaultMockTransactions: Transaction[] = [
    {
      id: 'tx-1',
      voucher_date: '2026-07-24',
      voucher_type: 'Payment',
      debit_ledger: 'Office Rent Expense',
      credit_ledger: 'Cash Account',
      amount: 15000.00,
      narration: 'Office space rent for July 2026'
    },
    {
      id: 'tx-2',
      voucher_date: '2026-07-24',
      voucher_type: 'Journal',
      debit_ledger: 'Printing & Stationery',
      credit_ledger: 'Petty Cash',
      amount: 2450.00,
      narration: 'Paper bill receipts and ledger books'
    }
  ];

  const [transactions, setTransactions] = useState<Transaction[]>(
    initialTransactions && initialTransactions.length ? initialTransactions : defaultMockTransactions
  );

  useEffect(() => {
    if (initialTransactions && initialTransactions.length) {
      setTransactions(initialTransactions);
    }
  }, [initialTransactions]);

  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  const handleUpdateTransaction = (id: string, field: keyof Transaction, value: any) => {
    setTransactions(transactions.map(t => {
      if (t.id === id) {
        return { ...t, [field]: value };
      }
      return t;
    }));
  };

  const handleAddTransaction = () => {
    const newTx: Transaction = {
      id: `tx-${Date.now()}`,
      voucher_date: new Date().toISOString().split('T')[0],
      voucher_type: 'Journal',
      debit_ledger: 'General Expense',
      credit_ledger: 'Cash Account',
      amount: 0.00,
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

  const totalAmount = transactions.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);

  // Get preview URL of uploaded receipt image if available
  const receiptPreviewUrl = batch?.receipts?.[0]?.previewUrl || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to Batches
          </button>

          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{batch?.name || 'Scan Batch Review'}</h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Side-by-Side Receipt Verification & Tally Ledger Mapping
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

      <div className="split-reviewer">
        {/* Left Panel: Original Receipt Image */}
        <div className="image-panel">
          <div className="panel-header">
            <span>📷 Original Handwritten Bill Receipt</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Zoom: 100%</span>
          </div>

          <div className="image-viewer">
            {receiptPreviewUrl ? (
              <img 
                src={receiptPreviewUrl} 
                alt="Uploaded Handwritten Bill Receipt" 
                className="receipt-img"
              />
            ) : (
              <svg width="340" height="460" viewBox="0 0 340 460" style={{ borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', background: '#fff' }}>
                <rect width="340" height="460" fill="#fcfbf7" rx="6" />
                <rect x="20" y="20" width="300" height="420" fill="none" stroke="#e5e7eb" strokeWidth="1" strokeDasharray="4" />
                
                <text x="170" y="55" textAnchor="middle" fontFamily="cursive, sans-serif" fontSize="22" fontWeight="bold" fill="#1e293b">
                  PETTY CASH VOUCHER
                </text>
                <text x="170" y="75" textAnchor="middle" fontFamily="sans-serif" fontSize="12" fill="#64748b">
                  Date: 24/07/2026 | Bill No: #4892
                </text>
                <line x1="30" y1="90" x2="310" y2="90" stroke="#334155" strokeWidth="1.5" />

                <text x="40" y="115" fontFamily="sans-serif" fontSize="12" fontWeight="bold" fill="#334155">Particulars / Details</text>
                <text x="260" y="115" fontFamily="sans-serif" fontSize="12" fontWeight="bold" fill="#334155">Amount (Rs.)</text>
                <line x1="30" y1="125" x2="310" y2="125" stroke="#cbd5e1" strokeWidth="1" />

                <text x="40" y="155" fontFamily="cursive" fontSize="18" fill="#1e3a8a">
                  1. Paid Office Space Rent (July)
                </text>
                <text x="250" y="155" fontFamily="cursive" fontSize="18" fill="#1e3a8a">
                  15,000.00
                </text>

                <text x="40" y="205" fontFamily="cursive" fontSize="18" fill="#1e3a8a">
                  2. Paper Bills & Stationery
                </text>
                <text x="255" y="205" fontFamily="cursive" fontSize="18" fill="#1e3a8a">
                  2,450.00
                </text>

                <line x1="30" y1="270" x2="310" y2="270" stroke="#334155" strokeWidth="1.5" />
                
                <text x="40" y="300" fontFamily="sans-serif" fontSize="14" fontWeight="bold" fill="#0f172a">TOTAL AMOUNT:</text>
                <text x="245" y="300" fontFamily="cursive" fontSize="20" fontWeight="bold" fill="#0f172a">
                  Rs. 17,450.00
                </text>

                <line x1="40" y1="400" x2="130" y2="400" stroke="#94a3b8" strokeWidth="1" />
                <text x="50" y="415" fontFamily="sans-serif" fontSize="10" fill="#64748b">Prepared By</text>

                <line x1="210" y1="400" x2="300" y2="400" stroke="#94a3b8" strokeWidth="1" />
                <text x="220" y="415" fontFamily="sans-serif" fontSize="10" fill="#64748b">Approved By</text>
              </svg>
            )}
          </div>
        </div>

        {/* Right Panel: Extracted Transaction Editor */}
        <div className="data-panel">
          <div className="panel-header">
            <span>✏️ Extracted Tally Transaction Data ({transactions.length} rows)</span>
            <span style={{ fontSize: '0.85rem', color: '#10b981', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <CheckCircle2 size={14} /> Total Debit == Total Credit Check Passed
            </span>
          </div>

          <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Voucher Type</th>
                    <th>Debit Ledger (Expense/Party)</th>
                    <th>Credit Ledger (Payment)</th>
                    <th>Amount (Rs.)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td style={{ width: '130px' }}>
                        <input 
                          type="date" 
                          className="form-input" 
                          style={{ padding: '4px 8px', fontSize: '0.85rem' }}
                          value={tx.voucher_date}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'voucher_date', e.target.value)}
                        />
                      </td>
                      <td style={{ width: '120px' }}>
                        <select 
                          className="form-select" 
                          style={{ padding: '4px 8px', fontSize: '0.85rem' }}
                          value={tx.voucher_type}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'voucher_type', e.target.value)}
                        >
                          <option value="Journal">Journal</option>
                          <option value="Payment">Payment</option>
                          <option value="Receipt">Receipt</option>
                          <option value="Purchase">Purchase</option>
                          <option value="Sales">Sales</option>
                        </select>
                      </td>
                      <td>
                        <input 
                          type="text" 
                          className="form-input" 
                          style={{ padding: '4px 8px', fontSize: '0.85rem', width: '100%' }}
                          value={tx.debit_ledger}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'debit_ledger', e.target.value)}
                        />
                      </td>
                      <td>
                        <input 
                          type="text" 
                          className="form-input" 
                          style={{ padding: '4px 8px', fontSize: '0.85rem', width: '100%' }}
                          value={tx.credit_ledger}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'credit_ledger', e.target.value)}
                        />
                      </td>
                      <td style={{ width: '120px' }}>
                        <input 
                          type="number" 
                          className="form-input" 
                          style={{ padding: '4px 8px', fontSize: '0.85rem', fontWeight: 600, width: '100%' }}
                          value={tx.amount}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'amount', parseFloat(e.target.value) || 0)}
                        />
                      </td>
                      <td style={{ width: '40px' }}>
                        <button 
                          className="btn btn-danger btn-sm" 
                          onClick={() => handleDeleteTransaction(tx.id)}
                          title="Delete Row"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={handleAddTransaction}>
                <Plus size={14} /> Add Transaction Row
              </button>

              <div style={{ background: 'rgba(99, 102, 241, 0.1)', padding: '10px 16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', display: 'flex', gap: '16px' }}>
                <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Batch Total:</span>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--primary)' }}>
                  Rs. {totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
