#!/usr/bin/env node
/**
 * Creates a Scan2Tally login.
 *
 * Accounts are created by an administrator rather than by self-signup, and the
 * app has no user-management screen yet, so this is how the first accounts get
 * made. It needs the SERVICE ROLE key because creating an auth user and its
 * profile row deliberately bypasses the policies that stop ordinary users
 * doing so.
 *
 *   node scripts/create-user.mjs \
 *     --url https://xxxx.supabase.co \
 *     --service-key <service_role key> \
 *     --email admin@company.com \
 *     --password 'a strong password' \
 *     --name 'Sarah Admin' \
 *     --role Admin \
 *     --org 'Alpha Accounts Pvt Ltd'
 *
 * A "Super Admin" belongs to no organisation, so --org is not required (and is
 * ignored) for that role.
 */
import { createRequire } from 'node:module';
// Resolved from the frontend, which already depends on supabase-js, so this
// script needs no install of its own.
const require = createRequire(new URL('../frontend/', import.meta.url));
const { createClient } = require('@supabase/supabase-js');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const url = arg('url', process.env.SUPABASE_URL);
const serviceKey = arg('service-key', process.env.SUPABASE_SERVICE_ROLE_KEY);
const email = arg('email');
const password = arg('password');
const name = arg('name');
const role = arg('role', 'Operator');
const orgName = arg('org');

const missing = Object.entries({ url, serviceKey, email, password, name })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`Missing required option(s): ${missing.join(', ')}`);
  console.error('Run with --help style flags, e.g. --url --service-key --email --password --name --role --org');
  process.exit(1);
}

const VALID_ROLES = ['Super Admin', 'Admin', 'Operator'];
if (!VALID_ROLES.includes(role)) {
  console.error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}
if (role !== 'Super Admin' && !orgName) {
  console.error('--org is required for Admin and Operator accounts.');
  process.exit(1);
}
if (String(password).length < 8) {
  console.error('--password must be at least 8 characters.');
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

// Resolve or create the organisation first, so a failure here does not leave an
// auth account stranded without a profile.
let organizationId = null;
if (role !== 'Super Admin') {
  const { data: existing, error: findErr } = await db
    .from('organizations').select('id, name').eq('name', orgName).maybeSingle();
  if (findErr) {
    console.error(`Could not look up the organisation: ${findErr.message}`);
    process.exit(1);
  }
  if (existing) {
    organizationId = existing.id;
    console.log(`Using existing organisation "${existing.name}"`);
  } else {
    const { data: created, error: orgErr } = await db
      .from('organizations').insert({ name: orgName, status: 'Active' }).select('id').single();
    if (orgErr) {
      console.error(`Could not create the organisation: ${orgErr.message}`);
      process.exit(1);
    }
    organizationId = created.id;
    console.log(`Created organisation "${orgName}"`);
  }
}

const { data: created, error: authErr } = await db.auth.admin.createUser({
  email, password, email_confirm: true,
});
if (authErr) {
  console.error(`Could not create the login: ${authErr.message}`);
  process.exit(1);
}

const { error: profileErr } = await db.from('users').insert({
  id: created.user.id,
  organization_id: organizationId,
  name,
  email,
  role,
  status: 'Active',
});

if (profileErr) {
  // Roll the auth account back, otherwise the user can sign in but has no
  // profile and the app can only show them an error.
  await db.auth.admin.deleteUser(created.user.id);
  console.error(`Could not create the user profile, so the login was removed: ${profileErr.message}`);
  process.exit(1);
}

console.log(`\nCreated ${role}: ${name} <${email}>`);
if (organizationId) console.log(`Organisation: ${orgName}`);
console.log('They can now sign in to Scan2Tally.');
