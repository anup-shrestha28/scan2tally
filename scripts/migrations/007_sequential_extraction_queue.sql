-- ============================================================================
-- Scan2Tally migration 007: durable, globally sequential receipt extraction
--
-- The browser only asks the backend to enqueue a receipt.  PGMQ keeps that
-- request durable and a singleton lease allows exactly one backend worker to
-- own OCR work across the whole platform, even when several backend replicas
-- are running.  Every final write is fenced by (worker, lease token, queue
-- message, receipt), so a worker that wakes after losing its lease cannot
-- overwrite a newer attempt.
--
-- Requires migration 002_ledgers_claiming_audit.sql. Apply 002 first.
-- Deploy this migration while the old backend is stopped, then start the new
-- backend.  Existing Processing receipts are moved into the durable queue.
-- Safe to run more than once.
-- ============================================================================

-- Migration 007's lifecycle RPCs deliberately reuse the audit and claiming
-- fields introduced by migration 002.  PL/pgSQL resolves table columns lazily,
-- so without this explicit guard an out-of-order install can appear successful
-- and even report healthy, only to fail when the first receipt is enqueued.
DO $$
DECLARE
    missing_columns TEXT[];
BEGIN
    SELECT array_agg(required.table_name || '.' || required.column_name)
    INTO missing_columns
    FROM (VALUES
        ('ledgers', 'id'),
        ('ledgers', 'organization_id'),
        ('ledgers', 'name'),
        ('ledgers', 'aliases'),
        ('ledgers', 'is_active'),
        ('transactions', 'ledger_id'),
        ('transactions', 'ledger_match'),
        ('transactions', 'ledger_match_score'),
        ('receipts', 'extraction_worker'),
        ('receipts', 'extraction_claimed_at'),
        ('receipts', 'raw_extraction')
    ) AS required(table_name, column_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns AS existing
        WHERE existing.table_schema = 'public'
          AND existing.table_name = required.table_name
          AND existing.column_name = required.column_name
    );

    IF missing_columns IS NOT NULL
       OR to_regtype('public.ledger_match') IS NULL THEN
        RAISE EXCEPTION
            'Migration 007 requires migration 002_ledgers_claiming_audit.sql first'
            USING DETAIL = concat(
                'Missing prerequisites: ',
                COALESCE(array_to_string(missing_columns, ', '), ''),
                CASE
                    WHEN to_regtype('public.ledger_match') IS NULL
                    THEN CASE WHEN missing_columns IS NULL THEN '' ELSE ', ' END
                         || 'type public.ledger_match'
                    ELSE ''
                END
            ),
            HINT = 'Apply migration 002, then run migration 007 again.';
    END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pgmq CASCADE;

-- PGMQ creates one logged queue table and one archive table.  Keep the queue
-- private: application browsers use the public backend endpoint, never PGMQ.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pgmq.list_queues()
        WHERE queue_name = 'receipt_extraction'
    ) THEN
        PERFORM pgmq.create('receipt_extraction');
    END IF;
END;
$$;

REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA pgmq TO service_role;

-- Keep receipt_status unchanged.  A receipt is visibly Queued when its raw
-- status is Pending and extraction_queue_message_id is non-null.  This avoids
-- the unsafe-in-the-same-transaction edge of adding and immediately using a
-- PostgreSQL enum value during a migration.
ALTER TABLE public.receipts
    ADD COLUMN IF NOT EXISTS extraction_queue_message_id BIGINT,
    ADD COLUMN IF NOT EXISTS extraction_queued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS extraction_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extraction_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extraction_lease_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_extraction_queue_message
    ON public.receipts(extraction_queue_message_id)
    WHERE extraction_queue_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_extraction_queued_at
    ON public.receipts(extraction_queued_at, id)
    WHERE extraction_queue_message_id IS NOT NULL;

-- There is deliberately one row and one slot.  Increasing the number of rows
-- would change the platform-wide concurrency contract.
CREATE TABLE IF NOT EXISTS public.extraction_worker_slot (
    slot_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (slot_id = 1),
    worker_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    queue_message_id BIGINT,
    receipt_id UUID REFERENCES public.receipts(id) ON DELETE SET NULL,
    CONSTRAINT extraction_worker_slot_all_or_none CHECK (
        (worker_id IS NULL
         AND lease_token IS NULL
         AND lease_expires_at IS NULL
         AND heartbeat_at IS NULL
         AND queue_message_id IS NULL
         AND receipt_id IS NULL)
        OR
        (worker_id IS NOT NULL
         AND lease_token IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND heartbeat_at IS NOT NULL
         AND queue_message_id IS NOT NULL
         AND receipt_id IS NOT NULL)
    )
);

-- Rebuild the constraint as well as creating it, so rerunning this migration
-- also repairs an interrupted/older draft without leaving a weaker invariant.
ALTER TABLE public.extraction_worker_slot
    DROP CONSTRAINT IF EXISTS extraction_worker_slot_all_or_none;
ALTER TABLE public.extraction_worker_slot
    ADD CONSTRAINT extraction_worker_slot_all_or_none CHECK (
        (worker_id IS NULL
         AND lease_token IS NULL
         AND lease_expires_at IS NULL
         AND heartbeat_at IS NULL
         AND queue_message_id IS NULL
         AND receipt_id IS NULL)
        OR
        (worker_id IS NOT NULL
         AND lease_token IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND heartbeat_at IS NOT NULL
         AND queue_message_id IS NOT NULL
         AND receipt_id IS NOT NULL)
    );

INSERT INTO public.extraction_worker_slot (slot_id)
VALUES (1)
ON CONFLICT (slot_id) DO NOTHING;

ALTER TABLE public.extraction_worker_slot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.extraction_worker_slot FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.extraction_worker_slot TO service_role;

-- Browsers must not manufacture queue claims, terminal statuses, or model
-- output.  They may create/delete their own receipt rows under RLS and fill in
-- only the storage metadata after an upload succeeds.
REVOKE INSERT, UPDATE ON TABLE public.receipts FROM authenticated;
GRANT INSERT (
    id, batch_id, uploaded_by, filename, file_path,
    image_width, image_height
) ON public.receipts TO authenticated;
GRANT UPDATE (
    file_path, image_width, image_height
) ON public.receipts TO authenticated;

-- The service role downloads the object named by receipts.file_path, bypassing
-- Storage RLS.  Accept only the exact key shape written by uploadReceiptImage:
-- <organization>/<batch>/<receipt>.<extension>.  This prevents an otherwise
-- valid receipt row from being pointed at another tenant's private object.
CREATE OR REPLACE FUNCTION public.receipt_storage_path_is_valid(
    p_path TEXT,
    p_organization_id UUID,
    p_batch_id UUID,
    p_receipt_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_path IS NOT NULL
       AND p_organization_id IS NOT NULL
       AND p_batch_id IS NOT NULL
       AND p_receipt_id IS NOT NULL
       AND p_path LIKE (
           p_organization_id::TEXT || '/' ||
           p_batch_id::TEXT || '/' ||
           p_receipt_id::TEXT || '.%'
       )
       AND LENGTH(p_path) > LENGTH(
           p_organization_id::TEXT || '/' ||
           p_batch_id::TEXT || '/' ||
           p_receipt_id::TEXT || '.'
       )
       AND POSITION('/' IN SUBSTRING(
           p_path FROM LENGTH(
               p_organization_id::TEXT || '/' ||
               p_batch_id::TEXT || '/' ||
               p_receipt_id::TEXT || '.'
           ) + 1
       )) = 0;
$$;

CREATE OR REPLACE FUNCTION public.guard_queued_receipt_file_path()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.file_path IS DISTINCT FROM OLD.file_path
       AND (OLD.extraction_queue_message_id IS NOT NULL OR OLD.status = 'Processing') THEN
        RAISE EXCEPTION 'A queued or processing receipt image cannot be replaced'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_receipts_guard_queued_file_path ON public.receipts;
CREATE TRIGGER trg_receipts_guard_queued_file_path
    BEFORE UPDATE OF file_path ON public.receipts
    FOR EACH ROW EXECUTE FUNCTION public.guard_queued_receipt_file_path();

REVOKE ALL ON FUNCTION public.receipt_storage_path_is_valid(TEXT, UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_queued_receipt_file_path()
    FROM PUBLIC, anon, authenticated;

-- A cheap feature probe for backend startup and diagnostics.
CREATE OR REPLACE FUNCTION public.extraction_queue_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    queue_depth BIGINT := 0;
    current_slot public.extraction_worker_slot%ROWTYPE;
    prerequisites_ready BOOLEAN := FALSE;
BEGIN
    SELECT COALESCE(metrics.queue_length, 0)
    INTO queue_depth
    FROM pgmq.metrics('receipt_extraction') AS metrics;

    SELECT *
    INTO current_slot
    FROM public.extraction_worker_slot
    WHERE slot_id = 1;

    SELECT to_regtype('public.ledger_match') IS NOT NULL
       AND NOT EXISTS (
            SELECT 1
            FROM (VALUES
                ('ledgers', 'id'),
                ('ledgers', 'organization_id'),
                ('ledgers', 'name'),
                ('ledgers', 'aliases'),
                ('ledgers', 'is_active'),
                ('transactions', 'ledger_id'),
                ('transactions', 'ledger_match'),
                ('transactions', 'ledger_match_score'),
                ('receipts', 'extraction_worker'),
                ('receipts', 'extraction_claimed_at'),
                ('receipts', 'raw_extraction')
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
                SELECT 1
                FROM information_schema.columns AS existing
                WHERE existing.table_schema = 'public'
                  AND existing.table_name = required.table_name
                  AND existing.column_name = required.column_name
            )
       )
    INTO prerequisites_ready;

    RETURN jsonb_build_object(
        'ready', prerequisites_ready AND COALESCE(current_slot.slot_id = 1, FALSE),
        'queue_name', 'receipt_extraction',
        'queue_length', COALESCE(queue_depth, 0),
        'active_receipt_id', current_slot.receipt_id,
        'lease_expires_at', current_slot.lease_expires_at
    );
END;
$$;

-- Idempotently enqueue one receipt.  Ownership is checked here even though the
-- backend also checks it, because this function runs with elevated privileges.
CREATE OR REPLACE FUNCTION public.enqueue_receipt_extraction(
    p_receipt_id UUID,
    p_requested_by UUID
)
RETURNS TABLE (
    receipt_id UUID,
    queue_message_id BIGINT,
    status receipt_status,
    queued_at TIMESTAMPTZ,
    already_queued BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    target_receipt public.receipts%ROWTYPE;
    target_org_id UUID;
    requester public.users%ROWTYPE;
    next_generation BIGINT;
    new_message_id BIGINT;
BEGIN
    IF p_receipt_id IS NULL OR p_requested_by IS NULL THEN
        RAISE EXCEPTION 'Receipt and requester are required' USING ERRCODE = '22004';
    END IF;

    SELECT r.*
    INTO target_receipt
    FROM public.receipts AS r
    WHERE r.id = p_receipt_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Receipt % does not exist', p_receipt_id USING ERRCODE = 'P0002';
    END IF;

    SELECT b.organization_id
    INTO target_org_id
    FROM public.scan_batches AS b
    WHERE b.id = target_receipt.batch_id;

    SELECT u.*
    INTO requester
    FROM public.users AS u
    WHERE u.id = p_requested_by;

    IF NOT FOUND OR requester.status <> 'Active' THEN
        RAISE EXCEPTION 'The requester is not an active staff user' USING ERRCODE = '42501';
    END IF;

    IF requester.role <> 'Super Admin'
       AND requester.organization_id IS DISTINCT FROM target_org_id THEN
        RAISE EXCEPTION 'The requester cannot access this receipt' USING ERRCODE = '42501';
    END IF;

    IF target_receipt.extraction_queue_message_id IS NOT NULL
       AND target_receipt.status IN ('Pending', 'Processing') THEN
        RETURN QUERY
        SELECT target_receipt.id,
               target_receipt.extraction_queue_message_id,
               target_receipt.status,
               target_receipt.extraction_queued_at,
               TRUE;
        RETURN;
    END IF;

    IF target_receipt.status NOT IN ('Pending', 'Failed') THEN
        RAISE EXCEPTION 'Receipt % is not available for extraction (status %)',
            target_receipt.id, target_receipt.status
            USING ERRCODE = '55000';
    END IF;

    IF NOT public.receipt_storage_path_is_valid(
        target_receipt.file_path,
        target_org_id,
        target_receipt.batch_id,
        target_receipt.id
    ) THEN
        RAISE EXCEPTION 'The receipt image path is missing or invalid'
            USING ERRCODE = '55000';
    END IF;

    next_generation := target_receipt.extraction_generation + 1;

    SELECT sent.message_id
    INTO new_message_id
    FROM (
        SELECT pgmq.send(
            'receipt_extraction',
            jsonb_build_object(
                'receipt_id', target_receipt.id,
                'requested_by', p_requested_by,
                'generation', next_generation
            )
        ) AS message_id
    ) AS sent;

    IF new_message_id IS NULL THEN
        RAISE EXCEPTION 'PGMQ did not return a message id';
    END IF;

    UPDATE public.receipts AS r
    SET status = 'Pending',
        error_message = NULL,
        verification_warnings = '[]'::JSONB,
        extraction_queue_message_id = new_message_id,
        extraction_queued_at = clock_timestamp(),
        extraction_generation = next_generation,
        extraction_attempt_count = 0,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = target_receipt.id
    RETURNING r.* INTO target_receipt;

    RETURN QUERY
    SELECT target_receipt.id,
           target_receipt.extraction_queue_message_id,
           target_receipt.status,
           target_receipt.extraction_queued_at,
           FALSE;
END;
$$;

-- Pull at most one job.  The singleton row is locked before PGMQ is read, so
-- concurrent replicas cannot both reserve a message. Invalid/obsolete poison
-- messages are deleted and skipped rather than blocking the FIFO head. Receipt
-- state and extraction audit data are already durable, so retaining a second
-- PGMQ archive copy would consume storage forever without serving the app.
CREATE OR REPLACE FUNCTION public.claim_next_receipt_extraction(
    p_worker_id TEXT,
    p_visibility_seconds INTEGER DEFAULT 900,
    p_max_attempts INTEGER DEFAULT 3
)
RETURNS TABLE (
    receipt_id UUID,
    queue_message_id BIGINT,
    lease_token UUID,
    attempt_count INTEGER,
    requested_by UUID,
    uploaded_by UUID,
    batch_id UUID,
    organization_id UUID,
    filename TEXT,
    file_path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    queue_message RECORD;
    target_receipt public.receipts%ROWTYPE;
    target_receipt_id UUID;
    target_org_id UUID;
    target_requested_by UUID;
    target_generation BIGINT;
    new_lease_token UUID;
    removed BOOLEAN;
    skipped_count INTEGER := 0;
BEGIN
    IF NULLIF(BTRIM(p_worker_id), '') IS NULL OR length(p_worker_id) > 200 THEN
        RAISE EXCEPTION 'A worker id of 1-200 characters is required' USING ERRCODE = '22023';
    END IF;
    IF p_visibility_seconds < 30 OR p_visibility_seconds > 86400 THEN
        RAISE EXCEPTION 'Visibility must be between 30 and 86400 seconds' USING ERRCODE = '22023';
    END IF;
    IF p_max_attempts < 1 OR p_max_attempts > 100 THEN
        RAISE EXCEPTION 'Max attempts must be between 1 and 100' USING ERRCODE = '22023';
    END IF;

    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    -- A live owner means platform capacity is exactly one and already occupied.
    IF current_slot.worker_id IS NOT NULL
       AND current_slot.lease_expires_at > clock_timestamp() THEN
        RETURN;
    END IF;

    -- Fence an expired owner immediately.  The message becomes readable again
    -- at its PGMQ visibility timeout and will receive a fresh token on reclaim.
    IF current_slot.worker_id IS NOT NULL THEN
        UPDATE public.receipts AS r
        SET status = 'Pending',
            extraction_worker = NULL,
            extraction_claimed_at = NULL,
            extraction_lease_token = NULL
        WHERE r.id = current_slot.receipt_id
          AND r.extraction_queue_message_id = current_slot.queue_message_id
          AND r.extraction_lease_token = current_slot.lease_token
          AND r.status = 'Processing';

        UPDATE public.extraction_worker_slot AS s
        SET worker_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            queue_message_id = NULL,
            receipt_id = NULL
        WHERE s.slot_id = 1;
    END IF;

    LOOP
        -- Commit progress after a bounded cleanup batch.  Returning (instead of
        -- raising) is important: an exception would roll every archive back and
        -- leave the same poison messages at the head forever.
        IF skipped_count >= 100 THEN
            RETURN;
        END IF;

        SELECT message.*
        INTO queue_message
        FROM pgmq.read('receipt_extraction', p_visibility_seconds, 1) AS message;

        -- No work: leave the singleton slot free immediately.
        IF NOT FOUND THEN
            RETURN;
        END IF;

        skipped_count := skipped_count + 1;

        BEGIN
            target_receipt_id := (queue_message.message ->> 'receipt_id')::UUID;
            target_requested_by := (queue_message.message ->> 'requested_by')::UUID;
            target_generation := (queue_message.message ->> 'generation')::BIGINT;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete malformed extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END;

        SELECT r.*
        INTO target_receipt
        FROM public.receipts AS r
        WHERE r.id = target_receipt_id
        FOR UPDATE;

        -- A deleted receipt, an old generation, or an already-finished receipt
        -- makes this message obsolete.  Archive it and keep looking.
        IF NOT FOUND
           OR target_receipt.extraction_queue_message_id IS DISTINCT FROM queue_message.msg_id
           OR target_receipt.extraction_generation IS DISTINCT FROM target_generation
           OR target_receipt.status NOT IN ('Pending', 'Processing') THEN
            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete obsolete extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        IF queue_message.read_ct > p_max_attempts THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'Extraction stopped after repeated worker interruptions. Please try again.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete exhausted extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        SELECT b.organization_id
        INTO target_org_id
        FROM public.scan_batches AS b
        WHERE b.id = target_receipt.batch_id;

        IF target_org_id IS NULL THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The receipt batch is no longer linked to an organization.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete orphan extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        target_requested_by := COALESCE(target_requested_by, target_receipt.uploaded_by);

        IF NOT public.receipt_storage_path_is_valid(
            target_receipt.file_path,
            target_org_id,
            target_receipt.batch_id,
            target_receipt.id
        ) THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The uploaded image path is missing or invalid. Upload it again and retry.',
                extraction_queue_message_id = NULL,
                extraction_queued_at = NULL,
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL,
                extraction_attempt_count = queue_message.read_ct
            WHERE r.id = target_receipt.id
              AND r.extraction_queue_message_id = queue_message.msg_id;

            SELECT pgmq.delete('receipt_extraction', queue_message.msg_id)
            INTO removed;
            IF removed IS NOT TRUE THEN
                RAISE EXCEPTION 'Could not delete invalid-path extraction message %', queue_message.msg_id;
            END IF;
            CONTINUE;
        END IF;

        new_lease_token := gen_random_uuid();

        UPDATE public.extraction_worker_slot AS s
        SET worker_id = p_worker_id,
            lease_token = new_lease_token,
            lease_expires_at = clock_timestamp() + make_interval(secs => p_visibility_seconds),
            heartbeat_at = clock_timestamp(),
            queue_message_id = queue_message.msg_id,
            receipt_id = target_receipt.id
        WHERE s.slot_id = 1;

        UPDATE public.receipts AS r
        SET status = 'Processing',
            error_message = NULL,
            extraction_worker = p_worker_id,
            extraction_claimed_at = clock_timestamp(),
            extraction_lease_token = new_lease_token,
            extraction_attempt_count = queue_message.read_ct
        WHERE r.id = target_receipt.id
          AND r.extraction_queue_message_id = queue_message.msg_id
          AND r.extraction_generation = target_generation;

        RETURN QUERY
        SELECT target_receipt.id,
               queue_message.msg_id::BIGINT,
               new_lease_token,
               queue_message.read_ct::INTEGER,
               target_requested_by,
               target_receipt.uploaded_by,
               target_receipt.batch_id,
               target_org_id,
               target_receipt.filename,
               target_receipt.file_path;
        RETURN;
    END LOOP;
END;
$$;

-- Renew both the singleton lease and the PGMQ visibility timeout atomically.
CREATE OR REPLACE FUNCTION public.heartbeat_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_visibility_seconds INTEGER DEFAULT 900
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    affected_rows INTEGER;
    queue_message RECORD;
BEGIN
    IF p_visibility_seconds < 30 OR p_visibility_seconds > 86400 THEN
        RAISE EXCEPTION 'Visibility must be between 30 and 86400 seconds' USING ERRCODE = '22023';
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET lease_expires_at = clock_timestamp() + make_interval(secs => p_visibility_seconds),
        heartbeat_at = clock_timestamp()
    WHERE s.slot_id = 1
      AND s.worker_id = p_worker_id
      AND s.lease_token = p_lease_token
      AND s.queue_message_id = p_queue_message_id
      AND s.lease_expires_at > clock_timestamp();

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    UPDATE public.receipts AS r
    SET extraction_claimed_at = clock_timestamp()
    WHERE r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id
      AND r.status = 'Processing';

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RAISE EXCEPTION 'The leased receipt no longer matches the worker slot';
    END IF;

    SELECT message.*
    INTO queue_message
    FROM pgmq.set_vt(
        'receipt_extraction',
        p_queue_message_id,
        p_visibility_seconds
    ) AS message;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Queue message % no longer exists', p_queue_message_id;
    END IF;

    RETURN TRUE;
END;
$$;

-- Atomically replace all voucher rows, finalize the receipt, archive the queue
-- message, and release the singleton.  No write happens unless the lease is
-- still current, which is the fencing guarantee.
CREATE OR REPLACE FUNCTION public.complete_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_receipt_id UUID,
    p_transactions JSONB,
    p_verification_warnings JSONB,
    p_raw_extraction JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    target_receipt public.receipts%ROWTYPE;
    target_org_id UUID;
    removed BOOLEAN;
BEGIN
    IF jsonb_typeof(p_transactions) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_transactions) = 0 THEN
        RAISE EXCEPTION 'At least one extracted transaction is required' USING ERRCODE = '22023';
    END IF;
    IF p_verification_warnings IS NOT NULL
       AND jsonb_typeof(p_verification_warnings) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Verification warnings must be a JSON array' USING ERRCODE = '22023';
    END IF;

    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    IF current_slot.worker_id IS DISTINCT FROM p_worker_id
       OR current_slot.lease_token IS DISTINCT FROM p_lease_token
       OR current_slot.queue_message_id IS DISTINCT FROM p_queue_message_id
       OR current_slot.receipt_id IS DISTINCT FROM p_receipt_id
       OR current_slot.lease_expires_at <= clock_timestamp() THEN
        RETURN FALSE;
    END IF;

    SELECT r.*
    INTO target_receipt
    FROM public.receipts AS r
    WHERE r.id = p_receipt_id
      AND r.status = 'Processing'
      AND r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT b.organization_id
    INTO target_org_id
    FROM public.scan_batches AS b
    WHERE b.id = target_receipt.batch_id;

    IF target_org_id IS NULL THEN
        RAISE EXCEPTION 'The receipt batch no longer has an organization';
    END IF;

    DELETE FROM public.transactions AS existing
    WHERE existing.receipt_id = target_receipt.id;

    INSERT INTO public.transactions (
        receipt_id,
        batch_id,
        organization_id,
        position,
        voucher_date,
        voucher_type,
        entry_type,
        ledger_name,
        ledger_id,
        ledger_match,
        ledger_match_score,
        debit_amount,
        credit_amount,
        needs_review,
        narration,
        raw_extracted_data,
        updated_by
    )
    SELECT
        target_receipt.id,
        target_receipt.batch_id,
        target_org_id,
        COALESCE(row_data.position, row_number() OVER ()::INTEGER - 1),
        row_data.voucher_date,
        COALESCE(NULLIF(row_data.voucher_type, ''), 'Journal'),
        row_data.entry_type::public.entry_type,
        COALESCE(row_data.ledger_name, ''),
        row_data.ledger_id,
        COALESCE(row_data.ledger_match, 'Unchecked')::public.ledger_match,
        row_data.ledger_match_score,
        COALESCE(row_data.debit_amount, 0),
        COALESCE(row_data.credit_amount, 0),
        COALESCE(row_data.needs_review, FALSE),
        COALESCE(row_data.narration, ''),
        row_data.raw_extracted_data,
        COALESCE(row_data.updated_by, target_receipt.uploaded_by)
    FROM jsonb_to_recordset(p_transactions) AS row_data (
        position INTEGER,
        voucher_date TEXT,
        voucher_type TEXT,
        entry_type TEXT,
        ledger_name TEXT,
        ledger_id UUID,
        ledger_match TEXT,
        ledger_match_score NUMERIC(4, 3),
        debit_amount NUMERIC(14, 2),
        credit_amount NUMERIC(14, 2),
        needs_review BOOLEAN,
        narration TEXT,
        raw_extracted_data JSONB,
        updated_by UUID
    );

    UPDATE public.receipts AS r
    SET status = 'Extracted',
        error_message = NULL,
        verification_warnings = COALESCE(p_verification_warnings, '[]'::JSONB),
        raw_extraction = p_raw_extraction,
        extraction_queue_message_id = NULL,
        extraction_queued_at = NULL,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = target_receipt.id;

    SELECT pgmq.delete('receipt_extraction', p_queue_message_id)
    INTO removed;
    IF removed IS NOT TRUE THEN
        RAISE EXCEPTION 'Could not delete completed extraction message %', p_queue_message_id;
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        queue_message_id = NULL,
        receipt_id = NULL
    WHERE s.slot_id = 1;

    RETURN TRUE;
END;
$$;

-- Permanent failure is atomic for the same reason as completion.  Process
-- crashes do not call this function; their message becomes visible after the
-- lease/visibility timeout and is retried by another worker.
CREATE OR REPLACE FUNCTION public.fail_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_receipt_id UUID,
    p_error_message TEXT,
    p_raw_extraction JSONB DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
    affected_rows INTEGER;
    removed BOOLEAN;
BEGIN
    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    IF current_slot.worker_id IS DISTINCT FROM p_worker_id
       OR current_slot.lease_token IS DISTINCT FROM p_lease_token
       OR current_slot.queue_message_id IS DISTINCT FROM p_queue_message_id
       OR current_slot.receipt_id IS DISTINCT FROM p_receipt_id
       OR current_slot.lease_expires_at <= clock_timestamp() THEN
        RETURN FALSE;
    END IF;

    UPDATE public.receipts AS r
    SET status = 'Failed',
        error_message = LEFT(
            COALESCE(NULLIF(BTRIM(p_error_message), ''), 'Extraction failed. Please try again.'),
            2000
        ),
        verification_warnings = '[]'::JSONB,
        raw_extraction = COALESCE(p_raw_extraction, r.raw_extraction),
        extraction_queue_message_id = NULL,
        extraction_queued_at = NULL,
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = p_receipt_id
      AND r.status = 'Processing'
      AND r.extraction_worker = p_worker_id
      AND r.extraction_lease_token = p_lease_token
      AND r.extraction_queue_message_id = p_queue_message_id;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    SELECT pgmq.delete('receipt_extraction', p_queue_message_id)
    INTO removed;
    IF removed IS NOT TRUE THEN
        RAISE EXCEPTION 'Could not delete failed extraction message %', p_queue_message_id;
    END IF;

    UPDATE public.extraction_worker_slot AS s
    SET worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        queue_message_id = NULL,
        receipt_id = NULL
    WHERE s.slot_id = 1;

    RETURN TRUE;
END;
$$;

-- Lock down all queue RPCs.  The browser reaches them only through the backend,
-- whose service key is never shipped to the client.
REVOKE ALL ON FUNCTION public.extraction_queue_health()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_receipt_extraction(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.extraction_queue_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_receipt_extraction(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB) TO service_role;

-- Move work stranded by the pre-queue backend into PGMQ.  Plain Pending rows
-- are intentionally not queued: an upload may be saved for review later and
-- was never necessarily requested for extraction.
DO $$
DECLARE
    interrupted RECORD;
    next_generation BIGINT;
    new_message_id BIGINT;
BEGIN
    FOR interrupted IN
        SELECT r.id, r.uploaded_by, r.file_path, r.extraction_generation
        FROM public.receipts AS r
        WHERE r.status = 'Processing'
          AND r.extraction_queue_message_id IS NULL
        ORDER BY r.created_at, r.id
        FOR UPDATE
    LOOP
        IF NULLIF(BTRIM(interrupted.file_path), '') IS NULL THEN
            UPDATE public.receipts AS r
            SET status = 'Failed',
                error_message = 'The uploaded image is missing. Upload it again and retry.',
                extraction_worker = NULL,
                extraction_claimed_at = NULL,
                extraction_lease_token = NULL
            WHERE r.id = interrupted.id;
            CONTINUE;
        END IF;

        next_generation := interrupted.extraction_generation + 1;

        SELECT sent.message_id
        INTO new_message_id
        FROM (
            SELECT pgmq.send(
                'receipt_extraction',
                jsonb_build_object(
                    'receipt_id', interrupted.id,
                    'requested_by', interrupted.uploaded_by,
                    'generation', next_generation
                )
            ) AS message_id
        ) AS sent;

        UPDATE public.receipts AS r
        SET status = 'Pending',
            error_message = NULL,
            extraction_queue_message_id = new_message_id,
            extraction_queued_at = clock_timestamp(),
            extraction_generation = next_generation,
            extraction_attempt_count = 0,
            extraction_worker = NULL,
            extraction_claimed_at = NULL,
            extraction_lease_token = NULL
        WHERE r.id = interrupted.id;
    END LOOP;
END;
$$;

-- Receipt changes drive the queued/processing/completed UI without browser
-- polling.  Do not disturb tables already present in Supabase Realtime.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'receipts'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.receipts';
    END IF;
END;
$$;
