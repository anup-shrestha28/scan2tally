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
    const headers = ['Voucher Date', 'Voucher Type', 'Debit Ledger', 'Credit Ledger', 'Amount', 'Narration'];
    
    const rows = transactions.map(t => [
      t.voucher_date,
      t.voucher_type,
      `"${t.debit_ledger}"`,
      `"${t.credit_ledger}"`,
      t.amount,
      `"${t.narration}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Tally_Journal_Import_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setDownloaded(true);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1000px', margin: '0 auto' }}>
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

        <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Tally Excel File Ready</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '4px', maxWidth: '500px', margin: '4px auto 24px auto' }}>
          Your extracted handwritten receipts have been validated and formatted into a Tally-compatible spreadsheet ready for 1-click import into Tally Prime.
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
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '16px' }}>
          Tally Import File Preview ({transactions.length} rows)
        </h3>

        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Voucher Date</th>
                <th>Voucher Type</th>
                <th>Debit Ledger</th>
                <th>Credit Ledger</th>
                <th>Amount (Rs.)</th>
                <th>Narration</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.voucher_date}</td>
                  <td><span className="status-pill status-processing">{tx.voucher_type}</span></td>
                  <td style={{ fontWeight: 600 }}>{tx.debit_ledger}</td>
                  <td>{tx.credit_ledger}</td>
                  <td style={{ fontWeight: 700, color: 'var(--primary)' }}>
                    Rs. {Number(tx.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
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
