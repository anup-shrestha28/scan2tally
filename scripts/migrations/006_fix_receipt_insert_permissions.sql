-- Receipt uploads are created directly by signed-in browser clients.
-- Make both the table privilege and the INSERT row check explicit so existing
-- installations do not depend on implicit FOR ALL policy behaviour.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.receipts TO authenticated;

DROP POLICY IF EXISTS "Users Access Receipts in Org Batches" ON public.receipts;

CREATE POLICY "Users Access Receipts in Org Batches" ON public.receipts
    FOR ALL
    USING (
        batch_id IN (
            SELECT id
            FROM public.scan_batches
            WHERE organization_id = public.get_auth_user_org_id()
        )
    )
    WITH CHECK (
        batch_id IN (
            SELECT id
            FROM public.scan_batches
            WHERE organization_id = public.get_auth_user_org_id()
        )
        AND uploaded_by = auth.uid()
    );
