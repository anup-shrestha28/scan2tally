export type UserRole = 'Super Admin' | 'Admin' | 'Operator';
export type OrgStatus = 'Active' | 'Inactive';
export type UserStatus = 'Active' | 'Inactive';
export type BatchStatus = 'Active' | 'Archived';
export type ReceiptStatus = 'Pending' | 'Processing' | 'Extracted' | 'Failed';
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

export interface Receipt {
  id: string;
  filename: string;
  status: ReceiptStatus;
  previewUrl: string;
  // Measured from the image after upload, so we can warn about photos too
  // small to read reliably before spending an extraction on them.
  image_width?: number;
  image_height?: number;
  // Path inside the private 'receipts' storage bucket. previewUrl is a
  // short-lived signed URL derived from this, so only the path is durable.
  storage_path?: string;
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
