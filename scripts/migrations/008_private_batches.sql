-- Allow Admins to hide batches from other organisation users.
-- The batch creator can always see their own batch; other Admins can see only
-- batches that are not hidden. Super Admin access remains unchanged.

ALTER TABLE public.scan_batches
    ADD COLUMN IF NOT EXISTS hidden_from_users BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS hidden_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

DROP POLICY IF EXISTS "Users Access Org Scan Batches" ON public.scan_batches;

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
