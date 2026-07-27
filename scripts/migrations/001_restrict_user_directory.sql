-- Restrict the organisation-wide user directory to Admins.
--
-- The original policy was named "Admins View Users in Same Org" but never
-- checked the caller's role, so any Operator could list every colleague's name,
-- email and role. Operators keep access to their own row through the separate
-- "Users Read Own Profile" policy, which is all the app requires.
--
-- Safe to run on an existing database; it only replaces one policy.

DROP POLICY IF EXISTS "Admins View Users in Same Org" ON public.users;

CREATE POLICY "Admins View Users in Same Org" ON public.users
    FOR SELECT USING (
        public.get_auth_user_role() = 'Admin' AND
        organization_id = public.get_auth_user_org_id()
    );
