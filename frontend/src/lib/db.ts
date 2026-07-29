import { supabase } from './supabase';
import {
  ScanBatch, Receipt, ReceiptStatus, Transaction, User, UserRole, Organization,
  BatchStatus, Ledger, LedgerMatchState,
} from '../types';
import { ledgerMatchKey } from './ledgers';
import { LEDGER_MATCHING } from './features';

// The rules about ledger names live in ./ledgers so they can be tested without a
// Supabase client. Re-exported here because callers reach for one data module.
export { ledgerMatchKey, resolveLedgerName, parsePastedLedgers } from './ledgers';

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

/**
 * Archives or restores a batch.
 *
 * Archiving is the answer to a workspace that only ever grows: last quarter's
 * batches are still needed for their records, but they should not sit between
 * an operator and this morning's work. Nothing is deleted, and an archived
 * batch can still be reopened and exported.
 */
export async function setBatchStatus(id: string, status: BatchStatus): Promise<void> {
  const { error } = await supabase.from('scan_batches').update({ status }).eq('id', id);
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

/**
 * Asks the server to extract a receipt, and returns as soon as it has accepted.
 *
 * The extraction itself runs on the server, which reads the image from storage
 * and writes the results back itself. That is the whole point: the browser is
 * not holding the work, so closing the tab or losing the network partway
 * through cannot abandon it. Progress is observed by watching the receipt row.
 */
export async function startReceiptExtraction(receiptId: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');

  const base = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';
  const res = await fetch(`${base}/api/receipts/${receiptId}/extract`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || 'Could not start extraction on the server.');
  }
}

/** Current server-side state of specific receipts, for watching extractions. */
export async function fetchReceiptStates(ids: string[]): Promise<
  { id: string; status: ReceiptStatus; error_message?: string; verification_warnings?: string[] }[]
> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('receipts')
    .select('id, status, error_message, verification_warnings')
    .in('id', ids);

  if (error) throw new Error(error.message);
  return (data || []).map((r: any) => ({
    id: r.id,
    status: r.status as ReceiptStatus,
    error_message: r.error_message || undefined,
    verification_warnings: Array.isArray(r.verification_warnings) && r.verification_warnings.length
      ? r.verification_warnings
      : undefined,
  }));
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
  // The ledger columns arrive with migration 002. Asking for them on a database
  // that has not had it applied does not simply omit them — PostgREST rejects the
  // whole query, which would leave the reviewer showing no rows at all for a
  // voucher that extracted perfectly well.
  const result = LEDGER_MATCHING
    ? await supabase
        .from('transactions')
        .select(`
          id, receipt_id, position, voucher_date, voucher_type, entry_type,
          ledger_name, ledger_id, ledger_match, ledger_match_score,
          debit_amount, credit_amount, needs_review, narration
        `)
        .eq('batch_id', batchId)
        .order('position', { ascending: true })
    : await supabase
        .from('transactions')
        .select(`
          id, receipt_id, position, voucher_date, voucher_type, entry_type,
          ledger_name, debit_amount, credit_amount, needs_review, narration
        `)
        .eq('batch_id', batchId)
        .order('position', { ascending: true });

  const { error } = result;
  if (error) throw new Error(error.message);

  const grouped: Record<string, Transaction[]> = {};
  for (const row of (result.data || []) as any[]) {
    const tx: Transaction = {
      id: row.id,
      receipt_id: row.receipt_id,
      voucher_date: row.voucher_date || '',
      voucher_type: row.voucher_type || 'Journal',
      entry_type: row.entry_type,
      ledger_name: row.ledger_name || '',
      ledger_id: row.ledger_id || null,
      ledger_match: (row.ledger_match as LedgerMatchState) || 'Unchecked',
      ledger_match_score: row.ledger_match_score != null ? Number(row.ledger_match_score) : null,
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
  // What the model originally read, keyed by row. Delete-then-insert would drop
  // it, and losing it means a figure disputed months later can no longer be
  // traced back to a misreading rather than an edit — so rows that survive the
  // rewrite carry their original reading across it.
  const { data: existing } = await supabase
    .from('transactions')
    .select('id, raw_extracted_data')
    .eq('receipt_id', receiptId);
  const originalReadings = new Map<string, unknown>(
    (existing || []).map((row: any) => [row.id, row.raw_extracted_data])
  );

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
    // Only written when the feature is on, for the same reason it is only read
    // then: these columns do not exist before migration 002.
    ...(LEDGER_MATCHING ? {
      ledger_id: t.ledger_id || null,
      ledger_match: t.ledger_match || 'Unchecked',
      ledger_match_score: t.ledger_match_score ?? null,
    } : {}),
    // The CHECK constraint requires the unused side to be exactly zero.
    debit_amount: t.entry_type === 'Dr' ? Number(t.debit_amount) || 0 : 0,
    credit_amount: t.entry_type === 'Cr' ? Number(t.credit_amount) || 0 : 0,
    needs_review: t.needs_review === true,
    narration: t.narration || '',
    updated_by: ids.userId,
    raw_extracted_data: originalReadings.get(t.id) ?? null,
  }));

  const { error } = await supabase.from('transactions').insert(rows);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- chart of accounts

/** The organisation's chart of accounts. RLS scopes this to their own org. */
export async function fetchLedgers(includeInactive = false): Promise<Ledger[]> {
  let query = supabase
    .from('ledgers')
    .select('id, name, parent_group, aliases, is_active')
    .order('name');
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map((l: any) => ({
    id: l.id,
    name: l.name,
    parent_group: l.parent_group || undefined,
    aliases: Array.isArray(l.aliases) ? l.aliases : [],
    is_active: l.is_active,
  }));
}

export async function createLedger(input: {
  organizationId: string;
  userId: string;
  name: string;
  parentGroup?: string;
  aliases?: string[];
}): Promise<Ledger> {
  const { data, error } = await supabase
    .from('ledgers')
    .insert({
      organization_id: input.organizationId,
      created_by: input.userId,
      name: input.name.trim(),
      parent_group: input.parentGroup?.trim() || null,
      aliases: (input.aliases || []).map(a => a.trim()).filter(Boolean),
    })
    .select('id, name, parent_group, aliases, is_active')
    .single();

  if (error) {
    // The unique index is on the normalised name, so this is the database
    // refusing to hold one account under two spellings.
    if (error.code === '23505') {
      throw new Error(`"${input.name.trim()}" is already in your chart of accounts.`);
    }
    throw new Error(error.message);
  }
  return {
    id: data.id,
    name: data.name,
    parent_group: data.parent_group || undefined,
    aliases: Array.isArray(data.aliases) ? data.aliases : [],
    is_active: data.is_active,
  };
}

export async function updateLedger(
  id: string,
  patch: { name?: string; parentGroup?: string | null; aliases?: string[]; isActive?: boolean }
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.parentGroup !== undefined) row.parent_group = patch.parentGroup?.trim() || null;
  if (patch.aliases !== undefined) row.aliases = patch.aliases.map(a => a.trim()).filter(Boolean);
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { error } = await supabase.from('ledgers').update(row).eq('id', id);
  if (error) {
    if (error.code === '23505') {
      throw new Error('Another ledger already uses that name.');
    }
    throw new Error(error.message);
  }
}

/**
 * Adds several ledgers at once, skipping any the organisation already has.
 *
 * A chart of accounts is pasted out of Tally, and a re-paste after adding a few
 * accounts is the normal way to keep it current. Failing that whole paste over
 * names that are already correct would make the obvious action the wrong one, so
 * duplicates are reported rather than treated as errors.
 */
export async function importLedgers(
  ids: { organizationId: string; userId: string },
  entries: { name: string; parentGroup?: string }[]
): Promise<{ added: number; skipped: string[] }> {
  const existing = await fetchLedgers(true);
  const known = new Set(existing.map(l => ledgerMatchKey(l.name)));

  const skipped: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    const key = ledgerMatchKey(name);
    // `known` also absorbs duplicates within the paste itself, which would
    // otherwise collide with each other rather than with the existing chart.
    if (!key || known.has(key)) {
      if (name) skipped.push(name);
      continue;
    }
    known.add(key);
    rows.push({
      organization_id: ids.organizationId,
      created_by: ids.userId,
      name,
      parent_group: entry.parentGroup?.trim() || null,
      aliases: [],
    });
  }

  if (rows.length) {
    const { error } = await supabase.from('ledgers').insert(rows);
    if (error) throw new Error(error.message);
  }
  return { added: rows.length, skipped };
}

// ---------------------------------------------------------------- exports

/**
 * Records that a Tally file was generated.
 *
 * The spreadsheet leaves the browser and is imported by hand, so this row is the
 * only trace that it ever existed. Without it there is no way to answer "was
 * this batch already sent to Tally, and by whom?" — which is exactly the
 * question that comes up when someone suspects a voucher was posted twice.
 */
export async function recordExport(input: {
  batchId: string;
  userId: string;
  fileName: string;
  recordCount: number;
}): Promise<void> {
  const { error } = await supabase.from('exports').insert({
    batch_id: input.batchId,
    generated_by: input.userId,
    file_name: input.fileName,
    record_count: input.recordCount,
  });
  if (error) throw new Error(error.message);
}

export interface ExportRecord {
  id: string;
  file_name: string;
  record_count: number;
  created_at: string;
  generated_by_name?: string;
}

export async function fetchExportsForBatch(batchId: string): Promise<ExportRecord[]> {
  const { data, error } = await supabase
    .from('exports')
    .select('id, file_name, record_count, created_at, generated_by')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  // Only an Admin may read the user directory, so an Operator sees their own
  // exports without a name attached rather than an error.
  let names = new Map<string, string>();
  const authorIds = [...new Set((data || []).map((r: any) => r.generated_by).filter(Boolean))];
  if (authorIds.length) {
    const { data: people } = await supabase.from('users').select('id, name').in('id', authorIds);
    names = new Map((people || []).map((p: any) => [p.id, p.name]));
  }

  return (data || []).map((r: any) => ({
    id: r.id,
    file_name: r.file_name,
    record_count: r.record_count,
    created_at: new Date(r.created_at).toLocaleString(),
    generated_by_name: names.get(r.generated_by),
  }));
}

// ---------------------------------------------------------------- organisation overview

export interface OrgOverview {
  batches: { active: number; archived: number };
  receipts: Record<ReceiptStatus, number>;
  rows: number;
  /** Rows whose ledger Tally will not recognise as-is. */
  ledgersUnresolved: number;
  ledgerCount: number;
  exports: ExportRecord[];
  staff: { id: string; name: string; receipts: number }[];
}

/**
 * Everything an Admin needs to see how their organisation is doing.
 *
 * Counted from the database on every load rather than kept as running totals:
 * a figure that is derived cannot drift from what it claims to describe, and at
 * one company's volume the cost of counting is irrelevant.
 */
export async function fetchOrgOverview(): Promise<OrgOverview> {
  const [batchRes, receiptRes, txRes, exportRes, userRes] = await Promise.all([
    supabase.from('scan_batches').select('id, status'),
    supabase.from('receipts').select('id, status, uploaded_by'),
    LEDGER_MATCHING
      ? supabase.from('transactions').select('id, ledger_match')
      : supabase.from('transactions').select('id'),
    supabase.from('exports').select('id, file_name, record_count, created_at, generated_by')
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('users').select('id, name'),
  ]);

  const firstError = batchRes.error || receiptRes.error || txRes.error;
  if (firstError) throw new Error(firstError.message);

  // Only counted when there is a chart of accounts to count against; the table
  // itself does not exist before migration 002.
  const ledgerRes = LEDGER_MATCHING
    ? await supabase.from('ledgers').select('id', { count: 'exact', head: true }).eq('is_active', true)
    : { count: 0 };

  const batches = { active: 0, archived: 0 };
  for (const b of batchRes.data || []) {
    if (b.status === 'Archived') batches.archived++;
    else batches.active++;
  }

  const receipts: Record<ReceiptStatus, number> =
    { Pending: 0, Processing: 0, Extracted: 0, Failed: 0 };
  const perUploader = new Map<string, number>();
  for (const r of receiptRes.data || []) {
    if (r.status in receipts) receipts[r.status as ReceiptStatus]++;
    if (r.uploaded_by) perUploader.set(r.uploaded_by, (perUploader.get(r.uploaded_by) || 0) + 1);
  }

  const rows = (txRes.data || []).length;
  const ledgersUnresolved = LEDGER_MATCHING
    ? ((txRes.data || []) as any[]).filter(
        t => t.ledger_match === 'Unmatched' || t.ledger_match === 'Suggested'
      ).length
    : 0;

  const names = new Map((userRes.data || []).map((u: any) => [u.id, u.name]));
  // Keyed by id, not name: two people with the same name are two people.
  const staff = [...perUploader.entries()]
    .map(([id, count]) => ({ id, name: names.get(id) || 'Unknown', receipts: count }))
    .sort((a, b) => b.receipts - a.receipts);

  const exports = (exportRes.data || []).map((r: any) => ({
    id: r.id,
    file_name: r.file_name,
    record_count: r.record_count,
    created_at: new Date(r.created_at).toLocaleString(),
    generated_by_name: names.get(r.generated_by),
  }));

  return {
    batches,
    receipts,
    rows,
    ledgersUnresolved,
    ledgerCount: ledgerRes.count ?? 0,
    exports,
    staff,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
