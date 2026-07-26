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
  error_message?: string;
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
  debit_amount: number;
  credit_amount: number;
  amount?: number; // Legacy compatibility
  narration: string;
}
