import { supabase } from './supabase';
import {
  ScanBatch, Receipt, ReceiptStatus, ReceiptDisplayStatus, Transaction, User, UserRole, Organization,
  BatchStatus, Ledger, LedgerMatchState, PlatformUsage, CapacityAlert, TeamDirectoryMember,
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
 * Active colleagues visible in an Operator's privacy-limited directory.
 * The backend re-resolves the caller and organization from the session; the
 * browser never sends either a role or organization id to authorize itself.
 */
export async function fetchOperatorTeamDirectory(): Promise<TeamDirectoryMember[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');

  const base = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';
  const response = await fetch(`${base}/api/team-directory`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || 'Could not load the team directory.');
  }
  if (!Array.isArray(body?.members)) {
    throw new Error('Could not load the team directory.');
  }

  return body.members
    .filter((member: any) =>
      member
      && typeof member.id === 'string'
      && typeof member.name === 'string'
      && (member.role === 'Admin' || member.role === 'Operator')
    )
    .map((member: any) => ({
      id: member.id,
      name: member.name,
      designation: typeof member.designation === 'string' && member.designation
        ? member.designation
        : undefined,
      role: member.role as UserRole,
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

async function callUserApi(userId: string, method: 'PATCH' | 'DELETE', body?: object, path = ''): Promise<any> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  const base = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';
  const res = await fetch(`${base}/api/users/${userId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(responseBody?.detail || 'Could not update the account.');
  return responseBody;
}

export async function updateUserAccount(userId: string, input: {
  name: string; email: string; role: UserRole; designation?: string; phone?: string; password?: string;
  organizationId?: string | null;
}): Promise<User> {
  const body = await callUserApi(userId, 'PATCH', {
    name: input.name, email: input.email, role: input.role, designation: input.designation || '',
    phone: input.phone || '', password: input.password || '', organization_id: input.organizationId ?? null,
  });
  return { id: body.id, organization_id: body.organization_id, orgId: body.organization_id,
    name: body.name, email: body.email, phone: body.phone || undefined, designation: body.designation || undefined,
    role: body.role as UserRole, status: body.status };
}

export async function changeUserPassword(userId: string, password: string): Promise<void> {
  await callUserApi(userId, 'PATCH', { password }, '/password');
}

/** Verifies the current password before allowing a user to change their own. */
export async function changeOwnPassword(email: string, currentPassword: string, newPassword: string): Promise<void> {
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (verifyError) throw new Error('Current password is incorrect.');

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export async function deleteUserAccount(userId: string): Promise<void> {
  await callUserApi(userId, 'DELETE');
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

/**
 * Exact live Supabase capacity as calculated by the backend.
 *
 * This is only used by the Super Admin dashboard. Admins and Operators receive
 * sanitized warning rows directly from Supabase below instead of calling this
 * backend endpoint.
 */
export async function fetchPlatformUsage(): Promise<PlatformUsage> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');

  const base = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';
  const res = await fetch(`${base}/api/platform-usage`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.detail || 'Could not load Supabase capacity.');
  }
  return body as PlatformUsage;
}

const CAPACITY_RESOURCES = new Set(['storage', 'database']);
const CAPACITY_LEVELS = new Set(['healthy', 'warning', 'critical', 'full']);

/** Convert a PostgREST/Realtime row into the app's deliberately narrow shape. */
export function parseCapacityAlertRow(value: unknown): CapacityAlert | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const resource = String(row.resource || '');
  const level = String(row.level || '');
  const percent = Number(row.percent);
  const revision = Number(row.revision);
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  const changedAt = typeof row.changed_at === 'string' ? row.changed_at : '';

  if (
    !CAPACITY_RESOURCES.has(resource) ||
    !CAPACITY_LEVELS.has(level) ||
    !Number.isFinite(percent) || percent < 0 ||
    !Number.isSafeInteger(revision) || revision < 1 ||
    !title || !message || !changedAt
  ) {
    return null;
  }

  return {
    resource: resource as CapacityAlert['resource'],
    level: level as CapacityAlert['level'],
    percent,
    title,
    message,
    revision,
    changedAt,
  };
}

/**
 * Current persisted states for both capacity resources.
 *
 * RLS exposes only these sanitized rows to active staff. This bootstrap read is
 * important: Realtime delivers future transitions, while this read also covers
 * a warning that was raised before the user signed in or while they were away.
 */
export async function fetchCapacityAlerts(): Promise<CapacityAlert[]> {
  const { data, error } = await supabase
    .from('platform_capacity_alerts')
    .select('resource, level, percent, title, message, revision, changed_at');

  if (error) throw new Error(error.message);
  return (data || [])
    .map(parseCapacityAlertRow)
    .filter((alert): alert is CapacityAlert => alert !== null);
}

// ---------------------------------------------------------------- batches

// Migration 007 adds durable queue markers. Deployments can briefly run a new
// frontend against the old schema during a rolling release, so reads retry once
// without those columns instead of making the whole workspace unavailable.
const RECEIPT_QUEUE_COLUMNS = 'extraction_queue_message_id, extraction_queued_at, extraction_generation';
let receiptQueueColumnsAvailable: boolean | null = null;

function queueColumnsMissing(error: { message?: string; details?: string; hint?: string; code?: string } | null): boolean {
  if (!error) return false;
  const text = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  return (
    text.includes('extraction_queue_message_id') ||
    text.includes('extraction_queued_at') ||
    text.includes('extraction_generation') ||
    error.code === '42703' ||
    error.code === 'PGRST204'
  );
}

/** Loads batches with their receipts in one round trip. */
export async function fetchBatches(): Promise<ScanBatch[]> {
  const query = (includeQueue: boolean) => supabase
      .from('scan_batches')
      .select(`
        id, created_by, name, status, hidden_from_users, hidden_by, created_at,
        receipts (
          id, filename, file_path, status, error_message,
          image_width, image_height, verification_warnings, created_at, updated_at
          ${includeQueue ? `, ${RECEIPT_QUEUE_COLUMNS}` : ''}
        )
      `)
      .order('created_at', { ascending: false });

  const includeQueue = receiptQueueColumnsAvailable !== false;
  let result = await query(includeQueue);
  if (includeQueue && result.error && queueColumnsMissing(result.error)) {
    receiptQueueColumnsAvailable = false;
    result = await query(false);
  } else if (includeQueue && !result.error) {
    receiptQueueColumnsAvailable = true;
  }
  const { data, error } = result;

  if (error) throw new Error(error.message);

  const creatorIds = [...new Set((data || []).map((batch: any) => batch.created_by).filter(Boolean))];
  const creatorNames = new Map<string, string>();
  if (creatorIds.length) {
    const { data: creators } = await supabase.rpc('get_batch_creator_names', { p_batch_ids: creatorIds });
    for (const creator of creators || []) {
      if (creator?.id && creator?.name) creatorNames.set(creator.id, creator.name);
    }
  }

  return (data || []).map((b: any) => ({
    id: b.id,
    created_by_name: creatorNames.get(b.created_by) || null,
    created_by: b.created_by,
    name: b.name,
    status: b.status,
    hidden_from_users: Boolean(b.hidden_from_users),
    hidden_by: b.hidden_by || null,
    created_at: new Date(b.created_at).toLocaleString(),
    receipts: (b.receipts || [])
      .slice()
      // Newest uploads appear first in the Files list.
      .sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)))
      .map(
        (r: any): Receipt => ({
          id: r.id,
          filename: r.filename,
          status: r.status,
          created_at: r.created_at || undefined,
          updated_at: r.updated_at || undefined,
          // Resolved lazily via a signed URL; the stored path is not a URL.
          previewUrl: '',
          storage_path: r.file_path || undefined,
          upload_state: r.file_path ? 'uploaded' : 'failed',
          upload_error: r.file_path
            ? undefined
            : 'The image upload did not finish. Retry it if the original file is still available, or remove it and upload again.',
          extraction_queue_message_id: r.extraction_queue_message_id == null
            ? null
            : Number(r.extraction_queue_message_id),
          extraction_queued_at: r.extraction_queued_at || null,
          extraction_generation: Number.isSafeInteger(Number(r.extraction_generation))
            ? Number(r.extraction_generation)
            : undefined,
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

export async function setBatchHidden(id: string, hidden: boolean, userId: string): Promise<void> {
  const { error } = await supabase
    .from('scan_batches')
    .update({ hidden_from_users: hidden, hidden_by: hidden ? userId : null })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- receipts

export async function createReceipt(receipt: {
  id: string;
  batchId: string;
  userId: string;
  filename: string;
}): Promise<{ created_at?: string; updated_at?: string }> {
  // Ignore an existing id so retrying an interrupted upload is idempotent and
  // cannot reset a receipt that the server has already started processing.
  const { data, error } = await supabase.from('receipts')
    .upsert({
      id: receipt.id,
      batch_id: receipt.batchId,
      uploaded_by: receipt.userId,
      filename: receipt.filename,
    }, {
      onConflict: 'id',
      ignoreDuplicates: true,
      // Server-owned fields (including status) must use their database defaults;
      // PostgREST otherwise fills omitted upsert columns with null.
      defaultToNull: false,
    })
    .select('created_at, updated_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    created_at: data?.created_at || undefined,
    updated_at: data?.updated_at || undefined,
  };
}

export async function updateReceiptRow(
  id: string,
  patch: Partial<{
    file_path: string | null;
    image_width: number | null;
    image_height: number | null;
  }>
): Promise<void> {
  const { error } = await supabase.from('receipts').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteReceipt(id: string): Promise<void> {
  const { error } = await supabase.from('receipts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Storage cleanup is intentionally separate: delete the database row first. */
export async function deleteReceiptImages(paths: string[]): Promise<void> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) return;
  const { error } = await supabase.storage.from(RECEIPTS_BUCKET).remove(uniquePaths);
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
export interface StartReceiptExtractionResult {
  receipt_id: string;
  status: 'Queued' | 'Processing' | 'Extracted';
  extraction_queue_message_id?: number | null;
  extraction_queued_at?: string | null;
}

export async function startReceiptExtraction(receiptId: string): Promise<StartReceiptExtractionResult> {
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
  const body = await res.json().catch(() => ({}));
  const hasQueueMessage = Object.prototype.hasOwnProperty.call(body, 'extraction_queue_message_id');
  const hasQueuedAt = Object.prototype.hasOwnProperty.call(body, 'extraction_queued_at');
  return {
    receipt_id: typeof body.receipt_id === 'string' ? body.receipt_id : receiptId,
    status: body.status === 'Queued' || body.status === 'Extracted' ? body.status : 'Processing',
    extraction_queue_message_id: hasQueueMessage
      ? (body.extraction_queue_message_id == null ? null : Number(body.extraction_queue_message_id))
      : undefined,
    extraction_queued_at: hasQueuedAt
      ? (typeof body.extraction_queued_at === 'string' ? body.extraction_queued_at : null)
      : undefined,
  };
}

/** Current server-side state of specific receipts, for watching extractions. */
export interface ReceiptServerState {
  id: string;
  status: ReceiptStatus;
  error_message?: string;
  verification_warnings?: string[];
  extraction_queue_message_id?: number | null;
  extraction_queued_at?: string | null;
  extraction_generation?: number;
  updated_at?: string;
}

export function parseReceiptServerState(value: unknown): ReceiptServerState | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, any>;
  if (typeof row.id !== 'string' || !['Pending', 'Processing', 'Extracted', 'Failed'].includes(row.status)) {
    return null;
  }

  const hasQueueMessage = Object.prototype.hasOwnProperty.call(row, 'extraction_queue_message_id');
  const hasQueuedAt = Object.prototype.hasOwnProperty.call(row, 'extraction_queued_at');
  const hasGeneration = Object.prototype.hasOwnProperty.call(row, 'extraction_generation');
  const hasUpdatedAt = Object.prototype.hasOwnProperty.call(row, 'updated_at');
  const generation = hasGeneration ? Number(row.extraction_generation) : undefined;
  const updatedAt = hasUpdatedAt && row.updated_at != null ? String(row.updated_at) : undefined;
  const queueMessageId = hasQueueMessage && row.extraction_queue_message_id != null
    ? Number(row.extraction_queue_message_id)
    : null;
  const queuedAt = hasQueuedAt && row.extraction_queued_at != null
    ? String(row.extraction_queued_at)
    : null;

  // Reject malformed ordering metadata instead of letting one corrupt event
  // defeat monotonic state handling. Missing fields remain valid for a brief
  // rolling-deploy window against the pre-queue schema.
  if (hasGeneration && row.extraction_generation == null) return null;
  if (hasUpdatedAt && row.updated_at == null) return null;
  if (hasGeneration && (!Number.isSafeInteger(generation) || generation! < 0)) return null;
  if (updatedAt !== undefined && Number.isNaN(Date.parse(updatedAt))) return null;
  if (queueMessageId !== null && (!Number.isSafeInteger(queueMessageId) || queueMessageId < 1)) return null;
  if (queuedAt !== null && Number.isNaN(Date.parse(queuedAt))) return null;

  return {
    id: row.id,
    status: row.status as ReceiptStatus,
    error_message: row.error_message || undefined,
    verification_warnings: Array.isArray(row.verification_warnings) && row.verification_warnings.length
      ? row.verification_warnings
      : undefined,
    extraction_queue_message_id: hasQueueMessage ? queueMessageId : undefined,
    extraction_queued_at: hasQueuedAt ? queuedAt : undefined,
    extraction_generation: generation,
    updated_at: updatedAt,
  };
}

export async function fetchReceiptStates(ids: string[]): Promise<ReceiptServerState[]> {
  if (!ids.length) return [];
  const query = (includeQueue: boolean) => supabase
      .from('receipts')
      .select(`id, status, error_message, verification_warnings, updated_at${includeQueue ? `, ${RECEIPT_QUEUE_COLUMNS}` : ''}`)
      .in('id', ids);

  const includeQueue = receiptQueueColumnsAvailable !== false;
  let result = await query(includeQueue);
  if (includeQueue && result.error && queueColumnsMissing(result.error)) {
    receiptQueueColumnsAvailable = false;
    result = await query(false);
  } else if (includeQueue && !result.error) {
    receiptQueueColumnsAvailable = true;
  }
  const { data, error } = result;

  if (error) throw new Error(error.message);
  return (data || [])
    .map(parseReceiptServerState)
    .filter((state): state is ReceiptServerState => state !== null);
}

// ---------------------------------------------------------------- images

export const RECEIPT_UPLOAD_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

const RECEIPT_UPLOAD_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf']);
const RECEIPT_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/** Client-side format guard; the backend remains the final trust boundary. */
export function validateReceiptUploadFile(file: Pick<File, 'name' | 'type'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const mimeType = file.type.trim().toLowerCase();
  if (!RECEIPT_UPLOAD_EXTENSIONS.has(extension) || (mimeType && !RECEIPT_UPLOAD_MIME_TYPES.has(mimeType))) {
    return 'Only JPG, JPEG, PNG, WEBP, and PDF files are supported.';
  }
  return null;
}

/**
 * Uploads under <org>/<batch>/<receipt> because the storage policies scope
 * access by the first path segment.
 */
export async function uploadReceiptImage(
  file: File,
  ids: { organizationId: string; batchId: string; receiptId: string }
): Promise<string> {
  const validationError = validateReceiptUploadFile(file);
  if (validationError) throw new Error(validationError);

  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${ids.organizationId}/${ids.batchId}/${ids.receiptId}.${ext}`;

  const upload = () => supabase.storage
    .from(RECEIPTS_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined });

  let result = await upload();
  const storageError = result.error as (typeof result.error & {
    statusCode?: string;
    error?: string;
  });
  const isDuplicate = Boolean(storageError) && (
    storageError.statusCode === '409' ||
    storageError.error === 'Duplicate' ||
    /already exists|duplicate/i.test(storageError.message)
  );

  // A previous request can reach Storage even if its response never reaches
  // the browser. Replace only that exact receipt key on retry. This uses the
  // existing INSERT/DELETE policies and does not require broad UPDATE access.
  if (isDuplicate) {
    const { error: cleanupError } = await supabase.storage.from(RECEIPTS_BUCKET).remove([path]);
    if (cleanupError) throw new Error(cleanupError.message);
    result = await upload();
  }

  if (result.error) throw new Error(result.error.message);
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
  organizationId: string;
  fileName: string;
  recordCount: number;
  file: Blob;
}): Promise<void> {
  const filePath = `${input.organizationId}/${input.batchId}/${newId()}-${input.fileName}`;
  const { error: uploadError } = await supabase.storage.from('exports').upload(filePath, input.file, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    upsert: false,
  });
  if (uploadError) throw new Error(uploadError.message);

  const { error } = await supabase.from('exports').insert({
    batch_id: input.batchId,
    generated_by: input.userId,
    file_name: input.fileName,
    record_count: input.recordCount,
    file_path: filePath,
  });
  if (error) {
    await supabase.storage.from('exports').remove([filePath]);
    throw new Error(error.message);
  }
}

export interface ExportRecord {
  id: string;
  file_path?: string | null;
  file_name: string;
  record_count: number;
  created_at: string;
  generated_by_name?: string;
}

export async function fetchExportsForBatch(batchId: string): Promise<ExportRecord[]> {
  const { data, error } = await supabase
    .from('exports')
    .select('id, file_name, file_path, record_count, created_at, generated_by')
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
    file_path: r.file_path || null,
    file_name: r.file_name,
    record_count: r.record_count,
    created_at: new Date(r.created_at).toLocaleString(),
    generated_by_name: names.get(r.generated_by),
  }));
}

export async function downloadExportFile(filePath: string, fileName: string): Promise<void> {
  const { data, error } = await supabase.storage.from('exports').download(filePath);
  if (error) throw new Error(error.message);
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- organisation overview

export interface OrgOverview {
  batches: { active: number; archived: number };
  receipts: Record<ReceiptDisplayStatus, number>;
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
  const fetchOverviewReceipts = async () => {
    const query = (includeQueue: boolean) => supabase.from('receipts')
      .select(`id, status, uploaded_by${includeQueue ? `, ${RECEIPT_QUEUE_COLUMNS}` : ''}`);
    const includeQueue = receiptQueueColumnsAvailable !== false;
    let result = await query(includeQueue);
    if (includeQueue && result.error && queueColumnsMissing(result.error)) {
      receiptQueueColumnsAvailable = false;
      result = await query(false);
    } else if (includeQueue && !result.error) {
      receiptQueueColumnsAvailable = true;
    }
    return result;
  };

  const [batchRes, receiptRes, txRes, exportRes, userRes] = await Promise.all([
    supabase.from('scan_batches').select('id, status'),
    fetchOverviewReceipts(),
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

  const receipts: Record<ReceiptDisplayStatus, number> =
    { Pending: 0, Queued: 0, Processing: 0, Extracted: 0, Failed: 0 };
  const perUploader = new Map<string, number>();
  const receiptRows = (receiptRes.data || []) as unknown as Array<{
    status: ReceiptStatus;
    uploaded_by?: string | null;
    extraction_queue_message_id?: number | null;
  }>;
  for (const r of receiptRows) {
    const displayStatus: ReceiptDisplayStatus = r.status === 'Pending' && r.extraction_queue_message_id != null
      ? 'Queued'
      : r.status as ReceiptStatus;
    if (displayStatus in receipts) receipts[displayStatus]++;
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
