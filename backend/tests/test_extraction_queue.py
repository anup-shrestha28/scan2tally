"""Durable extraction queue integration at the backend/RPC boundary."""

import asyncio
import json
import os
import sys
import threading
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


def _mock_async_client(monkeypatch, responder):
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(responder)

    def factory(*_args, **kwargs):
        return real_client(transport=transport, timeout=kwargs.get("timeout"))

    monkeypatch.setattr(main.httpx, "AsyncClient", factory)


@pytest.mark.parametrize("health_ready", [True, False])
def test_queue_health_cannot_override_missing_migration_002_prerequisites(
    monkeypatch, capsys, health_ready
):
    probed = set()

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rpc/extraction_queue_health"):
            return httpx.Response(200, json={"ready": health_ready})
        column = request.url.params.get("select")
        probed.add((request.url.path, column))
        if column in {"aliases", "extraction_claimed_at"}:
            return httpx.Response(400, json={"code": "42703", "message": "missing"})
        return httpx.Response(200, json=[])

    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "ledger_matching_ready", False)
    monkeypatch.setattr(main, "job_claiming_ready", False)
    monkeypatch.setattr(main, "extraction_queue_ready", None)
    monkeypatch.setattr(main, "extraction_queue_configuration_error", None)
    monkeypatch.setattr(main, "extraction_queue_absence_first_seen", None)
    monkeypatch.setattr(main, "extraction_queue_absence_confirmations", 0)
    _mock_async_client(monkeypatch, respond)

    asyncio.run(main.detect_schema_features())

    assert ("/rest/v1/receipts", "extraction_worker") in probed
    assert ("/rest/v1/receipts", "extraction_claimed_at") in probed
    assert ("/rest/v1/transactions", "ledger_match_score") in probed
    assert main.ledger_matching_ready is False
    assert main.job_claiming_ready is False
    assert main.extraction_queue_ready is None
    assert main.extraction_queue_configuration_error == main.MIGRATION_002_REQUIRED_ERROR
    startup_output = capsys.readouterr().out
    assert "002_ledgers_claiming_audit.sql" in startup_output
    assert "007_sequential_extraction_queue.sql" in startup_output
    assert "Fine for development" not in startup_output
    assert "compatibility worker" not in startup_output


def test_queue_becomes_ready_only_with_complete_migration_002_schema(monkeypatch):
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rpc/extraction_queue_health"):
            return httpx.Response(200, json={"ready": True})
        return httpx.Response(200, json=[])

    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "ledger_matching_ready", False)
    monkeypatch.setattr(main, "job_claiming_ready", False)
    monkeypatch.setattr(main, "extraction_queue_ready", None)
    monkeypatch.setattr(main, "extraction_queue_configuration_error", None)
    monkeypatch.setattr(main, "extraction_queue_absence_first_seen", None)
    monkeypatch.setattr(main, "extraction_queue_absence_confirmations", 0)
    _mock_async_client(monkeypatch, respond)

    asyncio.run(main.detect_schema_features())

    assert main.ledger_matching_ready is True
    assert main.job_claiming_ready is True
    assert main.extraction_queue_ready is True
    assert main.extraction_queue_configuration_error is None


@pytest.mark.parametrize(
    ("health_body", "queue_marker_present", "expected_ready"),
    [
        ({"code": "PGRST202", "message": "function missing"}, False, None),
        ({"code": "PGRST202", "message": "stale schema cache"}, True, None),
        ({"code": "PGRST205", "message": "gateway table error"}, False, None),
        ({"message": "generic not found"}, False, None),
    ],
)
def test_only_postgrest_missing_function_404_starts_absence_confirmation(
    monkeypatch, health_body, queue_marker_present, expected_ready
):
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rpc/extraction_queue_health"):
            return httpx.Response(404, json=health_body)
        if request.url.params.get("select") in {
            "extraction_queue_message_id", "slot_id",
        } and not queue_marker_present:
            return httpx.Response(400, json={
                "code": "42703",
                "message": "queue marker missing",
            })
        return httpx.Response(200, json=[])

    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "extraction_queue_ready", None)
    monkeypatch.setattr(main, "extraction_queue_configuration_error", None)
    monkeypatch.setattr(main, "extraction_queue_absence_first_seen", None)
    monkeypatch.setattr(main, "extraction_queue_absence_confirmations", 0)
    _mock_async_client(monkeypatch, respond)

    asyncio.run(main.detect_schema_features())

    assert main.extraction_queue_ready is expected_ready
    assert main.extraction_queue_configuration_error is None


def test_confirmed_queue_absence_uses_legacy_only_after_grace_period(monkeypatch):
    now = {"value": 100.0}

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rpc/extraction_queue_health"):
            return httpx.Response(404, json={
                "code": "PGRST202",
                "message": "function missing",
            })
        if request.url.params.get("select") in {
            "extraction_queue_message_id", "slot_id",
        }:
            return httpx.Response(400, json={
                "code": "42703",
                "message": "queue marker missing",
            })
        return httpx.Response(200, json=[])

    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_ABSENCE_GRACE_SECONDS", 30.0)
    monkeypatch.setattr(main, "extraction_queue_ready", None)
    monkeypatch.setattr(main, "extraction_queue_configuration_error", None)
    monkeypatch.setattr(main, "extraction_queue_absence_first_seen", None)
    monkeypatch.setattr(main, "extraction_queue_absence_confirmations", 0)
    monkeypatch.setattr(main.time, "monotonic", lambda: now["value"])
    _mock_async_client(monkeypatch, respond)

    asyncio.run(main.detect_schema_features())
    assert main.extraction_queue_ready is None

    now["value"] += 31.0
    asyncio.run(main.detect_schema_features())
    assert main.extraction_queue_ready is False


def test_provider_and_queue_deadlines_preserve_sequential_safety():
    assert main.VISION_PROVIDER_TIMEOUT_SECONDS <= main.EXTRACTION_TIMEOUT_SECONDS
    assert main.EXTRACTION_QUEUE_VISIBILITY_SECONDS >= (
        main.EXTRACTION_TIMEOUT_SECONDS
        + main.EXTRACTION_FINALIZATION_MARGIN_SECONDS
    )
    assert main.EXTRACTION_QUEUE_HEARTBEAT_SECONDS <= (
        main.EXTRACTION_QUEUE_VISIBILITY_SECONDS / 3
    )


def test_openai_client_has_finite_timeout_and_no_automatic_retries(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **options):
            captured.update(options)

    monkeypatch.setattr(main, "OPENAI_API_KEY", "openai-test-key")
    client = main._create_openai_client(FakeOpenAI)

    assert isinstance(client, FakeOpenAI)
    assert captured == {
        "api_key": "openai-test-key",
        "timeout": main.VISION_PROVIDER_TIMEOUT_SECONDS,
        "max_retries": 0,
    }


def test_gemini_request_runs_off_the_event_loop(monkeypatch):
    """A blocking SDK call on the event loop would freeze the whole backend.

    The Gemini request is synchronous, so it has to be driven through
    _run_blocking_provider_calls — which is also what makes the concurrent
    consensus passes concurrent.
    """
    event_loop_thread = threading.get_ident()
    captured = {}

    def fake_vision_call(marker):
        captured["thread"] = threading.get_ident()
        return marker

    results = asyncio.run(
        main._run_blocking_provider_calls([(fake_vision_call, ("read this",), {})])
    )

    assert results == ["read this"]
    assert captured["thread"] != event_loop_thread


@pytest.mark.skipif(
    main.genai_client is None,
    reason="only meaningful when AI_PROVIDER=gemini actually built a client",
)
def test_the_real_gemini_client_carries_a_finite_timeout_in_milliseconds():
    """This SDK counts the timeout in MILLISECONDS, the previous one in seconds.

    Reading it back off the live client rather than re-deriving it here is the
    point: passing seconds would leave a 300ms deadline that fails every single
    vision request, and a test that rebuilds the value itself would agree with
    the bug instead of catching it.
    """
    configured = main.genai_client._api_client._http_options.timeout

    assert configured == pytest.approx(main.VISION_PROVIDER_TIMEOUT_SECONDS * 1000)
    # A sanity floor: anything this small can only be a seconds/ms mix-up.
    assert configured >= 10_000


def test_gemini_asks_for_less_deliberation_than_the_model_default():
    """Thinking on a transcription task was the single largest source of delay.

    Measured on one pass of a six-row voucher: 26.3s at the model default
    against 6.0s at thinking_level=low, with the same amounts read. The default
    here must therefore not be "let the model decide".
    """
    assert main.GEMINI_THINKING_LEVEL == "low"
    assert main.GEMINI_THINKING_LEVEL in main._GEMINI_THINKING_LEVELS


@pytest.mark.parametrize("extension", ["jpg", "jpeg", "png", "webp", "pdf", "JPG"])
def test_receipt_storage_path_must_match_claimed_tenant_batch_and_receipt(extension):
    receipt = {
        "id": "receipt-1",
        "batch_id": "batch-1",
        "organization_id": "org-1",
        "file_path": f"org-1/batch-1/receipt-1.{extension}",
    }

    assert main._validated_receipt_storage_path(receipt) == receipt["file_path"]


@pytest.mark.parametrize(
    "file_path",
    [
        "org-2/batch-1/receipt-1.jpg",
        "org-1/batch-2/receipt-1.jpg",
        "org-1/batch-1/receipt-2.jpg",
        "org-1/batch-1/receipt-1.jpg/other",
        "org-1/batch-1/receipt-1.exe",
        "org-1/batch-1/receipt-1.jpg?download=1",
        "../org-1/batch-1/receipt-1.jpg",
    ],
)
def test_receipt_storage_path_rejects_cross_row_or_non_receipt_objects(file_path):
    with pytest.raises(RuntimeError):
        main._validated_receipt_storage_path({
            "id": "receipt-1",
            "batch_id": "batch-1",
            "organization_id": "org-1",
            "file_path": file_path,
        })


def test_enqueue_rpc_is_service_role_authenticated_and_idempotent_shape(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    captured = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["apikey"] = request.headers.get("apikey")
        captured["authorization"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json=[{
            "receipt_id": "receipt-1",
            "queue_message_id": 42,
            "status": "Pending",
            "queued_at": "2026-07-31T10:00:00Z",
            "already_queued": True,
        }])

    async def enqueue():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.enqueue_extraction_job(client, "receipt-1", "user-1")

    row = asyncio.run(enqueue())

    assert row["queue_message_id"] == 42
    assert row["already_queued"] is True
    assert captured == {
        "path": "/rest/v1/rpc/enqueue_receipt_extraction",
        "apikey": "service-role-test-key",
        "authorization": "Bearer service-role-test-key",
        "payload": {"p_receipt_id": "receipt-1", "p_requested_by": "user-1"},
    }


def test_queue_rpc_error_includes_sanitized_supabase_context(monkeypatch):
    secret = "service-role-secret-value"
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", secret)

    def respond(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={
            "code": "42703",
            "message": f"column extraction_claimed_at is missing; Bearer {secret}",
            "details": {"apikey": secret, "migration": "002"},
            "hint": "this field is intentionally not copied",
        })

    async def call_rpc():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main._queue_rpc(client, "claim_next_receipt_extraction", {
                "private": "request-payload-must-not-be-logged",
            })

    with pytest.raises(RuntimeError) as error:
        asyncio.run(call_rpc())

    message = str(error.value)
    assert "claim_next_receipt_extraction" in message
    assert "status 400" in message
    assert "code=42703" in message
    assert "message=column extraction_claimed_at is missing" in message
    assert "details=" in message
    assert "migration" in message
    assert secret not in message
    assert "request-payload-must-not-be-logged" not in message
    assert "intentionally not copied" not in message


def test_claim_rpc_identifies_worker_and_requests_one_visibility_lease(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.setattr(main, "WORKER_ID", "worker-a")
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_VISIBILITY_SECONDS", 120)
    monkeypatch.setattr(main, "EXTRACTION_QUEUE_MAX_ATTEMPTS", 3)
    captured = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json=[])

    async def claim():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.claim_next_extraction_job(client)

    assert asyncio.run(claim()) is None
    assert captured == {
        "p_worker_id": "worker-a",
        "p_visibility_seconds": 120,
        "p_max_attempts": 3,
    }


@pytest.mark.parametrize(
    ("raw_status", "expected_status", "expected_detail"),
    [
        ("Pending", "Queued", "Already queued."),
        ("Processing", "Processing", "Already being extracted."),
    ],
)
def test_enqueue_endpoint_returns_effective_idempotent_status(
    monkeypatch, raw_status, expected_status, expected_detail
):
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "extraction_queue_ready", True)

    async def resolve(_authorization):
        return {"id": "user-1", "role": "Operator", "organization_id": "org-1"}

    async def load_receipt(_receipt_id, _caller):
        return {
            "id": "receipt-1",
            "status": raw_status,
            "file_path": "org-1/batch-1/receipt-1.jpg",
            "organization_id": "org-1",
        }

    async def enqueue(_client, _receipt_id, _requested_by):
        return {
            "receipt_id": "receipt-1",
            "queue_message_id": 42,
            "status": raw_status,
            "queued_at": "2026-07-31T10:00:00Z",
            "already_queued": True,
        }

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main, "_load_receipt_for_caller", load_receipt)
    monkeypatch.setattr(main, "enqueue_extraction_job", enqueue)

    response = asyncio.run(main.start_receipt_extraction(
        "receipt-1", "Bearer valid-session"
    ))

    assert response == {
        "receipt_id": "receipt-1",
        "status": expected_status,
        "detail": expected_detail,
        "extraction_queue_message_id": 42,
        "extraction_queued_at": "2026-07-31T10:00:00Z",
    }


def test_enqueue_endpoint_does_not_fail_open_when_queue_probe_is_indeterminate(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "extraction_queue_ready", None)

    async def resolve(_authorization):
        return {"id": "user-1", "role": "Operator", "organization_id": "org-1"}

    async def load_receipt(_receipt_id, _caller):
        return {
            "id": "receipt-1",
            "status": "Pending",
            "file_path": "org-1/batch-1/receipt-1.jpg",
            "organization_id": "org-1",
        }

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main, "_load_receipt_for_caller", load_receipt)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.start_receipt_extraction(
            "receipt-1", "Bearer valid-session"
        ))

    assert error.value.status_code == 503
    assert "queue reconnects" in error.value.detail


def test_enqueue_endpoint_reports_actionable_migration_002_configuration_error(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(
        main,
        "extraction_queue_configuration_error",
        main.MIGRATION_002_REQUIRED_ERROR,
    )

    async def resolve(_authorization):
        return {"id": "user-1", "role": "Operator", "organization_id": "org-1"}

    async def must_not_load_receipt(*_args):
        pytest.fail("A known schema configuration error should fail before receipt work")

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main, "_load_receipt_for_caller", must_not_load_receipt)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.start_receipt_extraction(
            "receipt-1", "Bearer valid-session"
        ))

    assert error.value.status_code == 503
    assert error.value.detail == main.MIGRATION_002_REQUIRED_ERROR
    assert "002_ledgers_claiming_audit.sql" in error.value.detail
    assert "007_sequential_extraction_queue.sql" in error.value.detail
    assert "restart" in error.value.detail.lower()


def test_fenced_completion_rejection_never_falls_back_to_unfenced_failure(monkeypatch):
    job = {
        "receipt_id": "receipt-1",
        "queue_message_id": 42,
        "lease_token": "11111111-1111-1111-1111-111111111111",
        "attempt_count": 1,
        "requested_by": "user-1",
        "uploaded_by": "user-1",
        "batch_id": "batch-1",
        "organization_id": "org-1",
        "filename": "receipt.jpg",
        "file_path": "org-1/batch-1/receipt.jpg",
    }
    calls = {"complete": 0, "fail": 0}

    async def heartbeat(_job, _lost):
        await asyncio.Event().wait()

    async def prepare(_receipt, _user_id):
        return {
            "error": None,
            "rows": [{"entry_type": "Dr"}],
            "warnings": [],
            "raw_extraction": {"transactions": []},
        }

    async def complete(_client, _job, _prepared):
        calls["complete"] += 1
        return False

    async def fail(*_args, **_kwargs):
        calls["fail"] += 1

    monkeypatch.setattr(main, "_heartbeat_queued_extraction", heartbeat)
    monkeypatch.setattr(main, "_prepare_extraction", prepare)
    monkeypatch.setattr(main, "complete_extraction_job", complete)
    monkeypatch.setattr(main, "_record_queued_failure", fail)

    asyncio.run(main._run_queued_extraction_job(job))

    assert calls == {"complete": 1, "fail": 0}
    assert "receipt-1" not in main._jobs_in_flight


def test_overall_timeout_keeps_queue_slot_until_provider_thread_settles(monkeypatch):
    job = {
        "receipt_id": "receipt-1",
        "queue_message_id": 42,
        "lease_token": "11111111-1111-1111-1111-111111111111",
        "attempt_count": 1,
        "requested_by": "user-1",
        "uploaded_by": "user-1",
        "batch_id": "batch-1",
        "organization_id": "org-1",
        "filename": "receipt.jpg",
        "file_path": "org-1/batch-1/receipt-1.jpg",
    }
    provider_started = threading.Event()
    provider_settled = threading.Event()
    failed = []

    def blocking_provider_request():
        provider_started.set()
        time.sleep(0.08)
        provider_settled.set()
        return {"transactions": []}

    async def prepare(_receipt, _user_id):
        await main._run_blocking_provider_calls([
            (blocking_provider_request, (), {})
        ])
        pytest.fail("A timed-out extraction must discard the provider result")

    async def heartbeat(_job, _lost):
        await asyncio.Event().wait()

    async def fail(_job, message, _raw_extraction=None):
        assert provider_settled.is_set()
        failed.append(message)

    monkeypatch.setattr(main, "EXTRACTION_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(main, "_prepare_extraction", prepare)
    monkeypatch.setattr(main, "_heartbeat_queued_extraction", heartbeat)
    monkeypatch.setattr(main, "_record_queued_failure", fail)

    asyncio.run(main._run_queued_extraction_job(job))

    assert provider_started.is_set()
    assert provider_settled.is_set()
    assert failed == ["Extraction took too long and was stopped. Please try again."]
    assert "receipt-1" not in main._jobs_in_flight


def test_legacy_direct_extraction_endpoint_is_closed():
    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.extract_receipt())

    assert error.value.status_code == 410
