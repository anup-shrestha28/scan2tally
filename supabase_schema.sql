-- ====================================================================
-- Scan2Tally - Complete Supabase PostgreSQL Schema Script
-- Supports Multi-Tenancy, Row Level Security (RLS), and PRD Specifications
-- ====================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;

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
    hidden_from_users BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
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
    -- Durable queue marker.  The UI derives Queued from Pending + non-null id;
    -- the enum itself deliberately stays unchanged.
    extraction_queue_message_id BIGINT,
    extraction_queued_at TIMESTAMPTZ,
    extraction_generation BIGINT NOT NULL DEFAULT 0,
    extraction_attempt_count INTEGER NOT NULL DEFAULT 0,
    extraction_lease_token UUID,
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
    file_path TEXT,
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

CREATE OR REPLACE FUNCTION public.get_batch_creator_names(p_batch_ids UUID[])
RETURNS TABLE (id UUID, name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT DISTINCT u.id, u.name
    FROM public.users AS u
    JOIN public.scan_batches AS b ON b.created_by = u.id
    WHERE b.id = ANY(p_batch_ids)
      AND (
        public.get_auth_user_role() = 'Super Admin'
        OR (
          b.organization_id = public.get_auth_user_org_id()
          AND (
            b.created_by = auth.uid()
            OR (b.hidden_from_users = FALSE AND public.get_auth_user_role() = 'Admin')
            OR (b.hidden_from_users = TRUE AND b.hidden_by = auth.uid())
          )
        )
      );
$$;

GRANT EXECUTE ON FUNCTION public.get_batch_creator_names(UUID[]) TO authenticated;

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
-- own row through "Users Read Own Profile" below; their limited directory is
-- served by the authenticated backend without broadening table access.
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
    FOR ALL
    USING (
        organization_id = public.get_auth_user_org_id() AND
        (
            (hidden_from_users = FALSE AND
                (created_by = auth.uid() OR public.get_auth_user_role() = 'Admin'))
            OR (hidden_from_users = TRUE AND hidden_by = auth.uid())
        )
    )
    WITH CHECK (
        organization_id = public.get_auth_user_org_id() AND
        (created_by = auth.uid() OR public.get_auth_user_role() = 'Admin') AND
        (hidden_from_users = FALSE OR
            (public.get_auth_user_role() = 'Admin' AND hidden_by = auth.uid()))
    );

CREATE POLICY "Users Access Receipts in Org Batches" ON public.receipts
    FOR ALL USING (
        batch_id IN (
            SELECT id FROM public.scan_batches WHERE organization_id = public.get_auth_user_org_id()
        )
    ) WITH CHECK (
        batch_id IN (
            SELECT id FROM public.scan_batches WHERE organization_id = public.get_auth_user_org_id()
        ) AND
        uploaded_by = auth.uid()
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

-- Private copies of generated Excel files, so an export can be downloaded again
-- from the batch history without rebuilding it in the browser.
INSERT INTO storage.buckets (id, name, public)
VALUES ('exports', 'exports', FALSE)
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

CREATE POLICY "Org members read own exports" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'exports' AND (
            public.get_auth_user_role() = 'Super Admin' OR
            (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
        )
    );

CREATE POLICY "Org members upload own exports" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'exports' AND
        (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
    );

CREATE POLICY "Org members delete own exports" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'exports' AND (
            public.get_auth_user_role() = 'Super Admin' OR
            (storage.foldername(name))[1] = public.get_auth_user_org_id()::text
        )
    );

-- 16. Platform capacity snapshot
-- Read-only aggregation for the backend's capacity monitor. Browser sessions
-- cannot call this directly; the backend authenticates the caller before using
-- its service-role access.
CREATE OR REPLACE FUNCTION public.get_platform_usage()
RETURNS TABLE (
    database_bytes BIGINT,
    storage_bytes BIGINT,
    storage_objects BIGINT,
    storage_by_bucket JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, storage
AS $$
    WITH bucket_totals AS (
        SELECT
            bucket_id,
            COUNT(*)::BIGINT AS object_count,
            COALESCE(SUM(
                CASE
                    WHEN metadata->>'size' ~ '^[0-9]+$'
                        THEN (metadata->>'size')::NUMERIC
                    ELSE 0
                END
            ), 0)::BIGINT AS bucket_bytes
        FROM storage.objects
        GROUP BY bucket_id
    )
    SELECT
        (
            SELECT COALESCE(SUM(pg_database_size(pg_database.datname)), 0)::BIGINT
            FROM pg_database
        ),
        COALESCE(SUM(bucket_bytes), 0)::BIGINT,
        COALESCE(SUM(object_count), 0)::BIGINT,
        COALESCE(jsonb_object_agg(bucket_id, bucket_bytes), '{}'::JSONB)
    FROM bucket_totals;
$$;

REVOKE ALL ON FUNCTION public.get_platform_usage() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_usage() TO service_role;

-- 16b. Persisted capacity alerts for Admin and Operator sessions
--
-- Exact capacity remains service-role-only. Browser sessions receive only these
-- sanitized state transitions, directly from Supabase Realtime, so they never
-- need to call the protected platform-usage endpoint.
CREATE TABLE IF NOT EXISTS public.platform_capacity_alerts (
    resource TEXT PRIMARY KEY CHECK (resource IN ('storage', 'database')),
    level TEXT NOT NULL CHECK (level IN ('healthy', 'warning', 'critical', 'full')),
    percent NUMERIC(7, 2) NOT NULL CHECK (percent >= 0),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_capacity_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.platform_capacity_alerts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_capacity_alerts FROM authenticated;
GRANT SELECT ON TABLE public.platform_capacity_alerts TO authenticated;
GRANT ALL ON TABLE public.platform_capacity_alerts TO service_role;

CREATE POLICY "Active staff read platform capacity alerts"
    ON public.platform_capacity_alerts
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.users AS current_profile
            WHERE current_profile.id = auth.uid()
              AND current_profile.status = 'Active'
              AND current_profile.role IN ('Super Admin', 'Admin', 'Operator')
        )
    );

-- This function performs the measurement and the transition write in one
-- transaction. Multiple backend workers can call it safely; the advisory lock
-- and level comparison prevent duplicate Realtime notifications.
CREATE OR REPLACE FUNCTION public.refresh_platform_capacity_alerts(
    p_storage_quota_bytes BIGINT,
    p_database_quota_bytes BIGINT,
    p_warning_percent NUMERIC,
    p_critical_percent NUMERIC
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, storage
AS $$
DECLARE
    usage_snapshot RECORD;
    metric RECORD;
    next_level TEXT;
    next_title TEXT;
    next_message TEXT;
    next_percent NUMERIC(7, 2);
    affected_rows INTEGER;
    transition_count INTEGER := 0;
BEGIN
    IF p_storage_quota_bytes <= 0 OR p_database_quota_bytes <= 0 THEN
        RAISE EXCEPTION 'Capacity quotas must be positive';
    END IF;
    IF p_warning_percent <= 0 OR p_warning_percent >= 100
       OR p_critical_percent < p_warning_percent OR p_critical_percent > 100 THEN
        RAISE EXCEPTION 'Capacity thresholds are invalid';
    END IF;

    IF NOT pg_try_advisory_xact_lock(735221904) THEN
        RETURN 0;
    END IF;

    SELECT * INTO usage_snapshot FROM public.get_platform_usage();

    FOR metric IN
        SELECT *
        FROM (VALUES
            ('storage'::TEXT, 'File storage'::TEXT, usage_snapshot.storage_bytes, p_storage_quota_bytes),
            ('database'::TEXT, 'Database'::TEXT, usage_snapshot.database_bytes, p_database_quota_bytes)
        ) AS available_metrics(resource, label, used_bytes, quota_bytes)
        WHERE used_bytes IS NOT NULL
    LOOP
        next_percent := ROUND((metric.used_bytes::NUMERIC / metric.quota_bytes::NUMERIC) * 100, 2);

        IF next_percent >= 100 THEN
            next_level := 'full';
            next_title := metric.label || ' capacity reached';
            next_message := CASE metric.resource
                WHEN 'storage' THEN 'File storage is full. New uploads may fail. Contact the Super Admin immediately.'
                ELSE 'Database capacity is full. New records and updates may fail. Contact the Super Admin immediately.'
            END;
        ELSIF next_percent >= p_critical_percent THEN
            next_level := 'critical';
            next_title := metric.label || ' capacity critical';
            next_message := metric.label || ' is critically close to its limit. Contact the Super Admin to free space or increase capacity.';
        ELSIF next_percent >= p_warning_percent THEN
            next_level := 'warning';
            next_title := metric.label || ' capacity warning';
            next_message := metric.label || ' is approaching its limit. Contact the Super Admin to free space or increase capacity.';
        ELSE
            next_level := 'healthy';
            next_title := metric.label || ' capacity healthy';
            next_message := metric.label || ' is within its configured capacity.';
        END IF;

        INSERT INTO public.platform_capacity_alerts (
            resource, level, percent, title, message, revision, changed_at
        ) VALUES (
            metric.resource, next_level, next_percent, next_title, next_message, 1, NOW()
        )
        ON CONFLICT (resource) DO UPDATE
        SET level = EXCLUDED.level,
            percent = EXCLUDED.percent,
            title = EXCLUDED.title,
            message = EXCLUDED.message,
            revision = public.platform_capacity_alerts.revision + 1,
            changed_at = NOW()
        WHERE public.platform_capacity_alerts.level IS DISTINCT FROM EXCLUDED.level;

        GET DIAGNOSTICS affected_rows = ROW_COUNT;
        transition_count := transition_count + affected_rows;
    END LOOP;

    RETURN transition_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_platform_capacity_alerts(BIGINT, BIGINT, NUMERIC, NUMERIC)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_platform_capacity_alerts(BIGINT, BIGINT, NUMERIC, NUMERIC)
    TO service_role;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'platform_capacity_alerts'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.platform_capacity_alerts';
    END IF;
END;
$$;

-- 17. Initial Seed Data (Primary Client & Super Admin Setup)
INSERT INTO public.organizations (id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Demo Organization', 'Active')
ON CONFLICT (id) DO NOTHING;

-- 18. Durable, globally sequential extraction queue
-- Mirrored from scripts/migrations/007_sequential_extraction_queue.sql so a
-- fresh schema install has the same queue, lease, fencing, and RPC contract.
-- ============================================================================
-- Scan2Tally migration 007: durable, globally sequential receipt extraction
--
-- The browser only asks the backend to enqueue a receipt.  PGMQ keeps that
-- request durable and a singleton lease allows exactly one backend worker to
-- own OCR work across the whole platform, even when several backend replicas
-- are running.  Every final write is fenced by (worker, lease token, queue
-- message, receipt), so a worker that wakes after losing its lease cannot
-- overwrite a newer attempt.
--
-- Requires migration 002_ledgers_claiming_audit.sql. Apply 002 first.
-- Deploy this migration while the old backend is stopped, then start the new
-- backend.  Existing Processing receipts are moved into the durable queue.
-- Safe to run more than once.
-- ============================================================================

-- Migration 007's lifecycle RPCs deliberately reuse the audit and claiming
-- fields introduced by migration 002.  PL/pgSQL resolves table columns lazily,
-- so without this explicit guard an out-of-order install can appear successful
-- and even report healthy, only to fail when the first receipt is enqueued.
DO $$
DECLARE
    missing_columns TEXT[];
BEGIN
    SELECT array_agg(required.table_name || '.' || required.column_name)
    INTO missing_columns
    FROM (VALUES
        ('ledgers', 'id'),
        ('ledgers', 'organization_id'),
        ('ledgers', 'name'),
        ('ledgers', 'aliases'),
        ('ledgers', 'is_active'),
        ('transactions', 'ledger_id'),
        ('transactions', 'ledger_match'),
        ('transactions', 'ledger_match_score'),
        ('receipts', 'extraction_worker'),
        ('receipts', 'extraction_claimed_at'),
        ('receipts', 'raw_extraction')
    ) AS required(table_name, column_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns AS existing
        WHERE existing.table_schema = 'public'
          AND existing.table_name = required.table_name
          AND existing.column_name = required.column_name
    );

    IF missing_columns IS NOT NULL
       OR to_regtype('public.ledger_match') IS NULL THEN
        RAISE EXCEPTION
            'Migration 007 requires migration 002_ledgers_claiming_audit.sql first'
            USING DETAIL = concat(
                'Missing prerequisites: ',
                COALESCE(array_to_string(missing_columns, ', '), ''),
                CASE
                    WHEN to_regtype('public.ledger_match') IS NULL
                    THEN CASE WHEN missing_columns IS NULL THEN '' ELSE ', ' END
                         || 'type public.ledger_match'
                    ELSE ''
                END
            ),
            HINT = 'Apply migration 002, then run migration 007 again.';
    END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;

-- PGMQ creates one logged queue table and one archive table.  Keep the queue
-- private: application browsers use the public backend endpoint, never PGMQ.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pgmq.list_queues()
        WHERE queue_name = 'receipt_extraction'
    ) THEN
        PERFORM pgmq.create('receipt_extraction');
    END IF;
END;
$$;

REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA pgmq TO service_role;

-- Keep receipt_status unchanged.  A receipt is visibly Queued when its raw
-- status is Pending and extraction_queue_message_id is non-null.  This avoids
-- the unsafe-in-the-same-transaction edge of adding and immediately using a
-- PostgreSQL enum value during a migration.
ALTER TABLE public.receipts
    ADD COLUMN IF NOT EXISTS extraction_queue_message_id BIGINT,
    ADD COLUMN IF NOT EXISTS extraction_queued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS extraction_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extraction_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extraction_lease_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_extraction_queue_message
    ON public.receipts(extraction_queue_message_id)
    WHERE extraction_queue_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_extraction_queued_at
    ON public.receipts(extraction_queued_at, id)
    WHERE extraction_queue_message_id IS NOT NULL;

-- There is deliberately one row and one slot.  Increasing the number of rows
-- would change the platform-wide concurrency contract.
CREATE TABLE IF NOT EXISTS public.extraction_worker_slot (
    slot_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (slot_id = 1),
    worker_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    queue_message_id BIGINT,
    receipt_id UUID REFERENCES public.receipts(id) ON DELETE SET NULL,
    CONSTRAINT extraction_worker_slot_all_or_none CHECK (
        (worker_id IS NULL
         AND lease_token IS NULL
         AND lease_expires_at IS NULL
         AND heartbeat_at IS NULL
         AND queue_message_id IS NULL
         AND receipt_id IS NULL)
        OR
        (worker_id IS NOT NULL
         AND lease_token IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND heartbeat_at IS NOT NULL
         AND queue_message_id IS NOT NULL
         AND receipt_id IS NOT NULL)
    )
);

-- Rebuild the constraint as well as creating it, so rerunning this migration
-- also repairs an interrupted/older draft without leaving a weaker invariant.
ALTER TABLE public.extraction_worker_slot
    DROP CONSTRAINT IF EXISTS extraction_worker_slot_all_or_none;
ALTER TABLE public.extraction_worker_slot
    ADD CONSTRAINT extraction_worker_slot_all_or_none CHECK (
        (worker_id IS NULL
         AND lease_token IS NULL
         AND lease_expires_at IS NULL
         AND heartbeat_at IS NULL
         AND queue_message_id IS NULL
         AND receipt_id IS NULL)
        OR
        (worker_id IS NOT NULL
         AND lease_token IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND heartbeat_at IS NOT NULL
         AND queue_message_id IS NOT NULL
         AND receipt_id IS NOT NULL)
    );

INSERT INTO public.extraction_worker_slot (slot_id)
VALUES (1)
ON CONFLICT (slot_id) DO NOTHING;

ALTER TABLE public.extraction_worker_slot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.extraction_worker_slot FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.extraction_worker_slot TO service_role;

-- Browsers must not manufacture queue claims, terminal statuses, or model
-- output.  They may create/delete their own receipt rows under RLS and fill in
-- only the storage metadata after an upload succeeds.
REVOKE INSERT, UPDATE ON TABLE public.receipts FROM authenticated;
GRANT INSERT (
    id, batch_id, uploaded_by, filename, file_path,
    image_width, image_height
) ON public.receipts TO authenticated;
GRANT UPDATE (
    file_path, image_width, image_height
) ON public.receipts TO authenticated;

-- The service role downloads the object named by receipts.file_path, bypassing
-- Storage RLS.  Accept only the exact key shape written by uploadReceiptImage:
-- <organization>/<batch>/<receipt>.<extension>.  This prevents an otherwise
-- valid receipt row from being pointed at another tenant's private object.
CREATE OR REPLACE FUNCTION public.receipt_storage_path_is_valid(
    p_path TEXT,
    p_organization_id UUID,
    p_batch_id UUID,
    p_receipt_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_path IS NOT NULL
       AND p_organization_id IS NOT NULL
       AND p_batch_id IS NOT NULL
       AND p_receipt_id IS NOT NULL
       AND p_path LIKE (
           p_organization_id::TEXT || '/' ||
           p_batch_id::TEXT || '/' ||
           p_receipt_id::TEXT || '.%'
       )
       AND LENGTH(p_path) > LENGTH(
           p_organization_id::TEXT || '/' ||
           p_batch_id::TEXT || '/' ||
           p_receipt_id::TEXT || '.'
       )
       AND POSITION('/' IN SUBSTRING(
           p_path FROM LENGTH(
               p_organization_id::TEXT || '/' ||
               p_batch_id::TEXT || '/' ||
               p_receipt_id::TEXT || '.'
           ) + 1
       )) = 0;
$$;

CREATE OR REPLACE FUNCTION public.guard_queued_receipt_file_path()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.file_path IS DISTINCT FROM OLD.file_path
       AND (OLD.extraction_queue_message_id IS NOT NULL OR OLD.status = 'Processing') THEN
        RAISE EXCEPTION 'A queued or processing receipt image cannot be replaced'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_receipts_guard_queued_file_path ON public.receipts;
CREATE TRIGGER trg_receipts_guard_queued_file_path
    BEFORE UPDATE OF file_path ON public.receipts
    FOR EACH ROW EXECUTE FUNCTION public.guard_queued_receipt_file_path();

REVOKE ALL ON FUNCTION public.receipt_storage_path_is_valid(TEXT, UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_queued_receipt_file_path()
    FROM PUBLIC, anon, authenticated;

-- A cheap feature probe for backend startup and diagnostics.
CREATE OR REPLACE FUNCTION public.extraction_queue_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    queue_depth BIGINT := 0;
    current_slot public.extraction_worker_slot%ROWTYPE;
    prerequisites_ready BOOLEAN := FALSE;
BEGIN
    SELECT COALESCE(metrics.queue_length, 0)
    INTO queue_depth
    FROM pgmq.metrics('receipt_extraction') AS metrics;

    SELECT *
    INTO current_slot
    FROM public.extraction_worker_slot
    WHERE slot_id = 1;

    SELECT to_regtype('public.ledger_match') IS NOT NULL
       AND NOT EXISTS (
            SELECT 1
            FROM (VALUES
                ('ledgers', 'id'),
                ('ledgers', 'organization_id'),
                ('ledgers', 'name'),
                ('ledgers', 'aliases'),
                ('ledgers', 'is_active'),
                ('transactions', 'ledger_id'),
                ('transactions', 'ledger_match'),
                ('transactions', 'ledger_match_score'),
                ('receipts', 'extraction_worker'),
                ('receipts', 'extraction_claimed_at'),
                ('receipts', 'raw_extraction')
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
                SELECT 1
                FROM information_schema.columns AS existing
                WHERE existing.table_schema = 'public'
                  AND existing.table_name = required.table_name
                  AND existing.column_name = required.column_name
            )
       )
    INTO prerequisites_ready;

    RETURN jsonb_build_object(
        'ready', prerequisites_ready AND COALESCE(current_slot.slot_id = 1, FALSE),
        'queue_name', 'receipt_extraction',
        'queue_length', COALESCE(queue_depth, 0),
        'active_receipt_id', current_slot.receipt_id,
        'lease_expires_at', current_slot.lease_expires_at
    );
END;
$$;

-- Idempotently enqueue one receipt.  Ownership is checked here even though the
-- backend also checks it, because this function runs with elevated privileges.
CREATE OR REPLACE FUNCTION public.enqueue_receipt_extraction(
    p_receipt_id UUID,
    p_requested_by UUID
)
RETURNS TABLE (
    receipt_id UUID,
    queue_message_id BIGINT,
    status receipt_status,
    queued_at TIMESTAMPTZ,
    already_queued BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    target_receipt public.receipts%ROWTYPE;
    target_org_id UUID;
    requester public.users%ROWTYPE;
    next_generation BIGINT;
    new_message_id BIGINT;
BEGIN
    IF p_receipt_id IS NULL OR p_requested_by IS NULL THEN
        RAISE EXCEPTION 'Receipt and requester are required' USING ERRCODE = '22004';
    END IF;

    SELECT r.*
    INTO target_receipt
    FROM public.receipts AS r
    WHERE r.id = p_receipt_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Receipt % does not exist', p_receipt_id USING ERRCODE = 'P0002';
    END IF;

    SELECT b.organization_id
    INTO target_org_id
    FROM public.scan_batches AS b
    WHERE b.id = target_receipt.batch_id;

    SELECT u.*
    INTO requester
    FROM public.users AS u
    WHERE u.id = p_requested_by;

    IF NOT FOUND OR requester.status <> 'Active' THEN
        RAISE EXCEPTION 'The requester is not an active staff user' USING ERRCODE = '42501';
    END IF;

    IF requester.role <> 'Super Admin'
       AND requester.organization_id IS DISTINCT FROM target_org_id THEN
        RAISE EXCEPTION 'The requester cannot access this receipt' USING ERRCODE = '42501';
    END IF;

    IF target_receipt.extraction_queue_message_id IS NOT NULL
       AND target_receipt.status IN ('Pending', 'Processing') THEN
        RETURN QUERY
        SELECT target_receipt.id,
               target_receipt.extraction_queue_message_id,
               target_receipt.status,
               target_receipt.extraction_queued_at,
               TRUE;
        RETURN;
    END IF;

    IF target_receipt.status NOT IN ('Pending', 'Failed') THEN
        RAISE EXCEPTION 'Receipt % is not available for extraction (status %)',
            target_receipt.id, target_receipt.status
            USING ERRCODE = '55000';
    END IF;

    IF NOT public.receipt_storage_path_is_valid(
        target_receipt.file_path,
        target_org_id,
        target_receipt.batch_id,
        target_receipt.id
    ) THEN
        RAISE EXCEPTION 'The receipt image path is missing or invalid'
            USING ERRCODE = '55000';
    END IF;

    next_generation := target_receipt.extraction_generation + 1;

    SELECT sent.message_id
    INTO new_message_id
    FROM (
        SELECT pgmq.send(
            'receipt_extraction',
            jsonb_build_object(
                'receipt_id', target_receipt.id,
                'requested_by', p_requested_by,
                'generation', next_generation
            )
        ) AS message_id
    ) AS sent;

    IF new_message_id IS NULL THEN
        RAISE EXCEPTION 'PGMQ did not return a message id';
    END IF;

    UPDATE public.receipts AS r
    SET status = 'Pending',
        error_message = NULL,
        verification_warnings = '[]'::JSONB,
        extraction_queue_message_id = new_message_id,
        extraction_queued_at = clock_timestamp(),
        extraction_generation = next_generation,
        extraction_attempt_count = 0,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = target_receipt.id
    RETURNING r.* INTO target_receipt;

    RETURN QUERY
    SELECT target_receipt.id,
           target_receipt.extraction_queue_message_id,
           target_receipt.status,
           target_receipt.extraction_queued_at,
           FALSE;
END;
$$;

-- Pull at most one job.  The singleton row is locked before PGMQ is read, so
-- concurrent replicas cannot both reserve a message. Invalid/obsolete poison
-- messages are deleted and skipped rather than blocking the FIFO head. Receipt
-- state and extraction audit data are already durable, so retaining a second
-- PGMQ archive copy would consume storage forever without serving the app.
CREATE OR REPLACE FUNCTION public.claim_next_receipt_extraction(
    p_worker_id TEXT,
    p_visibility_seconds INTEGER DEFAULT 900,
    p_max_attempts INTEGER DEFAULT 3
)
RETURNS TABLE (
    receipt_id UUID,
    queue_message_id BIGINT,
    lease_token UUID,
    attempt_count INTEGER,
    requested_by UUID,
    uploaded_by UUID,
    batch_id UUID,
    organization_id UUID,
    filename TEXT,
    file_path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    queue_message RECORD;
    target_receipt public.receipts%ROWTYPE;
    target_receipt_id UUID;
    target_org_id UUID;
    target_requested_by UUID;
    target_generation BIGINT;
    new_lease_token UUID;
    removed BOOLEAN;
    skipped_count INTEGER := 0;
BEGIN
    IF NULLIF(BTRIM(p_worker_id), '') IS NULL OR length(p_worker_id) > 200 THEN
        RAISE EXCEPTION 'A worker id of 1-200 characters is required' USING ERRCODE = '22023';
    END IF;
    IF p_visibility_seconds < 30 OR p_visibility_seconds > 86400 THEN
        RAISE EXCEPTION 'Visibility must be between 30 and 86400 seconds' USING ERRCODE = '22023';
    END IF;
    IF p_max_attempts < 1 OR p_max_attempts > 100 THEN
        RAISE EXCEPTION 'Max attempts must be between 1 and 100' USING ERRCODE = '22023';
    END IF;

    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    -- A live owner means platform capacity is exactly one and already occupied.
    IF current_slot.worker_id IS NOT NULL
       AND current_slot.lease_expires_at > clock_timestamp() THEN
        RETURN;
    END IF;

    -- Fence an expired owner immediately.  The message becomes readable again
    -- at its PGMQ visibility timeout and will receive a fresh token on reclaim.
    IF current_slot.worker_id IS NOT NULL THEN
        UPDATE public.receipts AS r
        SET status = 'Pending',
            extraction_worker = NULL,
            extraction_claimed_at = NULL,
            extraction_lease_token = NULL
        WHERE r.id = current_slot.receipt_id
          AND r.extraction_queue_message_id = current_slot.queue_message_id
          AND r.extraction_lease_token = current_slot.lease_token
          AND r.status = 'Processing';

        UPDATE public.extraction_worker_slot AS s
        SET worker_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            queue_message_id = NULL,
            receipt_id = NULL
        WHERE s.slot_id = 1;
    END IF;

    LOOP
        -- Commit progress after a bounded cleanup batch.  Returning (instead of
        -- raising) is important: an exception would roll every archive back and
        -- leave the same poison messages at the head forever.
        IF skipped_count >= 100 THEN
            RETURN;
        END IF;

        SELECT message.*
        INTO queue_message
        FROM pgmq.read('receipt_extraction', p_visibility_seconds, 1) AS message;

        -- No work: leave the singleton slot free immediately.
        IF NOT FOUND THEN
            RETURN;
        END IF;

        skipped_count := skipped_count + 1;

        BEGIN
            target_receipt_id := (queue_message.message ->> 'receipt_id')::UUID;
            target_requested_by := (queue_message.message ->> 'requested_by')::UUID;
            target_generation := (queue_message.message ->> 'generation')::BIGINT;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete malformed extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END;

        SELECT r.*
        INTO target_receipt
        FROM public.receipts AS r
        WHERE r.id = target_receipt_id
        FOR UPDATE;

        -- A deleted receipt, an old generation, or an already-finished receipt
        -- makes this message obsolete.  Archive it and keep looking.
        IF NOT FOUND
           OR target_receipt.extraction_queue_message_id IS DISTINCT FROM queue_message.msg_id
           OR target_receipt.extraction_generation IS DISTINCT FROM target_generation
           OR target_receipt.status NOT IN ('Pending', 'Processing') THEN
            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete obsolete extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        IF queue_message.read_ct > p_max_attempts THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'Extraction stopped after repeated worker interruptions. Please try again.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete exhausted extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        SELECT b.organization_id
        INTO target_org_id
        FROM public.scan_batches AS b
        WHERE b.id = target_receipt.batch_id;

        IF target_org_id IS NULL THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The receipt batch is no longer linked to an organization.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete orphan extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        target_requested_by := COALESCE(target_requested_by, target_receipt.uploaded_by);

        IF NOT public.receipt_storage_path_is_valid(
            target_receipt.file_path,
            target_org_id,
            target_receipt.batch_id,
            target_receipt.id
        ) THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The uploaded image path is missing or invalid. Upload it again and retry.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete invalid-path extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        new_lease_token := gen_random_uuid();

        UPDATE public.extraction_worker_slot AS s
        SET worker_id = p_worker_id,
            lease_token = new_lease_token,
            lease_expires_at = clock_timestamp() + make_interval(secs => p_visibility_seconds),
            heartbeat_at = clock_timestamp(),
            queue_message_id = queue_message.msg_id,
            receipt_id = target_receipt.id
        WHERE s.slot_id = 1;

        UPDATE public.receipts AS r
        SET status = 'Processing',
            error_message = NULL,
            extraction_worker = p_worker_id,
            extraction_claimed_at = clock_timestamp(),
            extraction_lease_token = new_lease_token,
            extraction_attempt_count = queue_message.read_ct
        WHERE r.id = target_receipt.id
          AND r.extraction_queue_message_id = queue_message.msg_id
          AND r.extraction_generation = target_generation;

        RETURN QUERY
        SELECT target_receipt.id,
               queue_message.msg_id::BIGINT,
               new_lease_token,
               queue_message.read_ct::INTEGER,
               target_requested_by,
               target_receipt.uploaded_by,
               target_receipt.batch_id,
               target_org_id,
               target_receipt.filename,
               target_receipt.file_path;
        RETURN;
    END LOOP;
END;
$$;

-- Renew both the singleton lease and the PGMQ visibility timeout atomically.
CREATE OR REPLACE FUNCTION public.heartbeat_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_visibility_seconds INTEGER DEFAULT 900
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    affected_rows INTEGER;
    queue_message RECORD;
BEGIN
    IF p_visibility_seconds < 30 OR p_visibility_seconds > 86400 THEN
        RAISE EXCEPTION 'Visibility must be between 30 and 86400 seconds' USING ERRCODE = '22023';
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET lease_expires_at = clock_timestamp() + make_interval(secs => p_visibility_seconds),
        heartbeat_at = clock_timestamp()
    WHERE s.slot_id = 1
      AND s.worker_id = p_worker_id
      AND s.lease_token = p_lease_token
      AND s.queue_message_id = p_queue_message_id
      AND s.lease_expires_at > clock_timestamp();

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    UPDATE public.receipts AS r
    SET extraction_claimed_at = clock_timestamp()
    WHERE r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id
      AND r.status = 'Processing';

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RAISE EXCEPTION 'The leased receipt no longer matches the worker slot';
    END IF;

    SELECT message.*
    INTO queue_message
    FROM pgmq.set_vt(
        'receipt_extraction',
        p_queue_message_id,
        p_visibility_seconds
    ) AS message;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Queue message % no longer exists', p_queue_message_id;
    END IF;

    RETURN TRUE;
END;
$$;

-- Atomically replace all voucher rows, finalize the receipt, archive the queue
-- message, and release the singleton.  No write happens unless the lease is
-- still current, which is the fencing guarantee.
CREATE OR REPLACE FUNCTION public.complete_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_receipt_id UUID,
    p_transactions JSONB,
    p_verification_warnings JSONB,
    p_raw_extraction JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    target_receipt public.receipts%ROWTYPE;
    target_org_id UUID;
    removed BOOLEAN;
BEGIN
    IF jsonb_typeof(p_transactions) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_transactions) = 0 THEN
        RAISE EXCEPTION 'At least one extracted transaction is required' USING ERRCODE = '22023';
    END IF;
    IF p_verification_warnings IS NOT NULL
       AND jsonb_typeof(p_verification_warnings) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Verification warnings must be a JSON array' USING ERRCODE = '22023';
    END IF;

    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    IF current_slot.worker_id IS DISTINCT FROM p_worker_id
       OR current_slot.lease_token IS DISTINCT FROM p_lease_token
       OR current_slot.queue_message_id IS DISTINCT FROM p_queue_message_id
       OR current_slot.receipt_id IS DISTINCT FROM p_receipt_id
       OR current_slot.lease_expires_at <= clock_timestamp() THEN
        RETURN FALSE;
    END IF;

    SELECT r.*
    INTO target_receipt
    FROM public.receipts AS r
    WHERE r.id = p_receipt_id
      AND r.status = 'Processing'
      AND r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT b.organization_id
    INTO target_org_id
    FROM public.scan_batches AS b
    WHERE b.id = target_receipt.batch_id;

    IF target_org_id IS NULL THEN
        RAISE EXCEPTION 'The receipt batch no longer has an organization';
    END IF;

    DELETE FROM public.transactions AS existing
    WHERE existing.receipt_id = target_receipt.id;

    INSERT INTO public.transactions (
        receipt_id,
        batch_id,
        organization_id,
        position,
        voucher_date,
        voucher_type,
        entry_type,
        ledger_name,
        ledger_id,
        ledger_match,
        ledger_match_score,
        debit_amount,
        credit_amount,
        needs_review,
        narration,
        raw_extracted_data,
        updated_by
    )
    SELECT
        target_receipt.id,
        target_receipt.batch_id,
        target_org_id,
        COALESCE(row_data.position, row_number() OVER ()::INTEGER - 1),
        row_data.voucher_date,
        COALESCE(NULLIF(row_data.voucher_type, ''), 'Journal'),
        row_data.entry_type::public.entry_type,
        COALESCE(row_data.ledger_name, ''),
        row_data.ledger_id,
        COALESCE(row_data.ledger_match, 'Unchecked')::public.ledger_match,
        row_data.ledger_match_score,
        COALESCE(row_data.debit_amount, 0),
        COALESCE(row_data.credit_amount, 0),
        COALESCE(row_data.needs_review, FALSE),
        COALESCE(row_data.narration, ''),
        row_data.raw_extracted_data,
        COALESCE(row_data.updated_by, target_receipt.uploaded_by)
    FROM jsonb_to_recordset(p_transactions) AS row_data (
        position INTEGER,
        voucher_date TEXT,
        voucher_type TEXT,
        entry_type TEXT,
        ledger_name TEXT,
        ledger_id UUID,
        ledger_match TEXT,
        ledger_match_score NUMERIC(4, 3),
        debit_amount NUMERIC(14, 2),
        credit_amount NUMERIC(14, 2),
        needs_review BOOLEAN,
        narration TEXT,
        raw_extracted_data JSONB,
        updated_by UUID
    );

    UPDATE public.receipts AS r
    SET status = 'Extracted',
        error_message = NULL,
        verification_warnings = COALESCE(p_verification_warnings, '[]'::JSONB),
        raw_extraction = p_raw_extraction,
        extraction_queue_message_id = NULL,
        extraction_queued_at = NULL,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = target_receipt.id;

    SELECT pgmq.delete('receipt_extraction', p_queue_message_id)
    INTO removed;
    IF removed IS NOT TRUE THEN
        RAISE EXCEPTION 'Could not delete completed extraction message %', p_queue_message_id;
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        queue_message_id = NULL,
        receipt_id = NULL
    WHERE s.slot_id = 1;

    RETURN TRUE;
END;
$$;

-- Permanent failure is atomic for the same reason as completion.  Process
-- crashes do not call this function; their message becomes visible after the
-- lease/visibility timeout and is retried by another worker.
CREATE OR REPLACE FUNCTION public.fail_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_receipt_id UUID,
    p_error_message TEXT,
    p_raw_extraction JSONB DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    affected_rows INTEGER;
    removed BOOLEAN;
BEGIN
    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    IF current_slot.worker_id IS DISTINCT FROM p_worker_id
       OR current_slot.lease_token IS DISTINCT FROM p_lease_token
       OR current_slot.queue_message_id IS DISTINCT FROM p_queue_message_id
       OR current_slot.receipt_id IS DISTINCT FROM p_receipt_id
       OR current_slot.lease_expires_at <= clock_timestamp() THEN
        RETURN FALSE;
    END IF;

    UPDATE public.receipts AS r
    SET status = 'Failed',
        error_message = LEFT(
            COALESCE(NULLIF(BTRIM(p_error_message), ''), 'Extraction failed. Please try again.'),
            2000
        ),
        verification_warnings = '[]'::JSONB,
        raw_extraction = COALESCE(p_raw_extraction, r.raw_extraction),
        extraction_queue_message_id = NULL,
        extraction_queued_at = NULL,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = p_receipt_id
      AND r.status = 'Processing'
      AND r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    SELECT pgmq.delete('receipt_extraction', p_queue_message_id)
    INTO removed;
    IF removed IS NOT TRUE THEN
        RAISE EXCEPTION 'Could not delete failed extraction message %', p_queue_message_id;
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        queue_message_id = NULL,
        receipt_id = NULL
    WHERE s.slot_id = 1;

    RETURN TRUE;
END;
$$;

-- Lock down all queue RPCs.  The browser reaches them only through the backend,
-- whose service key is never shipped to the client.
REVOKE ALL ON FUNCTION public.extraction_queue_health()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_receipt_extraction(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.extraction_queue_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_receipt_extraction(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB) TO service_role;

-- Move work stranded by the pre-queue backend into PGMQ.  Plain Pending rows
-- are intentionally not queued: an upload may be saved for review later and
-- was never necessarily requested for extraction.
DO $$
DECLARE
    interrupted RECORD;
    next_generation BIGINT;
    new_message_id BIGINT;
BEGIN
    FOR interrupted IN
        SELECT r.id, r.uploaded_by, r.file_path, r.extraction_generation
        FROM public.receipts AS r
        WHERE r.status = 'Processing'
          AND r.extraction_queue_message_id IS NULL
        ORDER BY r.created_at, r.id
        FOR UPDATE
    LOOP
        IF NULLIF(BTRIM(interrupted.file_path), '') IS NULL THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The uploaded image is missing. Upload it again and retry.',
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL
            WHERE r.id = interrupted.id;
            CONTINUE;
        END IF;

        next_generation := interrupted.extraction_generation + 1;

        SELECT sent.message_id
        INTO new_message_id
        FROM (
            SELECT pgmq.send(
                'receipt_extraction',
                jsonb_build_object(
                    'receipt_id', interrupted.id,
                    'requested_by', interrupted.uploaded_by,
                    'generation', next_generation
                )
            ) AS message_id
        ) AS sent;

        UPDATE public.receipts AS r
        SET status = 'Pending',
            error_message = NULL,
            extraction_queue_message_id = new_message_id,
            extraction_queued_at = clock_timestamp(),
            extraction_generation = next_generation,
            extraction_attempt_count = 0,
            extraction_worker = NULL,
            extraction_claimed_at = NULL,
            extraction_lease_token = NULL
        WHERE r.id = interrupted.id;
    END LOOP;
END;
$$;

-- Receipt changes drive the queued/processing/completed UI without browser
-- polling.  Do not disturb tables already present in Supabase Realtime.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'receipts'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.receipts';
    END IF;
END;
$$;
