export type UserRole = 'Super Admin' | 'Admin' | 'Operator';
export type OrgStatus = 'Active' | 'Inactive';
export type UserStatus = 'Active' | 'Inactive';
export type BatchStatus = 'Active' | 'Archived';
export type ReceiptStatus = 'Pending' | 'Processing' | 'Extracted' | 'Failed';
export type EntryType = 'Dr' | 'Cr';

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
  ledger_name: string;
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
