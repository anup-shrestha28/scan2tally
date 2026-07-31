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
