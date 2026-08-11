-- Repairs receipts.updated_at, which migration 014's backfill overwrote.
--
-- WHAT WENT WRONG
-- 014 ran `UPDATE public.receipts SET extracted_by = uploaded_by`. receipts
-- carries trg_receipts_touch, a BEFORE UPDATE trigger that sets
-- updated_at = NOW() on every row it touches. The backfill therefore stamped
-- every already-extracted receipt with the moment the migration ran, collapsing
-- their extraction times to a single identical value and destroying the
-- chronological order the Admin overview sorts by.
--
-- WHAT THIS RECOVERS
-- The extracted rows themselves were never touched, so each receipt's
-- transactions still carry the timestamp of the write that created them. That
-- is the extraction time for any voucher nobody has edited since, and the last
-- edit time otherwise -- either way it is the real chronology rather than one
-- flat value. A receipt with no rows at all falls back to created_at, which was
-- never modified.
--
-- The trigger is disabled for the duration, or this UPDATE would re-stamp
-- NOW() exactly as 014 did. The whole thing is one transaction, so a failure
-- rolls the trigger back on rather than leaving it off.

BEGIN;

ALTER TABLE public.receipts DISABLE TRIGGER trg_receipts_touch;

UPDATE public.receipts AS r
SET updated_at = COALESCE(
    (SELECT MAX(t.updated_at) FROM public.transactions AS t WHERE t.receipt_id = r.id),
    r.created_at
)
WHERE r.status = 'Extracted';

ALTER TABLE public.receipts ENABLE TRIGGER trg_receipts_touch;

COMMIT;
