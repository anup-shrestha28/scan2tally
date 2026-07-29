import React, { useState } from 'react';
import { Download, ArrowLeft, AlertTriangle } from 'lucide-react';
import ExcelJS from 'exceljs';
import { Transaction } from '../types';

interface ExcelExporterProps {
  transactions: Transaction[];
  receiptNames?: Record<string, string>;
  onBack: () => void;
}

const normalizeNarration = (raw: string | undefined): string => {
  const baseStatic = 'Being Expenses paid via cheque no.';
  if (!raw) return baseStatic;
  
  // Remove surrounding parentheses and trailing/leading dots
  const cleaned = raw.trim().replace(/^[\(\)\.]+|[\(\)\.]+$/g, '').trim();
  
  // Try to find any sequence of digits that might be the cheque number
  const chequeMatch = cleaned.match(/(?:cheque(?: no\.?)?\s*|no\.?\s*)(\d+)/i);
  
  if (chequeMatch) {
    const chequeNo = chequeMatch[1];
    return `${baseStatic} ${chequeNo}`;
  }
  
  // If no digits found but the text includes words like cheque/expenses,
  // or even if it's completely different, the user wants the static prefix.
  // We'll just return the static prefix, perhaps appending any non-standard text if it looks completely different,
  // but based on the prompt, it seems they just want it strictly static + cheque number if any.
  return baseStatic;
};

// Format number with Indian-style commas and 2 decimal places
const formatAmt = (n: number | undefined | null): string => {
  if (!n) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export default function ExcelExporter({ transactions, receiptNames = {}, onBack }: ExcelExporterProps) {
  const [showImbalanceWarning, setShowImbalanceWarning] = useState(false);
  // Group transactions by receipt_id so we can format each receipt as a separate voucher block
  const groupedTransactions: Record<string, Transaction[]> = {};
  transactions.forEach(t => {
    const key = t.receipt_id || 'default';
    if (!groupedTransactions[key]) groupedTransactions[key] = [];
    groupedTransactions[key].push(t);
  });
  const groups = Object.values(groupedTransactions);

  const imbalancedGroups = groups.map((groupTxs, index) => {
    const debit = groupTxs.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
    const credit = groupTxs.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);
    const difference = Math.round((debit - credit) * 100) / 100;
    const receiptId = groupTxs[0]?.receipt_id || 'default';
    return {
      name: receiptNames[receiptId] || `Journal ${index + 1}`,
      debit,
      credit,
      difference,
    };
  }).filter(group => Math.abs(group.difference) >= 0.01);

  const generateAndDownloadExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Goshwara Import');

    // Column widths
    sheet.getColumn(1).width = 15; 
    sheet.getColumn(2).width = 8;  
    sheet.getColumn(3).width = 40; 
    sheet.getColumn(4).width = 10; 
    sheet.getColumn(5).width = 15; 
    sheet.getColumn(6).width = 15; 

    groups.forEach((groupTxs, index) => {
      const rawType = groupTxs[0]?.voucher_type || 'Journal';
      const headerText = rawType === 'Journal' ? 'Journal Voucher' : rawType;
      const voucherNo = (groupTxs[0] as any)?.voucher_no || '';
      const voucherDate = groupTxs[0]?.voucher_date || '';
      const narration = normalizeNarration(groupTxs[0]?.narration);
      
      // Row 1: Header
      const row1 = sheet.addRow([headerText, '', '', '', '', '']);
      sheet.mergeCells(`A${row1.number}:F${row1.number}`);
      row1.getCell(1).alignment = { horizontal: 'center' };
      row1.getCell(1).font = { bold: true };
      
      // Row 2: Voucher No & Date
      const row2 = sheet.addRow(['Voucher No', voucherNo, '', 'Date', voucherDate, '']);
      sheet.mergeCells(`E${row2.number}:F${row2.number}`);
      row2.getCell(5).font = { bold: true }; 
      
      // Row 3: Column Headers
      const row3 = sheet.addRow(['', '', 'Particulars', 'LF', 'Dr', 'Cr']);
      ['C', 'D', 'E', 'F'].forEach(col => {
        row3.getCell(col).font = { bold: true };
        row3.getCell(col).alignment = { horizontal: 'center' };
      });
      
      // Rows: Transactions
      groupTxs.forEach(t => {
        const type = t.entry_type || (t.debit_amount ? 'Dr' : 'Cr');
        const drAmount = t.debit_amount ? formatAmt(Number(t.debit_amount)) : '';
        const crAmount = t.credit_amount ? formatAmt(Number(t.credit_amount)) : '';
        const ledgerName = t.ledger_name || t.debit_ledger || t.credit_ledger || '';
        const r = sheet.addRow(['', type, ledgerName, '', drAmount, crAmount]);
        r.getCell('E').alignment = { horizontal: 'right' };
        r.getCell('F').alignment = { horizontal: 'right' };
      });
      
      // Total Row
      const totalDr = groupTxs.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
      const totalCr = groupTxs.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);
      
      const totalRow = sheet.addRow(['', '', '', '', formatAmt(totalDr), formatAmt(totalCr)]);
      totalRow.getCell('E').font = { bold: true }; 
      totalRow.getCell('F').font = { bold: true }; 
      totalRow.getCell('E').alignment = { horizontal: 'right' };
      totalRow.getCell('F').alignment = { horizontal: 'right' };
      
      // Narration Row
      const narrationRow = sheet.addRow([narration, '', '', '', '', '']);
      sheet.mergeCells(`A${narrationRow.number}:F${narrationRow.number}`);
      narrationRow.getCell(1).font = { bold: true }; 

      // Apply borders to all generated rows for this voucher block
      const startRow = row1.number;
      const endRow = narrationRow.number;
      for (let i = startRow; i <= endRow; i++) {
        const row = sheet.getRow(i);
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber <= 6) {
            cell.border = {
              top: {style:'thin'},
              left: {style:'thin'},
              bottom: {style:'thin'},
              right: {style:'thin'}
            };
          }
        });
      }

      // Add a blank row between groups, except for the last one
      if (index < groups.length - 1) {
        sheet.addRow([]);
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Tally_Goshwara_Import_${new Date().toISOString().split('T')[0]}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  };

  const handleDownloadClick = () => {
    if (imbalancedGroups.length) {
      setShowImbalanceWarning(true);
      return;
    }
    generateAndDownloadExcel();
  };

  const totalDebit = transactions.reduce((acc, curr) => acc + (Number(curr.debit_amount) || 0), 0);
  const totalCredit = transactions.reduce((acc, curr) => acc + (Number(curr.credit_amount) || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1050px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to Review & Edit
        </button>
        <button className="btn btn-primary export-download-btn" onClick={handleDownloadClick}>
          <Download size={18} />
          Download Excel (.xlsx)
        </button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Excel File Preview</h3>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              {groups.length} {groups.length === 1 ? 'voucher' : 'vouchers'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span>Total Debit: <strong style={{ color: '#818cf8' }}>Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
              <span>Total Credit: <strong style={{ color: '#34d399' }}>Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
            </div>
          </div>
        </div>

        <div className="table-container" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {groups.map((groupTxs, index) => {
            const rawType = groupTxs[0]?.voucher_type || 'Journal';
            const headerText = rawType === 'Journal' ? 'Journal Voucher' : rawType;
            const voucherNo = (groupTxs[0] as any)?.voucher_no || '';
            const voucherDate = groupTxs[0]?.voucher_date || '';
            const narration = normalizeNarration(groupTxs[0]?.narration);

            const grpTotalDr = groupTxs.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
            const grpTotalCr = groupTxs.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);

            return (
              <table key={index} className="custom-table" style={{ borderCollapse: 'collapse', width: '100%', border: '1px solid var(--border-color, #e5e7eb)' }}>
                <tbody>
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                      {headerText}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Voucher No</td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>{voucherNo}</td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>Date</td>
                    <td colSpan={2} style={{ border: '1px solid var(--border-color, #e5e7eb)', fontWeight: 'bold', padding: '8px' }}>
                      {voucherDate}
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
                  {groupTxs.map((tx) => (
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
                        {tx.debit_amount ? formatAmt(Number(tx.debit_amount)) : ''}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px', minWidth: '100px' }}>
                        {tx.credit_amount ? formatAmt(Number(tx.credit_amount)) : ''}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                    <td style={{ border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}></td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                      {formatAmt(grpTotalDr)}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                      {formatAmt(grpTotalCr)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={6} style={{ fontWeight: 'bold', border: '1px solid var(--border-color, #e5e7eb)', padding: '8px' }}>
                      {narration}
                    </td>
                  </tr>
                </tbody>
              </table>
            );
          })}
        </div>
      </div>

      {showImbalanceWarning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '20px', background: 'rgba(0, 0, 0, 0.62)',
          backdropFilter: 'blur(4px)'
        }}>
          <div className="card" style={{ width: '100%', maxWidth: '460px', padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#f59e0b', marginBottom: '12px' }}>
              <AlertTriangle size={23} />
              <h3 style={{ color: 'var(--text-main)', fontSize: '1.15rem' }}>Imbalance Detected</h3>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.96rem', lineHeight: 1.55, marginBottom: '14px' }}>
              Debit / Credit Imbalance Detected in one or more receipts. Do you want to download the Excel file anyway?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button className="btn btn-secondary" onClick={() => setShowImbalanceWarning(false)}>Cancel</button>
              <button
                className="btn btn-primary excel-download-anyway-btn"
                onClick={() => {
                  setShowImbalanceWarning(false);
                  generateAndDownloadExcel();
                }}
                style={{ background: '#f59e0b', borderColor: '#f59e0b' }}
              >
                <span style={{ fontSize: '0.92rem' }}>Download Anyway</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
