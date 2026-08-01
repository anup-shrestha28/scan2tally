import React, { useEffect, useRef, useState } from 'react';
import { FolderPlus, FolderOpen, UploadCloud, Play, FileText, CheckCircle2, Clock, Edit2, Trash2, Camera, Loader2, AlertCircle, AlertTriangle, RotateCw, RotateCcw, Archive, ArchiveRestore, FileSpreadsheet, Download, Eye, EyeOff, LockKeyhole, ZoomIn, MoreHorizontal, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { ScanBatch, Receipt, ReceiptDisplayStatus, User, Transaction } from '../types';
import SearchInput from './SearchInput';
import StatusFilter from './StatusFilter';
import { supabase } from '../lib/supabase';
import { filterBySearch, normalizeSearchText } from '../lib/search';
import { usePolling } from '../lib/usePolling';
import {
  newId,
  fetchBatches,
  createBatch,
  renameBatch,
  deleteBatch,
  setBatchStatus,
  setBatchHidden,
  createReceipt,
  updateReceiptRow,
  deleteReceipt,
  deleteReceiptImages,
  uploadReceiptImage,
  validateReceiptUploadFile,
  RECEIPT_UPLOAD_ACCEPT,
  getReceiptImageUrl,
  startReceiptExtraction,
  fetchReceiptStates,
  parseReceiptServerState,
  ReceiptServerState,
  fetchTransactionsForBatch,
  fetchExportsForBatch,
  downloadExportFile,
  ExportRecord,
} from '../lib/db';

/**
 * How often to re-check receipts the server is still working on.
 *
 * Extraction runs server-side, so this is the only way the page learns that a
 * voucher has finished — including one that was started before the tab was
 * last closed.
 */
const EXTRACTION_POLL_MS = 10000;

const NOT_JOURNAL_ENTRY_ERROR = 'The uploaded image is not a journal entry. Please check and try again.';

/**
 * Which batch the operator was last looking at, per tab.
 *
 * Session rather than local storage: two tabs open on different batches should
 * stay on their own, and a new session should start at the newest batch.
 */
const ACTIVE_BATCH_STORAGE_KEY = 'scan2tally-active-batch';

/**
 * Minimum short edge, in pixels, for a voucher photo we trust.
 *
 * The vision API works at roughly 768px on the short edge, so anything below
 * that has already lost handwriting detail before extraction even starts. 1000
 * leaves a margin. For reference, vouchers that extract cleanly measure around
 * 1350x1800; a 368x547 photo produced amounts the model could not read
 * consistently and had to flag.
 */
const MIN_IMAGE_SHORT_EDGE = 1000;
const RECEIPTS_PER_PAGE = 10;

interface ReceiptUploadTask {
  receiptId: string;
  filename: string;
  previewUrl: string;
  file: File;
  batchId: string;
  organizationId: string;
  userId: string;
}

function isReceiptQueued(receipt: Receipt): boolean {
  return receipt.status === 'Pending' && (
    receipt.extraction_queue_message_id != null || receipt.enqueue_accepted === true
  );
}

function receiptDisplayStatus(receipt: Receipt): ReceiptDisplayStatus {
  return isReceiptQueued(receipt) ? 'Queued' : receipt.status;
}

type ReceiptStatusTone = 'pending' | 'queued' | 'processing' | 'extracted' | 'failed';
type ReceiptFilterStatus = ReceiptDisplayStatus | 'Waiting to upload' | 'Uploading';
type ReceiptStatusFilter = 'All' | ReceiptFilterStatus;
type BatchCreatorFilter = 'all' | 'mine' | 'others';

const RECEIPT_FILTER_STATUSES: ReceiptFilterStatus[] = [
  'Waiting to upload',
  'Uploading',
  'Pending',
  'Queued',
  'Processing',
  'Extracted',
  'Failed',
];

function receiptFilterStatus(receipt: Receipt): ReceiptFilterStatus {
  if (receipt.upload_state === 'waiting') return 'Waiting to upload';
  if (receipt.upload_state === 'uploading') return 'Uploading';
  if (receipt.upload_state === 'failed') return 'Failed';
  return receiptDisplayStatus(receipt);
}

function ReceiptStatusBadge({ receipt }: { receipt: Receipt }) {
  const displayStatus = receiptDisplayStatus(receipt);
  let label: string;
  let tone: ReceiptStatusTone;
  let icon: React.ReactNode;

  if (receipt.upload_state === 'waiting') {
    label = 'Waiting to upload';
    tone = 'queued';
    icon = <Clock size={12} />;
  } else if (receipt.upload_state === 'uploading') {
    label = 'Uploading';
    tone = 'processing';
    icon = <Loader2 size={12} className="animate-spin" />;
  } else if (receipt.upload_state === 'failed') {
    label = 'Upload failed';
    tone = 'failed';
    icon = <AlertCircle size={12} />;
  } else if (displayStatus === 'Extracted') {
    label = displayStatus;
    tone = 'extracted';
    icon = <CheckCircle2 size={12} />;
  } else if (displayStatus === 'Processing') {
    label = displayStatus;
    tone = 'processing';
    icon = <Loader2 size={12} className="animate-spin" />;
  } else if (displayStatus === 'Queued') {
    label = displayStatus;
    tone = 'queued';
    icon = <Clock size={12} />;
  } else if (displayStatus === 'Failed') {
    label = displayStatus;
    tone = 'failed';
    icon = <AlertCircle size={12} />;
  } else {
    label = displayStatus;
    tone = 'pending';
    icon = <Clock size={12} />;
  }

  return (
    <span
      className={`receipt-status-badge receipt-status-${tone}`}
      aria-label={`File processing status: ${label}`}
    >
      <span className="receipt-status-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function uploadIsBusy(receipt: Receipt): boolean {
  return receipt.upload_state === 'waiting' || receipt.upload_state === 'uploading';
}

function uploadIsComplete(receipt: Receipt): boolean {
  return receipt.upload_state === 'uploaded' || Boolean(receipt.storage_path);
}

function isTerminalReceiptStatus(status: Receipt['status']): boolean {
  return status === 'Extracted' || status === 'Failed';
}

function timestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A Realtime event and an in-flight poll can arrive out of order. Generation
 * is authoritative across retries; updated_at orders transitions within one
 * generation. The final guards cover legacy rows while migration 007 rolls out.
 */
function receiptServerStateCanAdvance(receipt: Receipt, state: ReceiptServerState): boolean {
  const currentGeneration = receipt.extraction_generation ?? 0;
  const incomingGeneration = state.extraction_generation ?? currentGeneration;
  if (incomingGeneration < currentGeneration) return false;
  if (incomingGeneration > currentGeneration) return true;

  const currentUpdatedAt = timestampMs(receipt.updated_at);
  const incomingUpdatedAt = timestampMs(state.updated_at);
  if (currentUpdatedAt !== null && incomingUpdatedAt !== null) {
    if (incomingUpdatedAt < currentUpdatedAt) return false;
    if (incomingUpdatedAt > currentUpdatedAt) return true;
  }

  // A successful enqueue can briefly precede its Realtime echo. Do not let a
  // same-generation response captured before that POST undo the local bridge.
  if (
    (receipt.enqueue_accepted || receipt.extraction_queue_message_id != null) &&
    state.extraction_queue_message_id == null &&
    state.status !== 'Processing'
  ) {
    return false;
  }

  // Equal/unknown ordering metadata must never move a terminal row backwards.
  if (isTerminalReceiptStatus(receipt.status) && !isTerminalReceiptStatus(state.status)) return false;
  return true;
}

/** Durable extraction order is independent from the newest-first file table. */
function compareReceiptCreationOldestFirst(left: Receipt, right: Receipt): number {
  const leftCreated = timestampMs(left.created_at) ?? 0;
  const rightCreated = timestampMs(right.created_at) ?? 0;
  return leftCreated - rightCreated || left.id.localeCompare(right.id);
}

function isLowResolution(receipt: Receipt): boolean {
  if (!receipt.image_width || !receipt.image_height) return false;
  return Math.min(receipt.image_width, receipt.image_height) < MIN_IMAGE_SHORT_EDGE;
}

function receiptHasImageIssue(receipt: Receipt): boolean {
  return isLowResolution(receipt)
    || receipt.upload_state === 'failed'
    || Boolean(receipt.upload_error || receipt.enqueue_error || receipt.error_message)
    || receipt.status === 'Failed';
}

function readableReceiptError(message?: string): string | undefined {
  if (!message) return undefined;
  if (/invalid_image_format|unsupported image/i.test(message)) {
    return 'Unsupported image format. Upload the voucher as JPG, JPEG, PNG, or WEBP. PDF files cannot be extracted yet.';
  }
  return message;
}

function formatBatchDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Reads an image's pixel dimensions without blocking the upload. */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

interface BatchWorkspaceProps {
  currentUser: User;
  onSelectBatch: (batch: ScanBatch, selectedReceipt?: Receipt, extractedTx?: Transaction[], txMap?: Record<string, Transaction[]>) => void;
}

export default function BatchWorkspace({ currentUser, onSelectBatch }: BatchWorkspaceProps) {
  const [batches, setBatches] = useState<ScanBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadValidationError, setUploadValidationError] = useState<string | null>(null);

  const [activeBatchId, setActiveBatchId] = useState<string>('');
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const editingBatchRef = useRef<HTMLDivElement | null>(null);
  const [editedBatchName, setEditedBatchName] = useState<string>('');
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [pendingDeleteReceiptIds, setPendingDeleteReceiptIds] = useState<string[]>([]);
  const [openBatchMenuId, setOpenBatchMenuId] = useState<string | null>(null);
  const [batchMenuPosition, setBatchMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [batchPage, setBatchPage] = useState(1);
  const [receiptPage, setReceiptPage] = useState(1);
  const [receiptStatusFilter, setReceiptStatusFilter] = useState<ReceiptStatusFilter>('All');
  const [batchSearch, setBatchSearch] = useState('');
  const [batchCreatorFilter, setBatchCreatorFilter] = useState<BatchCreatorFilter>('all');
  const [receiptSearch, setReceiptSearch] = useState('');
  const [selectedReceiptIds, setSelectedReceiptIds] = useState<Set<string>>(new Set());
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [dragOver, setDragOver] = useState<boolean>(false);
  // True only while extraction requests are being handed to the server. Once
  // they are accepted the receipts' own Processing status takes over, so this
  // covers just the brief gap before that shows up.
  const [startingExtraction, setStartingExtraction] = useState<boolean>(false);
  const [openingReview, setOpeningReview] = useState<boolean>(false);

  // Archived batches are hidden rather than deleted: last quarter's work is
  // still needed for its records, it just should not sit between an operator and
  // this morning's batch.
  const [showArchived, setShowArchived] = useState<boolean>(false);

  const [uploadedFilesMap, setUploadedFilesMap] = useState<Record<string, File>>({});
  const [receiptTransactionsMap, setReceiptTransactionsMap] = useState<Record<string, Transaction[]>>({});
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);
  const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);

  useEffect(() => {
    if (!openBatchMenuId) return;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.batch-menu')) setOpenBatchMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenBatchMenuId(null);
    };

    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openBatchMenuId]);

  // One FIFO covers repeated selections as well as a single multi-file pick.
  // Only the worker removes tasks, so file N+1 cannot begin before N settles.
  const uploadQueueRef = useRef<ReceiptUploadTask[]>([]);
  const uploadWorkerRunningRef = useRef(false);
  // Gives optimistic rows a strict order even when several FileList selections
  // happen inside the same millisecond. Server created_at replaces it on insert.
  const optimisticReceiptClockRef = useRef(0);
  // Read inside the polling loop, which must not close over a stale render.
  const batchesRef = useRef<ScanBatch[]>([]);
  // Batches whose stored transactions have already been loaded.
  const loadedTxBatchesRef = useRef<Set<string>>(new Set());
  // Set when this tab starts a run, so it can open the reviewer once the batch
  // finishes. A tab that merely finds work already in progress does not jump.
  // The receipt ids are kept too, so it lands on one this run produced rather
  // than on an older extraction that happens to sit earlier in the batch.
  const autoOpenRef = useRef<{ batchId: string; receiptIds: string[] } | null>(null);

  const wantedStatus = showArchived ? 'Archived' : 'Active';
  const statusScopedBatches = batches.filter(b => b.status === wantedStatus);
  const myBatchCount = statusScopedBatches.filter(batch => batch.created_by === currentUser.id).length;
  const otherBatchCount = statusScopedBatches.filter(batch => batch.created_by && batch.created_by !== currentUser.id).length;
  const creatorScopedBatches = statusScopedBatches.filter(batch =>
    batchCreatorFilter === 'all'
    || (batchCreatorFilter === 'mine' && batch.created_by === currentUser.id)
    || (batchCreatorFilter === 'others' && Boolean(batch.created_by) && batch.created_by !== currentUser.id)
  );
  const hasBatchSearch = Boolean(normalizeSearchText(batchSearch));
  const visibleBatches = filterBySearch(creatorScopedBatches, batchSearch, batch => [
    batch.name,
    batch.created_at,
    formatBatchDate(batch.created_at),
    `${batch.receipts.length} ${batch.receipts.length === 1 ? 'receipt' : 'receipts'}`,
    ...batch.receipts.map(receipt => receipt.filename),
  ]);
  const BATCHES_PER_PAGE = 10;
  const batchPageCount = Math.max(1, Math.ceil(visibleBatches.length / BATCHES_PER_PAGE));
  const visibleBatchPage = Math.min(batchPage, batchPageCount);
  const paginatedBatches = visibleBatches.slice(
    (visibleBatchPage - 1) * BATCHES_PER_PAGE,
    visibleBatchPage * BATCHES_PER_PAGE
  );
  const archivedCount = batches.filter(b => b.status === 'Archived').length;

  // May be undefined before the first load finishes, or when the user has no
  // batches yet — every read below has to tolerate that.
  // Search only controls the sidebar results. It must never silently replace
  // the batch open in the workspace just because that batch does not match.
  const activeBatch: ScanBatch | undefined =
    statusScopedBatches.find(b => b.id === activeBatchId) || statusScopedBatches[0];
  const activeBatchHiddenBySearch = Boolean(
    hasBatchSearch && activeBatch && !visibleBatches.some(batch => batch.id === activeBatch.id)
  );
  const activeReceipts = activeBatch?.receipts ?? [];
  const receiptStatusCounts = activeReceipts.reduce<Record<ReceiptFilterStatus, number>>(
    (counts, receipt) => {
      counts[receiptFilterStatus(receipt)] += 1;
      return counts;
    },
    {
      'Waiting to upload': 0,
      Uploading: 0,
      Pending: 0,
      Queued: 0,
      Processing: 0,
      Extracted: 0,
      Failed: 0,
    }
  );
  const normalizedReceiptSearch = normalizeSearchText(receiptSearch);
  const filteredReceipts = activeReceipts
    .filter(receipt => {
      const matchesStatus = receiptStatusFilter === 'All' || receiptFilterStatus(receipt) === receiptStatusFilter;
      const matchesName = !normalizedReceiptSearch || normalizeSearchText(receipt.filename).includes(normalizedReceiptSearch);
      return matchesStatus && matchesName;
    })
    .sort((a, b) => {
      const issueScore = (receipt: Receipt) => (
        receipt.upload_state === 'failed' ||
        receipt.status === 'Failed' ||
        Boolean(receipt.enqueue_error || receipt.error_message) ||
        isLowResolution(receipt)
          ? 0
          : 1
      );
      return issueScore(a) - issueScore(b);
    });
  const receiptPageCount = Math.max(1, Math.ceil(filteredReceipts.length / RECEIPTS_PER_PAGE));
  const visibleReceiptPage = Math.min(receiptPage, receiptPageCount);
  const paginatedReceipts = filteredReceipts.slice(
    (visibleReceiptPage - 1) * RECEIPTS_PER_PAGE,
    visibleReceiptPage * RECEIPTS_PER_PAGE
  );
  // An archived batch is a record, not a workspace. It stays fully readable and
  // exportable; what stops is adding to it.
  const isArchived = activeBatch?.status === 'Archived';
  // Derived from the receipts themselves rather than tracked separately, so a
  // reopened tab shows work still running on the server.
  const batchIsProcessing = (batch: ScanBatch) => batch.receipts.some(
    r => r.status === 'Processing' || isReceiptQueued(r)
  );
  const batchIsUploading = (batch: ScanBatch) => batch.receipts.some(uploadIsBusy);
  const isUploading = activeReceipts.some(uploadIsBusy);
  const isProcessing = startingExtraction || activeReceipts.some(
    r => r.status === 'Processing' || isReceiptQueued(r)
  );
  const uploadsLocked = isProcessing || isArchived;
  const extractableCount = activeReceipts.filter(
    r => (r.status === 'Pending' || r.status === 'Failed') &&
      !isReceiptQueued(r) && uploadIsComplete(r)
  ).length;
  const allReceiptsExtracted = activeReceipts.length > 0 && activeReceipts.every(r => r.status === 'Extracted');
  // Only counts receipts still awaiting extraction — no point nagging about
  // photos that have already been processed.
  const lowResPendingCount = activeReceipts.filter(
    r => (r.status === 'Pending' || r.status === 'Failed') &&
      !isReceiptQueued(r) && uploadIsComplete(r) && isLowResolution(r)
  ).length;

  useEffect(() => {
    setReceiptPage(page => Math.min(page, receiptPageCount));
  }, [receiptPageCount]);

  useEffect(() => {
    setBatchPage(page => Math.min(page, batchPageCount));
  }, [batchPageCount]);

  useEffect(() => {
    setReceiptPage(1);
    setBatchPage(1);
    setSelectedReceiptIds(new Set());
  }, [activeBatch?.id, receiptStatusFilter, receiptSearch, batchSearch, showArchived]);

  useEffect(() => {
    if (!previewReceipt) return;

    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewReceipt(null);
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      const currentIndex = activeReceipts.findIndex(receipt => receipt.id === previewReceipt.id);
      if (currentIndex < 0) return;
      const nextIndex = event.key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1;
      const nextReceipt = activeReceipts[nextIndex];
      if (!nextReceipt) return;

      event.preventDefault();
      setPreviewRotation(0);
      setPreviewZoom(1);
      setPreviewReceipt(nextReceipt);
    };

    window.addEventListener('keydown', handlePreviewKeyDown);
    return () => window.removeEventListener('keydown', handlePreviewKeyDown);
  }, [activeReceipts, previewReceipt]);

  useEffect(() => {
    if (previewReceipt || receiptPageCount <= 1) return;

    const handlePaginationKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft' && visibleReceiptPage > 1) {
        event.preventDefault();
        setReceiptPage(page => Math.max(1, page - 1));
      } else if (event.key === 'ArrowRight' && visibleReceiptPage < receiptPageCount) {
        event.preventDefault();
        setReceiptPage(page => Math.min(receiptPageCount, page + 1));
      }
    };

    window.addEventListener('keydown', handlePaginationKeyDown);
    return () => window.removeEventListener('keydown', handlePaginationKeyDown);
  }, [previewReceipt, receiptPageCount, visibleReceiptPage]);

  // Load everything this user is allowed to see. Row-level security decides
  // that server-side, so there is no organisation filter here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchBatches();
        if (cancelled) return;

        // Swap stored paths for signed URLs so thumbnails work after a refresh.
        await Promise.all(
          loaded.flatMap(b =>
            b.receipts.map(async r => {
              if (!r.storage_path) return;
              try {
                r.previewUrl = await getReceiptImageUrl(r.storage_path);
              } catch {
                r.previewUrl = '';
              }
            })
          )
        );

        if (cancelled) return;
        const latestDurableReceiptTime = loaded.reduce(
          (latest, batch) => batch.receipts.reduce(
            (batchLatest, receipt) => Math.max(batchLatest, timestampMs(receipt.created_at) ?? 0),
            latest
          ),
          0
        );
        optimisticReceiptClockRef.current = Math.max(
          optimisticReceiptClockRef.current,
          latestDurableReceiptTime
        );
        setBatches(loaded);
        const rememberedBatchId = sessionStorage.getItem(ACTIVE_BATCH_STORAGE_KEY);
        // The screen always opens on Active batches. Do not restore an archived
        // id without also restoring that view, or the highlighted card and the
        // workspace would disagree about which batch is current.
        const rememberedActiveBatch = loaded.find(batch => (
          batch.id === rememberedBatchId && batch.status === 'Active'
        ));
        const nextBatchId = rememberedActiveBatch?.id
          || loaded.find(batch => batch.status === 'Active')?.id
          || '';
        setActiveBatchId(nextBatchId);
        if (nextBatchId) sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, nextBatchId);
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load your scan batches.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    batchesRef.current = batches;
  }, [batches]);

  const applyReceiptStates = async (states: ReceiptServerState[]) => {
    if (!states.length) return;
    const currentBatches = batchesRef.current;
    const currentReceipts = new Map(
      currentBatches.flatMap(batch => batch.receipts.map(receipt => [receipt.id, receipt] as const))
    );

    // Transactions are committed before the backend announces Extracted. Load
    // them before updating the visible status so Review never opens on an empty
    // in-memory map merely because the Realtime event arrived quickly.
    const extractedIds = new Set(states
      .filter(state => {
        const current = currentReceipts.get(state.id);
        return Boolean(
          current &&
          state.status === 'Extracted' &&
          current.status !== 'Extracted' &&
          receiptServerStateCanAdvance(current, state)
        );
      })
      .map(state => state.id));
    const affectedBatchIds = currentBatches
      .filter(batch => batch.receipts.some(receipt => extractedIds.has(receipt.id)))
      .map(batch => batch.id);
    await Promise.all(affectedBatchIds.map(async batchId => {
      try {
        const stored = await fetchTransactionsForBatch(batchId);
        setReceiptTransactionsMap(previous => ({ ...previous, ...stored }));
      } catch {
        // Status is still authoritative; reopening the batch retries this read.
        loadedTxBatchesRef.current.delete(batchId);
      }
    }));

    const updates = new Map(states.map(state => [state.id, state]));
    setBatches(previous => previous.map(batch => ({
      ...batch,
      receipts: batch.receipts.map(receipt => {
        const state = updates.get(receipt.id);
        if (!state || !receiptServerStateCanAdvance(receipt, state)) return receipt;
        const nextQueueMessageId = state.extraction_queue_message_id !== undefined
          ? state.extraction_queue_message_id
          : receipt.extraction_queue_message_id;
        const hasDurableQueueMarker = nextQueueMessageId != null;
        return {
          ...receipt,
          status: state.status,
          error_message: state.error_message,
          verification_warnings: state.verification_warnings,
          extraction_queue_message_id: nextQueueMessageId,
          extraction_queued_at: state.extraction_queued_at !== undefined
            ? state.extraction_queued_at
            : receipt.extraction_queued_at,
          extraction_generation: state.extraction_generation ?? receipt.extraction_generation,
          updated_at: state.updated_at ?? receipt.updated_at,
          enqueue_accepted: state.status === 'Pending' && !hasDurableQueueMarker
            ? receipt.enqueue_accepted
            : false,
          enqueue_error: undefined,
        };
      }),
    })));
  };

  // Pull in transactions that were extracted previously. Without this, a batch
  // opened in a new session looks empty even though its rows are safely stored.
  useEffect(() => {
    const batchId = activeBatch?.id;
    if (!batchId || loadedTxBatchesRef.current.has(batchId)) return;
    loadedTxBatchesRef.current.add(batchId);

    fetchTransactionsForBatch(batchId)
      .then(stored => {
        // Anything already in memory is at least as fresh, so it wins.
        setReceiptTransactionsMap(prev => ({ ...stored, ...prev }));
      })
      .catch(() => {
        // Allow a later attempt rather than leaving the batch permanently blank.
        loadedTxBatchesRef.current.delete(batchId);
      });
  }, [activeBatch?.id]);

  // Which Tally spreadsheets this batch has already produced. Kept beside the
  // batch because the question it answers — "was this already posted?" — comes
  // up while looking at the batch, not somewhere else.
  useEffect(() => {
    const batchId = activeBatch?.id;
    if (!batchId) { setExportHistory([]); return; }

    let cancelled = false;
    fetchExportsForBatch(batchId)
      .then(records => { if (!cancelled) setExportHistory(records); })
      .catch(() => { if (!cancelled) setExportHistory([]); });
    return () => { cancelled = true; };
  }, [activeBatch?.id]);

  // Realtime is the primary path. Polling these ids is the recovery path for a
  // temporarily disconnected socket or a deployment where replication has not
  // yet been enabled for receipts.
  const processingIds = batches
    .flatMap(b => b.receipts
      .filter(r => r.status === 'Processing' || isReceiptQueued(r))
      .map(r => r.id))
    .sort();
  const processingKey = processingIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const channel = supabase
      .channel(`receipt-state-${currentUser.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'receipts' },
        payload => {
          const state = parseReceiptServerState(payload.new);
          if (!cancelled && state) void applyReceiptStates([state]);
        }
      )
      .subscribe(status => {
        if (status !== 'SUBSCRIBED') return;
        const ids = batchesRef.current.flatMap(batch => batch.receipts
          .filter(receipt => receipt.status === 'Processing' || isReceiptQueued(receipt))
          .map(receipt => receipt.id));
        if (ids.length) {
          fetchReceiptStates(ids)
            .then(states => { if (!cancelled) return applyReceiptStates(states); })
            .catch(() => { /* polling below remains the fallback */ });
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [currentUser.id]);

  usePolling(async ({ signal }) => {
    const states = await fetchReceiptStates(processingKey ? processingKey.split(',') : []);
    if (!signal.aborted) await applyReceiptStates(states);
  }, {
    enabled: Boolean(processingKey),
    intervalMs: EXTRACTION_POLL_MS,
    maxIntervalMs: 60000,
    resetKey: processingKey,
  });

  // Open the reviewer once a run this tab started has finished, preserving the
  // old behaviour of not making the user click through manually.
  useEffect(() => {
    const pending = autoOpenRef.current;
    if (!pending || startingExtraction) return;

    const batch = batches.find(b => b.id === pending.batchId);
    if (!batch) {
      autoOpenRef.current = null;
      return;
    }
    if (batch.receipts.some(r => r.status === 'Processing' || isReceiptQueued(r))) return;

    const runReceipts = batch.receipts.filter(r => pending.receiptIds.includes(r.id));
    // Keep the user on the batch workspace when any uploaded image needs
    // attention. The warning, failed status, retry action, and image preview
    // are all available there; opening the reviewer would hide that context.
    if (runReceipts.some(receiptHasImageIssue) || !runReceipts.every(r => r.status === 'Extracted')) {
      autoOpenRef.current = null;
      return;
    }

    autoOpenRef.current = null;
    const firstExtracted = runReceipts.find(
      r => pending.receiptIds.includes(r.id) && r.status === 'Extracted'
    );
    if (firstExtracted) {
      onSelectBatch(
        batch,
        firstExtracted,
        receiptTransactionsMap[firstExtracted.id] || [],
        receiptTransactionsMap
      );
    }
  }, [batches, startingExtraction, receiptTransactionsMap]);

  useEffect(() => {
    if (!deletingBatchId) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [deletingBatchId]);

  useEffect(() => {
    if (!editingBatchId) return;

    const closeEditOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!editingBatchRef.current?.contains(target)) {
        setEditingBatchId(null);
      }
    };

    document.addEventListener('pointerdown', closeEditOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeEditOnOutsideClick);
  }, [editingBatchId]);

  const handleCreateBatch = async () => {
    if (!currentUser.organization_id) {
      setSaveError('Your account is not linked to an organisation, so batches cannot be created.');
      return;
    }
    const batchNumbers = batches
      .map(b => Number(b.name.match(/^Batch[- ](\d+)/i)?.[1] || 0))
      .filter(Number.isFinite);
    const nextBatchNumber = Math.max(0, ...batchNumbers) + 1;
    const batchDate = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    const defaultName = `Batch ${nextBatchNumber} · ${batchDate}`;

    const newBatch: ScanBatch = {
      // A real UUID, because that is the primary key type in Postgres.
      id: newId(),
      name: defaultName,
      status: 'Active',
      created_at: new Date().toLocaleString(),
      receipts: []
    };

    try {
      await createBatch({
        id: newBatch.id,
        name: newBatch.name,
        organizationId: currentUser.organization_id,
        userId: currentUser.id,
      });
      setBatches(prev => [newBatch, ...prev]);
      setBatchSearch('');
      setActiveBatchId(newBatch.id);
      sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, newBatch.id);
      setSaveError(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not create the batch.');
    }
  };

  const handleRenameBatch = async (id: string) => {
    if (!editedBatchName.trim()) return;
    const name = editedBatchName.trim();
    const previous = batches.find(b => b.id === id)?.name;
    setBatches(prev => prev.map(b => (b.id === id ? { ...b, name } : b)));
    setEditingBatchId(null);
    try {
      await renameBatch(id, name);
      setSaveError(null);
    } catch (err: any) {
      // Put the old name back rather than leaving the screen disagreeing
      // with what is actually stored.
      setBatches(prev => prev.map(b => (b.id === id && previous ? { ...b, name: previous } : b)));
      setSaveError(err?.message || 'Could not rename the batch.');
    }
  };

  const handleDeleteBatch = async (id: string) => {
    // Extraction runs on the server now, so a batch can be busy even when it is
    // not the one on screen. Deleting it would leave a job writing rows that
    // no longer have anything to belong to.
    const target = batches.find(b => b.id === id);
    if ((target && (batchIsProcessing(target) || batchIsUploading(target))) || (startingExtraction && id === activeBatchId)) {
      setSaveError('This batch cannot be deleted while an upload or extraction is in progress.');
      return;
    }
    const storedPaths = target?.receipts.flatMap(receipt => receipt.storage_path ? [receipt.storage_path] : []) || [];
    const snapshot = batches;
    const remaining = batches.filter(b => b.id !== id);
    setBatches(remaining);
    if (activeBatchId === id) {
      setBatchSearch('');
      const nextBatchId = remaining.find(batch => batch.status === wantedStatus)?.id || '';
      setActiveBatchId(nextBatchId);
      if (nextBatchId) sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, nextBatchId);
      else sessionStorage.removeItem(ACTIVE_BATCH_STORAGE_KEY);
    }
    setDeletingBatchId(null);
    try {
      await deleteBatch(id);
      try {
        await deleteReceiptImages(storedPaths);
        setSaveError(null);
      } catch (err: any) {
        setSaveError(`Batch deleted, but some stored images could not be cleaned up: ${err?.message || 'unknown error'}`);
      }
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not delete the batch.');
    }
  };

  /**
   * Archives or restores a batch.
   *
   * Nothing is destroyed — the receipts, rows and export history stay exactly
   * where they are, which is what makes this the safe alternative to the delete
   * button people would otherwise reach for to tidy up.
   */
  const handleToggleArchive = async (batch: ScanBatch) => {
    if (batchIsProcessing(batch) || batchIsUploading(batch)) {
      setSaveError('This batch cannot be archived while an upload or extraction is in progress.');
      return;
    }
    const next = batch.status === 'Archived' ? 'Active' : 'Archived';
    const snapshot = batches;
    setBatches(prev => prev.map(b => (b.id === batch.id ? { ...b, status: next } : b)));
    if (activeBatchId === batch.id) {
      const nextBatchId = batches.find(candidate => (
        candidate.id !== batch.id && candidate.status === batch.status
      ))?.id || '';
      setBatchSearch('');
      setActiveBatchId(nextBatchId);
      if (nextBatchId) sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, nextBatchId);
      else sessionStorage.removeItem(ACTIVE_BATCH_STORAGE_KEY);
    }

    try {
      await setBatchStatus(batch.id, next);
      setSaveError(null);
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not update that batch.');
    }
  };

  const handleToggleBatchVisibility = async (batch: ScanBatch) => {
    if (currentUser.role !== 'Admin') return;
    const hidden = !batch.hidden_from_users;
    const snapshot = batches;
    setBatches(prev => prev.map(item => item.id === batch.id ? { ...item, hidden_from_users: hidden } : item));
    setOpenBatchMenuId(null);
    try {
      await setBatchHidden(batch.id, hidden, currentUser.id);
      setSaveError(null);
    } catch (err: any) {
      setBatches(snapshot);
      setSaveError(err?.message || 'Could not update batch visibility.');
    }
  };

  const updateReceipt = (batchId: string, receiptId: string, patch: Partial<Receipt>) => {
    setBatches(previous => previous.map(batch => {
      if (batch.id !== batchId) return batch;
      return {
        ...batch,
        receipts: batch.receipts.map(receipt =>
          receipt.id === receiptId ? { ...receipt, ...patch } : receipt
        ),
      };
    }));
  };

  const drainUploadQueue = async () => {
    if (uploadWorkerRunningRef.current) return;
    uploadWorkerRunningRef.current = true;
    try {
      let task: ReceiptUploadTask | undefined;
      while ((task = uploadQueueRef.current.shift())) {
        updateReceipt(task.batchId, task.receiptId, {
          upload_state: 'uploading',
          upload_error: undefined,
        });

        try {
          // Receipt creation is idempotent, which makes a failed upload safely
          // retryable without replacing server-owned extraction fields.
          const persisted = await createReceipt({
            id: task.receiptId,
            batchId: task.batchId,
            userId: task.userId,
            filename: task.filename,
          });
          if (persisted.created_at || persisted.updated_at) {
            updateReceipt(task.batchId, task.receiptId, {
              created_at: persisted.created_at,
              updated_at: persisted.updated_at,
            });
          }

          // Measurement starts only after the receipt row exists. It may run
          // alongside this file's upload, but the next file still waits for both.
          const dimensionsPromise = task.file.type === 'application/pdf'
            ? Promise.resolve(null)
            : measureImage(task.previewUrl);
          const path = await uploadReceiptImage(task.file, {
            organizationId: task.organizationId,
            batchId: task.batchId,
            receiptId: task.receiptId,
          });
          const dimensions = await dimensionsPromise;
          await updateReceiptRow(task.receiptId, {
            file_path: path,
            ...(dimensions ? {
              image_width: dimensions.width,
              image_height: dimensions.height,
            } : {}),
          });
          updateReceipt(task.batchId, task.receiptId, {
            storage_path: path,
            upload_state: 'uploaded',
            upload_error: undefined,
            ...(dimensions ? {
              image_width: dimensions.width,
              image_height: dimensions.height,
            } : {}),
          });
        } catch (err: any) {
          updateReceipt(task.batchId, task.receiptId, {
            upload_state: 'failed',
            upload_error: err?.message || 'The file could not be uploaded.',
          });
        }
      }
    } finally {
      uploadWorkerRunningRef.current = false;
      // A selection made as the worker was finishing must not be stranded.
      if (uploadQueueRef.current.length) void drainUploadQueue();
    }
  };

  const enqueueUpload = (task: ReceiptUploadTask) => {
    updateReceipt(task.batchId, task.receiptId, {
      upload_state: 'waiting',
      upload_error: undefined,
    });
    uploadQueueRef.current.push(task);
    void drainUploadQueue();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement> | { target: { files: FileList | File[] } }) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (!selectedFiles.length || !activeBatch || !currentUser.organization_id) return;

    const invalidFiles = selectedFiles.filter(file => validateReceiptUploadFile(file));
    const files = selectedFiles.filter(file => !validateReceiptUploadFile(file));
    if (invalidFiles.length) {
      const names = invalidFiles.slice(0, 3).map(file => file.name).join(', ');
      const remainder = invalidFiles.length > 3 ? ` and ${invalidFiles.length - 3} more` : '';
      setUploadValidationError(
        `${invalidFiles.length === 1 ? 'This file was' : 'These files were'} skipped: ${names}${remainder}. ` +
        'Only JPG, JPEG, PNG, WEBP, and PDF files are supported.'
      );
    } else {
      setUploadValidationError(null);
    }

    // Selecting the exact same file again should still trigger onChange.
    if ('value' in e.target) (e.target as HTMLInputElement).value = '';
    if (!files.length) return;

    const batchId = activeBatch.id;
    const firstCreatedAt = Math.max(Date.now(), optimisticReceiptClockRef.current + 1);
    optimisticReceiptClockRef.current = firstCreatedAt + files.length - 1;
    const newReceipts = files.map((file, index) => ({
      receipt: {
        id: newId(),
        filename: file.name,
        status: 'Pending' as const,
        previewUrl: URL.createObjectURL(file),
        upload_state: 'waiting' as const,
        created_at: new Date(firstCreatedAt + index).toISOString(),
        updated_at: new Date(firstCreatedAt + index).toISOString(),
        extraction_generation: 0,
      },
      file,
    }));

    // Functional merge avoids losing an earlier selection made before React has
    // rendered this one. FileList order is retained in the FIFO below.
    setUploadedFilesMap(previous => ({
      ...previous,
      ...Object.fromEntries(newReceipts.map(({ receipt, file }) => [receipt.id, file])),
    }));
    setReceiptPage(1);
    setBatches(previous => previous.map(batch => batch.id === batchId
      ? { ...batch, receipts: [...newReceipts.map(item => item.receipt), ...batch.receipts] }
      : batch));

    for (const { receipt, file } of newReceipts) {
      uploadQueueRef.current.push({
        receiptId: receipt.id,
        filename: receipt.filename,
        previewUrl: receipt.previewUrl,
        file,
        batchId,
        organizationId: currentUser.organization_id,
        userId: currentUser.id,
      });
    }
    void drainUploadQueue();
  };

  const handleRetryUpload = (receipt: Receipt) => {
    if (!activeBatch || !currentUser.organization_id || uploadIsBusy(receipt)) return;
    const file = uploadedFilesMap[receipt.id];
    if (!file) {
      updateReceipt(activeBatch.id, receipt.id, {
        upload_state: 'failed',
        upload_error: 'The original file is no longer available in this browser. Remove this row and upload the file again.',
      });
      return;
    }
    enqueueUpload({
      receiptId: receipt.id,
      filename: receipt.filename,
      previewUrl: receipt.previewUrl,
      file,
      batchId: activeBatch.id,
      organizationId: currentUser.organization_id,
      userId: currentUser.id,
    });
  };

  const handleDeleteReceipt = async (receiptId: string) => {
    if (!activeBatch) return;
    const batchId = activeBatch.id;
    const receipt = activeBatch.receipts.find(r => r.id === receiptId);
    if (receipt && uploadIsBusy(receipt)) {
      setSaveError('Wait for this upload to finish before deleting the receipt.');
      return;
    }
    const snapshot = batches;
    const originalFile = uploadedFilesMap[receiptId];
    const originalTransactions = receiptTransactionsMap[receiptId];

    setUploadedFilesMap(prev => {
      const next = { ...prev };
      delete next[receiptId];
      return next;
    });

    setReceiptTransactionsMap(prev => {
      const next = { ...prev };
      delete next[receiptId];
      return next;
    });

    setBatches(prev => prev.map(b => {
      if (b.id === batchId) {
        return { ...b, receipts: b.receipts.filter(r => r.id !== receiptId) };
      }
      return b;
    }));

    try {
      await deleteReceipt(receiptId);
      if (receipt?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(receipt.previewUrl);
      if (receipt?.storage_path) {
        try {
          await deleteReceiptImages([receipt.storage_path]);
          setSaveError(null);
        } catch (err: any) {
          setSaveError(`Receipt deleted, but its stored image could not be cleaned up: ${err?.message || 'unknown error'}`);
        }
      } else {
        setSaveError(null);
      }
    } catch (err: any) {
      setBatches(snapshot);
      if (originalFile) {
        setUploadedFilesMap(previous => ({ ...previous, [receiptId]: originalFile }));
      }
      if (originalTransactions) {
        setReceiptTransactionsMap(previous => ({ ...previous, [receiptId]: originalTransactions }));
      }
      setSaveError(err?.message || 'Could not delete the receipt.');
    }
  };

  const handleDeleteSelectedReceipts = async () => {
    if (!activeBatch || isArchived || isProcessing) return;
    const ids = filteredReceipts
      .filter(receipt => selectedReceiptIds.has(receipt.id) && !uploadIsBusy(receipt) && receipt.status !== 'Processing')
      .map(receipt => receipt.id);
    if (!ids.length) return;
    setPendingDeleteReceiptIds(ids);
  };

  const confirmDeleteSelectedReceipts = async () => {
    const ids = pendingDeleteReceiptIds;
    if (!ids.length) return;
    setPendingDeleteReceiptIds([]);
    setSelectedReceiptIds(new Set());
    for (const id of ids) await handleDeleteReceipt(id);
  };

  /**
   * Hands one receipt to the server and returns once it has been accepted.
   *
   * Nothing here waits for the extraction itself. The server owns the work from
   * this point, which is what lets the tab be closed without losing it — the
   * result is picked up later by watching the receipt's status.
   */
  const beginExtraction = async (batchId: string, receipt: Receipt): Promise<void> => {
    if (!uploadIsComplete(receipt) || uploadIsBusy(receipt)) return;

    try {
      const accepted = await startReceiptExtraction(receipt.id);
      updateReceipt(batchId, receipt.id, accepted.status === 'Queued'
        ? {
            status: 'Pending',
            enqueue_accepted: true,
            enqueue_error: undefined,
            ...(accepted.extraction_queue_message_id !== undefined
              ? { extraction_queue_message_id: accepted.extraction_queue_message_id }
              : {}),
            ...(accepted.extraction_queued_at !== undefined
              ? { extraction_queued_at: accepted.extraction_queued_at }
              : {}),
            error_message: undefined,
            verification_warnings: undefined,
          }
        : {
            status: accepted.status,
            enqueue_accepted: false,
            enqueue_error: undefined,
            error_message: undefined,
            verification_warnings: undefined,
          });
    } catch (err: any) {
      const message = err?.message || 'Could not start extraction on the server.';
      // Queue/status columns are backend-owned. Keep the durable DB state intact
      // and show this submission failure locally with a retry action.
      updateReceipt(batchId, receipt.id, { enqueue_accepted: false, enqueue_error: message });
    }
  };

  const handleTriggerExtraction = async () => {
    if (!activeBatch) return;
    const batchId = activeBatch.id;

    // US-25: only process receipts that are new or previously failed —
    // successfully extracted receipts are left untouched.
    const targets = activeBatch.receipts
      .filter(r =>
        (r.status === 'Pending' || r.status === 'Failed') &&
        !isReceiptQueued(r) && uploadIsComplete(r)
      )
      // The table intentionally displays newest first; extraction does not.
      // created_at survives refreshes and repeated picker/drop selections.
      .sort(compareReceiptCreationOldestFirst);
    if (!targets.length) return;

    autoOpenRef.current = { batchId, receiptIds: targets.map(r => r.id) };
    setStartingExtraction(true);
    try {
      // Enqueue requests are handed off in receipt order. One rejection is
      // contained by beginExtraction and cannot prevent later receipts.
      for (const receipt of targets) {
        await beginExtraction(batchId, receipt);
      }
    } finally {
      setStartingExtraction(false);
    }
  };

  const handleRetryReceipt = async (receipt: Receipt) => {
    if (!activeBatch) return;
    setStartingExtraction(true);
    try {
      await beginExtraction(activeBatch.id, receipt);
    } finally {
      setStartingExtraction(false);
    }
  };

  const handleOpenReviewer = (receipt: Receipt) => {
    if (!activeBatch) return;
    if (receiptHasImageIssue(receipt)) {
      setSaveError('This image has an issue. Review the warning or preview the image before opening extracted rows.');
      return;
    }
    if (!allReceiptsExtracted) {
      setSaveError('Review & Edit becomes available after every file in this batch has finished extraction.');
      return;
    }
    onSelectBatch(
      activeBatch,
      receipt,
      receiptTransactionsMap[receipt.id] || [],
      receiptTransactionsMap
    );
  };

  const handleReviewSingleReceipt = (receipt: Receipt) => {
    setPreviewRotation(0);
    setPreviewZoom(1);
    setPreviewReceipt(receipt);
  };

  const handleContinueReview = async () => {
    if (!activeBatch || openingReview) return;
    if (activeBatch.receipts.some(receiptHasImageIssue)) {
      setSaveError('One or more uploaded images have an issue. Review or retry them before continuing.');
      return;
    }
    if (!allReceiptsExtracted) {
      setSaveError('Review & Edit becomes available after every file in this batch has finished extraction.');
      return;
    }
    setOpeningReview(true);
    try {
      const transactionMap = await fetchTransactionsForBatch(activeBatch.id);
      setReceiptTransactionsMap(transactionMap);
      const firstExtractedReceipt = activeBatch.receipts.find(r => r.status === 'Extracted');
      if (firstExtractedReceipt) {
        onSelectBatch(
          activeBatch,
          firstExtractedReceipt,
          transactionMap[firstExtractedReceipt.id] || [],
          transactionMap
        );
      }
    } catch (err: any) {
      setSaveError(err?.message || 'Could not load the extracted data for review.');
    } finally {
      setOpeningReview(false);
    }
  };

  const handleDownloadExport = async (record: ExportRecord) => {
    if (!record.file_path) {
      setSaveError('This older export has no stored file. Use Review & Edit to generate a new downloadable copy.');
      return;
    }
    setDownloadingExportId(record.id);
    try {
      await downloadExportFile(record.file_path, record.file_name);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not download that Excel file.');
    } finally {
      setDownloadingExportId(null);
    }
  };

  const isPdfReceipt = (receipt: Receipt) => {
    const file = uploadedFilesMap[receipt.id];
    return file?.type === 'application/pdf' || receipt.filename.toLowerCase().endsWith('.pdf');
  };

  if (loading) {
    return (
      <div className="loading-state loading-state-tall">
        <Loader2 size={18} className="animate-spin" />
        Loading your scan batches...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card panel-message">
        <AlertCircle size={28} className="panel-message-icon tone-rose" />
        <h3>Could not load your batches</h3>
        <p>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="page">
      {saveError && (
        <div className="alert alert-warning alert-top text-xs">
          <AlertTriangle size={15} className="alert-icon" />
          <span className="alert-body">{saveError}</span>
          <button className="alert-dismiss" onClick={() => setSaveError(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}
      {uploadValidationError && (
        <div className="alert alert-warning alert-top text-xs" role="alert">
          <AlertTriangle size={15} className="alert-icon" />
          <span className="alert-body">{uploadValidationError}</span>
          <button
            className="alert-dismiss"
            onClick={() => setUploadValidationError(null)}
            title="Dismiss"
            aria-label="Dismiss upload format warning"
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace-grid">
        <div className="card batch-sidebar">
          <h3 className="batch-sidebar-heading">
            {showArchived ? 'Archived Batches' : 'Your Batches'}
          </h3>
          {!showArchived && (
            <button className="btn btn-primary btn-block-lg" onClick={handleCreateBatch}>
              <FolderPlus size={18} />
              Create New Batch
            </button>
          )}

          <SearchInput
            value={batchSearch}
            onChange={value => {
              setBatchSearch(value);
              setOpenBatchMenuId(null);
            }}
            ariaLabel={showArchived ? 'Search archived batches' : 'Search active batches'}
            placeholder="Search batches or file names…"
            fullWidth
          />
          <div className="batch-creator-filter" role="group" aria-label="Filter batches by creator">
            {([
              ['all', `All (${statusScopedBatches.length})`],
              ['mine', `Mine (${myBatchCount})`],
              ['others', `Others (${otherBatchCount})`],
            ] as const).map(([filter, label]) => (
              <button
                key={filter}
                type="button"
                className={batchCreatorFilter === filter ? 'batch-creator-filter-active' : ''}
                aria-pressed={batchCreatorFilter === filter}
                onClick={() => {
                  setBatchCreatorFilter(filter);
                  setBatchPage(1);
                  setOpenBatchMenuId(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {activeBatchHiddenBySearch && (
            <div className="batch-search-note" role="status">
              <span>Current batch is hidden by this search.</span>
              <button type="button" onClick={() => setBatchSearch('')}>Show it</button>
            </div>
          )}

          {(archivedCount > 0 || showArchived) && (
            <button
              className="btn btn-secondary btn-sm btn-block"
              onClick={() => {
                const nextStatus = showArchived ? 'Active' : 'Archived';
                const nextBatchId = batches.find(batch => batch.status === nextStatus)?.id || '';
                setShowArchived(value => !value);
                setBatchSearch('');
                setActiveBatchId(nextBatchId);
                if (nextBatchId) sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, nextBatchId);
                else sessionStorage.removeItem(ACTIVE_BATCH_STORAGE_KEY);
              }}
            >
              {showArchived
                ? <><ArchiveRestore size={14} /> Back to active batches</>
                : <><Archive size={14} /> View archived ({archivedCount})</>}
            </button>
          )}

          <div className={`batch-list${openBatchMenuId ? ' batch-list-menu-open' : ''}`}>
            {!visibleBatches.length && (
              <div className="batch-list-empty" role="status">
                {statusScopedBatches.length === 0
                  ? (showArchived ? 'Nothing archived yet.' : 'No active batches.')
                  : hasBatchSearch
                    ? `No batches match “${batchSearch.trim()}”.`
                    : batchCreatorFilter === 'mine'
                      ? 'You have not created any batches here.'
                      : 'No batches were created by other users.'}
              </div>
            )}
            {paginatedBatches.map(b => (
              <div
                key={b.id}
                ref={editingBatchId === b.id ? editingBatchRef : undefined}
                className={`batch-item${b.id === activeBatchId ? ' batch-item-active' : ''}${b.created_by !== currentUser.id && b.created_by ? ' batch-item-with-creator' : ''}`}
              >
                {editingBatchId === b.id ? (
                  <div className="row-xs" onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      className="form-input batch-rename-input"
                      value={editedBatchName}
                      onChange={e => setEditedBatchName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameBatch(b.id);
                        if (e.key === 'Escape') setEditingBatchId(null);
                      }}
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="batch-item-content">
                    <button
                      type="button"
                      className="batch-item-select"
                      aria-current={b.id === activeBatchId ? 'true' : undefined}
                      onClick={() => {
                        setActiveBatchId(b.id);
                        setReceiptPage(1);
                        setOpenBatchMenuId(null);
                        sessionStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, b.id);
                      }}
                    >
                      <span className="batch-item-details">
                        <span
                          className="batch-item-name"
                          title="Double-click to rename"
                          onDoubleClick={event => {
                            event.stopPropagation();
                            if (isProcessing && b.id === activeBatchId) return;
                            setEditingBatchId(b.id);
                            setEditedBatchName(b.name);
                          }}
                        >
                          <span>{b.name}</span>
                          {b.hidden_from_users && (
                            <LockKeyhole
                              size={14}
                              className="batch-hidden-icon"
                              aria-label="Hidden from other users"
                            />
                          )}
                        </span>
                        <span className="batch-item-meta">
                          <span>{b.receipts.length} {b.receipts.length === 1 ? 'receipt' : 'receipts'}</span>
                          <span>•</span>
                          <span>{formatBatchDate(b.created_at)}</span>
                          {b.id === activeBatchId && <span className="batch-current-badge">Current</span>}
                        </span>
                        {b.created_by !== currentUser.id && b.created_by && (
                          <span className="batch-item-creator" title={b.created_by}>
                            Created by {b.created_by_name || `ID ${b.created_by}`}
                          </span>
                        )}
                      </span>
                    </button>

                    <div className="batch-menu">
                      <button
                        type="button"
                        className="batch-menu-trigger"
                        aria-label={`Actions for ${b.name}`}
                        aria-haspopup="menu"
                        aria-expanded={openBatchMenuId === b.id}
                        onClick={(event) => {
                          if (openBatchMenuId === b.id) {
                            setOpenBatchMenuId(null);
                            setBatchMenuPosition(null);
                            return;
                          }
                          const rect = event.currentTarget.getBoundingClientRect();
                          setBatchMenuPosition({ top: rect.top, left: Math.max(8, rect.left - 164) });
                          setOpenBatchMenuId(b.id);
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      {openBatchMenuId === b.id && (
                        <div
                          className="batch-menu-popover"
                          role="menu"
                          style={batchMenuPosition ? { top: batchMenuPosition.top, left: batchMenuPosition.left } : undefined}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            disabled={isProcessing && b.id === activeBatchId}
                            onClick={() => {
                              setOpenBatchMenuId(null);
                              setEditingBatchId(b.id);
                              setEditedBatchName(b.name);
                            }}
                          >
                            <Edit2 size={14} /> Rename
                          </button>
                          {currentUser.role === 'Admin' && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => handleToggleBatchVisibility(b)}
                            >
                              {b.hidden_from_users ? <Eye size={14} /> : <EyeOff size={14} />}
                              {b.hidden_from_users ? 'Show to other users' : 'Hide from other users'}
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            disabled={batchIsProcessing(b) || batchIsUploading(b)}
                            onClick={() => {
                              setOpenBatchMenuId(null);
                              handleToggleArchive(b);
                            }}
                          >
                            {b.status === 'Archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                            {b.status === 'Archived' ? 'Restore' : 'Archive'}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="batch-menu-danger"
                            disabled={batchIsProcessing(b) || batchIsUploading(b) || (startingExtraction && b.id === activeBatchId)}
                            onClick={() => {
                              setOpenBatchMenuId(null);
                              if (b.receipts.length === 0) handleDeleteBatch(b.id);
                              else setDeletingBatchId(b.id);
                            }}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {batchPageCount > 1 && (
              <div className="files-pagination batch-pagination" aria-label="Batch pages">
                <span className="pagination-summary">
                  Showing {(visibleBatchPage - 1) * BATCHES_PER_PAGE + 1}–{Math.min(visibleBatchPage * BATCHES_PER_PAGE, visibleBatches.length)} of {visibleBatches.length}
                </span>
                <div className="pagination-controls">
                  <button
                    type="button"
                    className="pagination-arrow"
                    onClick={() => setBatchPage(page => Math.max(1, page - 1))}
                    disabled={visibleBatchPage === 1}
                    aria-label="Previous batch page"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  {Array.from({ length: batchPageCount }, (_, index) => index + 1).map(page => (
                    <button
                      type="button"
                      key={page}
                      className={`pagination-page${visibleBatchPage === page ? ' pagination-page-active' : ''}`}
                      onClick={() => setBatchPage(page)}
                      aria-current={visibleBatchPage === page ? 'page' : undefined}
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="pagination-arrow"
                    onClick={() => setBatchPage(page => Math.min(batchPageCount, page + 1))}
                    disabled={visibleBatchPage === batchPageCount}
                    aria-label="Next batch page"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {!activeBatch ? (
          <div className="card empty-batches">
            <div className="empty-batches-art" aria-hidden="true">
              <div className="empty-folder"><FolderOpen size={48} /></div>
              <div className="empty-file empty-file-left"><FileText size={19} /></div>
              <div className="empty-file empty-file-right"><Camera size={18} /></div>
            </div>
            <h3>
              {showArchived ? 'Nothing archived' : 'Start your first scan'}
            </h3>
            <p>
              {showArchived
                ? 'Batches you archive are kept here, out of the way but never deleted.'
                : 'Create a batch to upload handwritten vouchers.'}
            </p>
          </div>
        ) : (
        <div className="batch-panel">
          <div className="batch-header">
            <div>
              <h3>{activeBatch.name}</h3>
              <p>
                {activeBatch.receipts.length} receipt images · Upload and review files below
              </p>
              {lowResPendingCount > 0 && (
                <p className="batch-lowres-warning">
                  <AlertTriangle size={14} />
                  {lowResPendingCount === 1
                    ? '1 photo is low resolution — you may want to retake it before extracting.'
                    : `${lowResPendingCount} photos are low resolution — you may want to retake them before extracting.`}
                </p>
              )}
            </div>

            <div className="row-sm" style={{ gap: '8px' }}>
              <button
                className="btn btn-primary"
                onClick={allReceiptsExtracted ? handleContinueReview : handleTriggerExtraction}
              // Archiving stops new work, not access to old work: a fully
              // extracted archived batch can still be opened and exported, so
              // the archive guard applies to extraction only.
              disabled={
                isUploading ||
                isProcessing ||
                openingReview ||
                (!allReceiptsExtracted && (!extractableCount || isArchived))
              }
              title={isArchived && !allReceiptsExtracted
                ? 'This batch is archived. Restore it to extract more receipts.'
                : undefined}
              >
              {openingReview ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Opening review...
                </>
              ) : isUploading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Uploading receipts in order...
                </>
              ) : isProcessing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Queued / extracting...
                </>
              ) : (
                <>
                  {allReceiptsExtracted
                    ? <><FileText size={16} /> Continue Review</>
                    : extractableCount
                    ? <><Play size={16} /> Extract {extractableCount} {extractableCount === 1 ? 'Receipt' : 'Receipts'}</>
                    : <><Play size={16} /> Extract Receipts</>}
                </>
              )}
              </button>
              {allReceiptsExtracted && exportHistory[0]?.file_path && (
                <button
                  type="button"
                  className="btn btn-icon latest-export-download"
                  onClick={() => handleDownloadExport(exportHistory[0])}
                  disabled={downloadingExportId === exportHistory[0].id}
                  title="Download the latest Excel export for this batch"
                  aria-label="Download the latest Excel export for this batch"
                >
                  {downloadingExportId === exportHistory[0].id
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Download size={16} />}
                </button>
              )}
            </div>
          </div>

          <div
            className={`card dropzone${dragOver ? ' dropzone-active' : ''}${uploadsLocked ? ' dropzone-locked' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!uploadsLocked) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (uploadsLocked) return;
              handleFileUpload({ target: { files: e.dataTransfer.files } });
            }}
          >
            <input
              type="file"
              className="dropzone-input"
              multiple
              accept={RECEIPT_UPLOAD_ACCEPT}
              onChange={handleFileUpload}
              disabled={uploadsLocked}
            />
            <div className="dropzone-icon">
              <UploadCloud size={28} />
            </div>

            <h4 className="dropzone-title">
              {isArchived ? 'This Batch is Archived'
                : isProcessing ? 'Extraction in Progress — Uploads Locked'
                : isUploading ? 'Uploading Receipts One at a Time'
                : `Upload to ${activeBatch.name}`}
            </h4>
            <p className="dropzone-text">
              {isArchived ? 'Everything in it is still readable and exportable. Restore it to add more receipts.'
                : isProcessing ? 'Please wait for the current batch to finish processing before adding more receipts.'
                : isUploading ? 'New files can be added here and will join the end of the upload queue.'
                : 'Drag and drop handwritten vouchers here, or browse your files'}
            </p>
            <div className="dropzone-cta">
              <span className="btn btn-secondary btn-sm">
                <Camera size={14} /> Upload Photo / Browse Files
              </span>
            </div>
          </div>

          <div className="card">
            <div className="receipt-table-toolbar">
              <h4 className="section-title">
                Files in {activeBatch.name} ({activeBatch.receipts.length})
              </h4>
              <div className="receipt-table-toolbar-actions">
                {selectedReceiptIds.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm files-delete-selected"
                    onClick={handleDeleteSelectedReceipts}
                    disabled={isArchived || isProcessing}
                  >
                    <Trash2 size={14} /> Delete ({selectedReceiptIds.size})
                  </button>
                )}
                <label className="files-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    value={receiptSearch}
                    onChange={event => setReceiptSearch(event.target.value)}
                    placeholder="Search file names"
                    aria-label="Search files in this batch"
                  />
                </label>
                <StatusFilter
                  value={receiptStatusFilter}
                  onChange={value => {
                    setReceiptStatusFilter(value);
                    setReceiptPage(1);
                  }}
                  ariaLabel="Filter receipt files by status"
                  options={[
                    { value: 'All', label: `All statuses (${activeReceipts.length})` },
                    ...RECEIPT_FILTER_STATUSES.map(status => ({
                      value: status,
                      label: `${status} (${receiptStatusCounts[status]})`,
                    })),
                  ]}
                />
              </div>
            </div>

            {!activeBatch.receipts.length ? (
              <div className="table-empty text-sm" style={{ padding: '24px' }}>
                No receipts uploaded in this batch yet. Use the upload box above to add paper receipt photos.
              </div>
            ) : (
              <div className="table-container">
                <table className="custom-table receipt-file-table">
                  <thead>
                    <tr>
                      <th>
                        <label className="file-select-control">
                          <input
                            type="checkbox"
                            checked={filteredReceipts.length > 0 && filteredReceipts.every(receipt => selectedReceiptIds.has(receipt.id))}
                            disabled={isArchived || isProcessing || !filteredReceipts.length}
                            onChange={event => setSelectedReceiptIds(previous => {
                              const next = new Set(previous);
                              filteredReceipts.forEach(receipt => event.target.checked ? next.add(receipt.id) : next.delete(receipt.id));
                              return next;
                            })}
                            aria-label="Select all visible files"
                          />
                          <span>File Name</span>
                        </label>
                      </th>
                      <th>Extraction Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedReceipts.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="table-empty">
                          No receipts match this status.
                        </td>
                      </tr>
                    ) : paginatedReceipts.map(rcpt => (
                      <tr key={rcpt.id}>
                        <td style={{ fontWeight: 500 }}>
                          <div className="file-cell">
                            <input
                              type="checkbox"
                              checked={selectedReceiptIds.has(rcpt.id)}
                              disabled={isArchived || isProcessing || uploadIsBusy(rcpt) || rcpt.status === 'Processing'}
                              onChange={event => setSelectedReceiptIds(previous => {
                                const next = new Set(previous);
                                if (event.target.checked) next.add(rcpt.id);
                                else next.delete(rcpt.id);
                                return next;
                              })}
                              aria-label={`Select ${rcpt.filename}`}
                            />
                            <FileText size={16} color="var(--primary)" />
                            {rcpt.filename}
                          </div>
                          {isLowResolution(rcpt) && (
                            <div
                              className="file-warning"
                              title={`This photo is ${rcpt.image_width}x${rcpt.image_height}. Vouchers read reliably at about 1350x1800.`}
                            >
                              <AlertTriangle size={12} />
                              <span>
                                This photo may be difficult to read. Try uploading a closer, clearer photo.
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="stack-xs receipt-status-stack">
                            <ReceiptStatusBadge receipt={rcpt} />
                            {rcpt.upload_state === 'failed' && rcpt.upload_error && (
                              <span className="receipt-error">{readableReceiptError(rcpt.upload_error)}</span>
                            )}
                            {rcpt.enqueue_error && (
                              <span className="receipt-error">{readableReceiptError(rcpt.enqueue_error)}</span>
                            )}
                            {rcpt.status === 'Failed' && rcpt.error_message && (
                              <span className="receipt-error">{readableReceiptError(rcpt.error_message)}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="row-actions receipt-row-actions">
                            <button
                              className="btn btn-secondary btn-sm preview-image-button"
                              onClick={() => handleReviewSingleReceipt(rcpt)}
                              title="Preview Image"
                              aria-label="Preview Image"
                            >
                              <ZoomIn size={15} />
                            </button>

                            {/* The way back into extracted rows on a later
                                visit — without this the reviewer is reachable
                                only in the session that ran the extraction. */}
                            {allReceiptsExtracted && rcpt.status === 'Extracted' && (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleOpenReviewer(rcpt)}
                                title="Review and edit the extracted rows"
                              >
                                Review &amp; Edit
                              </button>
                            )}

                            {rcpt.upload_state === 'failed' && (
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleRetryUpload(rcpt)}
                                title="Retry Upload"
                                disabled={isProcessing || uploadIsBusy(rcpt)}
                              >
                                <RotateCw size={13} /> Retry Upload
                              </button>
                            )}

                            {uploadIsComplete(rcpt) && (rcpt.status === 'Failed' || rcpt.enqueue_error) && !isReceiptQueued(rcpt) && (
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleRetryReceipt(rcpt)}
                                title="Retry Extraction"
                                disabled={uploadsLocked}
                              >
                                <RotateCw size={13} /> Retry
                              </button>
                            )}

                            {rcpt.status !== 'Processing' && !isReceiptQueued(rcpt) && !isArchived && (
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => handleDeleteReceipt(rcpt.id)}
                                title="Delete Receipt"
                                disabled={isProcessing || uploadIsBusy(rcpt)}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {receiptPageCount > 1 && (
                  <div className="files-pagination" aria-label="Receipt file pages">
                    <span className="pagination-summary">
                      Showing {(visibleReceiptPage - 1) * RECEIPTS_PER_PAGE + 1}–{Math.min(visibleReceiptPage * RECEIPTS_PER_PAGE, filteredReceipts.length)} of {filteredReceipts.length}
                    </span>
                    <div className="pagination-controls">
                      <button
                        type="button"
                        className="pagination-arrow"
                        onClick={() => setReceiptPage(page => Math.max(1, page - 1))}
                        disabled={visibleReceiptPage === 1}
                        aria-label="Previous receipt page"
                      >
                        <ChevronLeft size={15} />
                      </button>
                      {Array.from({ length: receiptPageCount }, (_, index) => index + 1).map(page => (
                        <button
                          type="button"
                          key={page}
                          className={`pagination-page${visibleReceiptPage === page ? ' pagination-page-active' : ''}`}
                          onClick={() => setReceiptPage(page)}
                          aria-current={visibleReceiptPage === page ? 'page' : undefined}
                        >
                          {page}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="pagination-arrow"
                        onClick={() => setReceiptPage(page => Math.min(receiptPageCount, page + 1))}
                        disabled={visibleReceiptPage === receiptPageCount}
                        aria-label="Next receipt page"
                      >
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* The spreadsheet is imported into Tally by hand, so this is the only
              record that it happened — and the only way to answer "has this
              already been posted?" before someone posts it twice. */}
          {exportHistory.length > 0 && (
            <div className="card">
              <h4 className="section-title">
                <FileSpreadsheet size={17} color="var(--primary)" />
                Tally Exported
              </h4>
              <div className="table-container">
                <table className="custom-table">
                  <thead>
                    <tr><th>File Name</th><th>Generated By</th><th>When</th><th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {exportHistory.map(record => (
                      <tr key={record.id}>
                        <td style={{ fontWeight: 500 }}>{record.file_name}</td>
                        <td className="text-muted">{record.generated_by_name || '—'}</td>
                        <td className="text-muted text-xs">{record.created_at}</td>
                        <td>
                          {record.file_path ? (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleDownloadExport(record)}
                              disabled={downloadingExportId === record.id}
                            >
                              {downloadingExportId === record.id
                                ? <Loader2 size={13} className="animate-spin" />
                                : <FileSpreadsheet size={13} />} Download
                            </button>
                          ) : (
                            <span className="text-muted text-xs">Older export</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {pendingDeleteReceiptIds.length > 0 && (
        <div className="modal-overlay modal-overlay-top" onClick={() => setPendingDeleteReceiptIds([])}>
          <div className="modal modal-confirm" role="dialog" aria-modal="true" aria-labelledby="delete-files-title" onClick={event => event.stopPropagation()}>
            <div className="modal-icon modal-icon-danger"><Trash2 size={24} /></div>
            <h3 className="modal-title" id="delete-files-title">
              Delete {pendingDeleteReceiptIds.length === 1 ? 'file' : 'files'}?
            </h3>
            <p className="modal-text">
              Delete <strong>{pendingDeleteReceiptIds.length} selected {pendingDeleteReceiptIds.length === 1 ? 'file' : 'files'}</strong> permanently? This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPendingDeleteReceiptIds([])}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-danger-solid" onClick={confirmDeleteSelectedReceipts}>
                <Trash2 size={15} /> Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingBatchId && (
        <div className="modal-overlay">
          <div className="modal modal-confirm">
            <div className="modal-icon modal-icon-danger">
              <Trash2 size={24} />
            </div>
            <h3 className="modal-title">Delete Batch?</h3>
            <p className="modal-text">
              Are you sure you want to delete <strong>"{batches.find(b => b.id === deletingBatchId)?.name}"</strong>? This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeletingBatchId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-danger-solid"
                onClick={() => handleDeleteBatch(deletingBatchId)}
              >
                <Trash2 size={15} /> Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {previewReceipt && (
        <div className="modal-overlay modal-overlay-top" onClick={() => setPreviewReceipt(null)}>
          <div className="card preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="row row-between">
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Image Preview</h3>
              <span className="text-muted text-xs">{previewReceipt.filename} · Use ← → to browse</span>
            </div>

            <div
              className="preview-stage"
              onWheel={event => {
                if (isPdfReceipt(previewReceipt)) return;
                event.preventDefault();
                setPreviewZoom(zoom => Math.max(1, Math.min(3, zoom - event.deltaY * 0.002)));
              }}
            >
              {isPdfReceipt(previewReceipt) ? (
                <iframe
                  className="preview-frame"
                  src={previewReceipt.previewUrl}
                  title={previewReceipt.filename}
                />
              ) : (
                <img
                  className="preview-img"
                  src={previewReceipt.previewUrl}
                  alt={previewReceipt.filename}
                  onDoubleClick={() => setPreviewZoom(zoom => zoom > 1 ? 1 : 2)}
                  // Rotation swaps which axis is constrained, so these two are
                  // genuinely dynamic and stay inline.
                  style={{
                    transform: `rotate(${previewRotation}deg) scale(${previewZoom})`,
                    maxWidth: Math.abs(previewRotation % 180) === 90 ? '68vh' : '100%',
                    maxHeight: Math.abs(previewRotation % 180) === 90 ? '100%' : '68vh',
                  }}
                />
              )}

              {!isPdfReceipt(previewReceipt) && (
                <div className="rotate-bar">
                  {!isArchived && !isProcessing && !uploadIsBusy(previewReceipt) && previewReceipt.status !== 'Processing' && (
                    <button
                      type="button"
                      className="rotate-btn preview-delete-control"
                      title="Delete file"
                      onClick={() => {
                        setPreviewReceipt(null);
                        setPendingDeleteReceiptIds([previewReceipt.id]);
                      }}
                    >
                      <Trash2 size={22} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="rotate-btn"
                    title="Rotate Left"
                    onClick={() => setPreviewRotation(r => r - 90)}
                  >
                    <RotateCcw size={22} />
                  </button>
                  <button
                    type="button"
                    className="rotate-btn"
                    title="Rotate Right"
                    onClick={() => setPreviewRotation(r => r + 90)}
                  >
                    <RotateCw size={22} />
                  </button>
                  <button type="button" className="rotate-btn zoom-icon-control" title={previewZoom > 1 ? 'Reset zoom' : 'Zoom image'} onClick={() => setPreviewZoom(zoom => zoom > 1 ? 1 : 2)}>
                    <ZoomIn size={22} />
                  </button>
                </div>
              )}
            </div>

            <div className="row row-end">
              <button className="btn btn-secondary" onClick={() => setPreviewReceipt(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
