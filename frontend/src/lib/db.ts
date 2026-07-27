import { supabase } from './supabase';
import { ScanBatch, Receipt, Transaction, User, UserRole, Organization } from '../types';

/**
 * Every read and write goes through here.
 *
 * Row-level security in Postgres decides what a signed-in user may touch, so
 * these functions never filter by organisation themselves — doing so in the
 * client would be duplicated logic that could silently drift from the policies
 * that actually enforce isolation.
 */

const RECEIPTS_BUCKET = 'receipts';

/** Primary keys are UUIDs in Postgres, so ids must be generated in that shape. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for non-secure contexts, where crypto.randomUUID is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------- auth

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/**
 * Loads the profile row for the signed-in user.
 *
 * Returns null when there is no session, and throws when a session exists but
 * has no matching profile — that means the account was created in Auth without
 * a users row, and silently treating it as "logged out" would send someone
 * round the login screen forever with no explanation.
 */
export async function fetchCurrentUser(): Promise<User | null> {
  const { data: sessionData } = await supabase.auth.getUser();
  const authUser = sessionData?.user;
  if (!authUser) return null;

  const { data, error } = await supabase
    .from('users')
    .select('id, organization_id, name, email, phone, designation, role, status')
    .eq('id', authUser.id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error(
      'Your login exists but no user profile is set up for it. Please ask an administrator to finish creating your account.'
    );
  }
  if (data.status === 'Inactive') {
    await signOut();
    throw new Error('This account has been deactivated. Please contact your administrator.');
  }

  let orgName: string | undefined;
  if (data.organization_id) {
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', data.organization_id)
      .maybeSingle();
    orgName = org?.name;
  }

  return {
    id: data.id,
    organization_id: data.organization_id,
    orgId: data.organization_id,
    orgName,
    name: data.name,
    email: data.email,
    phone: data.phone || undefined,
    designation: data.designation || undefined,
    role: data.role as UserRole,
    status: data.status,
  };
}

// ---------------------------------------------------------------- user management

/** Staff in the caller's organisation. RLS scopes this to their own org. */
export async function fetchOrgUsers(): Promise<User[]> {
  const { data, error } = await supabase
    .from('users')
    .select('id, organization_id, name, email, phone, designation, role, status, created_at')
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map((u: any) => ({
    id: u.id,
    organization_id: u.organization_id,
    orgId: u.organization_id,
    name: u.name,
    email: u.email,
    phone: u.phone || undefined,
    designation: u.designation || undefined,
    role: u.role as UserRole,
    status: u.status,
  }));
}

/**
 * Creates a login.
 *
 * Goes through the backend because minting an account needs the service role
 * key, which must never be shipped to a browser. The caller's own session token
 * is forwarded so the server can check they are actually allowed to do this —
 * the role is re-read server-side, never trusted from here.
 */
export async function createUserAccount(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  designation?: string;
  phone?: string;
  organizationId?: string | null;
}): Promise<User> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');

  const base = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';
  const res = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      password: input.password,
      role: input.role,
      designation: input.designation || '',
      phone: input.phone || '',
      organization_id: input.organizationId ?? null,
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.detail || 'Could not create the account.');
  }
  return {
    id: body.id,
    organization_id: body.organization_id,
    orgId: body.organization_id,
    name: body.name,
    email: body.email,
    role: body.role as UserRole,
    status: body.status,
  };
}

/** Deactivating blocks sign-in while keeping the person's history intact. */
export async function setUserStatus(userId: string, status: 'Active' | 'Inactive'): Promise<void> {
  const { error } = await supabase.from('users').update({ status }).eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function fetchOrganizations(): Promise<{ id: string; name: string; status: string }[]> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, status')
    .order('name');
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------- organisations (Super Admin)

/** Organisations with their real staff counts, for the platform dashboard. */
export async function fetchOrganizationsWithStats(): Promise<Organization[]> {
  const [{ data: orgs, error: orgErr }, { data: users, error: userErr }] = await Promise.all([
    supabase.from('organizations').select('id, name, status, created_at').order('created_at'),
    supabase.from('users').select('id, organization_id, status'),
  ]);
  if (orgErr) throw new Error(orgErr.message);
  if (userErr) throw new Error(userErr.message);

  const activePerOrg = new Map<string, number>();
  for (const u of users || []) {
    if (u.status !== 'Active' || !u.organization_id) continue;
    activePerOrg.set(u.organization_id, (activePerOrg.get(u.organization_id) || 0) + 1);
  }

  return (orgs || []).map((o: any) => ({
    id: o.id,
    name: o.name,
    status: o.status,
    usersCount: activePerOrg.get(o.id) || 0,
    created_at: o.created_at ? String(o.created_at).slice(0, 10) : '',
  }));
}

export async function createOrganization(name: string): Promise<Organization> {
  const { data, error } = await supabase
    .from('organizations')
    .insert({ name: name.trim(), status: 'Active' })
    .select('id, name, status, created_at')
    .single();
  if (error) throw new Error(error.message);
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    usersCount: 0,
    created_at: data.created_at ? String(data.created_at).slice(0, 10) : '',
  };
}

export async function setOrganizationStatus(id: string, status: 'Active' | 'Inactive'): Promise<void> {
  const { error } = await supabase.from('organizations').update({ status }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Platform-wide counts for the Super Admin summary tiles. */
export async function fetchPlatformStats(): Promise<{ activeUsers: number; receipts: number; batches: number }> {
  const [users, receipts, batches] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('status', 'Active'),
    supabase.from('receipts').select('id', { count: 'exact', head: true }),
    supabase.from('scan_batches').select('id', { count: 'exact', head: true }),
  ]);
  return {
    activeUsers: users.count ?? 0,
    receipts: receipts.count ?? 0,
    batches: batches.count ?? 0,
  };
}

// ---------------------------------------------------------------- batches

/** Loads batches with their receipts in one round trip. */
export async function fetchBatches(): Promise<ScanBatch[]> {
  const { data, error } = await supabase
    .from('scan_batches')
    .select(`
      id, name, status, created_at,
      receipts (
        id, filename, file_path, status, error_message,
        image_width, image_height, verification_warnings, created_at
      )
    `)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data || []).map((b: any) => ({
    id: b.id,
    name: b.name,
    status: b.status,
    created_at: new Date(b.created_at).toLocaleString(),
    receipts: (b.receipts || [])
      .slice()
      .sort((x: any, y: any) => String(x.created_at).localeCompare(String(y.created_at)))
      .map(
        (r: any): Receipt => ({
          id: r.id,
          filename: r.filename,
          status: r.status,
          // Resolved lazily via a signed URL; the stored path is not a URL.
          previewUrl: '',
          storage_path: r.file_path || undefined,
          image_width: r.image_width ?? undefined,
          image_height: r.image_height ?? undefined,
          error_message: r.error_message || undefined,
          verification_warnings: Array.isArray(r.verification_warnings)
            ? r.verification_warnings
            : undefined,
        })
      ),
  }));
}

export async function createBatch(batch: {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { error } = await supabase.from('scan_batches').insert({
    id: batch.id,
    name: batch.name,
    organization_id: batch.organizationId,
    created_by: batch.userId,
    status: 'Active',
  });
  if (error) throw new Error(error.message);
}

export async function renameBatch(id: string, name: string): Promise<void> {
  const { error } = await supabase.from('scan_batches').update({ name }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteBatch(id: string): Promise<void> {
  // Receipts and transactions cascade in the schema.
  const { error } = await supabase.from('scan_batches').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- receipts

export async function createReceipt(receipt: {
  id: string;
  batchId: string;
  userId: string;
  filename: string;
}): Promise<void> {
  const { error } = await supabase.from('receipts').insert({
    id: receipt.id,
    batch_id: receipt.batchId,
    uploaded_by: receipt.userId,
    filename: receipt.filename,
    status: 'Pending',
  });
  if (error) throw new Error(error.message);
}

export async function updateReceiptRow(
  id: string,
  patch: Partial<{
    status: string;
    error_message: string | null;
    file_path: string | null;
    image_width: number | null;
    image_height: number | null;
    verification_warnings: string[];
  }>
): Promise<void> {
  const { error } = await supabase.from('receipts').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteReceipt(id: string): Promise<void> {
  const { error } = await supabase.from('receipts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- images

/**
 * Uploads under <org>/<batch>/<receipt> because the storage policies scope
 * access by the first path segment.
 */
export async function uploadReceiptImage(
  file: File,
  ids: { organizationId: string; batchId: string; receiptId: string }
): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${ids.organizationId}/${ids.batchId}/${ids.receiptId}.${ext}`;

  const { error } = await supabase.storage
    .from(RECEIPTS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });

  if (error) throw new Error(error.message);
  return path;
}

/** The bucket is private, so viewing needs a short-lived signed URL. */
export async function getReceiptImageUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await supabase.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function downloadReceiptImage(path: string): Promise<File | null> {
  const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).download(path);
  if (error || !data) return null;
  const name = path.split('/').pop() || 'receipt.jpg';
  return new File([data], name, { type: data.type || 'image/jpeg' });
}

// ---------------------------------------------------------------- transactions

export async function fetchTransactionsForBatch(
  batchId: string
): Promise<Record<string, Transaction[]>> {
  const { data, error } = await supabase
    .from('transactions')
    .select(
      'id, receipt_id, position, voucher_date, voucher_type, entry_type, ledger_name, debit_amount, credit_amount, needs_review, narration'
    )
    .eq('batch_id', batchId)
    .order('position', { ascending: true });

  if (error) throw new Error(error.message);

  const grouped: Record<string, Transaction[]> = {};
  for (const row of data || []) {
    const tx: Transaction = {
      id: row.id,
      receipt_id: row.receipt_id,
      voucher_date: row.voucher_date || '',
      voucher_type: row.voucher_type || 'Journal',
      entry_type: row.entry_type,
      ledger_name: row.ledger_name || '',
      debit_amount: Number(row.debit_amount) || 0,
      credit_amount: Number(row.credit_amount) || 0,
      needs_review: row.needs_review || undefined,
      narration: row.narration || '',
    };
    (grouped[row.receipt_id] ||= []).push(tx);
  }
  return grouped;
}

/**
 * Replaces every line for a receipt.
 *
 * Delete-then-insert rather than diffing: a voucher is a small, self-contained
 * set of lines that the reviewer freely adds to, removes from and reorders, so
 * matching rows up individually buys nothing and risks leaving orphans behind.
 */
export async function saveTransactionsForReceipt(
  receiptId: string,
  ids: { batchId: string; organizationId: string; userId: string },
  transactions: Transaction[]
): Promise<void> {
  const { error: delError } = await supabase
    .from('transactions')
    .delete()
    .eq('receipt_id', receiptId);
  if (delError) throw new Error(delError.message);

  if (!transactions.length) return;

  const rows = transactions.map((t, index) => ({
    // Reuse the id when it is already a real UUID so edits keep stable
    // identities; rows created in the browser get a fresh one.
    id: isUuid(t.id) ? t.id : newId(),
    receipt_id: receiptId,
    batch_id: ids.batchId,
    organization_id: ids.organizationId,
    position: index,
    voucher_date: t.voucher_date || null,
    voucher_type: t.voucher_type || 'Journal',
    entry_type: t.entry_type,
    ledger_name: t.ledger_name || '',
    // The CHECK constraint requires the unused side to be exactly zero.
    debit_amount: t.entry_type === 'Dr' ? Number(t.debit_amount) || 0 : 0,
    credit_amount: t.entry_type === 'Cr' ? Number(t.credit_amount) || 0 : 0,
    needs_review: t.needs_review === true,
    narration: t.narration || '',
    updated_by: ids.userId,
  }));

  const { error } = await supabase.from('transactions').insert(rows);
  if (error) throw new Error(error.message);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
