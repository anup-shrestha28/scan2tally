-- ====================================================================
-- Scan2Tally migration 002
--
-- Three things the schema was missing:
--
--   1. A chart of accounts. Extraction reads whatever ledger name is written on
--      the paper, and Tally only recognises names that already exist in the
--      company. An unrecognised name is not a cosmetic problem: on import Tally
--      either rejects the voucher or quietly creates a SECOND ledger, splitting
--      one account's balance across two without anyone noticing.
--
--   2. Job claiming. Extraction resumes on server start-up, which is correct for
--      one process and actively harmful for several — a booting instance would
--      take over work another instance is still running. A claim makes that
--      race decidable.
--
--   3. Somewhere to keep what the model actually returned. Without it there is
--      no way to tell months later whether a figure was misread or edited, and
--      no way to re-derive rows without paying for the extraction again.
--
-- Safe to run more than once, and on a database that already holds live data.
-- ====================================================================

-- 1. How confident we are that a row's ledger name is one Tally will accept.
--    'Unchecked' is the default on purpose: an organisation that has not entered
--    a chart of accounts yet must not have every row flagged at it.
DO $$ BEGIN
    CREATE TYPE ledger_match AS ENUM ('Unchecked', 'Exact', 'Alias', 'Suggested', 'Unmatched');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Table: ledgers — one organisation's chart of accounts
CREATE TABLE IF NOT EXISTS public.ledgers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- Spelled EXACTLY as it is in Tally. This is the string that gets exported,
    -- so a difference here is a failed or duplicated import.
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

-- Two spellings of one ledger defeat the entire point of having a chart of
-- accounts, so 'TDS Payable' and 'tds payable' collide here rather than becoming
-- two separate accounts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_key ON public.ledgers(organization_id, match_key);
CREATE INDEX IF NOT EXISTS idx_ledgers_org ON public.ledgers(organization_id);

-- 3. Which ledger each extracted row resolved to, and how sure we are.
--    `ledger_name` stays the source of truth for export: it holds the canonical
--    Tally spelling once a row is confidently matched, and the name as written
--    while it is still only a suggestion.
ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS ledger_id UUID REFERENCES public.ledgers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ledger_match ledger_match NOT NULL DEFAULT 'Unchecked',
    -- Similarity behind a 'Suggested' match, 0-1. Null for every other state.
    ADD COLUMN IF NOT EXISTS ledger_match_score NUMERIC(4, 3);

CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON public.transactions(ledger_id);

-- 4. Claiming, so two backend processes cannot extract the same voucher.
--    A claim is (worker, timestamp): the timestamp is refreshed while the job is
--    alive, so a claim that has stopped being refreshed is one whose process
--    died and whose work is free to take over.
ALTER TABLE public.receipts
    ADD COLUMN IF NOT EXISTS extraction_worker TEXT,
    ADD COLUMN IF NOT EXISTS extraction_claimed_at TIMESTAMPTZ,
    -- Exactly what the vision model returned, before any normalisation. Kept on
    -- the receipt rather than only on the rows because the reviewer rewrites the
    -- rows, and the point of this column is to survive that.
    ADD COLUMN IF NOT EXISTS raw_extraction JSONB;

CREATE INDEX IF NOT EXISTS idx_receipts_processing
    ON public.receipts(status) WHERE status = 'Processing';

-- 5. Privileges. RLS filters rows; it does not grant reach to the table.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledgers TO authenticated;
GRANT ALL ON public.ledgers TO service_role;

ALTER TABLE public.ledgers ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledgers_touch ON public.ledgers;
CREATE TRIGGER trg_ledgers_touch BEFORE UPDATE ON public.ledgers
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 6. Policies
DROP POLICY IF EXISTS "Super Admins Full Access Ledgers" ON public.ledgers;
CREATE POLICY "Super Admins Full Access Ledgers" ON public.ledgers
    FOR ALL USING (public.get_auth_user_role() = 'Super Admin');

-- Everyone in the organisation READS the chart of accounts: an Operator needs it
-- to pick the right ledger while reviewing a voucher.
DROP POLICY IF EXISTS "Users Read Org Ledgers" ON public.ledgers;
CREATE POLICY "Users Read Org Ledgers" ON public.ledgers
    FOR SELECT USING (organization_id = public.get_auth_user_org_id());

-- Only Admins MAINTAIN it. This list decides what every future extraction
-- matches against, so a mistyped entry here misroutes vouchers company-wide —
-- that is an accountant's decision, not a data-entry one.
DROP POLICY IF EXISTS "Admins Manage Org Ledgers" ON public.ledgers;
CREATE POLICY "Admins Manage Org Ledgers" ON public.ledgers
    FOR ALL USING (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    ) WITH CHECK (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    );
