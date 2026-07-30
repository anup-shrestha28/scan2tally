"""Capacity warnings must change at the configured boundaries, not near them."""

import os
import sys

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
def test_non_super_admin_receives_warning_but_not_global_usage_details(role):
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
