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
    file_path TEXT NOT NULL, -- Path in Supabase Storage bucket 'receipts'
    status receipt_status DEFAULT 'Pending',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Table: transactions
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES public.receipts(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES public.scan_batches(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    voucher_date DATE,
    voucher_type TEXT DEFAULT 'Journal',
    debit_ledger TEXT,
    credit_ledger TEXT,
    amount NUMERIC(12, 2),
    narration TEXT,
    raw_extracted_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id)
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
CREATE INDEX IF NOT EXISTS idx_exports_batch ON public.exports(batch_id);

-- 10. Enable Row Level Security (RLS) on all tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exports ENABLE ROW LEVEL SECURITY;

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

-- Admin & Operator Organization Data Isolation
CREATE POLICY "Users Read Own Organization" ON public.organizations
    FOR SELECT USING (id = public.get_auth_user_org_id());

CREATE POLICY "Admins View Users in Same Org" ON public.users
    FOR SELECT USING (organization_id = public.get_auth_user_org_id());

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

-- 14. Initial Seed Data (Primary Client & Super Admin Setup)
INSERT INTO public.organizations (id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Demo Organization', 'Active')
ON CONFLICT (id) DO NOTHING;
