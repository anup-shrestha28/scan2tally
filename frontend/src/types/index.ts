export type UserRole = 'Super Admin' | 'Admin' | 'Operator';
export type OrgStatus = 'Active' | 'Inactive';
export type UserStatus = 'Active' | 'Inactive';
export type BatchStatus = 'Active' | 'Archived';
export type ReceiptStatus = 'Pending' | 'Processing' | 'Extracted' | 'Failed';
export type ReceiptDisplayStatus = ReceiptStatus | 'Queued';
export type ReceiptUploadState = 'waiting' | 'uploading' | 'uploaded' | 'failed';
export type EntryType = 'Dr' | 'Cr';

/**
 * How confident we are that a row's ledger name is one Tally will accept.
 *
 * 'Unchecked' means the organisation has no chart of accounts yet, so there was
 * nothing to check against — deliberately distinct from 'Unmatched', which means
 * we did check and the name is not there.
 */
export type LedgerMatchState = 'Unchecked' | 'Exact' | 'Alias' | 'Suggested' | 'Unmatched';

/** One account in an organisation's chart of accounts, as it exists in Tally. */
export interface Ledger {
  id: string;
  name: string;
  parent_group?: string;
  /** Other spellings staff write by hand, treated as equal to the name itself. */
  aliases: string[];
  is_active: boolean;
}

export interface Organization {
  id: string;
  name: string;
  status: OrgStatus;
  usersCount?: number;
  created_at: string;
}

export interface User {
  id: string;
  organization_id?: string | null;
  name: string;
  email: string;
  phone?: string;
  designation?: string;
  role: UserRole;
  status: UserStatus;
  orgId?: string | null;
  orgName?: string;
}

/** Privacy-limited colleague data available to an Operator's read-only view. */
export interface TeamDirectoryMember {
  id: string;
  name: string;
  designation?: string;
  role: UserRole;
}

export type CapacityLevel = 'healthy' | 'warning' | 'critical' | 'full';
export type CapacityResource = 'storage' | 'database';
export type CapacityConnectionState = 'connecting' | 'live' | 'retrying';

/**
 * A sanitized project-capacity state published for signed-in staff.
 *
 * Unlike PlatformUsage, this never contains byte counts, quotas, or bucket
 * details. Admins and Operators can therefore receive it directly through
 * Supabase Realtime without exposing the Super Admin's operational metrics.
 */
export interface CapacityAlert {
  resource: CapacityResource;
  level: CapacityLevel;
  percent: number;
  title: string;
  message: string;
  revision: number;
  changedAt: string;
}

export interface CapacityMetric {
  usedBytes: number;
  quotaBytes: number;
  percent: number;
  /** Super Admin only. */
  objectCount?: number;
  /** Super Admin only; keyed by Supabase bucket id. */
  byBucket?: Record<string, number>;
}

export interface PlatformUsage {
  level: CapacityLevel;
  resource: CapacityResource;
  percent: number;
  message: string;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  checkedAt: string;
  /** Full uses the protected SQL metric; storage-only is the live API fallback. */
  monitoringMode: 'full' | 'storage-only';
  /** Exact metrics come only from the Super-Admin-only backend endpoint. */
  storage?: CapacityMetric;
  database?: CapacityMetric;
}

export interface Receipt {
  id: string;
  filename: string;
  status: ReceiptStatus;
  previewUrl: string;
  /** Raw database timestamps retained for durable FIFO and state ordering. */
  created_at?: string;
  updated_at?: string;
  // Measured from the image after upload, so we can warn about photos too
  // small to read reliably before spending an extraction on them.
  image_width?: number;
  image_height?: number;
  // Path inside the private 'receipts' storage bucket. previewUrl is a
  // short-lived signed URL derived from this, so only the path is durable.
  storage_path?: string;
  /**
   * Durable queue marker written by the backend. Pending + a message id is the
   * user-facing Queued state; the receipt_status enum deliberately stays small.
   */
  extraction_queue_message_id?: number | null;
  extraction_queued_at?: string | null;
  /** Incremented by the backend for each extraction/retry generation. */
  extraction_generation?: number;
  /** Brief client-side bridge between a successful 202 and the Realtime row. */
  enqueue_accepted?: boolean;
  enqueue_error?: string;
  /** Upload progress is local; a stored file_path is the durable success flag. */
  upload_state?: ReceiptUploadState;
  upload_error?: string;
  error_message?: string;
  // Reconciliation notices from the backend (e.g. the extracted rows disagree
  // with the voucher's printed जम्मा total). Advisory only — the receipt is
  // still Extracted and editable; these just point the reviewer at what to check.
  verification_warnings?: string[];
}

export interface ScanBatch {
  id: string;
  name: string;
  status: BatchStatus;
  created_at: string;
  receipts: Receipt[];
}

export interface Transaction {
  id: string;
  receipt_id?: string;
  voucher_date: string;
  voucher_type: string;
  entry_type: EntryType; // 'Dr' or 'Cr'
  /**
   * The name that gets exported. Holds the canonical Tally spelling once the row
   * is confidently matched to a ledger, and the name as written on the paper
   * while the match is still only a suggestion.
   */
  ledger_name: string;
  /** Which ledger in the organisation's chart of accounts this resolved to. */
  ledger_id?: string | null;
  ledger_match?: LedgerMatchState;
  /** Similarity behind a 'Suggested' match, 0-1. Absent in every other state. */
  ledger_match_score?: number | null;
  debit_ledger?: string; // Legacy compatibility
  credit_ledger?: string; // Legacy compatibility
  // Single source of truth for money. A legacy flat `amount` may arrive on the
  // wire, but it is resolved onto one of these two at ingestion (see
  // BatchWorkspace) and never carried into app state.
  debit_amount: number;
  credit_amount: number;
  narration: string;
  // Set when independent extraction passes disagreed on this row's amount, i.e.
  // the handwriting could not be read reliably. The value shown is the majority
  // reading, so it is a starting point to verify — not a trusted figure.
  needs_review?: boolean;
}
