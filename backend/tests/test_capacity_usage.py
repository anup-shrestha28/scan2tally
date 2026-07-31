"""Capacity warnings must change at the configured boundaries, not near them."""

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


@pytest.fixture(autouse=True)
def fixed_capacity(monkeypatch):
    # Small round values keep each boundary obvious and independent of the
    # deployment's actual environment variables.
    monkeypatch.setattr(main, "STORAGE_QUOTA_BYTES", 1_000)
    monkeypatch.setattr(main, "DATABASE_QUOTA_BYTES", 1_000)
    monkeypatch.setattr(main, "USAGE_WARNING_PERCENT", 80.0)
    monkeypatch.setattr(main, "USAGE_CRITICAL_PERCENT", 95.0)


@pytest.mark.parametrize(
    ("used", "expected_level"),
    [
        (799, "healthy"),
        (800, "warning"),
        (949, "warning"),
        (950, "critical"),
        (999, "critical"),
        (1_000, "full"),
        (1_250, "full"),
    ],
)
def test_storage_warning_boundaries(used, expected_level):
    status = main.build_capacity_status(storage_bytes=used, database_bytes=0)

    assert status["level"] == expected_level
    assert status["resource"] == "storage"
    assert status["storage"]["usedBytes"] == used


def test_database_can_be_the_limiting_resource():
    status = main.build_capacity_status(storage_bytes=100, database_bytes=960)

    assert status["level"] == "critical"
    assert status["resource"] == "database"
    assert "Database storage" in status["message"]


def test_usage_percent_can_exceed_one_hundred_without_corrupting_bytes():
    status = main.build_capacity_status(storage_bytes=1_500, database_bytes=0)

    assert status["storage"] == {
        "usedBytes": 1_500,
        "quotaBytes": 1_000,
        "percent": 150.0,
    }
    assert status["level"] == "full"


@pytest.mark.parametrize("role", ["Admin", "Operator"])
def test_response_builder_withholds_exact_details_as_defense_in_depth(role):
    response = main.build_platform_usage_response({
        "storage_bytes": 850,
        "database_bytes": 400,
        "storage_objects": 9,
        "storage_by_bucket": {"receipts": 800, "exports": 50},
    }, role)

    assert response["level"] == "warning"
    assert response["percent"] == 85.0
    assert "storage" not in response
    assert "database" not in response


def test_super_admin_receives_exact_metrics_and_bucket_breakdown():
    response = main.build_platform_usage_response({
        "storage_bytes": 850,
        "database_bytes": 400,
        "storage_objects": 9,
        "storage_by_bucket": {"receipts": 800, "exports": 50},
    }, "Super Admin")

    assert response["storage"]["usedBytes"] == 850
    assert response["storage"]["objectCount"] == 9
    assert response["storage"]["byBucket"] == {"receipts": 800, "exports": 50}
    assert response["database"]["usedBytes"] == 400


def test_storage_only_snapshot_remains_live_without_inventing_database_usage():
    response = main.build_platform_usage_response({
        "storage_bytes": 850,
        "database_bytes": None,
        "storage_objects": 3,
        "storage_by_bucket": {"receipts": 850},
    }, "Super Admin")

    assert response["level"] == "warning"
    assert response["monitoringMode"] == "storage-only"
    assert response["storage"]["usedBytes"] == 850
    assert "database" not in response


def test_storage_api_fallback_traverses_folders_and_sums_object_metadata(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/storage/v1/bucket":
            return httpx.Response(200, json=[{"id": "receipts"}, {"id": "exports"}])

        payload = json.loads(request.content)
        prefix = payload["prefix"]
        if request.url.path.endswith("/receipts") and prefix == "":
            return httpx.Response(200, json=[
                {"id": None, "name": "org-1", "metadata": None},
                {"id": "root-file", "name": "root.jpg", "metadata": {"size": 5}},
            ])
        if request.url.path.endswith("/receipts") and prefix == "org-1":
            return httpx.Response(200, json=[
                {"id": "file-1", "name": "one.jpg", "metadata": {"size": "10"}},
                {"id": "file-2", "name": "two.jpg", "metadata": {"contentLength": 20}},
            ])
        if request.url.path.endswith("/exports") and prefix == "":
            return httpx.Response(200, json=[
                {"id": "export-1", "name": "report.xlsx", "metadata": {"size": 7}},
            ])
        return httpx.Response(404, json={"message": "unexpected request"})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.fetch_storage_usage_via_api(client)

    snapshot = asyncio.run(collect())

    assert snapshot == {
        "database_bytes": None,
        "storage_bytes": 42,
        "storage_objects": 4,
        "storage_by_bucket": {"receipts": 35, "exports": 7},
    }


def test_capacity_alert_publisher_calls_protected_rpc_with_configured_limits(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

    captured = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["apikey"] = request.headers.get("apikey")
        captured["authorization"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json=2)

    async def publish():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.publish_capacity_alerts_once(client)

    transitions = asyncio.run(publish())

    assert transitions == 2
    assert captured == {
        "method": "POST",
        "path": "/rest/v1/rpc/refresh_platform_capacity_alerts",
        "apikey": "service-role-test-key",
        "authorization": "Bearer service-role-test-key",
        "payload": {
            "p_storage_quota_bytes": 1_000,
            "p_database_quota_bytes": 1_000,
            "p_warning_percent": 80.0,
            "p_critical_percent": 95.0,
        },
    }


def test_capacity_alert_publisher_rejects_failed_rpc(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

    def respond(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "function not found"})

    async def publish():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await main.publish_capacity_alerts_once(client)

    with pytest.raises(RuntimeError, match="status 404"):
        asyncio.run(publish())


@pytest.mark.parametrize("role", ["Admin", "Operator"])
def test_staff_cannot_call_exact_platform_usage_endpoint(monkeypatch, role):
    monkeypatch.setattr(main, "supabase_admin_available", True)

    async def resolve(_authorization):
        return {"id": "staff-id", "role": role}

    async def exact_snapshot_must_not_be_loaded():
        raise AssertionError("Staff must not load exact platform metrics")

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main, "fetch_platform_usage_snapshot", exact_snapshot_must_not_be_loaded)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_platform_usage("Bearer valid-session"))

    assert error.value.status_code == 403
    assert "Super Admin" in error.value.detail
