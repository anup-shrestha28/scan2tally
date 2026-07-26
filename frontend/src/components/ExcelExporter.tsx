import React, { useState } from 'react';
import { FileSpreadsheet, Download, CheckCircle2, RefreshCw, ArrowLeft } from 'lucide-react';
import ExcelJS from 'exceljs';
import { Transaction } from '../types';

interface ExcelExporterProps {
  transactions: Transaction[];
  onBack: () => void;
}

export default function ExcelExporter({ transactions, onBack }: ExcelExporterProps) {
  const [downloaded, setDownloaded] = useState<boolean>(false);

  const generateAndDownloadExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Goshwara Import');

    const rawType = transactions[0]?.voucher_type || 'Journal';
    const headerText = rawType === 'Journal' ? 'Journal Voucher' : rawType;
    const voucherNo = (transactions[0] as any)?.voucher_no || '';
    const voucherDate = transactions[0]?.voucher_date || '';
    const defaultNarration = 'Being Expenses paid via cheque no.';
    const isOldNarration = transactions[0]?.narration?.includes('(Being Expenses Recorded)') || transactions[0]?.narration?.includes('Being Expenses paid via cheque no');
    const narration = isOldNarration 
      ? defaultNarration 
      : (transactions[0]?.narration || defaultNarration);
    
    sheet.getColumn(1).width = 15; 
    sheet.getColumn(2).width = 8;  
    sheet.getColumn(3).width = 40; 
    sheet.getColumn(4).width = 10; 
    sheet.getColumn(5).width = 15; 
    sheet.getColumn(6).width = 15; 
    
    const row1 = sheet.addRow([headerText, '', '', '', '', '']);
    sheet.mergeCells('A1:F1');
    row1.getCell(1).alignment = { horizontal: 'center' };
    row1.getCell(1).font = { bold: true };
    
    const row2 = sheet.addRow(['Voucher No', voucherNo, '', 'Date', voucherDate, '']);
    sheet.mergeCells('E2:F2');
    row2.getCell(5).font = { bold: true }; 
    
    const row3 = sheet.addRow(['', '', 'Particulars', 'LF', 'Dr', 'Cr']);
    ['C', 'D', 'E', 'F'].forEach(col => {
      row3.getCell(col).font = { bold: true };
      row3.getCell(col).alignment = { horizontal: 'center' };
    });
    
    transactions.forEach(t => {
      const type = t.entry_type || (t.debit_amount ? 'Dr' : 'Cr');
      const drAmount = t.debit_amount ? Number(t.debit_amount).toFixed(2) : '';
      const crAmount = t.credit_amount ? Number(t.credit_amount).toFixed(2) : '';
      const ledgerName = t.ledger_name || t.debit_ledger || t.credit_ledger || '';
      const r = sheet.addRow(['', type, ledgerName, '', drAmount, crAmount]);
      r.getCell('E').alignment = { horizontal: 'right' };
      r.getCell('F').alignment = { horizontal: 'right' };
    });
    
    const totalDr = transactions.reduce((sum, t) => sum + (Number(t.debit_amount) || Number(t.amount) || 0), 0);
    const totalCr = transactions.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);
    
    const totalRow = sheet.addRow(['', '', '', '', totalDr.toFixed(2), totalCr.toFixed(2)]);
    totalRow.getCell('E').font = { bold: true }; 
    totalRow.getCell('F').font = { bold: true }; 
    totalRow.getCell('E').alignment = { horizontal: 'right' };
    totalRow.getCell('F').alignment = { horizontal: 'right' };
    
    const narrationRow = sheet.addRow([narration, '', '', '', '', '']);
    sheet.mergeCells(`A${narrationRow.number}:F${narrationRow.number}`);
    narrationRow.getCell(1).font = { bold: true }; 

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Tally_Goshwara_Import_${new Date().toISOString().split('T')[0]}.xlsx`;
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
          <table className="custom-table" style={{ borderCollapse: 'collapse', width: '100%', border: '1px solid var(--border-color, #e5e7eb)' }}>
            <tbody>
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                  {transactions[0]?.voucher_type === 'Journal' ? 'Journal Voucher' : (transactions[0]?.voucher_type || 'Journal Voucher')}
                </td>
              </tr>
              <tr>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Voucher No</td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>{(transactions[0] as any)?.voucher_no || ''}</td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Date</td>
                <td colSpan={2} style={{ border: '1px solid var(--border-color, #e5e7eb)', fontWeight: 'bold', padding: '8px' }}>
                  {transactions[0]?.voucher_date || ''}
                </td>
              </tr>
              <tr>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', width: '250px' }}>Particulars</td>
                <td style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>LF</td>
                <td style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Dr</td>
                <td style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Cr</td>
              </tr>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                  <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', width: '50px', textAlign: 'center' }}>
                    {tx.entry_type || (tx.debit_amount ? 'Dr' : 'Cr')}
                  </td>
                  <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                    {tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                  </td>
                  <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', width: '50px' }}></td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', minWidth: '100px' }}>
                    {tx.debit_amount ? Number(tx.debit_amount).toFixed(2) : ''}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', minWidth: '100px' }}>
                    {tx.credit_amount ? Number(tx.credit_amount).toFixed(2) : ''}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                  {totalDebit.toFixed(2)}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                  {totalCredit.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td colSpan={6} style={{ fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                  {transactions[0]?.narration?.includes('(Being Expenses Recorded)') || transactions[0]?.narration?.includes('Being Expenses paid via cheque no') ? 'Being Expenses paid via cheque no.' : (transactions[0]?.narration || 'Being Expenses paid via cheque no.')}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
