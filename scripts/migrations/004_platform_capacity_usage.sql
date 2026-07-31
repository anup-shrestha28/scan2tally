-- Live Supabase project capacity for the Scan2Tally backend.
--
-- Storage object metadata is read-only. This function only aggregates it; file
-- writes and deletes continue to go through the Storage API as Supabase
-- requires. Execution is restricted to service_role so ordinary browser
-- sessions cannot inspect other organisations' storage usage.

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
