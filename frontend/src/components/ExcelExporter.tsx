import React, { useState } from 'react';
import { Download, ArrowLeft, AlertTriangle, Loader2, BarChart3 } from 'lucide-react';
import ExcelJS from 'exceljs';
import { ScanBatch, Transaction, User } from '../types';
import { recordExport } from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';
import { orderGroupedReceiptIds } from '../lib/receiptOrder';

interface ExcelExporterProps {
  transactions: Transaction[];
  batch: ScanBatch | null;
  currentUser: User;
  receiptNames?: Record<string, string>;
  onBack: () => void;
  onFixImbalanced: (receiptIds: string[]) => void;
  initialShowParticularTotals?: boolean;
  onBackFromParticulars?: () => void;
}

interface ParticularTotal {
  name: string;
  debit: number;
  credit: number;
}

const normalizeNarration = (raw: string | undefined): string => {
  if (!raw || !raw.trim()) return 'Being Expenses paid via cheque no.';
  return raw.trim();
};

// Format number with Indian-style commas and 2 decimal places
const formatAmt = (n: number | undefined | null): string => {
  if (!n) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const safeFilePart = (value: string): string =>
  value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '');

export default function ExcelExporter({ transactions, receiptNames = {}, batch, currentUser, onBack, onFixImbalanced, initialShowParticularTotals = false, onBackFromParticulars }: ExcelExporterProps) {
  const [downloading, setDownloading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [showImbalanceWarning, setShowImbalanceWarning] = useState(false);
  const [showParticularTotals, setShowParticularTotals] = useState(initialShowParticularTotals);
  const [downloadingParticularTotals, setDownloadingParticularTotals] = useState(false);

  // Group transactions by receipt_id so we can format each receipt as a separate voucher block
  const groupedTransactions: Record<string, Transaction[]> = {};
  transactions.forEach(t => {
    const key = t.receipt_id || 'default';
    if (!groupedTransactions[key]) groupedTransactions[key] = [];
    groupedTransactions[key].push(t);
  });
  // The voucher blocks in the SAME order the batch table and the reviewer show
  // their receipts, so page 3 of the reviewer is voucher 3 here and in the
  // downloaded .xlsx. This screen used to run its own sort, which put receipts
  // WITHOUT a voucher number first — the exact opposite of everywhere else.
  const groups = orderGroupedReceiptIds(batch?.receipts ?? [], groupedTransactions)
    .map(id => groupedTransactions[id]);
  // Batch-level summary based on the values after reviewer edits. Voucher
  // boundaries do not apply here: repeated particulars across the batch are
  // intentionally combined into one Dr/Cr total.
  const particularTotals: ParticularTotal[] = (() => {
    const totals = new Map<string, ParticularTotal>();
    transactions.forEach(transaction => {
      const name = (transaction.ledger_name || transaction.debit_ledger || transaction.credit_ledger || '').trim();
      if (!name) return;
      const key = name.replace(/[^a-zA-Z0-9]/g, '').toLocaleLowerCase().replace(/s$/, '');
      const current = totals.get(key) || { name, debit: 0, credit: 0 };
      current.debit += Number(transaction.debit_amount) || 0;
      current.credit += Number(transaction.credit_amount) || 0;
      totals.set(key, current);
    });

    // Merge all "Utility - *" entries into a single "Utility" row
    const UTILITY_KEY = '__utility__';
    const merged = new Map<string, ParticularTotal>();
    totals.forEach((total, key) => {
      if (total.name.trim().toLowerCase().startsWith('utility')) {
        const existing = merged.get(UTILITY_KEY) || { name: 'Utility', debit: 0, credit: 0 };
        existing.debit += total.debit;
        existing.credit += total.credit;
        merged.set(UTILITY_KEY, existing);
      } else {
        merged.set(key, total);
      }
    });

    return [...merged.values()]
      .map(total => ({
        ...total,
        debit: Math.round(total.debit * 100) / 100,
        credit: Math.round(total.credit * 100) / 100,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  })();

  const downloadParticularTotalsExcel = async () => {
    setDownloadingParticularTotals(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Particular Totals');
      sheet.getColumn(1).width = 42;
      sheet.getColumn(2).width = 18;
      sheet.getColumn(3).width = 18;

      const title = sheet.addRow([batch?.name || 'Particular Totals', '', '']);
      sheet.mergeCells(`A${title.number}:C${title.number}`);
      title.getCell(1).font = { bold: true, size: 14 };
      title.getCell(1).alignment = { horizontal: 'center' };

      const header = sheet.addRow(['Particulars', 'Dr', 'Cr']);
      header.eachCell(cell => {
        cell.font = { bold: true };
        cell.alignment = { horizontal: 'center' };
      });

      particularTotals.forEach(total => {
        const row = sheet.addRow([total.name, total.debit || '', total.credit || '']);
        row.getCell(2).numFmt = '#,##0.00';
        row.getCell(3).numFmt = '#,##0.00';
        row.getCell(2).alignment = { horizontal: 'right' };
        row.getCell(3).alignment = { horizontal: 'right' };
      });

      const totalDebit = particularTotals.reduce((sum, total) => sum + total.debit, 0);
      const totalCredit = particularTotals.reduce((sum, total) => sum + total.credit, 0);
      const totalRow = sheet.addRow(['Total', totalDebit, totalCredit]);
      totalRow.getCell(1).font = { bold: true };
      totalRow.getCell(2).font = { bold: true };
      totalRow.getCell(3).font = { bold: true };
      totalRow.getCell(2).numFmt = '#,##0.00';
      totalRow.getCell(3).numFmt = '#,##0.00';
      totalRow.getCell(2).alignment = { horizontal: 'right' };
      totalRow.getCell(3).alignment = { horizontal: 'right' };

      for (let rowNumber = header.number; rowNumber <= totalRow.number; rowNumber++) {
        sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, cell => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
          };
        });
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeFilePart(batch?.name || 'Particular Totals')}_particular_totals.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingParticularTotals(false);
    }
  };

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
      receiptId,
      name: receiptNames[receiptId] || `Journal ${index + 1}`,
      debit,
      credit,
      difference,
    };
  // Keep this identical to the reviewer: only vouchers that visibly show
  // "Voucher out of balance" belong in the focused-fix workflow.
  }).filter(group => Math.abs(group.difference) >= 0.05);
  const imbalancedReceiptIds = imbalancedGroups
    .map(group => group.receiptId)
    .filter((receiptId): receiptId is string => receiptId !== 'default');

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

    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const batchPart = safeFilePart(batch?.name || 'Scan2Tally Batch') || 'Scan2Tally Batch';
    const fileName = `${batchPart}_${date}.xlsx`;

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

  if (showParticularTotals) {
    return (
      <div className="export-page">
      <div className="row row-between row-wrap" style={{ marginBottom: '20px' }}>
          <div className="row row-wrap">
            <button className="back-link" onClick={onBackFromParticulars ?? (() => setShowParticularTotals(false))}>
              <ArrowLeft size={16} />
              {onBackFromParticulars ? 'Back to Batches' : 'Back to Excel Preview'}
            </button>
          </div>
          <button className="btn btn-primary export-download-btn" onClick={downloadParticularTotalsExcel} disabled={downloadingParticularTotals}>
            {downloadingParticularTotals
              ? <><Loader2 size={17} className="animate-spin" /> Preparing...</>
              : <><Download size={17} /> Download Particular Totals (.xlsx)</>}
          </button>
        </div>
        <div className="card">
          <div className="row row-between" style={{ marginBottom: '16px' }}>
            <div>
              <h3 className="section-title section-title-lg" style={{ marginBottom: 0 }}>Particular Totals</h3>
              <span className="text-muted export-voucher-count">
                {particularTotals.length} {particularTotals.length === 1 ? 'particular' : 'particulars'} across {groups.length} {groups.length === 1 ? 'voucher' : 'vouchers'}
              </span>
            </div>
            <div className="export-totals">
              <div className="export-totals-row">
                <span>Total Debit: <strong className="total-debit">Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
                <span>Total Credit: <strong className="total-credit">Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></span>
              </div>
            </div>
          </div>
          <div className="table-container export-preview">
            <table className="voucher-table">
              <tbody>
                <tr>
                  <td colSpan={3} className="voucher-heading">Particular Totals</td>
                </tr>
                <tr>
                  <td className="voucher-col-head voucher-particulars">Particulars</td>
                  <td className="voucher-col-head">Dr</td>
                  <td className="voucher-col-head">Cr</td>
                </tr>
                {particularTotals.map(total => (
                  <tr key={total.name.toLocaleLowerCase()}>
                    <td>{total.name}</td>
                    <td className="voucher-amount">{formatAmt(total.debit)}</td>
                    <td className="voucher-amount">{formatAmt(total.credit)}</td>
                  </tr>
                ))}
                {particularTotals.length === 0 && (
                  <tr><td colSpan={3} className="table-empty">No named particulars found.</td></tr>
                )}
                <tr>
                  <td className="voucher-heading">Total</td>
                  <td className="voucher-amount">{formatAmt(totalDebit)}</td>
                  <td className="voucher-amount">{formatAmt(totalCredit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="export-page">
      <div className="row row-between row-wrap">
        <div className="row row-wrap">
          <button className="back-link excel-back-review-btn" onClick={onBack}>
            <ArrowLeft size={16} />
            Review & Edit
          </button>
        </div>
        <div className="row row-wrap" style={{ gap: '10px' }}>
          <button className="btn btn-teal" onClick={() => setShowParticularTotals(true)}>
            <BarChart3 size={17} /> Show Particular Totals
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
              Debit / Credit imbalance detected in {imbalancedGroups.length === 1 ? 'one receipt' : `${imbalancedGroups.length} receipts`}.
              <br />Would you like to fix the affected receipts first?
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowImbalanceWarning(false)}>
                Cancel
              </button>
              {imbalancedReceiptIds.length > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setShowImbalanceWarning(false);
                    onFixImbalanced(imbalancedReceiptIds);
                  }}
                >
                  Fix imbalanced receipts
                </button>
              )}
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
