-- Keep the extraction backend from being put to sleep.
--
-- Render's free plan stops a web service after 15 minutes without an inbound
-- request. The extraction worker is not a separate process — it is an asyncio
-- task inside that same web service — so a sleeping backend is a stopped queue.
-- Vouchers uploaded meanwhile sit at "Queued" doing nothing, and the next click
-- pays roughly 50 seconds of cold start before anything begins.
--
-- The database is the one part of this system that is always awake, so it does
-- the waking. pg_net issues the request from inside Postgres and pg_cron decides
-- when, which needs no third-party pinger, no new account, and no GitHub Actions
-- minutes.
--
-- WHY NOT AROUND THE CLOCK
-- Render's free tier allows 750 instance-hours a month per workspace. Awake
-- permanently is about 730 of them, which fits with nothing to spare and stops
-- fitting the moment a second free service exists. The window below is the
-- Nepali working day, which is when vouchers are actually extracted:
--
--     */10 0-16 * * *   ->  every 10 min, 00:00-16:59 UTC
--                       ->  05:45-22:44 Nepal time (UTC+5:45)
--                       ->  ~17h/day, ~510 h/month, comfortably inside 750
--
-- Outside that window the service sleeps as usual, and the first upload of the
-- morning wakes it as it does today.
--
-- WORTH KNOWING
-- This works around a limit that exists to sell the paid plan. Render's $7/month
-- Starter never sleeps and needs none of this. Nothing here is hidden or
-- disguised, but it is a workaround, not a fix.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;


-- Scheduling is wrapped so the URL is passed in rather than buried in a cron
-- command string, and so re-running this file, or moving the backend, is one
-- call instead of hand-editing the job table.
CREATE OR REPLACE FUNCTION public.schedule_backend_keepalive(
    p_health_url TEXT,
    p_schedule TEXT DEFAULT '*/10 0-16 * * *'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    job_name CONSTANT TEXT := 'scan2tally-keep-backend-awake';
BEGIN
    -- Only ever points at a health endpoint, and only over TLS. A cron entry is
    -- an unattended outbound request from inside the database; it should not be
    -- possible to aim it at an arbitrary host by passing a different string.
    IF p_health_url !~ '^https://[A-Za-z0-9.-]+\.onrender\.com/api/health$' THEN
        RAISE EXCEPTION 'Expected an https .onrender.com /api/health URL, got %', p_health_url
            USING ERRCODE = '22023';
    END IF;

    -- unschedule() raises when the job is absent, so removing it is conditional.
    PERFORM cron.unschedule(job_name)
    FROM cron.job AS j
    WHERE j.jobname = job_name;

    PERFORM cron.schedule(
        job_name,
        p_schedule,
        format(
            -- A short timeout on purpose: this only has to arrive, not to be
            -- answered. A cold start takes far longer than any sensible wait,
            -- and the request itself is what does the waking.
            --
            -- The header is what makes the ping legible in the backend log.
            -- Render's own health probe hits this same path, so without it the
            -- access log is a mix of two things that look identical and nobody
            -- can tell whether the keepalive is actually running.
            $cmd$SELECT net.http_get(
                url := %L,
                headers := '{"X-Keepalive-Source": "supabase-pg-cron"}'::jsonb,
                timeout_milliseconds := 5000
            )$cmd$,
            p_health_url
        )
    );

    RETURN format('%s scheduled: %s -> %s', job_name, p_schedule, p_health_url);
END;
$$;

COMMENT ON FUNCTION public.schedule_backend_keepalive(TEXT, TEXT) IS
    'Schedules the pg_cron job that pings the backend health endpoint so Render '
    'does not idle the extraction worker to sleep. Re-run with a new URL to move '
    'it, or SELECT cron.unschedule(''scan2tally-keep-backend-awake'') to stop it.';


-- pg_net records every response it receives. These are small, but nothing
-- deletes them and the free database allowance is 500 MB, so the log is pruned
-- rather than left to grow for the life of the project.
CREATE OR REPLACE FUNCTION public.prune_http_response_log(p_keep_days INTEGER DEFAULT 2)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed BIGINT;
BEGIN
    IF p_keep_days < 1 THEN
        RAISE EXCEPTION 'Keep at least one day of responses' USING ERRCODE = '22023';
    END IF;

    DELETE FROM net._http_response
    WHERE created < clock_timestamp() - make_interval(days => p_keep_days);

    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

COMMENT ON FUNCTION public.prune_http_response_log(INTEGER) IS
    'Deletes pg_net response rows older than the given number of days. Scheduled '
    'nightly so the keepalive ping cannot grow the database indefinitely.';


-- ---------------------------------------------------------------- schedule it
--
-- Change this URL if the backend ever moves; re-running the SELECT is enough.
SELECT public.schedule_backend_keepalive('https://scan2tally-api.onrender.com/api/health');

DO $$
BEGIN
    PERFORM cron.unschedule('scan2tally-prune-http-log')
    FROM cron.job AS j
    WHERE j.jobname = 'scan2tally-prune-http-log';

    -- 03:17 UTC: outside the ping window, and off the hour so it does not queue
    -- behind everything else that runs at midnight.
    PERFORM cron.schedule(
        'scan2tally-prune-http-log',
        '17 3 * * *',
        'SELECT public.prune_http_response_log(2)'
    );
END;
$$;


-- Same posture as the extraction RPCs: the browser has no business rescheduling
-- unattended outbound requests from inside the database.
REVOKE ALL ON FUNCTION public.schedule_backend_keepalive(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_http_response_log(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_backend_keepalive(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_http_response_log(INTEGER) TO service_role;
