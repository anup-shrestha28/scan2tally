import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Save, CheckCircle2, AlertTriangle, FileSpreadsheet, Plus, Trash2,
  RotateCcw, RotateCw, ChevronLeft, ChevronRight, Loader2, HelpCircle, Camera,
  Pencil, Maximize2, Minimize2,
} from 'lucide-react';
import { ScanBatch, Receipt, Transaction, User, Ledger } from '../types';
import { saveTransactionsForReceipt, getReceiptImageUrl, deleteReceipt, fetchLedgers, resolveLedgerName } from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';

/** Ties the ledger inputs to the single datalist rendered at the bottom. */
const LEDGER_OPTIONS_ID = 'chart-of-accounts';

type ReviewerNavigationItem = number | 'start-ellipsis' | 'end-ellipsis';

/** Shows nearby receipts without allowing a large batch to stretch the toolbar. */
function getReviewerNavigationItems(currentIndex: number, receiptCount: number): ReviewerNavigationItem[] {
  if (receiptCount <= 9) return Array.from({ length: receiptCount }, (_, index) => index);

  const rangeStart = Math.max(1, currentIndex - 2);
  const rangeEnd = Math.min(receiptCount - 2, currentIndex + 2);
  const items: ReviewerNavigationItem[] = [0];

  if (rangeStart > 1) items.push('start-ellipsis');
  for (let index = rangeStart; index <= rangeEnd; index += 1) items.push(index);
  if (rangeEnd < receiptCount - 2) items.push('end-ellipsis');
  items.push(receiptCount - 1);
  return items;
}

interface SideBySideReviewerProps {
  batch: ScanBatch | null;
  currentUser: User;
  selectedReceipt?: Receipt | null;
  initialTransactions?: Transaction[];
  allReceiptTransactions?: Record<string, Transaction[]>;
  onBack: () => void;
  onExportExcel: (transactions: Transaction[]) => void;
}

/**
 * Currency cell for the reviewer grid.
 *
 * Uses a text input rather than type="number" so the native spinner arrows
 * never overlap the amount. Shows an Indian-grouped, 2-decimal value while
 * idle and the raw editable number while focused.
 */
function AmountInput({
  value,
  tone,
  uncertain,
  gridColumn,
  onChange,
  onConfirm,
}: {
  value: number;
  tone: 'debit' | 'credit';
  uncertain?: boolean;
  gridColumn: string;
  onChange: (amount: number) => void;
  onConfirm: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const formatted = value
    ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

  return (
    <div className="amount-field">
      <input
        type="text"
        inputMode="decimal"
        // size=1 kills the ~20ch intrinsic width an <input> otherwise demands,
        // which would override the table's column widths.
        size={1}
        className={`cell-input amount-input amount-${tone}${uncertain ? ' amount-uncertain' : ''}`}
        data-grid-cell="true"
        data-grid-column={gridColumn}
        title={uncertain ? 'This amount may be inaccurate. Please verify it with the receipt.' : undefined}
        placeholder="0.00"
        value={draft !== null ? draft : formatted}
        onFocus={() => setDraft(value ? String(value) : '')}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (uncertain && event.key === 'Enter') {
            event.preventDefault();
            onConfirm();
          }
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, '');
          setDraft(raw);
          onChange(parseFloat(raw) || 0);
        }}
      />
      {uncertain && (
        <button
          type="button"
          className="amount-confirm"
          onClick={onConfirm}
          title="Confirm this amount against the receipt"
          aria-label="Confirm this amount"
        >
          ?
        </button>
      )}
    </div>
  );
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
  currentUser,
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
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string>('');
  const dirtyRef = useRef(false);
  const changeVersionRef = useRef(0);
  const reviewerTableRef = useRef<HTMLTableElement | null>(null);
  const pendingFocusIdRef = useRef<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [showImbalanceModal, setShowImbalanceModal] = useState(false);
  const [pendingExportData, setPendingExportData] = useState<Transaction[] | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingTransactionId, setDeletingTransactionId] = useState<string | null>(null);
  const [deletingReceipt, setDeletingReceipt] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(false);
  const [deletedReceiptIds, setDeletedReceiptIds] = useState<Set<string>>(new Set());
  // The organisation's real ledgers, so a name can be picked rather than typed
  // and so the reviewer is told when one will not survive the trip into Tally.
  const [ledgers, setLedgers] = useState<Ledger[]>([]);

  const visibleReceipts = receipts.filter(receipt => !deletedReceiptIds.has(receipt.id));
  const currentReceipt = visibleReceipts[currentIndex] || null;

  // Get transactions for the currently viewed receipt
  const getTxForReceipt = (receipt: Receipt | null): Transaction[] => {
    if (!receipt) return [blankRow()];
    if (txMap[receipt.id] && txMap[receipt.id].length > 0) return txMap[receipt.id];
    return [blankRow()];
  };

  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    getTxForReceipt(currentReceipt)
  );

  // Persist before navigating. Merely copying rows into txMap would cancel the
  // pending autosave when the receipt changes and could lose a fast edit.
  const saveCurrentTx = async (nextIndex: number) => {
    const changeVersion = changeVersionRef.current;
    if (dirtyRef.current && currentReceipt && batch && currentUser.organization_id) {
      setSaveState('saving');
      try {
        await saveTransactionsForReceipt(
          currentReceipt.id,
          { batchId: batch.id, organizationId: currentUser.organization_id, userId: currentUser.id },
          transactions
        );
        // If a keystroke landed while the request was in flight, stay put so
        // the newer value is not abandoned on the old receipt.
        if (changeVersion !== changeVersionRef.current) return;
        setSaveState('saved');
        setSaveError(null);
        window.setTimeout(() => setSaveState('idle'), 2500);
      } catch (err: any) {
        setSaveState('error');
        setSaveError(err?.message || 'Changes could not be saved.');
        return;
      }
    }
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    dirtyRef.current = false;
    setCurrentIndex(nextIndex);
    setRotation(0);
  };

  // When currentIndex changes, load that receipt's transactions
  useEffect(() => {
    setTransactions(getTxForReceipt(visibleReceipts[currentIndex] || null));
  }, [currentIndex, deletedReceiptIds]);

  // When allReceiptTransactions changes (fresh extraction), merge in
  useEffect(() => {
    setTxMap(prev => ({ ...prev, ...allReceiptTransactions }));
  }, [allReceiptTransactions]);

  /**
   * Auto-save.
   *
   * Every edit is written back roughly a second after typing stops, so closing
   * the tab cannot lose corrections. The timer restarts on each keystroke, which
   * keeps a burst of typing to a single write.
   *
   * The first render is skipped deliberately: it would otherwise re-save rows
   * that were only just loaded, and would write a blank placeholder row over a
   * receipt that has not been extracted yet.
   */
  const AUTOSAVE_DELAY_MS = 1000;
  useEffect(() => {
    if (!dirtyRef.current) return;
    if (!currentReceipt || !batch || !currentUser.organization_id) return;
    // A single empty row is the placeholder shown for an unextracted receipt,
    // not user work; saving it would create a phantom voucher line.
    const isJustBlankPlaceholder =
      transactions.length === 1 &&
      !transactions[0].ledger_name &&
      !transactions[0].debit_amount &&
      !transactions[0].credit_amount;
    if (isJustBlankPlaceholder) return;

    const receiptId = currentReceipt.id;
    const rows = transactions;
    const changeVersion = changeVersionRef.current;
    const timer = setTimeout(() => {
      setSaveState('saving');
      saveTransactionsForReceipt(
        receiptId,
        { batchId: batch.id, organizationId: currentUser.organization_id!, userId: currentUser.id },
        rows
      )
        .then(() => {
          if (changeVersion === changeVersionRef.current) {
            dirtyRef.current = false;
            setSaveState('saved');
            setSaveError(null);
            window.setTimeout(() => setSaveState('idle'), 2500);
          }
        })
        .catch((err: any) => {
          setSaveState('error');
          setSaveError(err?.message || 'Changes could not be saved.');
        });
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [transactions, currentReceipt?.id, batch?.id]);

  // Resolve a signed URL for the stored image; blob URLs from this session are
  // used as-is, and only the storage path survives a refresh.
  useEffect(() => {
    let cancelled = false;
    if (!currentReceipt) { setImageUrl(''); return; }
    if (currentReceipt.previewUrl) { setImageUrl(currentReceipt.previewUrl); return; }
    if (!currentReceipt.storage_path) { setImageUrl(''); return; }

    getReceiptImageUrl(currentReceipt.storage_path)
      .then(url => { if (!cancelled) setImageUrl(url); })
      .catch(() => { if (!cancelled) setImageUrl(''); });

    return () => { cancelled = true; };
  }, [currentReceipt?.id, currentReceipt?.previewUrl, currentReceipt?.storage_path]);

  // An empty chart of accounts is a normal state, not an error: matching simply
  // does not apply, and every row stays 'Unchecked'. With the feature off the
  // ledgers table may not exist at all, so it is not asked for.
  useEffect(() => {
    if (!LEDGER_MATCHING) return;
    let cancelled = false;
    fetchLedgers()
      .then(list => { if (!cancelled) setLedgers(list); })
      .catch(() => { /* the reviewer still works as a plain text field */ });
    return () => { cancelled = true; };
  }, []);

  const ledgerById = (id?: string | null) => ledgers.find(l => l.id === id);

  const rotateLeft = () => setRotation(r => r - 90);
  const rotateRight = () => setRotation(r => r + 90);

  const handleUpdateTransaction = (id: string, field: keyof Transaction, value: any) => {
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(transactions.map(t => {
      if (t.id === id) {
        const updated = { ...t, [field]: value };
        if (field === 'ledger_name') {
          if (updated.entry_type === 'Dr') updated.debit_ledger = value;
          else updated.credit_ledger = value;
          // Re-check against the chart of accounts on every keystroke: whatever
          // the server decided applied to the name it extracted, and this is no
          // longer that name. Leaving the old verdict attached would show a
          // confident tick beside something nobody has checked.
          const resolved = resolveLedgerName(value, ledgers);
          updated.ledger_id = resolved.ledger_id;
          updated.ledger_match = resolved.ledger_match;
          updated.ledger_match_score = null;
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

  /**
   * Takes the server's suggestion for a row.
   *
   * The suggestion was deliberately never applied on its own: extraction can see
   * that a handwritten name is close to a real ledger, but "close" is not a
   * reason to post money somewhere nobody chose. This is that decision being
   * made by a person, which is the only thing that makes it safe.
   */
  const acceptLedgerSuggestion = (tx: Transaction) => {
    const suggested = ledgerById(tx.ledger_id);
    if (suggested) handleUpdateTransaction(tx.id, 'ledger_name', suggested.name);
  };

  const handleAddTransaction = (entryType: 'Dr' | 'Cr' = 'Dr') => {
    dirtyRef.current = true;
    changeVersionRef.current += 1;
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
    pendingFocusIdRef.current = newTx.id;
    setTransactions([...transactions, newTx]);
  };

  useEffect(() => {
    const pendingId = pendingFocusIdRef.current;
    if (!pendingId) return;
    const input = reviewerTableRef.current?.querySelector<HTMLInputElement>(
      `[data-transaction-id="${pendingId}"]`
    );
    if (input) {
      input.focus();
      pendingFocusIdRef.current = null;
    }
  }, [transactions.length]);

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.gridCell !== 'true') return;

    if (event.key === 'Tab') {
      const cells = Array.from(
        event.currentTarget.querySelectorAll<HTMLInputElement>('[data-grid-cell="true"]')
      );
      const current = cells.indexOf(target);
      if (current < 0 || !cells.length) return;
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      cells[(current + direction + cells.length) % cells.length].focus();
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const column = target.dataset.gridColumn;
      if (!column) return;
      const cells = Array.from(
        event.currentTarget.querySelectorAll<HTMLInputElement>(`[data-grid-column="${column}"]`)
      );
      const current = cells.indexOf(target);
      const next = current + (event.key === 'ArrowUp' ? -1 : 1);
      if (current < 0 || next < 0 || next >= cells.length) return;
      event.preventDefault();
      cells[next].focus();
    }
  };

  const handleDeleteTransaction = (id: string) => {
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(transactions.filter(t => t.id !== id));
  };

  const handleSaveProgress = async () => {
    if (!dirtyRef.current) return;
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    // Writes through rather than only confirming: this button previously
    // reported success while nothing left the browser.
    if (currentReceipt && batch && currentUser.organization_id) {
      setSaveState('saving');
      try {
        await saveTransactionsForReceipt(
          currentReceipt.id,
          { batchId: batch.id, organizationId: currentUser.organization_id, userId: currentUser.id },
          transactions
        );
        setSaveState('saved');
        setSaveError(null);
        dirtyRef.current = false;
        window.setTimeout(() => setSaveState('idle'), 2500);
      } catch (err: any) {
        setSaveState('error');
        setSaveError(err?.message || 'Changes could not be saved.');
        return;
      }
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleBack = () => {
    onBack();
  };

  const handleDeleteCurrentReceipt = async () => {
    if (!currentReceipt) return;
    setDeletingReceipt(true);
    try {
      const remainingReceipts = visibleReceipts.filter(receipt => receipt.id !== currentReceipt.id);
      await deleteReceipt(currentReceipt.id);
      setDeletedReceiptIds(prev => new Set([...prev, currentReceipt.id]));
      setTxMap(prev => {
        const next = { ...prev };
        delete next[currentReceipt.id];
        return next;
      });
      setShowDeleteModal(false);
      if (remainingReceipts.length === 0) {
        onBack();
      } else {
        setCurrentIndex(index => Math.min(index, remainingReceipts.length - 1));
      }
    } catch (err: any) {
      setSaveError(err?.message || 'Could not delete this receipt.');
    } finally {
      setDeletingReceipt(false);
    }
  };

  // Export collects all receipts' transactions merged
  const handleExportAll = () => {
    const saved = currentReceipt ? { ...txMap, [currentReceipt.id]: transactions } : txMap;
    const all = visibleReceipts.flatMap(r => (saved[r.id] || []).map(t => ({ ...t, receipt_id: r.id })));
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
  const balanceDifference = Math.round((totalDebit - totalCredit) * 100) / 100;
  const isBalanced = Math.abs(balanceDifference) < 0.05;
  const formattedDifference = `${balanceDifference > 0 ? '+' : balanceDifference < 0 ? '−' : ''}Rs. ${Math.abs(balanceDifference).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const currentReceiptIsLowResolution = Boolean(
    currentReceipt?.image_width && currentReceipt?.image_height &&
    Math.min(currentReceipt.image_width, currentReceipt.image_height) < 1000
  );

  // Rows whose ledger Tally would not recognise. Only meaningful once the
  // organisation actually has a chart of accounts to be measured against.
  const unresolvedLedgers = ledgers.length
    ? transactions.filter(t => t.ledger_match === 'Unmatched' || t.ledger_match === 'Suggested').length
    : 0;

  // Narration is shared across all rows in a receipt
  const narration = transactions[0]?.narration || 'Being Expenses paid via cheque no.';

  const handleUpdateNarration = (value: string) => {
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(prev => prev.map(t => ({ ...t, narration: value })));
  };

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < visibleReceipts.length - 1;

  // Alt+arrow follows the documented receipt-navigation model and avoids
  // stealing plain arrow keys from table cells and assistive technology.
  useEffect(() => {
    const handlePaginationKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      if (showDeleteModal || showImbalanceModal || deletingTransactionId) return;

      const nextIndex = event.key === 'ArrowLeft'
        ? (hasPrev ? currentIndex - 1 : null)
        : (hasNext ? currentIndex + 1 : null);
      if (nextIndex === null) return;

      event.preventDefault();
      void saveCurrentTx(nextIndex);
    };

    window.addEventListener('keydown', handlePaginationKey);
    return () => window.removeEventListener('keydown', handlePaginationKey);
  }, [currentIndex, hasPrev, hasNext, showDeleteModal, showImbalanceModal, deletingTransactionId, transactions, currentReceipt?.id]);

  // The high-value shortcuts do not require a new persistence model. They use
  // the same add/save paths as the visible controls, so keyboard and mouse
  // behavior cannot drift apart.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (showDeleteModal || showImbalanceModal || deletingTransactionId) return;
      const key = event.key.toLowerCase();
      if (key === 'd' || key === 'k') {
        event.preventDefault();
        handleAddTransaction(key === 'd' ? 'Dr' : 'Cr');
      } else if (key === 's') {
        event.preventDefault();
        handleSaveProgress();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [transactions, currentReceipt?.id, batch?.id, showDeleteModal, showImbalanceModal, deletingTransactionId]);

  const stepClass = (active: boolean) => `nav-step${active ? ' nav-step-active' : ''}`;

  return (
    <div className="reviewer-page">
      <div className="reviewer-header">
        <div className="reviewer-toolbar">
          <div className="reviewer-identity">
            <button className="btn btn-secondary" onClick={handleBack}>
              <ArrowLeft size={16} /> Batches
            </button>
            <div>
              <h1 className="reviewer-title">{batch?.name || 'Scan Batch Review'}</h1>
              <p className="reviewer-file">{currentReceipt?.filename || 'No receipt selected'}</p>
            </div>
          </div>

          <div className="reviewer-actions">
          {/* Reflects what has actually reached the database, so "Saved" is
              never claimed for work that only exists in the browser. */}
          {saveState === 'saving' && (
            <span className="save-state save-state-busy">
              <Loader2 size={15} className="animate-spin" /> Saving…
            </span>
          )}
          {saveState === 'saved' && !savedSuccess && (
            <span className="save-state save-state-ok">
              <CheckCircle2 size={16} /> Saved
            </span>
          )}
          {saveState === 'error' && (
            <span className="save-state save-state-error" title={saveError || undefined}>
              <AlertTriangle size={16} /> Not saved
            </span>
          )}
          {savedSuccess && (
            <span className="save-state save-state-ok">
              <CheckCircle2 size={16} /> Saved!
            </span>
          )}
          <button className="btn btn-secondary" onClick={handleSaveProgress} disabled={saveState === 'saving'}>
            <Save size={16} /> Save now
          </button>
          <button className="btn btn-primary" onClick={handleExportAll}>
            <FileSpreadsheet size={16} /> Review Excel file
          </button>
        </div>
        </div>

        <div className="reviewer-nav">
          <button
            className={stepClass(hasPrev)}
            disabled={!hasPrev}
            onClick={() => { if (hasPrev) void saveCurrentTx(currentIndex - 1); }}
          >
            <ChevronLeft size={16} /> Prev
          </button>

          <div className="reviewer-nav-center">
            <nav className="receipt-pagination" aria-label="Choose a receipt">
              {getReviewerNavigationItems(currentIndex, visibleReceipts.length).map(item => {
                if (typeof item !== 'number') {
                  return <span className="receipt-pagination-ellipsis" key={item} aria-hidden="true">…</span>;
                }

                const receipt = visibleReceipts[item];
                const rows = item === currentIndex
                  ? transactions
                  : (txMap[receipt.id] || []);
                const debit = rows.reduce((sum, row) => sum + (Number(row.debit_amount) || 0), 0);
                const credit = rows.reduce((sum, row) => sum + (Number(row.credit_amount) || 0), 0);
                const unbalanced = rows.length > 0 && Math.abs(debit - credit) >= 0.05;
                return (
                  <button
                    key={receipt.id}
                    title={`${receipt.filename}${unbalanced ? ' — out of balance' : ''}`}
                    aria-label={`Receipt ${item + 1}: ${receipt.filename}${unbalanced ? ', out of balance' : ''}`}
                    aria-current={item === currentIndex ? 'page' : undefined}
                    className={`receipt-dot${item === currentIndex ? ' receipt-dot-active' : ''}${unbalanced ? ' receipt-dot-warning' : ''}`}
                    onClick={() => { if (item !== currentIndex) void saveCurrentTx(item); }}
                  >
                    {item + 1}{unbalanced ? ' !' : ''}
                  </button>
                );
              })}
            </nav>

            <div className="reviewer-count" aria-live="polite">
              Receipt {currentIndex + 1} of {visibleReceipts.length}
              <span className="kbd-hint">Alt+← / Alt+→</span>
            </div>
          </div>

          <button
            className={stepClass(hasNext)}
            disabled={!hasNext}
            onClick={() => { if (hasNext) void saveCurrentTx(currentIndex + 1); }}
          >
            Next <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Split Reviewer Workspace */}
      <div className="split-reviewer">
        {/* Left Panel: Original Receipt Image */}
        <div className={`image-panel${imageExpanded ? ' image-panel-expanded' : ''}`}>
          <div className="panel-head">
            <div className="panel-head-title">
              <Camera size={15} />
              <span>{currentReceipt?.filename || 'Handwritten voucher'}</span>
              {currentReceiptIsLowResolution && (
                <span className="image-quality-warning">
                  Low res {Math.min(currentReceipt!.image_width!, currentReceipt!.image_height!)}px
                </span>
              )}
            </div>
            <div className="row-xs">
              <button
                className="btn btn-danger btn-sm btn-icon"
                onClick={() => setShowDeleteModal(true)}
                title="Delete this receipt"
                disabled={deletingReceipt}
              >
                <Trash2 size={14} />
              </button>
              <button className="btn btn-secondary btn-sm btn-icon" onClick={rotateLeft} title="Rotate left">
                <RotateCcw size={14} />
              </button>
              <button className="btn btn-secondary btn-sm btn-icon" onClick={rotateRight} title="Rotate right">
                <RotateCw size={14} />
              </button>
              <button
                className="btn btn-secondary btn-sm btn-icon image-expand-toggle"
                onClick={() => setImageExpanded(value => !value)}
                title={imageExpanded ? 'Collapse image' : 'Expand image'}
              >
                {imageExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </div>

          <div className="image-viewer image-viewer-fixed">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Uploaded Handwritten Bill Receipt"
                className="receipt-img receipt-img-rotatable"
                style={{ transform: `rotate(${rotation}deg)` }}
              />
            ) : (
              <div className="text-muted text-center">No Receipt Image Selected</div>
            )}
          </div>
        </div>

        {/* Right Panel: Extracted Transaction Editor */}
        <div className={`data-panel${isBalanced ? '' : ' data-panel-unbalanced'}`}>
          <div className="panel-head">
            <div className="panel-head-title">
              <Pencil size={15} />
              <span>Voucher entries</span>
              <span className="panel-head-meta">
                {transactions.length} {transactions.length === 1 ? 'ledger line' : 'ledger lines'}
              </span>
              {unresolvedLedgers > 0 && (
                <span
                  className="ledger-count-pill"
                  title="Tally creates a new account for any ledger name it does not already have"
                >
                  {unresolvedLedgers} unresolved {unresolvedLedgers === 1 ? 'ledger' : 'ledgers'}
                </span>
              )}
            </div>
          </div>

          <div className="reviewer-body">
            <div className="voucher-meta">
              <div><span>Date</span><strong>{transactions[0]?.voucher_date || '—'}</strong></div>
              <div><span>Voucher no.</span><strong>{(transactions[0] as any)?.voucher_no || '—'}</strong></div>
            </div>
            {!isBalanced && (
              <div className="balance-banner" role="alert">
                <AlertTriangle size={17} />
                <div>
                  <strong>Out of balance by {formattedDifference}</strong>
                  <span>Debits Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })} · Credits Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. Review the voucher before exporting.</span>
                </div>
              </div>
            )}
            <div className="table-container">
              <table className="custom-table tx-table" ref={reviewerTableRef} onKeyDown={handleGridKeyDown}>
                <thead>
                  <tr>
                    <th className="tx-col-flag" aria-label="Flags"></th>
                    <th className="tx-col-type">Type</th>
                    <th>Particulars</th>
                    <th className="tx-col-amount">Debit (Rs.)</th>
                    <th className="tx-col-amount">Credit (Rs.)</th>
                    <th className="tx-col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr
                      key={tx.id}
                      className={
                        `${tx.entry_type === 'Dr' ? 'tx-row-debit' : 'tx-row-credit'}` +
                        `${tx.needs_review ? ' row-needs-review' : ''}`
                      }
                    >
                      <td className="tx-col-flag flag-gutter">
                        {tx.needs_review ? (
                          <span className="flag-uncertain" title="Low-confidence amount">▲</span>
                        ) : tx.ledger_match === 'Unmatched' || tx.ledger_match === 'Suggested' ? (
                          <span className="flag-unknown-ledger" title="Ledger is not confirmed in the chart of accounts">!</span>
                        ) : null}
                      </td>
                      <td>
                        <span className={tx.entry_type === 'Dr' ? 'dr-badge' : 'cr-badge'}>
                          {tx.entry_type}
                        </span>
                      </td>
                      <td className="tx-particulars">
                        <input
                          type="text"
                          size={1}
                          // Native picker rather than a bespoke dropdown: it
                          // filters as you type, works on touch, and needs no
                          // code that a redesign would have to throw away.
                          list={ledgers.length ? LEDGER_OPTIONS_ID : undefined}
                          className={`cell-input${tx.entry_type === 'Dr' ? ' cell-input-debit' : ''}`}
                          data-grid-cell="true"
                          data-grid-column="particulars"
                          data-transaction-id={tx.id}
                          value={tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                          title={tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'ledger_name', e.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && tx.ledger_match === 'Suggested' && ledgerById(tx.ledger_id)) {
                              event.preventDefault();
                              acceptLedgerSuggestion(tx);
                            }
                          }}
                        />

                        {/* Nothing is said when there is no chart of accounts to
                            check against — a flag on every row of every voucher
                            teaches people to ignore flags. */}
                        {tx.ledger_match === 'Suggested' && ledgerById(tx.ledger_id) && (
                          <button
                            type="button"
                            className="ledger-hint ledger-hint-suggest"
                            onClick={() => acceptLedgerSuggestion(tx)}
                            title="Use this ledger instead of the name written on the voucher"
                          >
                            <HelpCircle size={11} />
                            <span>Did you mean <strong>{ledgerById(tx.ledger_id)!.name}</strong>?</span>
                          </button>
                        )}
                        {tx.ledger_match === 'Unmatched' && (
                          <div
                            className="ledger-hint ledger-hint-missing ledger-not-in-chart"
                            title="Tally will create a new account under this name on import"
                          >
                            <AlertTriangle size={11} />
                            <span>Not in your chart of accounts</span>
                          </div>
                        )}
                      </td>
                      <td>
                        {tx.entry_type === 'Dr' ? (
                          <AmountInput
                            tone="debit"
                            gridColumn="amount"
                            uncertain={tx.needs_review}
                            value={tx.debit_amount || 0}
                            onChange={(amount) => handleUpdateTransaction(tx.id, 'debit_amount', amount)}
                            onConfirm={() => handleUpdateTransaction(tx.id, 'needs_review', false)}
                          />
                        ) : (
                          <span className="amount-empty">—</span>
                        )}
                      </td>
                      <td>
                        {tx.entry_type === 'Cr' ? (
                          <AmountInput
                            tone="credit"
                            gridColumn="amount"
                            uncertain={tx.needs_review}
                            value={tx.credit_amount || 0}
                            onChange={(amount) => handleUpdateTransaction(tx.id, 'credit_amount', amount)}
                            onConfirm={() => handleUpdateTransaction(tx.id, 'needs_review', false)}
                          />
                        ) : (
                          <span className="amount-empty">—</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn btn-danger btn-sm btn-icon"
                          onClick={() => setDeletingTransactionId(tx.id)}
                          title="Delete Row"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="tx-totals-row">
                    <td></td>
                    <td colSpan={2}>Totals</td>
                    <td className="tx-total-amount">{totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    <td className={`tx-total-amount${isBalanced ? '' : ' tx-total-offending'}`}>{totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {isBalanced && (
              <div className="balance-strip">
                <CheckCircle2 size={15} /> Balanced · difference Rs. 0.00
              </div>
            )}

            <div className="reviewer-table-actions">
              <div className="row-sm">
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Dr')}>
                  <Plus size={14} /> Add debit line <span className="kbd-hint">⌘D</span>
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Cr')}>
                  <Plus size={14} /> Add credit line <span className="kbd-hint">⌘K</span>
                </button>
              </div>
              {!isBalanced && <strong className="balance-difference">Difference {formattedDifference}</strong>}
            </div>

            {/* Narration */}
            <div className="narration-row">
              <label className="narration-label">Narration:</label>
              <input
                type="text"
                className="form-input narration-input"
                value={narration}
                onChange={(e) => handleUpdateNarration(e.target.value)}
                placeholder="Being Expenses paid via cheque no."
              />
            </div>
          </div>
        </div>
      </div>

      {/* One list shared by every ledger input on the page. */}
      {ledgers.length > 0 && (
        <datalist id={LEDGER_OPTIONS_ID}>
          {ledgers.map(ledger => (
            <option key={ledger.id} value={ledger.name}>
              {ledger.parent_group || ''}
            </option>
          ))}
        </datalist>
      )}

      {showImbalanceModal && (
        <div className="modal-overlay modal-overlay-top">
          <div className="modal modal-prompt">
            <div className="modal-head modal-head-warning">
              <AlertTriangle size={24} />
              <h3 className="modal-title">Imbalance Detected</h3>
            </div>
            <p className="modal-text">
              Debit / Credit Imbalance Detected in one or more receipts. Are you sure you want to continue with the export?
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={cancelExport}>
                Cancel
              </button>
              <button className="btn btn-warning" onClick={confirmExport}>
                Proceed to Export
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingTransactionId && (
        <div className="modal-overlay modal-overlay-top">
          <div className="modal modal-confirm">
            <div className="modal-icon modal-icon-danger">
              <Trash2 size={24} />
            </div>
            <h3 className="modal-title">Delete voucher line?</h3>
            <p className="modal-text">
              This removes the ledger and amount from this receipt. The change is saved with the rest of the voucher.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeletingTransactionId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-danger-solid"
                onClick={() => {
                  handleDeleteTransaction(deletingTransactionId);
                  setDeletingTransactionId(null);
                }}
              >
                <Trash2 size={15} /> Delete line
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && currentReceipt && (
        <div className="modal-overlay modal-overlay-top">
          <div className="modal modal-prompt">
            <div className="modal-head modal-head-danger">
              <Trash2 size={22} />
              <h3 className="modal-title">Delete receipt?</h3>
            </div>
            <p className="modal-text">
              This will permanently delete <strong>{currentReceipt.filename}</strong> and its extracted data. This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowDeleteModal(false)} disabled={deletingReceipt}>
                Cancel
              </button>
              <button className="btn btn-danger btn-danger-solid" onClick={handleDeleteCurrentReceipt} disabled={deletingReceipt}>
                {deletingReceipt ? <><Loader2 size={15} className="animate-spin" /> Deleting...</> : <><Trash2 size={15} /> Delete Receipt</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
