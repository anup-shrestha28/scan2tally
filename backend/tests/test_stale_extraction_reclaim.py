"""Getting a voucher back from a worker that is no longer there.

Extraction is one voucher at a time platform-wide, so an abandoned slot does not
stall one receipt — it stalls everything behind it. Migration 007 sizes both the
slot lease and the PGMQ visibility window for how long an extraction may
legitimately take, which is the right question for "is this slow" and the wrong
one for "is anyone still there". A backend killed mid-voucher therefore froze the
whole queue for the full window; measured once at 15 minutes for the remaining 13
vouchers of a batch.

Migration 010 answers liveness from the heartbeat instead. These tests cover the
three things that make that safe: it waits long enough, it degrades to the old
behaviour on a database that has not been migrated, and a failure to ask never
stops the worker from getting on with its job.
"""

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


@pytest.fixture(autouse=True)
def _reset_probe(monkeypatch):
    """The missing-function probe is process-wide; never leak it between tests."""
    monkeypatch.setattr(main, "stale_reclaim_available", None)
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")


def _null_response() -> httpx.Response:
    """What PostgREST actually sends when the function returns SQL NULL."""
    return httpx.Response(200, content=b"null", headers={"content-type": "application/json"})


def _run(respond):
    async def call():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.reclaim_stale_extraction_job(client)
    return asyncio.run(call())


# --------------------------------------------------------------- the request

def test_reclaim_asks_with_the_configured_silence_threshold(monkeypatch):
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS", 120)
    captured = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        assert request.url.path.endswith("/rpc/reclaim_stale_receipt_extraction")
        return _null_response()

    assert _run(respond) is None
    assert captured == {"p_stale_after_seconds": 120}


def test_silence_threshold_is_several_heartbeats_wide():
    """Reclaiming a worker that is merely between beats would take a voucher
    away mid-read, so the threshold must sit well clear of the heartbeat."""
    assert main.EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS >= (
        main.EXTRACTION_QUEUE_HEARTBEAT_SECONDS * 3
    )
    # The database function rejects anything under 60s outright.
    assert main.EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS >= 60


def test_recovery_is_far_quicker_than_waiting_out_the_visibility_window():
    """The entire point. If this ever stops holding, the fix has been undone."""
    assert main.EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS < (
        main.EXTRACTION_QUEUE_VISIBILITY_SECONDS / 2
    )


def test_the_visibility_safety_rule_is_left_intact():
    """Recovery speed came from a separate signal, deliberately NOT from
    shortening the lease that stops a job being stolen mid-extraction."""
    assert main.EXTRACTION_QUEUE_VISIBILITY_SECONDS >= (
        main.EXTRACTION_TIMEOUT_SECONDS + main.EXTRACTION_FINALIZATION_MARGIN_SECONDS
    )


# --------------------------------------------------------------- the outcomes

def test_a_reclaimed_slot_is_reported_back():
    payload = {
        "worker_id": "nova-machine:9463:1b1f865b",
        "receipt_id": "cc969096-b1bb-4d85-88e9-ca33c3403e1a",
        "queue_message_id": 182,
        "silent_for_seconds": 494,
    }

    assert _run(lambda request: httpx.Response(200, json=payload)) == payload


def test_a_live_or_empty_slot_reclaims_nothing():
    assert _run(lambda request: _null_response()) is None


# ------------------------------------------------- databases without migration 010

def test_a_missing_function_disables_the_probe_instead_of_failing():
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(404, json={
            "code": "PGRST202",
            "message": "Could not find the function public.reclaim_stale_receipt_extraction",
        })

    assert _run(respond) is None
    assert main.stale_reclaim_available is False

    # And never asked again, so an un-migrated database is not made to answer
    # a 404 on every single poll.
    assert _run(respond) is None
    assert len(calls) == 1


def test_a_real_database_fault_is_not_mistaken_for_a_missing_function():
    """Swallowing these would silently disable recovery on a healthy database."""
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"code": "XX000", "message": "connection lost"})

    with pytest.raises(RuntimeError):
        _run(respond)

    # Still eligible: the function may well exist, this call just failed.
    assert main.stale_reclaim_available is not False


def test_credentials_never_reach_the_reclaim_error_text(monkeypatch):
    secret = "service-role-test-key"
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", secret)

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "42501", "message": f"denied for {secret}"})

    with pytest.raises(RuntimeError) as error:
        _run(respond)

    assert secret not in str(error.value)


# --------------------------------------------------------------- the worker loop

def test_a_failing_reclaim_check_never_stops_the_worker_claiming(monkeypatch):
    """Recovery is an optimisation. If asking about it breaks, the worker must
    still get on with the queue rather than stop consuming."""
    monkeypatch.setattr(main, "extraction_queue_ready", True)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_POLL_SECONDS", 0)
    claims = []

    async def exploding_reclaim(_client):
        raise RuntimeError("supabase unreachable")

    async def claim(_client):
        claims.append(1)
        if len(claims) >= 3:
            raise asyncio.CancelledError
        return None

    monkeypatch.setattr(main, "reclaim_stale_extraction_job", exploding_reclaim)
    monkeypatch.setattr(main, "claim_next_extraction_job", claim)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.consume_extraction_queue())

    assert len(claims) == 3


def test_the_reclaim_check_runs_before_the_very_first_claim(monkeypatch):
    """A backend that just came back from a crash is exactly when the slot is
    most likely held by the process it replaced, so this must not wait out an
    interval first."""
    monkeypatch.setattr(main, "extraction_queue_ready", True)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_POLL_SECONDS", 0)
    order = []

    async def reclaim(_client):
        order.append("reclaim")
        return None

    async def claim(_client):
        order.append("claim")
        raise asyncio.CancelledError

    monkeypatch.setattr(main, "reclaim_stale_extraction_job", reclaim)
    monkeypatch.setattr(main, "claim_next_extraction_job", claim)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.consume_extraction_queue())

    assert order == ["reclaim", "claim"]


def test_the_reclaim_check_is_rate_limited_between_polls(monkeypatch):
    """Polling is every couple of seconds; asking the database this often would
    be pure noise."""
    monkeypatch.setattr(main, "extraction_queue_ready", True)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_POLL_SECONDS", 0)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS", 120)
    now = {"value": 1000.0}
    monkeypatch.setattr(main.time, "monotonic", lambda: now["value"])
    reclaims = []
    claims = []

    async def reclaim(_client):
        reclaims.append(now["value"])
        return None

    async def claim(_client):
        claims.append(1)
        # Well inside the 30s (120/4) interval, so no second check is due.
        now["value"] += 1.0
        if len(claims) >= 5:
            raise asyncio.CancelledError
        return None

    monkeypatch.setattr(main, "reclaim_stale_extraction_job", reclaim)
    monkeypatch.setattr(main, "claim_next_extraction_job", claim)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.consume_extraction_queue())

    assert len(claims) == 5
    assert len(reclaims) == 1


def test_the_reclaim_check_resumes_once_its_interval_has_passed(monkeypatch):
    monkeypatch.setattr(main, "extraction_queue_ready", True)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_POLL_SECONDS", 0)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS", 120)
    now = {"value": 1000.0}
    monkeypatch.setattr(main.time, "monotonic", lambda: now["value"])
    reclaims = []
    claims = []

    async def reclaim(_client):
        reclaims.append(now["value"])
        return None

    async def claim(_client):
        claims.append(1)
        now["value"] += 31.0  # past the 30s interval
        if len(claims) >= 3:
            raise asyncio.CancelledError
        return None

    monkeypatch.setattr(main, "reclaim_stale_extraction_job", reclaim)
    monkeypatch.setattr(main, "claim_next_extraction_job", claim)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.consume_extraction_queue())

    assert len(reclaims) == 3


# ------------------------------------------------- diagnosability of failures

def test_a_network_failure_logs_something_identifiable():
    """httpx raises timeouts with no message, which turned a real outage into
    "Could not claim the next queued extraction: " and nothing more. The class
    name is the whole diagnosis there, so it must survive into the log."""
    assert main._describe_error(httpx.ReadTimeout("")) == "ReadTimeout"
    assert main._describe_error(httpx.ConnectTimeout("")) == "ConnectTimeout"
    assert main._describe_error(httpx.PoolTimeout("")) == "PoolTimeout"


def test_an_explained_failure_keeps_its_message_and_gains_its_type():
    described = main._describe_error(RuntimeError("Extraction queue RPC failed with status 404."))

    assert described == "RuntimeError: Extraction queue RPC failed with status 404."


def test_whitespace_only_messages_do_not_produce_a_dangling_colon():
    assert main._describe_error(ValueError("   ")) == "ValueError"
