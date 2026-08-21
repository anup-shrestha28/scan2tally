-- 017: let more than one receipt be extracted at a time.
--
-- WHY
--
-- Migration 007 deliberately allowed exactly one extraction platform-wide, and
-- enforced it with a one-row table: extraction_worker_slot, primary key
-- CHECK (slot_id = 1). That was the right call at the time — a receipt then held
-- four full-resolution decoded images in memory at once and cost ~28 CPU-seconds
-- just building its provider requests, so a 512MB shared-CPU instance could not
-- have survived two of them.
--
-- Neither of those is true any more. The image is resized once and shared by all
-- the concurrent passes (~11MB, ~0.3s), and the provider fan-out is flat: four
-- concurrent vision calls measured 4.4s against 4.1s for one. What is left is a
-- worker that spends nearly all of a receipt's wall clock waiting on the network
-- while the next receipt is not allowed to start. Six receipts took ~38s to do
-- ~6s of work six times.
--
-- WHAT CHANGES
--
-- The slot table gains rows. Everything that made the single slot safe — the
-- fencing token, the all-or-none constraint, the guard that a terminal write is
-- refused unless its lease is still current — is kept exactly as it was, per
-- slot instead of for the one slot.
--
-- The important detail is that a lease_token is a fresh gen_random_uuid() per
-- claim and is therefore already unique across all slots. So heartbeat,
-- complete and fail do not need to know which slot they are in: matching the
-- token identifies the lease unambiguously, and dropping "slot_id = 1" from
-- those three is the whole change to them. Claiming is the only function that
-- has to choose a slot, and it takes a free one with FOR UPDATE SKIP LOCKED so
-- two workers racing pick different rows rather than queueing behind each other.
--
-- SAFE IN EITHER DEPLOY ORDER
--
--   this migration + old backend  → the backend runs one consumer loop, so it
--                                   claims one receipt at a time regardless of
--                                   how many slots exist. No error, no change.
--   new backend + old schema      → extra consumer loops ask for a slot, are
--                                   told there is none free, and go back to
--                                   polling. No error, no concurrency gained.
--
-- So this can be applied before or after the backend deploy.
--
-- Re-runnable, like the migrations before it.

-- ---------------------------------------------------------------- the slots

-- The primary key stays; only the "there is exactly one" check is replaced. The
-- 16 ceiling is a sanity bound, not a recommendation: capacity is bounded in
-- practice by the vision provider's rate limits and the instance's memory, and
-- EXTRACTION_QUEUE_WORKERS on the backend is what actually decides how many are
-- used.
ALTER TABLE public.extraction_worker_slot
    DROP CONSTRAINT IF EXISTS extraction_worker_slot_slot_id_check;
ALTER TABLE public.extraction_worker_slot
    ADD CONSTRAINT extraction_worker_slot_slot_id_check
    CHECK (slot_id >= 1 AND slot_id <= 16);

-- A default of 1 only ever made sense when 1 was the only legal value; leaving
-- it would make an INSERT with no slot_id silently collide with slot 1.
ALTER TABLE public.extraction_worker_slot
    ALTER COLUMN slot_id DROP DEFAULT;

-- Adjusts capacity without another migration.
--
-- Growing is trivial. Shrinking must never take a slot that is mid-extraction,
-- so busy slots above the target are left in place and reported back: they are
-- released normally when their receipt finishes, and the next call to this
-- function removes them. Returns the capacity actually in effect.
CREATE OR REPLACE FUNCTION public.set_extraction_slot_count(p_slots INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    still_busy INTEGER;
    total INTEGER;
BEGIN
    IF p_slots < 1 OR p_slots > 16 THEN
        RAISE EXCEPTION 'Extraction slots must be between 1 and 16'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.extraction_worker_slot (slot_id)
    SELECT generate_series(1, p_slots)
    ON CONFLICT (slot_id) DO NOTHING;

    -- Only idle slots are removable. A busy one is holding a fencing token that
    -- its worker will present on completion; deleting it would turn a finished
    -- extraction into a discarded one.
    DELETE FROM public.extraction_worker_slot AS s
    WHERE s.slot_id > p_slots
      AND s.worker_id IS NULL;

    SELECT count(*) FILTER (WHERE slot_id > p_slots), count(*)
    INTO still_busy, total
    FROM public.extraction_worker_slot;

    RETURN jsonb_build_object(
        'requested', p_slots,
        'in_effect', total,
        'awaiting_release', still_busy
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_extraction_slot_count(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_extraction_slot_count(INTEGER) TO service_role;

-- Three to begin with. Deliberately modest: it is a 3x improvement on batches
-- while staying well inside a free-tier instance's memory and a vision
-- provider's per-minute limits. Raise it with set_extraction_slot_count once
-- real batches show the headroom.
SELECT public.set_extraction_slot_count(3);

-- ---------------------------------------------------------------- health

-- Reports capacity rather than the state of "the" slot. `ready` keeps its exact
-- meaning for the backend — the prerequisites are present and the slot table is
-- populated — but is no longer phrased as "slot 1 exists".
CREATE OR REPLACE FUNCTION public.extraction_queue_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    queue_depth BIGINT := 0;
    slot_total INTEGER := 0;
    slot_busy INTEGER := 0;
    active_receipts UUID[];
    next_expiry TIMESTAMPTZ;
    prerequisites_ready BOOLEAN := FALSE;
BEGIN
    SELECT COALESCE(metrics.queue_length, 0)
    INTO queue_depth
    FROM pgmq.metrics('receipt_extraction') AS metrics;

    SELECT count(*),
           count(*) FILTER (WHERE s.worker_id IS NOT NULL),
           COALESCE(array_agg(s.receipt_id) FILTER (WHERE s.receipt_id IS NOT NULL), '{}'),
           min(s.lease_expires_at)
    INTO slot_total, slot_busy, active_receipts, next_expiry
    FROM public.extraction_worker_slot AS s;

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
        'ready', prerequisites_ready AND slot_total > 0,
        'queue_name', 'receipt_extraction',
        'queue_length', COALESCE(queue_depth, 0),
        'slot_capacity', slot_total,
        'slots_busy', slot_busy,
        'active_receipt_ids', to_jsonb(active_receipts),
        -- Kept for readers written against the single-slot shape: the first
        -- active receipt, and the soonest lease to expire.
        'active_receipt_id', active_receipts[1],
        'lease_expires_at', next_expiry
    );
END;
$$;

-- ---------------------------------------------------------------- claiming

-- Identical to migration 007 except for which slot is taken. The message
-- validation, poison-message handling, attempt ceiling, orphan-batch and
-- invalid-path paths are unchanged; only the slot selection at the top and the
-- slot_id in the final UPDATE differ.
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
    target_slot_id SMALLINT;
    expired_slot public.extraction_worker_slot%ROWTYPE;
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

    -- SKIP LOCKED, not a plain FOR UPDATE: with one slot, blocking was the
    -- mechanism that serialised claimers, but with several it would make a
    -- worker wait behind another worker's slot selection for no reason. Skipping
    -- a row someone else is already looking at is what keeps them off each
    -- other's toes while still guaranteeing no slot is handed out twice.
    SELECT s.slot_id
    INTO target_slot_id
    FROM public.extraction_worker_slot AS s
    WHERE s.worker_id IS NULL
    ORDER BY s.slot_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF target_slot_id IS NULL THEN
        -- Every slot is held. One may belong to a worker that died: take over
        -- the longest-expired lease so a crash costs one lease window rather
        -- than permanently reducing capacity.
        SELECT s.*
        INTO expired_slot
        FROM public.extraction_worker_slot AS s
        WHERE s.worker_id IS NOT NULL
          AND s.lease_expires_at <= clock_timestamp()
        ORDER BY s.lease_expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1;

        -- Genuinely at capacity: every slot is held by a live worker.
        IF NOT FOUND THEN
            RETURN;
        END IF;

        -- Fence the dead owner. Guarded on its own lease token, so a receipt
        -- that has since been picked up by somebody else is left alone.
        UPDATE public.receipts AS r
        SET status = 'Pending',
            extraction_worker = NULL,
            extraction_claimed_at = NULL,
            extraction_lease_token = NULL
        WHERE r.id = expired_slot.receipt_id
          AND r.extraction_queue_message_id = expired_slot.queue_message_id
          AND r.extraction_lease_token = expired_slot.lease_token
          AND r.status = 'Processing';

        UPDATE public.extraction_worker_slot AS s
        SET worker_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            queue_message_id = NULL,
            receipt_id = NULL
        WHERE s.slot_id = expired_slot.slot_id;

        target_slot_id := expired_slot.slot_id;
    END IF;

    LOOP
        -- Commit progress after a bounded cleanup batch.  Returning (instead of
        -- raising) is important: an exception would roll every archive back and
        -- leave the same poison messages at the head forever.
        IF skipped_count >= 100 THEN
            RETURN;
        END IF;

        -- pgmq.read takes its own FOR UPDATE SKIP LOCKED and sets the message
        -- invisible for p_visibility_seconds, so concurrent claimers are handed
        -- different messages. That is what makes the loop safe to run in
        -- parallel now that the slot no longer serialises it.
        SELECT message.*
        INTO queue_message
        FROM pgmq.read('receipt_extraction', p_visibility_seconds, 1) AS message;

        -- No work: leave the slot free immediately.
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
        WHERE s.slot_id = target_slot_id;

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

-- ---------------------------------------------------------------- heartbeat

-- Unchanged but for the slot predicate. The lease token is unique per claim, so
-- it already identifies one slot on its own.
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
    WHERE s.worker_id = p_worker_id
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

-- ------------------------------------------------- releasing a slot by token

-- The two terminal RPCs below each ended with "release slot 1". Both now release
-- the slot holding this lease. Extracted so the two cannot drift apart.
CREATE OR REPLACE FUNCTION public.release_extraction_slot(p_lease_token UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    UPDATE public.extraction_worker_slot AS s
    SET worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        queue_message_id = NULL,
        receipt_id = NULL
    WHERE s.lease_token = p_lease_token;
$$;

REVOKE ALL ON FUNCTION public.release_extraction_slot(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_extraction_slot(UUID) TO service_role;

-- ---------------------------------------------------------------- reclaim

-- Scans every slot rather than only slot 1, and reports the one it reclaimed.
-- One per call, oldest silence first: the backend calls this on a timer, so
-- several dead slots are recovered over consecutive calls, and each recovery
-- still gets its own log line.
CREATE OR REPLACE FUNCTION public.reclaim_stale_receipt_extraction(
    p_stale_after_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    stale_slot public.extraction_worker_slot%ROWTYPE;
    queue_message RECORD;
    silent_for NUMERIC;
BEGIN
    -- The floor must stay well above the heartbeat interval, or a worker that is
    -- merely busy between beats would have its voucher taken away mid-read.
    IF p_stale_after_seconds < 60 OR p_stale_after_seconds > 86400 THEN
        RAISE EXCEPTION 'Stale threshold must be between 60 and 86400 seconds'
            USING ERRCODE = '22023';
    END IF;

    SELECT s.*
    INTO stale_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.worker_id IS NOT NULL
      AND s.heartbeat_at <= clock_timestamp()
                            - make_interval(secs => p_stale_after_seconds)
    ORDER BY s.heartbeat_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    -- Nothing stale: the ordinary case, and by far the most common.
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    silent_for := EXTRACT(EPOCH FROM (clock_timestamp() - stale_slot.heartbeat_at));

    -- Hand the message straight back to the queue. Without this it stays
    -- invisible for the remainder of its visibility timeout even once the slot
    -- is free, which is what made recovery take the full window.
    SELECT message.*
    INTO queue_message
    FROM pgmq.set_vt('receipt_extraction', stale_slot.queue_message_id, 0) AS message;

    -- A message that no longer exists means the previous worker's terminal write
    -- committed and only the slot release was lost. Releasing the slot is then
    -- the whole repair, so this is not an error.
    IF NOT FOUND THEN
        RAISE NOTICE 'Extraction queue message % no longer exists; releasing its slot only',
            stale_slot.queue_message_id;
    END IF;

    -- Back to Pending so the receipt reads as waiting rather than as being
    -- worked on by a process that is gone. Guarded on the dead worker's own
    -- lease token so a receipt already re-claimed by someone else is untouched.
    UPDATE public.receipts AS r
    SET status = 'Pending',
        extraction_worker = NULL,
        extraction_claimed_at = NULL,
        extraction_lease_token = NULL
    WHERE r.id = stale_slot.receipt_id
      AND r.extraction_queue_message_id = stale_slot.queue_message_id
      AND r.extraction_lease_token = stale_slot.lease_token
      AND r.status = 'Processing';

    PERFORM public.release_extraction_slot(stale_slot.lease_token);

    RETURN jsonb_build_object(
        'worker_id', stale_slot.worker_id,
        'receipt_id', stale_slot.receipt_id,
        'queue_message_id', stale_slot.queue_message_id,
        'slot_id', stale_slot.slot_id,
        'silent_for_seconds', ROUND(silent_for)
    );
END;
$$;
-- ------------------------------------------------- terminal RPCs
--
-- Byte-for-byte the current definitions, with two edits each: the slot is
-- found by lease token instead of by slot_id, and released through the
-- shared helper above. Every fencing guard is untouched.

CREATE OR REPLACE FUNCTION public.complete_receipt_extraction(
    p_worker_id TEXT,
    p_lease_token UUID,
    p_queue_message_id BIGINT,
    p_receipt_id UUID,
    p_transactions JSONB,
    p_verification_warnings JSONB,
    p_raw_extraction JSONB,
    p_has_signature BOOLEAN DEFAULT NULL,
    p_extracted_by UUID DEFAULT NULL
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

    -- By lease token, not by slot: the token is unique per claim, so it names
    -- exactly one slot without this function needing to know which. A token
    -- that matches nothing leaves current_slot all-NULL, and the guard below
    -- then refuses the write — which is the correct answer for a result whose
    -- lease was already released or taken over.
    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.lease_token = p_lease_token
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
        voucher_no,
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
        row_data.voucher_no,
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
        voucher_no TEXT,
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
        has_signature = p_has_signature,
        extracted_by = COALESCE(p_extracted_by, target_receipt.uploaded_by),
        extracted_at = clock_timestamp(),
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

    PERFORM public.release_extraction_slot(p_lease_token);

    RETURN TRUE;
END;
$$;

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
    -- By lease token, not by slot: the token is unique per claim, so it names
    -- exactly one slot without this function needing to know which. A token
    -- that matches nothing leaves current_slot all-NULL, and the guard below
    -- then refuses the write — which is the correct answer for a result whose
    -- lease was already released or taken over.
    SELECT s.*
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.lease_token = p_lease_token
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

    PERFORM public.release_extraction_slot(p_lease_token);

    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------- grants
--
-- Re-applied because CREATE OR REPLACE keeps existing privileges but these are
-- cheap to restate, and restating them is what makes this file safe to run on a
-- database where an earlier attempt stopped partway.
REVOKE ALL ON FUNCTION public.extraction_queue_health()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB, BOOLEAN, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reclaim_stale_receipt_extraction(INTEGER)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.extraction_queue_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_receipt_extraction(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_receipt_extraction(TEXT, UUID, BIGINT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_receipt_extraction(TEXT, UUID, BIGINT, UUID, JSONB, JSONB, JSONB, BOOLEAN, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_receipt_extraction(TEXT, UUID, BIGINT, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_receipt_extraction(INTEGER) TO service_role;

SELECT 'migration 017 applied: extraction slot capacity = '
       || (public.extraction_queue_health() ->> 'slot_capacity') AS status;
