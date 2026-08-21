"""Turning this process's extraction worker off, without breaking anything else.

The extraction queue is global: every backend pointed at the same Supabase
project competes for one singleton lease, so a laptop and a deployed instance
race, and the deployed one frequently wins work started from the laptop. The
symptom is a local terminal that logs the request being accepted and then goes
silent, because the extraction — and its progress lines — happened elsewhere.

The switch that resolves that is also the switch that, set by accident on a
deployment, stops extraction for everybody while leaving the service looking
perfectly healthy. So these tests pin both halves: that it actually stops the
worker, and that it is impossible to miss when it has.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


@pytest.fixture
def lifespan_probe(monkeypatch):
    """Runs the real lifespan with the workers replaced by observable stubs."""
    lines = []
    monkeypatch.setattr(main, "log", lambda *parts: lines.append(" ".join(str(p) for p in parts)))

    started = []

    async def noop_detect():
        return None

    async def fake_consume():
        started.append("extraction")
        await asyncio.sleep(3600)

    async def fake_alerts():
        started.append("alerts")
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "detect_schema_features", noop_detect)
    monkeypatch.setattr(main, "consume_extraction_queue", fake_consume)
    monkeypatch.setattr(main, "publish_capacity_alerts", fake_alerts)
    monkeypatch.setattr(main, "extraction_queue_ready", True)
    monkeypatch.setattr(main, "_install_uvicorn_timestamps", lambda: None)
    monkeypatch.setattr(main, "_worker_state", {})

    async def run():
        async with main.lifespan(main.app):
            # Long enough for the supervisor to have entered the factory.
            await asyncio.sleep(0.05)
            # Snapshotted while still inside the context: on the way out the
            # supervisor legitimately records every worker as "stopped", so
            # reading it afterwards would report the shutdown, not the run.
            live_state = dict(main._worker_state)
        return started, lines, live_state

    return run


def test_the_worker_runs_by_default(lifespan_probe, monkeypatch):
    monkeypatch.setattr(main, "EXTRACTION_WORKER_ENABLED", True)

    started, lines, state = asyncio.run(lifespan_probe())

    assert "extraction" in started
    assert state["extraction-worker"]["status"] == "running"
    assert not any("EXTRACTION_WORKER_ENABLED=false" in line for line in lines)


def test_switching_it_off_stops_the_worker_consuming(lifespan_probe, monkeypatch):
    monkeypatch.setattr(main, "EXTRACTION_WORKER_ENABLED", False)

    started, _lines, state = asyncio.run(lifespan_probe())

    assert "extraction" not in started, "the queue must not be consumed here"
    assert state["extraction-worker"]["status"] == "disabled"


def test_switching_it_off_says_so_loudly(lifespan_probe, monkeypatch):
    """Reported as 'disabled', never as 'finished normally'.

    A worker that returns immediately is, technically, a worker that finished
    normally — and describing it that way in the log and on /api/health is how
    a deployment with extraction switched off would look healthy.
    """
    monkeypatch.setattr(main, "EXTRACTION_WORKER_ENABLED", False)

    _started, lines, state = asyncio.run(lifespan_probe())

    assert any("EXTRACTION_WORKER_ENABLED=false" in line for line in lines)
    assert any("will NOT extract" in line for line in lines)
    assert state["extraction-worker"]["status"] != "finished"
    assert not any("finished normally" in line for line in lines)


def test_the_other_workers_are_untouched(lifespan_probe, monkeypatch):
    """Switching off extraction must not switch off anything else."""
    monkeypatch.setattr(main, "EXTRACTION_WORKER_ENABLED", False)

    started, _lines, state = asyncio.run(lifespan_probe())

    assert "alerts" in started
    assert state["capacity-alerts"]["status"] == "running"


def test_shutdown_is_clean_with_no_extraction_task(lifespan_probe, monkeypatch):
    """The shutdown path used to cancel the task unconditionally.

    With the worker switched off there is no task, so an unguarded .cancel()
    would raise AttributeError out of the lifespan's finally block — turning a
    normal shutdown into a crash. Reaching this assertion at all is the test.
    """
    monkeypatch.setattr(main, "EXTRACTION_WORKER_ENABLED", False)

    started, _lines, _state = asyncio.run(lifespan_probe())

    assert started == ["alerts"]


def test_the_default_is_on():
    """Nobody should have to set an env var to get a working backend."""
    assert main.EXTRACTION_WORKER_ENABLED is True
