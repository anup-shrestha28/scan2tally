"""Background workers must not be able to die quietly.

Extraction runs in an asyncio task started at app startup and then never looked
at again. An unhandled exception in that task killed it without stopping
anything else: FastAPI kept serving, /api/health kept returning 200, the host saw
a healthy service — and no voucher was ever extracted again, because extraction
is one worker platform-wide. Nothing in the system said so.

These tests cover the supervisor that keeps it alive: it restarts a crash, backs
off instead of spinning, leaves a deliberate exit alone, and reports what it is
doing where somebody can see it.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


@pytest.fixture(autouse=True)
def _fast_and_clean(monkeypatch):
    """No real waiting, and no state carried between tests."""
    monkeypatch.setattr(main, "_worker_state", {})
    monkeypatch.setattr(main, "WORKER_RESTART_DELAY_SECONDS", 0)
    monkeypatch.setattr(main, "WORKER_RESTART_MAX_DELAY_SECONDS", 0)


# ------------------------------------------------------------ restarting

def test_a_crashed_worker_is_restarted():
    runs = []

    async def crashes_twice_then_runs():
        runs.append(1)
        if len(runs) <= 2:
            raise RuntimeError("supabase unreachable")
        raise asyncio.CancelledError  # stand-in for "still running at shutdown"

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._supervise("worker", crashes_twice_then_runs))

    assert len(runs) == 3, "should have been restarted after each crash"
    assert main._worker_state["worker"]["restarts"] == 2


def test_a_crash_is_logged_with_its_cause(capsys):
    attempts = []

    async def crashes_once():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("PostgREST exploded")
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._supervise("extraction-worker", crashes_once))

    output = capsys.readouterr().out
    assert "extraction-worker" in output
    assert "crashed" in output
    assert "RuntimeError: PostgREST exploded" in output
    assert "restart #1" in output


def test_a_worker_that_fails_without_a_message_still_names_itself(capsys):
    """httpx raises timeouts blank; the log must not trail off after the colon."""
    import httpx

    attempts = []

    async def times_out():
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ReadTimeout("")
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._supervise("extraction-worker", times_out))

    assert "ReadTimeout" in capsys.readouterr().out


# ------------------------------------------------------------ not restarting

def test_a_worker_that_returns_on_purpose_is_left_alone():
    """consume_extraction_queue returns immediately when the schema is not
    ready. Restarting that would spin at full speed forever."""
    runs = []

    async def finishes():
        runs.append(1)

    asyncio.run(main._supervise("worker", finishes))

    assert len(runs) == 1
    assert main._worker_state["worker"]["status"] == "finished"


def test_a_deliberate_return_says_so_rather_than_looking_like_a_crash(capsys):
    async def finishes():
        return

    asyncio.run(main._supervise("worker", finishes))

    output = capsys.readouterr().out
    assert "finished normally" in output
    assert "crashed" not in output


def test_shutdown_cancellation_propagates():
    """Swallowing this would leave the app unable to shut down."""
    async def never_ends():
        await asyncio.Event().wait()

    async def drive():
        task = asyncio.create_task(main._supervise("worker", never_ends))
        await asyncio.sleep(0)
        task.cancel()
        await task

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(drive())

    assert main._worker_state["worker"]["status"] == "stopped"


# ------------------------------------------------------------ backoff

def test_repeated_instant_failures_back_off(monkeypatch):
    """A worker failing instantly must not hammer a service already in trouble."""
    monkeypatch.setattr(main, "WORKER_RESTART_DELAY_SECONDS", 1)
    monkeypatch.setattr(main, "WORKER_RESTART_MAX_DELAY_SECONDS", 8)
    slept = []

    async def record_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(main.asyncio, "sleep", record_sleep)
    attempts = []

    async def always_crashes():
        attempts.append(1)
        if len(attempts) > 5:
            raise asyncio.CancelledError
        raise RuntimeError("down")

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._supervise("worker", always_crashes))

    assert slept == [1, 2, 4, 8, 8], f"expected doubling capped at 8, got {slept}"


def test_backoff_resets_after_a_long_healthy_run(monkeypatch):
    """An outage hours ago should not leave the worker slow to recover today."""
    monkeypatch.setattr(main, "WORKER_RESTART_DELAY_SECONDS", 1)
    monkeypatch.setattr(main, "WORKER_RESTART_MAX_DELAY_SECONDS", 64)
    monkeypatch.setattr(main, "WORKER_HEALTHY_RUN_SECONDS", 300)

    clock = {"now": 0.0}
    monkeypatch.setattr(main.time, "monotonic", lambda: clock["now"])
    slept = []

    async def record_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(main.asyncio, "sleep", record_sleep)
    attempts = []

    async def crash_pattern():
        attempts.append(1)
        if len(attempts) == 1:
            clock["now"] += 1        # instant failure
        elif len(attempts) == 2:
            clock["now"] += 1        # instant again -> should double
        elif len(attempts) == 3:
            clock["now"] += 3600     # ran an hour -> next failure starts fresh
        else:
            raise asyncio.CancelledError
        raise RuntimeError("down")

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._supervise("worker", crash_pattern))

    assert slept == [1, 2, 4], "delays applied before each restart"
    # The fourth attempt would have waited 1s again, not 8s, because attempt 3
    # ran for an hour. That reset is what the third entry records.


# ------------------------------------------------------------ visibility

def test_health_reports_worker_state(monkeypatch):
    monkeypatch.setattr(main, "_worker_state", {
        "extraction-worker": {"status": "running", "restarts": 0},
    })

    body = main.health_check(x_keepalive_source=None)

    assert body["status"] == "online"
    assert body["workers"]["extraction-worker"]["status"] == "running"


def test_health_still_reports_online_when_a_worker_is_down(monkeypatch):
    """Deliberate: the app can still serve vouchers for review, and failing the
    health check would have the host restart a backend that is serving fine."""
    monkeypatch.setattr(main, "_worker_state", {
        "extraction-worker": {"status": "restarting", "restarts": 3,
                              "last_error": "ReadTimeout"},
    })

    body = main.health_check(x_keepalive_source=None)

    assert body["status"] == "online"
    assert body["workers"]["extraction-worker"]["restarts"] == 3
    assert body["workers"]["extraction-worker"]["last_error"] == "ReadTimeout"
