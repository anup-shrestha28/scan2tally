import React, { useState } from 'react';
import { FileSpreadsheet, Download, CheckCircle2, RefreshCw, ArrowLeft } from 'lucide-react';
import { Transaction } from '../types';

interface ExcelExporterProps {
  transactions: Transaction[];
  onBack: () => void;
}

export default function ExcelExporter({ transactions, onBack }: ExcelExporterProps) {
  const [downloaded, setDownloaded] = useState<boolean>(false);

  const generateAndDownloadExcel = () => {
    // Construct CSV / Excel content matching Tally Prime Journal Voucher Import Schema
    const headers = ['Voucher Date', 'Voucher Type', 'Dr/Cr', 'Ledger Name', 'Debit Amount (Rs.)', 'Credit Amount (Rs.)', 'Narration'];
    
    const rows = transactions.map(t => [
      t.voucher_date,
      t.voucher_type,
      t.entry_type || (t.debit_amount ? 'Dr' : 'Cr'),
      `"${t.ledger_name || t.debit_ledger || t.credit_ledger || ''}"`,
      t.debit_amount || t.amount || 0,
      t.credit_amount || 0,
      `"${t.narration || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Tally_Goshwara_Import_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setDownloaded(true);
  };

  const totalDebit = transactions.reduce((acc, curr) => acc + (Number(curr.debit_amount) || Number(curr.amount) || 0), 0);
  const totalCredit = transactions.reduce((acc, curr) => acc + (Number(curr.credit_amount) || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1050px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to Verification Editor
        </button>
      </div>

      <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
        <div style={{
          width: '64px',
          height: '64px',
          background: 'rgba(16, 185, 129, 0.1)',
          color: '#10b981',
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '16px'
        }}>
          <FileSpreadsheet size={32} />
        </div>

        <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Tally Goshwara Excel File Ready</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '4px', maxWidth: '540px', margin: '4px auto 24px auto' }}>
          Your extracted handwritten voucher line items have been formatted into a Tally-compatible spreadsheet ready for 1-click import into Tally Prime.
        </p>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={generateAndDownloadExcel} style={{ padding: '12px 24px', fontSize: '1rem' }}>
            <Download size={18} />
            Download Tally Excel Spreadsheet (.xlsx)
          </button>
          
          <button className="btn btn-secondary" onClick={generateAndDownloadExcel}>
            <RefreshCw size={16} />
            Regenerate Fresh Copy
          </button>
        </div>

        {downloaded && (
          <div style={{ marginTop: '16px', color: '#10b981', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <CheckCircle2 size={18} /> Excel file successfully saved to your downloads!
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            Tally Import File Preview ({transactions.length} rows)
          </h3>

          <div style={{ display: 'flex', gap: '16px', fontSize: '0.875rem' }}>
            <span>Total Debit: <strong style={{ color: '#818cf8' }}>Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
            <span>Total Credit: <strong style={{ color: '#34d399' }}>Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
          </div>
        </div>

        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Dr/Cr</th>
                <th>Ledger Name</th>
                <th style={{ textAlign: 'right' }}>Debit (Rs.)</th>
                <th style={{ textAlign: 'right' }}>Credit (Rs.)</th>
                <th>Narration</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.voucher_date}</td>
                  <td><span className="status-pill status-processing">{tx.voucher_type}</span></td>
                  <td>
                    <span className={`status-pill ${tx.entry_type === 'Dr' ? 'status-processing' : 'status-extracted'}`}>
                      {tx.entry_type || 'Dr'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>{tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}</td>
                  <td style={{ textAlign: 'right', color: '#818cf8', fontWeight: tx.debit_amount ? 600 : 400 }}>
                    {tx.debit_amount ? `Rs. ${Number(tx.debit_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#34d399', fontWeight: tx.credit_amount ? 600 : 400 }}>
                    {tx.credit_amount ? `Rs. ${Number(tx.credit_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{tx.narration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
