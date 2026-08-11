-- Adds the editable voucher-number field alongside the existing voucher date.
--
-- Run this file only -- not supabase_schema.sql. That file is the full
-- from-scratch schema (types, tables, every function) and re-running it
-- against a database that already has these objects fails immediately on
-- the first CREATE TYPE with "already exists" (42710), which is the error
-- that prompted this migration. supabase_schema.sql is kept as the
-- from-scratch reference; it is not a migration to be replayed.

ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS voucher_no TEXT;

-- Re-published in full so the extraction worker writes voucher_no on every
-- OCR pass, not only on a manual save. CREATE OR REPLACE is safe to rerun.
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
