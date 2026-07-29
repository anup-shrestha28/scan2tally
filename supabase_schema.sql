-- ====================================================================
-- Scan2Tally - Complete Supabase PostgreSQL Schema Script
-- Supports Multi-Tenancy, Row Level Security (RLS), and PRD Specifications
-- ====================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Custom Enum Types
CREATE TYPE org_status AS ENUM ('Active', 'Inactive');
CREATE TYPE user_role AS ENUM ('Super Admin', 'Admin', 'Operator');
CREATE TYPE user_status AS ENUM ('Active', 'Inactive');
CREATE TYPE batch_status AS ENUM ('Active', 'Archived');
CREATE TYPE receipt_status AS ENUM ('Pending', 'Processing', 'Extracted', 'Failed');
CREATE TYPE entry_type AS ENUM ('Dr', 'Cr');
-- How confident we are that a row's ledger name is one Tally will accept.
-- 'Unchecked' means the organisation has no chart of accounts yet, so there was
-- nothing to check against — deliberately distinct from "checked and not found".
CREATE TYPE ledger_match AS ENUM ('Unchecked', 'Exact', 'Alias', 'Suggested', 'Unmatched');

-- 3. Table: organizations
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status org_status DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Table: users (Extends Supabase Auth users)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL, -- NULL for Super Admin
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    designation TEXT,
    role user_role NOT NULL,
    status user_status DEFAULT 'Active',
    created_by UUID REFERENCES public.users(id),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Table: scan_batches
CREATE TABLE IF NOT EXISTS public.scan_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES public.users(id),
    name TEXT NOT NULL,
    status batch_status DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Table: receipts
CREATE TABLE IF NOT EXISTS public.receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES public.scan_batches(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES public.users(id),
    filename TEXT NOT NULL DEFAULT '',
    -- Path in Supabase Storage bucket 'receipts'. Nullable because the row is
    -- created as soon as the file is picked, before the upload has finished.
    file_path TEXT,
    -- Pixel size, used to warn that a photo is too small to read reliably.
    image_width INTEGER,
    image_height INTEGER,
    status receipt_status DEFAULT 'Pending',
    error_message TEXT,
    -- Reconciliation notices from extraction (advisory, not failures).
    verification_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Which backend process is extracting this receipt, and when it last said so.
    -- Extraction resumes on start-up, which is correct for a single process and
    -- harmful for several: without a claim, a booting instance would take over
    -- work another instance is still running. The timestamp is refreshed while
    -- the job is alive, so a claim that stopped being refreshed belongs to a
    -- process that died and is free to take over.
    extraction_worker TEXT,
    extraction_claimed_at TIMESTAMPTZ,
    -- Exactly what the vision model returned, before any normalisation. Kept
    -- here rather than only on the rows because the reviewer rewrites the rows,
    -- and the point of this column is to survive that.
    raw_extraction JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6b. Table: ledgers — one organisation's chart of accounts
--
-- Extraction reads whatever ledger name is written on the paper, and Tally only
-- recognises names that already exist in the company. An unrecognised name is
-- not a cosmetic problem: on import Tally either rejects the voucher or quietly
-- creates a SECOND ledger, splitting one account's balance across two without
-- anyone noticing. This table is what an extracted name is matched against.
CREATE TABLE IF NOT EXISTS public.ledgers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- Spelled EXACTLY as it is in Tally. This is the string that gets exported.
    name TEXT NOT NULL,
    -- The Tally group the ledger sits under, e.g. 'Indirect Expenses'. Carried
    -- for the accountant's benefit; nothing matches on it.
    parent_group TEXT,
    -- Other spellings staff actually write by hand: 'Bank A/c' for
    -- 'Bank Account'. Matching treats these as equal to the name itself.
    aliases TEXT[] NOT NULL DEFAULT '{}',
    -- Normalised name, used to compare two spellings of the same ledger.
    -- Generated rather than written by the application so it cannot drift from
    -- `name`. The identical rule lives in backend/ledger_matching.py
    -- (`match_key`) and frontend/src/lib/db.ts (`ledgerMatchKey`) — all three
    -- must agree or the same name will match in one place and not another.
    match_key TEXT GENERATED ALWAYS AS (
        lower(regexp_replace(name, '[^A-Za-z0-9]+', '', 'g'))
    ) STORED,
    -- Retiring a ledger keeps the history of rows already posted to it, while
    -- taking it out of matching and out of the reviewer's picker.
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Table: transactions
--
-- One row per voucher line. The money lives in debit_amount / credit_amount
-- with entry_type saying which side the line belongs to. There is deliberately
-- NO single flat `amount` column: that shape cannot say which side a figure
-- belongs on, and reading it back inconsistently is what previously made the
-- exported Excel totals disagree with the rows above them.
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES public.receipts(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES public.scan_batches(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- Preserves the order the lines appear on the voucher. Without this a
    -- SELECT returns rows in arbitrary order and the voucher reads scrambled.
    position INTEGER NOT NULL DEFAULT 0,
    -- Vouchers carry Nepali (Bikram Sambat) dates such as 2083-03-15. Stored as
    -- text because they are not Gregorian dates: a DATE column would accept the
    -- value and then quietly give wrong answers to any sort or range filter.
    voucher_date TEXT,
    voucher_type TEXT DEFAULT 'Journal',
    entry_type entry_type NOT NULL,
    -- The name that gets exported. Holds the canonical Tally spelling once the
    -- row is confidently matched to a ledger, and the name as written on the
    -- paper while the match is still only a suggestion.
    ledger_name TEXT NOT NULL DEFAULT '',
    -- Which ledger in the organisation's chart of accounts this row resolved to.
    ledger_id UUID REFERENCES public.ledgers(id) ON DELETE SET NULL,
    ledger_match ledger_match NOT NULL DEFAULT 'Unchecked',
    -- Similarity behind a 'Suggested' match, 0-1. Null in every other state.
    ledger_match_score NUMERIC(4, 3),
    debit_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    credit_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    -- Set when repeated extraction passes disagreed on this line's amount.
    needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    narration TEXT,
    raw_extracted_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id),
    -- A line sits on exactly one side; both-sides or neither-side is a bug.
    CONSTRAINT transactions_single_sided CHECK (
        (entry_type = 'Dr' AND credit_amount = 0) OR
        (entry_type = 'Cr' AND debit_amount = 0)
    )
);

-- 8. Table: exports
CREATE TABLE IF NOT EXISTS public.exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES public.scan_batches(id) ON DELETE CASCADE,
    generated_by UUID NOT NULL REFERENCES public.users(id),
    file_name TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Performance & Lookup Indexes
CREATE INDEX IF NOT EXISTS idx_users_org ON public.users(organization_id);
CREATE INDEX IF NOT EXISTS idx_scan_batches_org ON public.scan_batches(organization_id);
CREATE INDEX IF NOT EXISTS idx_scan_batches_user ON public.scan_batches(created_by);
CREATE INDEX IF NOT EXISTS idx_receipts_batch ON public.receipts(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON public.transactions(receipt_id);
CREATE INDEX IF NOT EXISTS idx_transactions_batch ON public.transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_org ON public.transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON public.transactions(ledger_id);
CREATE INDEX IF NOT EXISTS idx_exports_batch ON public.exports(batch_id);
CREATE INDEX IF NOT EXISTS idx_ledgers_org ON public.ledgers(organization_id);
-- Two spellings of one ledger defeat the entire point of having a chart of
-- accounts, so 'TDS Payable' and 'tds payable' collide here rather than becoming
-- two separate accounts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_key ON public.ledgers(organization_id, match_key);
-- Start-up recovery scans for stranded jobs, which is a tiny slice of the table.
CREATE INDEX IF NOT EXISTS idx_receipts_processing
    ON public.receipts(status) WHERE status = 'Processing';

-- 9b. Table privileges
-- RLS filters rows, it does not grant access to the table in the first place;
-- without these the API returns "permission denied" before any policy is
-- consulted. Stated explicitly so the schema works on a database where
-- Supabase's default privileges are missing or have been reset.
-- `anon` is deliberately granted nothing: signed-out visitors have no reason to
-- reach these tables, so they are blocked outright rather than relying on RLS.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Same treatment for anything added to the schema later.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO service_role;

-- 10. Enable Row Level Security (RLS) on all tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledgers ENABLE ROW LEVEL SECURITY;

-- 11. Helper Function: Get Current User's Organization ID
CREATE OR REPLACE FUNCTION public.get_auth_user_org_id()
RETURNS UUID AS $$
    SELECT organization_id FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 12. Helper Function: Get Current User's Role
CREATE OR REPLACE FUNCTION public.get_auth_user_role()
RETURNS user_role AS $$
    SELECT role FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 12b. The policies below call these helpers, so they must be executable by
-- signed-in users. Granted here rather than with the table privileges because
-- the functions do not exist until this point in the script.
GRANT EXECUTE ON FUNCTION public.get_auth_user_org_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_auth_user_role() TO authenticated, service_role;

-- 13. RLS Security Policies
-- Super Admin can view/edit everything
CREATE POLICY "Super Admins Full Access Organizations" ON public.organizations
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Users" ON public.users
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Batches" ON public.scan_batches
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Receipts" ON public.receipts
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Transactions" ON public.transactions
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Exports" ON public.exports
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

CREATE POLICY "Super Admins Full Access Ledgers" ON public.ledgers
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

-- Admin & Operator Organization Data Isolation
CREATE POLICY "Users Read Own Organization" ON public.organizations
    FOR SELECT USING (id = public.get_auth_user_org_id());

-- Only Admins may enumerate colleagues. Without the role check this reads as an
-- organisation-wide directory, letting any Operator list every co-worker's name
-- and email — which the policy name never intended. Operators still reach their
-- own row through "Users Read Own Profile" below, which is all the app needs.
CREATE POLICY "Admins View Users in Same Org" ON public.users
    FOR SELECT USING (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    );

-- Every user must be able to read their OWN row, otherwise get_auth_user_org_id()
-- has nothing to resolve on first load and the whole app sees an empty database.
CREATE POLICY "Users Read Own Profile" ON public.users
    FOR SELECT USING (id = auth.uid());

-- Admins add staff to their own organization. Without an INSERT policy the
-- admin-creates-accounts flow is impossible for anyone but a Super Admin, and
-- WITH CHECK is what constrains the row being written (USING only filters rows
-- that already exist).
CREATE POLICY "Admins Create Users in Own Org" ON public.users
    FOR INSERT WITH CHECK (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id() AND
        role IN ('Admin', 'Operator')
    );

CREATE POLICY "Admins Update Users in Own Org" ON public.users
    FOR UPDATE USING (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    );

CREATE POLICY "Users Access Org Scan Batches" ON public.scan_batches
    FOR ALL USING (
        organization_id = public.get_auth_user_org_id() AND
        (public.get_auth_user_role() = 'Admin' OR created_by = auth.uid())
    );

CREATE POLICY "Users Access Receipts in Org Batches" ON public.receipts
    FOR ALL USING (
        batch_id IN (
            SELECT id FROM public.scan_batches WHERE organization_id = public.get_auth_user_org_id()
        )
    );

CREATE POLICY "Users Access Transactions in Org" ON public.transactions
    FOR ALL USING (organization_id = public.get_auth_user_org_id());

CREATE POLICY "Users Access Exports in Org Batches" ON public.exports
    FOR ALL USING (
        batch_id IN (
            SELECT id FROM public.scan_batches WHERE organization_id = public.get_auth_user_org_id()
        )
    );

-- Everyone in the organisation READS the chart of accounts: an Operator needs it
-- to pick the right ledger while reviewing a voucher.
CREATE POLICY "Users Read Org Ledgers" ON public.ledgers
    FOR SELECT USING (organization_id = public.get_auth_user_org_id());

-- Only Admins MAINTAIN it. This list decides what every future extraction
-- matches against, so a mistyped entry here misroutes vouchers company-wide —
-- that is an accountant's decision, not a data-entry one.
CREATE POLICY "Admins Manage Org Ledgers" ON public.ledgers
    FOR ALL USING (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    ) WITH CHECK (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    );

-- 14. Keep updated_at honest without every caller remembering to set it
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_touch BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_scan_batches_touch BEFORE UPDATE ON public.scan_batches
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_receipts_touch BEFORE UPDATE ON public.receipts
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_transactions_touch BEFORE UPDATE ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_ledgers_touch BEFORE UPDATE ON public.ledgers
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 15. Storage bucket for receipt images
-- Private: images are reachable only through a signed URL, so one organization
-- cannot read another's scans by guessing a path.
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', FALSE)
ON CONFLICT (id) DO NOTHING;

-- Objects are stored under <organization_id>/<batch_id>/<receipt_id>, so the
-- first path segment is what scopes access to an organization.
CREATE POLICY "Org members read own receipt images" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'receipts' AND (
            public.get_auth_user_role() = 'Super Admin' OR
            (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
        )
    );

CREATE POLICY "Org members upload receipt images" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'receipts' AND
        (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
    );

CREATE POLICY "Org members delete own receipt images" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'receipts' AND (
            public.get_auth_user_role() = 'Super Admin' OR
            (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
        )
    );

-- 16. Initial Seed Data (Primary Client & Super Admin Setup)
INSERT INTO public.organizations (id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Demo Organization', 'Active')
ON CONFLICT (id) DO NOTHING;
