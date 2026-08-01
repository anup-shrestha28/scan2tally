-- Release the extraction slot held by a worker that stopped heartbeating.
--
-- Migration 007 already fences an expired lease when the next claim comes in.
-- What it cannot do is shorten the wait. The slot lease and the PGMQ visibility
-- timeout are both set to p_visibility_seconds at claim time, so a backend that
-- dies mid-voucher leaves the receipt showing "Processing", and the whole
-- platform — extraction is deliberately one voucher at a time — stalls behind it
-- for the full window. Observed in practice: a restart at 17:41:21 blocked the
-- remaining 13 vouchers of a batch until 17:56:21.
--
-- That window is sized for the extraction itself (EXTRACTION_TIMEOUT_SECONDS
-- plus a margin to persist a terminal result), which is the right size for "how
-- long may this legitimately take" and far too long for "is anyone still there".
-- Liveness already has its own, much faster signal: the heartbeat, which a
-- working backend sends every few seconds. This reads that signal directly.
--
-- Safety rests on the same fencing as everything else in 007. Reclaiming issues
-- no new lease and grants nothing — it clears the slot and makes the message
-- visible. If the old worker turns out to be alive after all, its heartbeat,
-- completion and failure calls all verify slot ownership first and return FALSE,
-- so the worst case is a voucher read twice and one result discarded, never two
-- writers on one receipt.
CREATE OR REPLACE FUNCTION public.reclaim_stale_receipt_extraction(
    p_stale_after_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
    current_slot public.extraction_worker_slot%ROWTYPE;
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
    INTO current_slot
    FROM public.extraction_worker_slot AS s
    WHERE s.slot_id = 1
    FOR UPDATE;

    -- Nothing held: the ordinary idle case, and by far the most common.
    IF NOT FOUND OR current_slot.worker_id IS NULL THEN
        RETURN NULL;
    END IF;

    silent_for := EXTRACT(EPOCH FROM (clock_timestamp() - current_slot.heartbeat_at));

    -- Still beating. Leave it strictly alone: a slow voucher is not a dead one.
    IF silent_for < p_stale_after_seconds THEN
        RETURN NULL;
    END IF;

    -- Hand the message straight back to the queue. This is the part migration
    -- 007 has no way to express from the claim path: without it the message
    -- stays invisible for the remainder of its visibility timeout even once the
    -- slot is free, which is what made recovery take the full window.
    SELECT message.*
    INTO queue_message
    FROM pgmq.set_vt('receipt_extraction', current_slot.queue_message_id, 0) AS message;

    -- A message that no longer exists means the previous worker's terminal write
    -- committed and only the slot release was lost. Releasing the slot is then
    -- the whole repair, so this is not an error.
    IF NOT FOUND THEN
        RAISE NOTICE 'Extraction queue message % no longer exists; releasing its slot only',
            current_slot.queue_message_id;
    END IF;

    -- Back to Pending so the receipt reads as waiting rather than as being
    -- worked on by a process that is gone. Guarded on the dead worker's own
    -- lease token so a receipt already re-claimed by someone else is untouched.
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
    WHERE s.slot_id = 1
      AND s.lease_token = current_slot.lease_token;

    RETURN jsonb_build_object(
        'worker_id', current_slot.worker_id,
        'receipt_id', current_slot.receipt_id,
        'queue_message_id', current_slot.queue_message_id,
        'silent_for_seconds', ROUND(silent_for)
    );
END;
$$;

COMMENT ON FUNCTION public.reclaim_stale_receipt_extraction(INTEGER) IS
    'Frees the singleton extraction slot when its holder has stopped '
    'heartbeating, and makes the in-flight queue message immediately visible '
    'again. Returns details of what was reclaimed, or NULL when the slot is '
    'free or its holder is still alive.';

-- Same posture as every other queue RPC: the backend's service key only. The
-- browser must never be able to take a voucher away from a running worker.
REVOKE ALL ON FUNCTION public.reclaim_stale_receipt_extraction(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_receipt_extraction(INTEGER)
    TO service_role;
