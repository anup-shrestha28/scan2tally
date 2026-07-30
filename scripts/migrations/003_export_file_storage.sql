-- Store generated Excel files so users can download an earlier export again.
ALTER TABLE public.exports ADD COLUMN IF NOT EXISTS file_path TEXT;

INSERT INTO storage.buckets (id, name, public)
VALUES ('exports', 'exports', FALSE)
ON CONFLICT (id) DO NOTHING;

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
