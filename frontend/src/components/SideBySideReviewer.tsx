import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Save, CheckCircle2, AlertTriangle, FileSpreadsheet, Plus, Trash2, RotateCcw, RotateCw, ZoomIn, ChevronLeft, ChevronRight, Loader2, HelpCircle, FileSignature, Scale } from 'lucide-react';
import { ScanBatch, Receipt, Transaction, User, Ledger } from '../types';
import { saveTransactionsForReceipt, getReceiptImageUrl, deleteReceipt, fetchLedgers, resolveLedgerName } from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';
import { duplicateVoucherGroups, sortReceiptsByVoucherNo } from '../lib/receiptOrder';
import { findImbalanceSuspects, describeMisread, ImbalanceSuspect } from '../lib/imbalance';

/** Ties the ledger inputs to the single datalist rendered at the bottom. */
const LEDGER_OPTIONS_ID = 'chart-of-accounts';
type ReceiptPageItem = number | 'start-ellipsis' | 'end-ellipsis';

interface TransactionHistoryEntry {
  receiptId: string;
  before: Transaction[];
  after: Transaction[];
}

const RECEIPT_ROTATIONS_STORAGE_KEY = 'scan2tally.receipt-rotations';

function loadReceiptRotations(): Record<string, number> {
  try {
    const stored = window.localStorage.getItem(RECEIPT_ROTATIONS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveReceiptRotation(receiptId: string, rotation: number): void {
  try {
    const rotations = loadReceiptRotations();
    rotations[receiptId] = ((rotation % 360) + 360) % 360;
    window.localStorage.setItem(RECEIPT_ROTATIONS_STORAGE_KEY, JSON.stringify(rotations));
  } catch {
    // Image rotation remains available for the current session if storage is blocked.
  }
}

function getReceiptPageItems(currentPage: number, pageCount: number): ReceiptPageItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'end-ellipsis', pageCount];
  if (currentPage >= pageCount - 3) {
    return [1, 'start-ellipsis', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }
  return [1, 'start-ellipsis', currentPage - 1, currentPage, currentPage + 1, 'end-ellipsis', pageCount];
}

interface SideBySideReviewerProps {
  batch: ScanBatch | null;
  currentUser: User;
  selectedReceipt?: Receipt | null;
  initialReceiptIndex?: number;
  initialTransactions?: Transaction[];
  allReceiptTransactions?: Record<string, Transaction[]>;
  reviewOnlyImbalanced?: boolean;
  focusedImbalancedReceiptIds?: string[];
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
  suspect,
  onChange,
  onEnter
}: {
  value: number;
  tone: 'debit' | 'credit';
  /** The extraction's own passes disagreed on this cell. */
  uncertain?: boolean;
  /** This amount is the one that would explain the voucher not balancing. */
  suspect?: boolean;
  onChange: (amount: number) => void;
  onEnter?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const formatted = value
    ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

  return (
    <input
      type="text"
      inputMode="decimal"
      // size=1 kills the ~20ch intrinsic width an <input> otherwise demands,
      // which would override the table's column widths.
      size={1}
      className={
        `cell-input amount-input amount-${tone}` +
        `${uncertain ? ' amount-uncertain' : ''}` +
        `${suspect ? ' amount-suspect' : ''}`
      }
      title={
        suspect
          ? 'This is the amount that would explain the voucher not balancing. Check it against the image.'
          : uncertain
            ? 'This amount may be inaccurate. Please verify it with the receipt.'
            : undefined
      }
      placeholder="0.00"
      value={draft !== null ? draft : formatted}
      onFocus={() => setDraft(value ? String(value) : '')}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.]/g, '');
        setDraft(raw);
        onChange(parseFloat(raw) || 0);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.currentTarget.blur();
        onEnter?.();
      }}
    />
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
  initialReceiptIndex,
  initialTransactions,
  allReceiptTransactions = {},
  reviewOnlyImbalanced = false,
  focusedImbalancedReceiptIds = [],
  onBack,
  onExportExcel
}: SideBySideReviewerProps) {
  const receipts = batch?.receipts || [];

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
  const [imageLoading, setImageLoading] = useState(false);
  const imageRetryReceiptIdRef = useRef<string | null>(null);
  const preloadedImagesRef = useRef<Map<string, Promise<string>>>(new Map());
  const dirtyRef = useRef(false);
  const changeVersionRef = useRef(0);
  // Transaction saves replace all rows. Serialize them so a later undo cannot
  // be overwritten by an earlier delete save that finishes out of order.
  const transactionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showImbalanceModal, setShowImbalanceModal] = useState(false);
  const [pendingExportData, setPendingExportData] = useState<Transaction[] | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [duplicateWarningDismissed, setDuplicateWarningDismissed] = useState(false);
  const [deletingReceipt, setDeletingReceipt] = useState(false);
  const [deletedReceiptIds, setDeletedReceiptIds] = useState<Set<string>>(new Set());
  const undoStacksRef = useRef<Record<string, TransactionHistoryEntry[]>>({});
  const redoStacksRef = useRef<Record<string, TransactionHistoryEntry[]>>({});
  const [, setHistoryVersion] = useState(0);
  // Set when the user chooses the fix option from this reviewer's own
  // imbalance dialog. The exporter path supplies the same list through App.
  const [localFocusedReceiptIds, setLocalFocusedReceiptIds] = useState<string[] | null>(null);
  // The organisation's real ledgers, so a name can be picked rather than typed
  // and so the reviewer is told when one will not survive the trip into Tally.
  const [ledgers, setLedgers] = useState<Ledger[]>([]);

  const allVisibleReceipts = sortReceiptsByVoucherNo(
    receipts.filter(receipt => !deletedReceiptIds.has(receipt.id)),
    txMap,
  );
  const duplicateVoucherWarnings = duplicateVoucherGroups(allVisibleReceipts, txMap);
  const rowsForReceipt = (receiptId: string): Transaction[] => {
    return txMap[receiptId] || allReceiptTransactions[receiptId] ||
      (receiptId === selectedReceipt?.id ? initialTransactions || [] : []);
  };
  const focusedReceiptIds = reviewOnlyImbalanced
    ? focusedImbalancedReceiptIds
    : (localFocusedReceiptIds || []);
  const isFocusedMode = reviewOnlyImbalanced || localFocusedReceiptIds !== null;
  const visibleReceipts = !isFocusedMode
    ? allVisibleReceipts
    : focusedReceiptIds.length > 0
      // The focused set is decided once, when the reviewer chooses to fix the
      // imbalance, and then held. Re-deriving it every render would drop the
      // very voucher the user was sent here to fix: the open grid can hold
      // edits txMap has not been given yet, so the recomputation can find it
      // balanced (or find no rows at all) and filter it away, leaving an empty
      // receipt list and a blank image panel. Holding the set also keeps a
      // voucher on screen after it has just been balanced, instead of making
      // it disappear from under the person who balanced it.
      ? allVisibleReceipts.filter(receipt => focusedReceiptIds.includes(receipt.id))
      : allVisibleReceipts.filter(receipt => {
          const rows = rowsForReceipt(receipt.id);
          const debit = rows.reduce((sum, row) => sum + (Number(row.debit_amount) || 0), 0);
          const credit = rows.reduce((sum, row) => sum + (Number(row.credit_amount) || 0), 0);
          return rows.length > 0 && Math.abs(debit - credit) >= 0.05;
        });

  // Find the starting index inside the currently visible set. In focused mode
  // this prevents the image panel from opening on a non-imbalanced receipt.
  const startIndex = initialReceiptIndex ?? (selectedReceipt
    ? visibleReceipts.findIndex(r => r.id === selectedReceipt.id)
    : 0);

  const [currentIndex, setCurrentIndex] = useState(Math.max(0, startIndex));
  const currentReceipt = visibleReceipts[currentIndex] || null;
  // Voucher-number edits can reorder visibleReceipts while the reviewer is
  // open. Keep the page identity separate from its numeric position so page 2
  // does not suddenly show another receipt with the edited receipt's fields.
  const currentReceiptIdRef = useRef<string | null>(currentReceipt?.id || null);
  const visibleReceiptSignature = visibleReceipts.map(receipt => receipt.id).join(',');

  const preloadReceipt = (receipt: Receipt): Promise<string> => {
    const existing = preloadedImagesRef.current.get(receipt.id);
    if (existing) return existing;

    const urlPromise = (receipt.previewUrl
      ? Promise.resolve(receipt.previewUrl)
      : receipt.storage_path
        ? getReceiptImageUrl(receipt.storage_path)
        : Promise.resolve('')
    ).then(url => new Promise<string>((resolve, reject) => {
      if (!url) {
        reject(new Error('Receipt image path is missing.'));
        return;
      }
      const image = new window.Image();
      image.onload = () => resolve(url);
      image.onerror = () => reject(new Error('Receipt image could not be loaded.'));
      image.src = url;
    }));

    preloadedImagesRef.current.set(receipt.id, urlPromise);
    urlPromise.catch(() => preloadedImagesRef.current.delete(receipt.id));
    return urlPromise;
  };

  // Get transactions for the currently viewed receipt
  const getTxForReceipt = (receipt: Receipt | null): Transaction[] => {
    if (!receipt) return [blankRow()];
    if (txMap[receipt.id] && txMap[receipt.id].length > 0) return txMap[receipt.id];
    return [blankRow()];
  };

  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    getTxForReceipt(currentReceipt)
  );

  const applyTransactionHistory = (direction: 'undo' | 'redo'): boolean => {
    if (!currentReceipt) return false;
    const sourceHistory = direction === 'undo' ? undoStacksRef.current : redoStacksRef.current;
    const source = sourceHistory[currentReceipt.id] || [];
    const entry = source[source.length - 1];
    if (!entry) return false;

    source.pop();
    const destinationHistory = direction === 'undo' ? redoStacksRef.current : undoStacksRef.current;
    const destination = destinationHistory[currentReceipt.id] || [];
    destination.push(entry);
    sourceHistory[currentReceipt.id] = source;
    destinationHistory[currentReceipt.id] = destination;
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    const restoredRows = direction === 'undo' ? entry.before : entry.after;
    // AmountInput keeps an unformatted draft while focused. Blur it before
    // restoring a snapshot so the restored amount is shown immediately.
    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement?.matches('input, textarea, select, [contenteditable="true"]')) {
      activeElement.blur();
    }
    setTransactions(restoredRows);
    setHistoryVersion(version => version + 1);

    // The delete autosave may already have removed the row from Supabase. Put
    // the snapshot back immediately instead of waiting for the next debounce.
    if (batch && currentUser.organization_id) {
      setSaveState('saving');
      queueTransactionSave(
        currentReceipt.id,
        { batchId: batch.id, organizationId: currentUser.organization_id, userId: currentUser.id },
        restoredRows
      )
        .then(() => {
          setSaveState('saved');
          setSaveError(null);
          window.setTimeout(() => setSaveState('idle'), 2500);
        })
        .catch((err: any) => {
          setSaveState('error');
          setSaveError(err?.message || 'Undo could not be saved.');
        });
    }
    return true;
  };

  // A single empty row is the placeholder shown for an unextracted receipt, not
  // user work; saving it would create a phantom voucher line.
  const isBlankPlaceholder = (rows: Transaction[]) =>
    rows.length === 1 &&
    !rows[0].ledger_name &&
    !rows[0].debit_amount &&
    !rows[0].credit_amount;

  // Save current transactions into the map before navigating
  const saveCurrentTx = (nextIndex: number) => {
    // Send the edits to the database before the receipt swaps out, or the
    // autosave effect's cleanup cancels them and only the in-memory map keeps
    // them — right up until the next reload. Not awaited: stepping between
    // vouchers should stay instant, and the write is serialized behind the
    // save queue either way.
    void flushPendingSave();
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    currentReceiptIdRef.current = visibleReceipts[nextIndex]?.id || null;
    dirtyRef.current = false;
    setCurrentIndex(nextIndex);
    setZoom(1);
  };

  useEffect(() => {
    const handleReceiptArrow = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft' && currentIndex > 0) {
        event.preventDefault();
        saveCurrentTx(currentIndex - 1);
      } else if (event.key === 'ArrowRight' && currentIndex < visibleReceipts.length - 1) {
        event.preventDefault();
        saveCurrentTx(currentIndex + 1);
      }
    };
    window.addEventListener('keydown', handleReceiptArrow);
    return () => window.removeEventListener('keydown', handleReceiptArrow);
  }, [currentIndex, visibleReceipts.length, currentReceipt?.id, transactions]);

  // Keep row deletion undo separate from the browser's text-edit undo. This
  // lets Ctrl/Cmd+Z restore a deleted Dr/Cr row even when the last focus was
  // inside one of the voucher inputs.
  useEffect(() => {
    const handleTransactionHistory = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;

      // Use the physical Z key so this works consistently across keyboard
      // layouts: Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z redoes.
      const isZ = event.code === 'KeyZ' || event.key.toLowerCase() === 'z';
      const isUndo = isZ && !event.shiftKey;
      const isRedo = isZ && event.shiftKey;
      if (!isUndo && !isRedo || !currentReceipt) return;

      if (!applyTransactionHistory(isUndo ? 'undo' : 'redo')) return;
      event.preventDefault();
    };

    // Capture before the focused input/browser default undo handler runs.
    document.addEventListener('keydown', handleTransactionHistory, true);
    const handleNativeUndo = (event: InputEvent) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
      if (!applyTransactionHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo')) return;
      event.preventDefault();
    };
    document.addEventListener('beforeinput', handleNativeUndo, true);
    return () => {
      document.removeEventListener('keydown', handleTransactionHistory, true);
      document.removeEventListener('beforeinput', handleNativeUndo, true);
    };
  }, [currentReceipt?.id]);

  // When currentIndex changes, load that receipt's transactions
  useEffect(() => {
    setTransactions(getTxForReceipt(visibleReceipts[currentIndex] || null));
  }, [currentIndex, deletedReceiptIds]);

  // Editing a voucher number changes the sort order. Re-find the receipt by
  // id before allowing the numeric page index to identify a different one.
  useEffect(() => {
    const receiptId = currentReceiptIdRef.current;
    if (receiptId) {
      const matchingIndex = visibleReceipts.findIndex(receipt => receipt.id === receiptId);
      if (matchingIndex >= 0) {
        if (matchingIndex !== currentIndex) setCurrentIndex(matchingIndex);
        return;
      }
    }
    currentReceiptIdRef.current = visibleReceipts[currentIndex]?.id || null;
  }, [visibleReceiptSignature, currentIndex]);

  useEffect(() => {
    setCurrentIndex(Math.max(0, startIndex));
  }, [startIndex]);

  // Restore the saved orientation whenever the reviewer moves to another
  // receipt. The orientation is kept per receipt, including after a reload.
  useEffect(() => {
    setRotation(currentReceipt ? loadReceiptRotations()[currentReceipt.id] || 0 : 0);
  }, [currentReceipt?.id]);

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
    if (isBlankPlaceholder(transactions)) return;

    const receiptId = currentReceipt.id;
    const rows = transactions;
    const changeVersion = changeVersionRef.current;
    const timer = setTimeout(() => {
      setSaveState('saving');
      queueTransactionSave(
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
    // Do not leave the previous receipt visible while the new signed URL is
    // being resolved. The URL is keyed by receipt, so it must be cleared first.
    setImageUrl('');
    setImageLoading(Boolean(currentReceipt));
    imageRetryReceiptIdRef.current = null;
    if (!currentReceipt) return;
    if (currentReceipt.previewUrl) {
      setImageUrl(currentReceipt.previewUrl);
      void preloadReceipt(currentReceipt).catch(() => undefined);
      return;
    }
    if (!currentReceipt.storage_path) {
      setImageLoading(false);
      return;
    }
    getReceiptImageUrl(currentReceipt.storage_path)
      .then(url => {
        if (!cancelled) setImageUrl(url);
        void preloadReceipt(currentReceipt).catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) {
          setImageUrl('');
          setImageLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [currentReceipt?.id, currentReceipt?.previewUrl, currentReceipt?.storage_path]);

  // Fetch and decode the adjacent page before the operator clicks it. This
  // keeps normal next/previous navigation responsive even when signed URL
  // creation or image download takes a moment.
  useEffect(() => {
    const adjacentReceipts = [
      visibleReceipts[currentIndex - 1],
      visibleReceipts[currentIndex + 1],
      visibleReceipts[currentIndex + 2],
    ].filter((receipt): receipt is Receipt => Boolean(receipt));
    let cancelled = false;
    adjacentReceipts.forEach(receipt => {
      preloadReceipt(receipt).catch(() => {
        // The visible page will show the load error if preloading fails.
      });
    });
    return () => { cancelled = true; };
  }, [currentIndex, visibleReceiptSignature]);

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

  const rotateBy = (degrees: number) => {
    if (!currentReceipt) return;
    setRotation(previous => {
      const next = previous + degrees;
      saveReceiptRotation(currentReceipt.id, next);
      return next;
    });
  };
  const rotateLeft = () => rotateBy(-90);
  const rotateRight = () => rotateBy(90);

  const recordTransactionChange = (before: Transaction[], after: Transaction[]) => {
    if (!currentReceipt) return;
    const undoStack = undoStacksRef.current[currentReceipt.id] || [];
    undoStack.push({ receiptId: currentReceipt.id, before, after });
    undoStacksRef.current[currentReceipt.id] = undoStack;
    // A new edit after undo starts a new branch, just like native editors.
    redoStacksRef.current[currentReceipt.id] = [];
    setHistoryVersion(version => version + 1);
  };

  const queueTransactionSave = (
    receiptId: string,
    ids: { batchId: string; organizationId: string; userId: string },
    rows: Transaction[]
  ): Promise<void> => {
    const save = transactionSaveQueueRef.current.then(() =>
      saveTransactionsForReceipt(receiptId, ids, rows)
    );
    transactionSaveQueueRef.current = save.catch(() => undefined);
    return save;
  };

  /**
   * Write the open voucher through to the database right now, rather than
   * waiting out the autosave debounce.
   *
   * The autosave timer is owned by an effect keyed on the receipt, so both
   * leaving the reviewer and stepping to another receipt run that effect's
   * cleanup and cancel the pending write. Anything typed in the last second
   * would otherwise reach the in-memory map and nothing else, and the stale
   * database row would be what came back on the next visit.
   *
   * Resolves false only when the write was attempted and failed, so a caller
   * that is about to navigate can stay put and leave the error on screen.
   */
  const flushPendingSave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    if (!currentReceipt || !batch || !currentUser.organization_id) return true;
    if (isBlankPlaceholder(transactions)) return true;

    const changeVersion = changeVersionRef.current;
    setSaveState('saving');
    try {
      await queueTransactionSave(
        currentReceipt.id,
        { batchId: batch.id, organizationId: currentUser.organization_id, userId: currentUser.id },
        transactions
      );
    } catch (err: any) {
      setSaveState('error');
      setSaveError(err?.message || 'Changes could not be saved.');
      return false;
    }
    if (changeVersion === changeVersionRef.current) {
      dirtyRef.current = false;
      setSaveState('saved');
      setSaveError(null);
      window.setTimeout(() => setSaveState('idle'), 2500);
    }
    return true;
  };

  const saveTransactionRows = async (rows: Transaction[]): Promise<boolean> => {
    if (!currentReceipt || !batch || !currentUser.organization_id) return true;
    if (isBlankPlaceholder(rows)) return true;

    const changeVersion = changeVersionRef.current;
    setSaveState('saving');
    try {
      await queueTransactionSave(
        currentReceipt.id,
        { batchId: batch.id, organizationId: currentUser.organization_id, userId: currentUser.id },
        rows
      );
    } catch (err: any) {
      setSaveState('error');
      setSaveError(err?.message || 'Changes could not be saved.');
      return false;
    }
    if (changeVersion === changeVersionRef.current) {
      dirtyRef.current = false;
      setSaveState('saved');
      setSaveError(null);
      window.setTimeout(() => setSaveState('idle'), 2500);
    }
    return true;
  };

  const handleUpdateTransaction = (id: string, field: keyof Transaction, value: any) => {
    const before = transactions;
    const after = transactions.map(t => {
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
    });
    recordTransactionChange(before, after);
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(after);
  };

  const handleUpdateReceiptField = (field: 'voucher_date' | 'voucher_no', value: string) => {
    const before = transactions;
    const after = transactions.map(t => ({ ...t, [field]: value }));
    recordTransactionChange(before, after);
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(after);
    if (field === 'voucher_no') {
      if (currentReceipt) {
        currentReceiptIdRef.current = currentReceipt.id;
        setTxMap(prev => ({ ...prev, [currentReceipt.id]: after }));
      }
      void saveTransactionRows(after);
    }
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
    const after = [...transactions, newTx];
    recordTransactionChange(transactions, after);
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(after);
  };

  const handleDeleteTransaction = (id: string) => {
    if (!currentReceipt) return;
    const before = transactions;
    const after = transactions.filter(t => t.id !== id);
    if (before.length === after.length) return;
    recordTransactionChange(before, after);
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(after);
  };

  const handleSaveProgress = async () => {
    if (!dirtyRef.current) return;
    if (currentReceipt) {
      setTxMap(prev => ({ ...prev, [currentReceipt.id]: transactions }));
    }
    // Writes through rather than only confirming: this button previously
    // reported success while nothing left the browser.
    if (!(await flushPendingSave())) return;
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleBack = async () => {
    // Leaving unmounts the reviewer and cancels the debounced write, so the
    // batch list would otherwise reload the pre-edit rows. Stay put if the save
    // fails: the error beside the Save button is the only warning the user gets.
    if (!(await flushPendingSave())) return;
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

    // Focused mode limits the review list, but exporting must always return to
    // the complete batch. Otherwise "Proceed to Export" would silently create
    // an export containing only the receipt(s) that were sent for fixing.
  const handleExportAll = async () => {
    // The export screen replaces this one, so the same cancelled-debounce loss
    // applies here as on Back.
    if (!(await flushPendingSave())) return;
    const saved = currentReceipt ? { ...txMap, [currentReceipt.id]: transactions } : txMap;
    const exportReceipts = allVisibleReceipts;
    const all = exportReceipts.flatMap(r => (saved[r.id] || []).map(t => ({ ...t, receipt_id: r.id })));
    const exportData = all.length > 0 ? all : transactions.map(t => ({ ...t, receipt_id: currentReceipt?.id }));

    // Check for imbalance using the same source of truth as imbalancedReceiptIds,
    // so the dialog only fires when there is a real imbalance the user can fix.
    let hasImbalance = false;
    for (const r of exportReceipts) {
      const rows = r.id === currentReceipt?.id ? transactions : rowsForReceipt(r.id);
      const dr = rows.reduce((sum, t) => sum + (Number(t.debit_amount) || 0), 0);
      const cr = rows.reduce((sum, t) => sum + (Number(t.credit_amount) || 0), 0);
      if (rows.length > 0 && Math.abs(dr - cr) > 0.005) {
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

  // Which amount, if any, is worth re-reading against the photo. Recomputed as
  // the grid is edited, so correcting the row makes its own hint disappear.
  const suspectsByRow = useMemo(() => {
    const found = isBalanced
      ? []
      : findImbalanceSuspects(transactions, totalDebit - totalCredit);
    return new Map(found.map(suspect => [suspect.transactionId, suspect]));
  }, [transactions, totalDebit, totalCredit, isBalanced]);

  /** Takes the suggested reading. Routed through the normal edit path, so it
   *  is undoable and autosaves exactly as typing the number would. */
  const applySuggestedAmount = (suspect: ImbalanceSuspect) => {
    handleUpdateTransaction(
      suspect.transactionId,
      suspect.side === 'debit' ? 'debit_amount' : 'credit_amount',
      suspect.suggested
    );
  };

  const imbalancedReceiptIds = visibleReceipts.filter(receipt => {
    // The currently open voucher may have unsaved edits; use the live grid.
    const rows = receipt.id === currentReceipt?.id ? transactions : rowsForReceipt(receipt.id);
    const debit = rows.reduce((sum, row) => sum + (Number(row.debit_amount) || 0), 0);
    const credit = rows.reduce((sum, row) => sum + (Number(row.credit_amount) || 0), 0);
    return rows.length > 0 && Math.abs(debit - credit) > 0.005;
  }).map(receipt => receipt.id);

  const focusFirstImbalancedReceipt = () => {
    if (!imbalancedReceiptIds.length) return;
    setLocalFocusedReceiptIds(imbalancedReceiptIds);
    setCurrentIndex(0);
    setShowImbalanceModal(false);
  };

  // Rows whose ledger Tally would not recognise. Only meaningful once the
  // organisation actually has a chart of accounts to be measured against.
  const unresolvedLedgers = ledgers.length
    ? transactions.filter(t => t.ledger_match === 'Unmatched' || t.ledger_match === 'Suggested').length
    : 0;

  // Narration is shared across all rows in a receipt
  const narration = transactions[0]?.narration || 'Being Expenses paid via cheque no.';

  const handleUpdateNarration = (value: string) => {
    const after = transactions.map(t => ({ ...t, narration: value }));
    recordTransactionChange(transactions, after);
    dirtyRef.current = true;
    changeVersionRef.current += 1;
    setTransactions(after);
  };

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < visibleReceipts.length - 1;

  const stepClass = (active: boolean) => `nav-step${active ? ' nav-step-active' : ''}`;

  return (
    <div className="reviewer-page">
      {/* Review header */}
      <div className="reviewer-header">
      <div className="row row-between row-wrap" style={{ gap: '16px' }}>
        <div className="row" style={{ gap: '16px' }}>
          <button className="btn btn-secondary" onClick={handleBack}>
            <ArrowLeft size={16} /> Back to Batches
          </button>
          <div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>
              {batch?.name || 'Scan Batch Review'}
            </h3>
          </div>
        </div>

        <div className="row-sm" style={{ gap: '10px' }}>
          {/* Reflects what has actually reached the database, so "Saved" is
              never claimed for work that only exists in the browser. */}
          {saveState === 'saving' && (
            <span className="save-state save-state-busy">
              <Loader2 size={15} className="animate-spin" /> Saving...
            </span>
          )}
          {saveState === 'saved' && !savedSuccess && (
            <span className="save-state save-state-ok">
              <CheckCircle2 size={16} /> All changes saved
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
            <Save size={16} /> Save Now
          </button>
          <button className="btn btn-primary" onClick={handleExportAll}>
            <FileSpreadsheet size={16} /> Review Excel File
          </button>
        </div>
      </div>

      {duplicateVoucherWarnings.length > 0 && !duplicateWarningDismissed && (
        <div className="alert alert-warning alert-top text-xs" role="alert">
          <AlertTriangle size={15} className="alert-icon" />
          <span className="alert-body">
            {duplicateVoucherWarnings.map(group => (
              <span key={group.voucherNo}>
                <span className="alert-title">Duplicate voucher detected on pages:</span>{' '}
                {group.receipts
                  .map(receipt => allVisibleReceipts.findIndex(item => item.id === receipt.id) + 1)
                  .join(', ')}. Verify before export.
              </span>
            ))}
          </span>
          <button
            className="alert-dismiss duplicate-warning-dismiss"
            onClick={() => setDuplicateWarningDismissed(true)}
            title="Dismiss"
            aria-label="Dismiss duplicate voucher warning"
            type="button"
          >
            ×
          </button>
        </div>
      )}

      {/* Receipt navigation */}
      {visibleReceipts.length > 1 && (
        <div className="reviewer-nav">
          <button
            className={stepClass(hasPrev)}
            disabled={!hasPrev}
            onClick={() => hasPrev && saveCurrentTx(currentIndex - 1)}
            aria-label="Previous receipt"
            title="Previous receipt"
          >
            <ChevronLeft size={18} />
          </button>

          <div className="row-sm receipt-pagination" aria-label="Receipt pages">
            {getReceiptPageItems(currentIndex + 1, visibleReceipts.length).map(item => (
              typeof item === 'number' ? (
                <button
                  key={item}
                  title={visibleReceipts[item - 1]?.filename}
                  className={`receipt-dot${currentIndex + 1 === item ? ' receipt-dot-active' : ''}`}
                  onClick={() => currentIndex + 1 !== item && saveCurrentTx(item - 1)}
                  aria-label={`Go to receipt ${item}`}
                  aria-current={currentIndex + 1 === item ? 'page' : undefined}
                >
                  {item}
                </button>
              ) : (
                <span key={item} className="receipt-pagination-ellipsis" aria-hidden="true">…</span>
              )
            ))}
          </div>

          <button
            className={stepClass(hasNext)}
            disabled={!hasNext}
            onClick={() => hasNext && saveCurrentTx(currentIndex + 1)}
            aria-label="Next receipt"
            title="Next receipt"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
      </div>

      {/* Split Reviewer Workspace */}
      <div className="split-reviewer">
        {/* Left Panel: Original Receipt Image */}
        <div className="image-panel">
          <div className="panel-header">
            <span>📷 {currentReceipt?.filename || 'Handwritten Voucher'}</span>
            <div className="row-xs">
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setShowDeleteModal(true)}
                title="Delete this receipt"
                disabled={deletingReceipt}
              >
                <Trash2 size={14} />
              </button>
              <button className="panel-rotate" onClick={rotateLeft} title="Rotate Left">
                <RotateCcw size={14} />
              </button>
              <button className="panel-rotate" onClick={rotateRight} title="Rotate Right">
                <RotateCw size={14} />
              </button>
              <button className="panel-rotate zoom-icon-control" onClick={() => setZoom(value => value > 1 ? 1 : 2)} title={zoom > 1 ? 'Reset zoom' : 'Zoom image'}>
                <ZoomIn size={14} />
              </button>
            </div>
          </div>

          <div
            className="image-viewer image-viewer-fixed"
            onWheel={event => {
              event.preventDefault();
              setZoom(value => Math.max(1, Math.min(3, value - event.deltaY * 0.002)));
            }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                className="receipt-img receipt-img-rotatable"
                style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }}
                onLoad={() => setImageLoading(false)}
                onError={() => {
                  // A signed URL can be stale after a same-path retry or an
                  // object replacement. Refresh it once before showing the
                  // empty-state message, rather than making the operator
                  // leave and reopen the reviewer.
                  if (currentReceipt?.storage_path && imageRetryReceiptIdRef.current !== currentReceipt.id) {
                    const retryReceiptId = currentReceipt.id;
                    imageRetryReceiptIdRef.current = retryReceiptId;
                    setImageLoading(true);
                    getReceiptImageUrl(currentReceipt.storage_path, 3600, true)
                      .then(url => {
                        if (imageRetryReceiptIdRef.current === retryReceiptId) {
                          setImageUrl(url);
                          void preloadReceipt(currentReceipt).catch(() => undefined);
                        }
                      })
                      .catch(() => {
                        if (imageRetryReceiptIdRef.current === retryReceiptId) {
                          setImageUrl('');
                          setImageLoading(false);
                        }
                      });
                    return;
                  }
                  setImageUrl('');
                  setImageLoading(false);
                }}
                onDoubleClick={() => setZoom(value => value > 1 ? 1 : 2)}
              />
            ) : (
              imageLoading ? <Loader2 size={24} className="animate-spin" aria-label="Loading receipt image" /> : null
            )}
          </div>
        </div>

        {/* Right Panel: Extracted Transaction Editor */}
        <div className="data-panel">
          <div className="panel-header row-wrap" style={{ gap: '12px' }}>
            <div className="row-sm" style={{ minWidth: 0 }}>
              <span>✏️ Voucher entries</span>
              <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 500 }}>
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
            <span
              className={`balance-pill ${isBalanced ? 'balance-ok' : 'balance-warn'}`}
              // Naming the gap matters most when no row could be singled out:
              // the reviewer at least knows what they are hunting for.
              title={
                isBalanced
                  ? undefined
                  : `${totalDebit > totalCredit ? 'Credit' : 'Debit'} is short by Rs. ` +
                    `${Math.abs(totalDebit - totalCredit).toLocaleString('en-IN', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}`
              }
            >
              {isBalanced ? (
                <><CheckCircle2 size={14} /> Voucher balanced</>
              ) : (
                <>
                  <AlertTriangle size={14} /> Out of balance by Rs.{' '}
                  {Math.abs(totalDebit - totalCredit).toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </>
              )}
            </span>
          </div>

          <div className="reviewer-body">
            <div className="voucher-meta">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong>Date:</strong> 
                <input 
                  type="text"
                  className="form-input"
                  style={{ padding: '2px 8px', minHeight: 'auto', width: '120px' }}
                  value={transactions[0]?.voucher_date || ''} 
                  onChange={(e) => handleUpdateReceiptField('voucher_date', e.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong>Voucher No:</strong> 
                <input 
                  type="text"
                  className="form-input"
                  style={{ padding: '2px 8px', minHeight: 'auto', width: '120px' }}
                  value={(transactions[0] as any)?.voucher_no || ''} 
                  onChange={(e) => handleUpdateReceiptField('voucher_no', e.target.value)}
                  onBlur={() => void handleSaveProgress()}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    event.currentTarget.blur();
                    void handleSaveProgress();
                  }}
                />
              </div>
            </div>
            <div className="table-container">
              <table className="custom-table tx-table">
                <thead>
                  <tr>
                    <th className="tx-col-type">Type</th>
                    <th>Particulars</th>
                    <th className="tx-col-amount">Debit (Rs.)</th>
                    <th className="tx-col-amount">Credit (Rs.)</th>
                    <th className="tx-col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => {
                    const suspect = suspectsByRow.get(tx.id);
                    return (
                    <tr
                      key={tx.id}
                      className={
                        `${tx.entry_type === 'Dr' ? 'tx-row-debit' : ''}` +
                        `${tx.needs_review ? ' row-needs-review' : ''}` +
                        `${suspect ? ' row-imbalance-suspect' : ''}`
                      }
                    >
                      <td>
                        <span className={`status-pill status-pill-strong ${tx.entry_type === 'Dr' ? 'status-processing' : 'status-extracted'}`}>
                          {tx.entry_type}
                        </span>
                      </td>
                      <td>
                        <input
                          type="text"
                          size={1}
                          // Native picker rather than a bespoke dropdown: it
                          // filters as you type, works on touch, and needs no
                          // code that a redesign would have to throw away.
                          list={ledgers.length ? LEDGER_OPTIONS_ID : undefined}
                          className={`cell-input${tx.entry_type === 'Dr' ? ' cell-input-debit' : ''}`}
                          value={tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                          title={tx.ledger_name || tx.debit_ledger || tx.credit_ledger || ''}
                          onChange={(e) => handleUpdateTransaction(tx.id, 'ledger_name', e.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            event.currentTarget.blur();
                            void handleSaveProgress();
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
                            className="ledger-hint ledger-hint-missing"
                            title="Tally will create a new account under this name on import"
                          >
                            <AlertTriangle size={11} />
                            <span>Not in your chart of accounts</span>
                          </div>
                        )}

                        {/* Sits beside the ledger name rather than under the
                            amount because the amount column is 112px wide and
                            clips. The amount itself is tinted to match, which
                            is what ties the two together. */}
                        {suspect && (
                          <button
                            type="button"
                            className="ledger-hint amount-hint-suggest"
                            onClick={() => applySuggestedAmount(suspect)}
                            title={describeMisread(suspect)}
                          >
                            <Scale size={11} />
                            <span>
                              Did you mean{' '}
                              <strong>
                                {suspect.suggested.toLocaleString('en-IN', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                              </strong>
                              ? That balances this voucher.
                            </span>
                          </button>
                        )}
                      </td>
                      <td>
                        {tx.entry_type === 'Dr' ? (
                          <AmountInput
                            tone="debit"
                            uncertain={tx.needs_review}
                            suspect={Boolean(suspect)}
                            value={tx.debit_amount || 0}
                            onChange={(amount) => handleUpdateTransaction(tx.id, 'debit_amount', amount)}
                            onEnter={() => void handleSaveProgress()}
                          />
                        ) : (
                          <span className="amount-empty">–</span>
                        )}
                      </td>
                      <td>
                        {tx.entry_type === 'Cr' ? (
                          <AmountInput
                            tone="credit"
                            uncertain={tx.needs_review}
                            suspect={Boolean(suspect)}
                            value={tx.credit_amount || 0}
                            onChange={(amount) => handleUpdateTransaction(tx.id, 'credit_amount', amount)}
                            onEnter={() => void handleSaveProgress()}
                          />
                        ) : (
                          <span className="amount-empty">–</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn btn-danger btn-sm btn-icon"
                          onClick={() => handleDeleteTransaction(tx.id)}
                          title="Delete Row (Ctrl/Cmd+Z to undo)"
                          aria-label="Delete row"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="row row-between">
              <div className="row-sm">
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Dr')}>
                  <Plus size={14} /> Add Debit
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => handleAddTransaction('Cr')}>
                  <Plus size={14} /> Add Credit
                </button>
              </div>

              <div className={`totals-panel ${isBalanced ? 'totals-ok' : 'totals-warn'}`}>
                <div>
                  <span className="total-label">Total Debit:</span>
                  <span className="total-value total-debit">
                    Rs. {totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="total-divider">
                  <span className="total-label">Total Credit:</span>
                  <span className="total-value total-credit">
                    Rs. {totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
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

            {/* Signature detection. Advisory, like the ledger-match pill above —
                a best-effort read from a general vision model, not a dedicated
                signature verifier, so it never blocks anything, only flags it. */}
            {currentReceipt?.status === 'Extracted' && currentReceipt.has_signature != null && (
              <span
                className={`receipt-status-badge ${currentReceipt.has_signature ? 'receipt-status-signed' : 'receipt-status-unsigned'} signature-badge-standalone`}
                title={currentReceipt.has_signature
                  ? 'The AI saw what looks like a handwritten signature on this voucher.'
                  : 'The AI did not see a handwritten signature on this voucher. Verify against the original if one is required.'}
              >
                <span className="receipt-status-icon" aria-hidden="true">
                  <FileSignature size={12} />
                </span>
                <span>{currentReceipt.has_signature ? 'Signature Detected' : 'No Signature'}</span>
              </span>
            )}
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
            <div className="row tone-amber">
              <AlertTriangle size={24} />
              <h3 className="modal-title" style={{ marginBottom: 0, color: 'var(--text-main)' }}>
                Imbalance Detected
              </h3>
            </div>
            <p className="modal-text" style={{ marginBottom: 0, fontSize: '0.95rem' }}>
              Debit / Credit Imbalance Detected in one or more receipts. Are you sure you want to continue with the export?
            </p>
            <div className="row row-end" style={{ marginTop: '8px' }}>
              <button className="btn btn-secondary" onClick={cancelExport}>
                Cancel
              </button>
              {imbalancedReceiptIds.length > 0 && (
                <button className="btn btn-primary" onClick={focusFirstImbalancedReceipt}>
                  Fix imbalanced receipts
                </button>
              )}
              <button className="btn btn-warning" onClick={confirmExport}>
                Proceed to Export
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && currentReceipt && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          backgroundColor: 'rgba(0, 0, 0, 0.68)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '20px', backdropFilter: 'blur(4px)'
        }}>
          <div className="card" style={{ width: '100%', maxWidth: '430px', padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#f43f5e', marginBottom: '12px' }}>
              <Trash2 size={22} />
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-main)' }}>
                Delete receipt?
              </h3>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
              This will permanently delete <strong style={{ color: 'var(--text-main)' }}>{currentReceipt.filename}</strong> and its extracted data. This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '22px' }}>
              <button className="btn btn-secondary" onClick={() => setShowDeleteModal(false)} disabled={deletingReceipt}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleDeleteCurrentReceipt} disabled={deletingReceipt}>
                {deletingReceipt ? <><Loader2 size={15} className="animate-spin" /> Deleting...</> : <><Trash2 size={15} /> Delete Receipt</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
