-- Persist the current platform-capacity state so Admins and Operators can
-- receive specific warnings through Supabase Realtime without polling the
-- backend capacity endpoint themselves.

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

-- The browser may read sanitized alert text but can never manufacture or alter
-- a platform warning. Only the backend service role calls the refresh function.
REVOKE ALL ON TABLE public.platform_capacity_alerts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.platform_capacity_alerts FROM authenticated;
GRANT SELECT ON TABLE public.platform_capacity_alerts TO authenticated;
GRANT ALL ON TABLE public.platform_capacity_alerts TO service_role;

DROP POLICY IF EXISTS "Active staff read platform capacity alerts"
    ON public.platform_capacity_alerts;
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

-- One transaction calculates both resources and records only severity
-- transitions. The advisory lock makes this safe when several backend workers
-- tick at once; unchanged levels do not emit repetitive Realtime events.
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

-- Supabase creates this publication. Add the table once without disturbing any
-- tables that are already being replicated for other app features.
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
