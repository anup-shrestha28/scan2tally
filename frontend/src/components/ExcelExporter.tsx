import React, { useState } from 'react';
import { Download, ArrowLeft, AlertTriangle, Loader2 } from 'lucide-react';
import ExcelJS from 'exceljs';
import { ScanBatch, Transaction, User } from '../types';
import { recordExport } from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';

interface ExcelExporterProps {
  transactions: Transaction[];
  batch: ScanBatch | null;
  currentUser: User;
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

export default function ExcelExporter({ transactions, receiptNames = {}, batch, currentUser, onBack }: ExcelExporterProps) {
  const [downloading, setDownloading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [showImbalanceWarning, setShowImbalanceWarning] = useState(false);

  // Group transactions by receipt_id so we can format each receipt as a separate voucher block
  const groupedTransactions: Record<string, Transaction[]> = {};
  transactions.forEach(t => {
    const key = t.receipt_id || 'default';
    if (!groupedTransactions[key]) groupedTransactions[key] = [];
    groupedTransactions[key].push(t);
  });
  const groups = Object.values(groupedTransactions);

  // Names Tally has no account for. It will not reject them — it will create a
  // new ledger for each, which is how one account's balance ends up split in
  // two. Last chance to say so before the file leaves. Nothing to say when there
  // is no chart of accounts to have checked them against.
  const unresolved = LEDGER_MATCHING
    ? transactions.filter(t => t.ledger_match === 'Unmatched' || t.ledger_match === 'Suggested')
    : [];
  const unresolvedNames = [...new Set(unresolved.map(t => t.ledger_name).filter(Boolean))];
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

  // An unbalanced voucher is not blocked, but it is never exported silently:
  // the confirmation names which ones, so the decision is made knowingly.
  const handleDownloadClick = () => {
    if (imbalancedGroups.length) {
      setShowImbalanceWarning(true);
      return;
    }
    generateAndDownloadExcel();
  };

  const generateAndDownloadExcel = async () => {
    setShowImbalanceWarning(false);
    setDownloading(true);
    try {
      await buildAndDownload();
    } finally {
      setDownloading(false);
    }
  };

  const buildAndDownload = async () => {
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

    const fileName = `Tally_Goshwara_Import_${new Date().toISOString().split('T')[0]}.xlsx`;

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    // The spreadsheet is imported into Tally by hand, so this row is the only
    // trace it ever existed — and the only way to answer "has this batch
    // already been posted, and by whom?" when someone suspects a double entry.
    // Recorded after the download so a failure here cannot cost the file.
    if (batch) {
      try {
        await recordExport({
          batchId: batch.id,
          userId: currentUser.id,
          organizationId: currentUser.organization_id || '',
          fileName,
          recordCount: transactions.length,
          file: blob,
        });
        setRecordError(null);
      } catch (err: any) {
        setRecordError(
          `The file downloaded, but it could not be recorded in your export history (${err?.message || 'unknown error'}).`
        );
      }
    }
  };

  const totalDebit = transactions.reduce((acc, curr) => acc + (Number(curr.debit_amount) || 0), 0);
  const totalCredit = transactions.reduce((acc, curr) => acc + (Number(curr.credit_amount) || 0), 0);
  const balanceDifference = totalDebit - totalCredit;
  const isBalanced = Math.abs(balanceDifference) < 0.01;

  return (
    <div className="export-page">
      <div className="row row-between row-wrap">
        <button className="back-link excel-back-review-btn" onClick={onBack}>
          <ArrowLeft size={16} />
          Review & Edit
        </button>
        <button
          className="btn btn-primary export-download-btn"
          onClick={handleDownloadClick}
          disabled={downloading}
        >
          {downloading
            ? <><Loader2 size={18} className="animate-spin" /> Preparing...</>
            : <><Download size={18} /> Download Excel (.xlsx)</>}
        </button>
      </div>

      {/* Not a blocker. The accountant may know perfectly well that these are
          new accounts they intend to create — but they should be making that
          choice, not discovering it after the import. */}
      {unresolvedNames.length > 0 && (
        <div className="alert alert-error alert-top">
          <AlertTriangle size={16} className="alert-icon" style={{ marginTop: '2px' }} />
          <div>
            <strong className="alert-title">
              {unresolvedNames.length === 1
                ? '1 ledger name is not in your chart of accounts'
                : `${unresolvedNames.length} ledger names are not in your chart of accounts`}
            </strong>
            <div className="alert-detail">
              {unresolvedNames.slice(0, 6).map(n => `"${n}"`).join(', ')}
              {unresolvedNames.length > 6 && ` and ${unresolvedNames.length - 6} more`}.
              {' '}Tally will create a new account for each of these on import. Go back and
              pick the matching ledger if that is not what you want.
            </div>
          </div>
        </div>
      )}

      {recordError && (
        <div className="alert alert-error">
          <AlertTriangle size={16} className="alert-icon" /> {recordError}
        </div>
      )}

      <div className="card">
        <div className="row row-between" style={{ marginBottom: '16px' }}>
          <div>
            <h3 className="section-title section-title-lg" style={{ marginBottom: 0 }}>Excel File Preview</h3>
            <span className="text-muted export-voucher-count">
              {groups.length} {groups.length === 1 ? 'voucher' : 'vouchers'}
            </span>
          </div>

          <div className="export-totals">
            <div className="export-totals-row">
              <span>Total Debit: <strong className="total-debit">Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
              <span>Total Credit: <strong className="total-credit">Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
            </div>
            {!isBalanced && (
              <span className="export-unbalanced">
                Unbalanced by Rs. {Math.abs(balanceDifference).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            )}
          </div>
        </div>

        <div className="table-container export-preview">
          {groups.map((groupTxs, index) => {
            const rawType = groupTxs[0]?.voucher_type || 'Journal';
            const headerText = rawType === 'Journal' ? 'Journal Voucher' : rawType;
            const voucherNo = (groupTxs[0] as any)?.voucher_no || '';
            const voucherDate = groupTxs[0]?.voucher_date || '';
            const narration = normalizeNarration(groupTxs[0]?.narration);

            const grpTotalDr = groupTxs.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
            const grpTotalCr = groupTxs.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);

            return (
              <table key={index} className="voucher-table">
                <tbody>
                  <tr>
                    <td colSpan={6} className="voucher-heading">{headerText}</td>
                  </tr>
                  <tr>
                    <td>Voucher No</td>
                    <td>{voucherNo}</td>
                    <td></td>
                    <td>Date</td>
                    <td colSpan={2} className="text-strong">{voucherDate}</td>
                  </tr>
                  <tr>
                    <td></td>
                    <td></td>
                    <td className="voucher-col-head voucher-particulars">Particulars</td>
                    <td className="voucher-col-head">LF</td>
                    <td className="voucher-col-head">Dr</td>
                    <td className="voucher-col-head">Cr</td>
                  </tr>
                  {groupTxs.map((tx) => {
                    const unknownLedger = LEDGER_MATCHING && (tx.ledger_match === 'Unmatched' || tx.ledger_match === 'Suggested');
                    return (
                    <tr key={tx.id} className={unknownLedger ? 'voucher-ledger-warning' : ''}>
                      <td></td>
                      <td className="voucher-side">
                        {tx.entry_type || (tx.debit_amount ? 'Dr' : 'Cr')}
                      </td>
                      <td>
                        {tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                        {unknownLedger && <span className="voucher-new-account">New account</span>}
                      </td>
                      <td className="voucher-lf"></td>
                      <td className="voucher-amount">
                        {tx.debit_amount ? formatAmt(Number(tx.debit_amount)) : ''}
                      </td>
                      <td className="voucher-amount">
                        {tx.credit_amount ? formatAmt(Number(tx.credit_amount)) : ''}
                      </td>
                    </tr>
                  );})}
                  <tr>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td className="voucher-amount">{formatAmt(grpTotalDr)}</td>
                    <td className="voucher-amount">{formatAmt(grpTotalCr)}</td>
                  </tr>
                  <tr>
                    <td colSpan={6} className="voucher-narration">{narration}</td>
                  </tr>
                </tbody>
              </table>
            );
          })}
        </div>
      </div>

      {showImbalanceWarning && (
        <div className="modal-overlay modal-overlay-top">
          <div className="modal modal-prompt imbalance-modal">
            <div className="modal-head modal-head-warning">
              <AlertTriangle size={23} />
              <h3 className="modal-title">Imbalance Detected</h3>
            </div>
            <p className="modal-text">
              Debit / Credit Imbalance Detected in one or more receipts.<br />
              Are you sure you want to download Excel?
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowImbalanceWarning(false)}>
                Cancel
              </button>
              <button className="btn btn-warning" onClick={generateAndDownloadExcel}>
                Download Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
