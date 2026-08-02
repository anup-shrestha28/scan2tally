"""A reading that succeeded must not be thrown away by what happens afterwards.

Observed in production: a voucher was read, all three transcription passes
agreed, and the rows reconciled exactly against the voucher's own जम्मा totals —
and the receipt was then marked Failed:

    ✅ Extracted 4 transactions from OpenAI (3/3 transcription runs agreed)
    ✅ Verification: line items reconcile with the voucher's जम्मा totals
    ❌ Queued extraction for receipt 4170da67-... failed:

The blank message was an httpx timeout. Chart-of-accounts matching runs after the
extraction is complete, and its network failure propagated out of
_prepare_extraction, so the queue worker discarded four correct transactions and
charged for the vision calls again on retry.

Matching only ever proposes names for a reviewer to confirm. It is not allowed to
destroy the reading it decorates.
"""

import asyncio
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


RECEIPT = {
    "id": "receipt-1",
    "batch_id": "batch-1",
    "organization_id": "org-1",
    "filename": "bill.jpg",
    "file_path": "org-1/batch-1/receipt-1.jpg",
    "uploaded_by": "user-1",
}

READING = {
    "filename": "bill.jpg",
    "engine_used": "OpenAI gpt-5.5",
    "status": "Extracted",
    "error": None,
    "transactions": [
        {"entry_type": "Dr", "ledger_name": "Freight outward", "debit_amount": 1237.35, "credit_amount": 0},
        {"entry_type": "Cr", "ledger_name": "TDS payable", "debit_amount": 0, "credit_amount": 1237.35},
    ],
    "verification": {"warnings": [], "reconciles": True},
}


@pytest.fixture
def extracted(monkeypatch):
    """A receipt whose image downloads and whose voucher reads cleanly."""
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.setattr(main, "ledger_matching_ready", True)

    class _Response:
        status_code = 200
        content = b"\xff\xd8\xff-jpeg-bytes"
        headers = {"content-type": "image/jpeg"}

    class _Client:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **kw): return _Response()

    monkeypatch.setattr(main.httpx, "AsyncClient", _Client)

    async def read(raw_bytes, content_type, filename):
        return dict(READING)

    monkeypatch.setattr(main, "run_extraction", read)


def _prepare():
    return asyncio.run(main._prepare_extraction(RECEIPT, "user-1"))


# ------------------------------------------------- the regression

@pytest.mark.parametrize("failure", [
    httpx.ReadTimeout(""),
    httpx.ConnectTimeout(""),
    httpx.ConnectError(""),
    RuntimeError("PostgREST exploded"),
])
def test_a_chart_of_accounts_failure_never_fails_the_receipt(monkeypatch, extracted, failure):
    async def boom(_client, _org):
        raise failure

    monkeypatch.setattr(main, "_load_org_ledgers", boom)
    prepared = _prepare()

    assert prepared["error"] is None
    assert len(prepared["rows"]) == 2
    assert prepared["rows"][0]["ledger_name"] == "Freight outward"
    assert prepared["rows"][0]["debit_amount"] == 1237.35


def test_the_reviewer_is_told_the_names_were_not_matched(monkeypatch, extracted):
    async def boom(_client, _org):
        raise httpx.ReadTimeout("")

    monkeypatch.setattr(main, "_load_org_ledgers", boom)
    prepared = _prepare()

    assert main.LEDGER_MATCHING_UNAVAILABLE_WARNING in prepared["warnings"]
    # It must say the figures are safe; the reviewer's job here is names only.
    assert "amounts are unaffected" in main.LEDGER_MATCHING_UNAVAILABLE_WARNING


def test_cancellation_still_unwinds(monkeypatch, extracted):
    """Swallowing this would leave a cancelled extraction reporting success and
    the queue worker unable to stop it."""
    async def cancelled(_client, _org):
        raise asyncio.CancelledError

    monkeypatch.setattr(main, "_load_org_ledgers", cancelled)

    with pytest.raises(asyncio.CancelledError):
        _prepare()


# ------------------------------------------------- the ordinary path

def test_matching_still_applies_when_the_chart_of_accounts_loads(monkeypatch, extracted):
    applied = {}

    async def ledgers(_client, org):
        applied["org"] = org
        return [{"id": "l-1", "name": "Freight outward", "aliases": []}]

    monkeypatch.setattr(main, "_load_org_ledgers", ledgers)
    monkeypatch.setattr(main.ledger_matching, "apply_to_rows",
                        lambda rows, ledgers: ["a matching warning"])

    prepared = _prepare()

    assert applied["org"] == "org-1"
    assert prepared["error"] is None
    assert "a matching warning" in prepared["warnings"]
    assert main.LEDGER_MATCHING_UNAVAILABLE_WARNING not in prepared["warnings"]


def test_a_genuine_extraction_failure_is_still_a_failure(monkeypatch, extracted):
    """The safety net is for enrichment only — it must not mask a bad reading."""
    async def unreadable(raw_bytes, content_type, filename):
        return {**READING, "status": "Failed", "error": main.INVALID_JOURNAL_IMAGE_ERROR,
                "transactions": []}

    monkeypatch.setattr(main, "run_extraction", unreadable)
    prepared = _prepare()

    assert prepared["error"] == main.INVALID_JOURNAL_IMAGE_ERROR
    assert prepared["rows"] == []
