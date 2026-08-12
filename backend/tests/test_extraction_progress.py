"""Progress logging must describe the extraction, never distort or disturb it.

These lines exist to answer one question while a receipt is being read: is it
still working, or is it stuck? That only holds if the numbers mean something —
a percentage that advances on its own, or slides backwards, or keeps climbing
after a request was abandoned, is worse than printing nothing at all, because
it reports progress that is not happening.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


@pytest.fixture
def captured(monkeypatch):
    """Collects every line the logger is handed."""
    lines = []
    monkeypatch.setattr(main, "log", lambda *parts: lines.append(" ".join(str(p) for p in parts)))
    monkeypatch.setattr(main, "EXTRACTION_PROGRESS_LOGS", True)
    return lines


def percentages(lines):
    """The percentage from each progress line, in the order they were logged."""
    found = []
    for line in lines:
        if "📊 [" not in line or "%]" not in line:
            continue
        found.append(int(line.split("📊 [", 1)[1].split("%]", 1)[0].strip()))
    return found


# ------------------------------------------------- the numbers mean something

def test_progress_never_goes_backwards(captured):
    """A stage reported out of order must not print a number already passed.

    Provider calls settle in completion order, and a done-callback can land
    after a later stage has already been reported. Showing 43% under a line
    that said 75% would read as the extraction regressing.
    """
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.step(10, "image downloaded")
    progress.step(75, "consensus built")
    progress.step(15, "a late callback")

    assert percentages(captured) == [10, 75, 75]


def test_vision_band_is_proportional_and_lands_exactly_on_its_ceiling(captured):
    """Every response moves the bar, and the last one ends the band precisely."""
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.vision_sent(4, "Gemini test-model", 3)
    for _ in range(4):
        progress.vision_response()

    reported = percentages(captured)
    assert reported[0] == main._PROGRESS_VISION_SENT
    assert reported[-1] == main._PROGRESS_VISION_DONE
    # Strictly increasing, so each response is visibly distinct from the last.
    assert reported == sorted(reported)
    assert len(set(reported)) == len(reported)


def test_extra_responses_cannot_push_past_the_band(captured):
    """More callbacks than calls must not walk the bar into the next stage."""
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.vision_sent(2, "Gemini test-model", 1)
    for _ in range(6):
        progress.vision_response()

    assert max(percentages(captured)) == main._PROGRESS_VISION_DONE


def test_single_pass_configuration_still_reports_a_band(captured):
    """OCR_CONSENSUS_RUNS=1 means two calls, not zero: it must not divide by 0."""
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.vision_sent(2, "OpenAI test-model", 1)
    progress.vision_response()
    progress.vision_response()

    assert percentages(captured)[-1] == main._PROGRESS_VISION_DONE
    assert "1 transcription pass +" in captured[0]


def test_vision_response_before_dispatch_is_ignored(captured):
    """Nothing was sent, so nothing can have come back."""
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.vision_response()

    assert percentages(captured) == []


# ------------------------------------------------- failures stay honest

def test_failure_names_its_stage_and_reports_no_percentage(captured):
    """A failed extraction never reached a figure; printing one reads as success."""
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.step(70, "vision response received")
    progress.failed("the model returned nothing readable")

    assert percentages(captured) == [70]
    assert "[FAIL]" in captured[-1]
    assert "vision response received" in captured[-1]
    assert "the model returned nothing readable" in captured[-1]


def test_a_cancelled_provider_call_is_not_counted_as_a_response(captured):
    """A timed-out receipt must not climb the band on its way out.

    asyncio cancels the awaitable, and the done-callback fires for a cancelled
    task exactly as it does for a finished one. Counting those would let an
    extraction that returned nothing print its way to the top of the band.
    """
    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.vision_sent(2, "Gemini test-model", 1)

    async def scenario():
        task = asyncio.create_task(asyncio.sleep(30))
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        main._announce_settled_call(task, progress.vision_response)

    asyncio.run(scenario())

    assert percentages(captured) == [main._PROGRESS_VISION_SENT]


def test_a_broken_reporter_cannot_fail_the_extraction():
    """Commentary must never be able to break the work it describes."""
    def explode():
        raise RuntimeError("reporting is broken")

    async def scenario():
        task = asyncio.create_task(asyncio.sleep(0))
        await task
        return task

    task = asyncio.run(scenario())
    main._announce_settled_call(task, explode)  # must not raise


# ------------------------------------------------- wiring

def test_concurrent_extractions_do_not_share_a_reporter():
    """The legacy path runs several receipts at once, each with its own label.

    Each asyncio task gets its own copy of the context, so a reporter set inside
    one must be invisible to another running beside it.
    """
    seen = {}

    async def one(name):
        main._extraction_progress.set(main.ExtractionProgress(name, f"{name}.jpg"))
        await asyncio.sleep(0)
        seen[name] = main.extraction_progress()

    async def scenario():
        await asyncio.gather(one("alpha"), one("beta"), one("gamma"))
        # The gathering task never set one of its own.
        return main.extraction_progress()

    outer = asyncio.run(scenario())

    assert len({id(reporter) for reporter in seen.values()}) == 3
    assert outer is main._SILENT_PROGRESS


def test_no_receipt_in_scope_logs_nothing(captured):
    """run_extraction called outside a job must not emit half a receipt's worth."""
    main.extraction_progress().step(50, "should not appear")
    main.extraction_progress().failed("nor should this")

    assert captured == []


def test_the_toggle_silences_progress_without_touching_other_logs(monkeypatch):
    """Log volume is an operational concern; the off switch must actually work."""
    lines = []
    monkeypatch.setattr(main, "log", lambda *parts: lines.append(" ".join(str(p) for p in parts)))
    monkeypatch.setattr(main, "EXTRACTION_PROGRESS_LOGS", False)

    progress = main.ExtractionProgress("receipt-1", "bill.jpg")
    progress.step(10, "image downloaded")
    progress.vision_sent(2, "Gemini test-model", 1)
    progress.vision_response()
    progress.failed("something went wrong")

    assert lines == []
    # Silenced, not disabled: the stage is still tracked, so a failure logged by
    # some other path can still say where the extraction had reached.
    assert progress.stage == "vision response received"


QUEUE_JOB = {
    "receipt_id": "387de908-1c24-4146-8768-def97f20470d",
    "queue_message_id": 42,
    "lease_token": "11111111-1111-1111-1111-111111111111",
    "attempt_count": 1,
    "requested_by": "user-1",
    "uploaded_by": "user-1",
    "batch_id": "batch-1",
    "organization_id": "org-1",
    "filename": "bill2.jpg",
    "file_path": "org-1/batch-1/receipt-1.jpg",
}


def test_the_reporter_reaches_the_extraction_task(captured, monkeypatch):
    """The reporter is set in the job runner but used a task deeper down.

    _prepare_extraction runs as its own task, and a task copies the context at
    the moment it is created. Set the reporter one line too late and every
    stage inside it would silently log nothing — the feature would look
    implemented and produce no output at all.
    """
    seen = {}

    async def heartbeat(_job, _lost):
        await asyncio.Event().wait()

    async def prepare(_receipt, _user_id):
        seen["reporter"] = main.extraction_progress()
        return {
            "error": None,
            "rows": [{"entry_type": "Dr"}, {"entry_type": "Cr"}],
            "warnings": [],
            "raw_extraction": {"transactions": []},
        }

    async def complete(_client, _job, _prepared):
        return True

    monkeypatch.setattr(main, "_heartbeat_queued_extraction", heartbeat)
    monkeypatch.setattr(main, "_prepare_extraction", prepare)
    monkeypatch.setattr(main, "complete_extraction_job", complete)

    asyncio.run(main._run_queued_extraction_job(dict(QUEUE_JOB)))

    assert seen["reporter"] is not main._SILENT_PROGRESS
    assert percentages(captured) == [0, 95, 100]
    assert "bill2.jpg (387de908)" in captured[0]


def test_the_job_runner_restores_the_context_for_the_next_receipt(monkeypatch):
    """The consumer loops in one task; a stale reporter would mislabel the next."""
    async def heartbeat(_job, _lost):
        await asyncio.Event().wait()

    async def prepare(_receipt, _user_id):
        return {"error": None, "rows": [], "warnings": [], "raw_extraction": {}}

    async def complete(_client, _job, _prepared):
        return True

    monkeypatch.setattr(main, "_heartbeat_queued_extraction", heartbeat)
    monkeypatch.setattr(main, "_prepare_extraction", prepare)
    monkeypatch.setattr(main, "complete_extraction_job", complete)

    async def scenario():
        await main._run_queued_extraction_job(dict(QUEUE_JOB))
        return main.extraction_progress()

    assert asyncio.run(scenario()) is main._SILENT_PROGRESS


def test_a_failed_queued_receipt_reports_no_completion_percentage(captured, monkeypatch):
    """A receipt that failed must not print 100%, or the log claims it worked."""
    async def heartbeat(_job, _lost):
        await asyncio.Event().wait()

    async def prepare(_receipt, _user_id):
        return {
            "error": "The uploaded image is not a journal entry. Please check.",
            "rows": [],
            "warnings": [],
            "raw_extraction": {},
        }

    async def record_failure(*_args, **_kwargs):
        return None

    monkeypatch.setattr(main, "_heartbeat_queued_extraction", heartbeat)
    monkeypatch.setattr(main, "_prepare_extraction", prepare)
    monkeypatch.setattr(main, "_record_queued_failure", record_failure)

    asyncio.run(main._run_queued_extraction_job(dict(QUEUE_JOB)))

    assert 100 not in percentages(captured)
    assert any("[FAIL]" in line for line in captured)


def test_the_label_distinguishes_identical_filenames(captured):
    """A split PDF produces the same page name in every batch it lands in."""
    first = main.ExtractionProgress("aaaaaaaa-1111", "newJourna - page 3 of 19.jpg")
    second = main.ExtractionProgress("bbbbbbbb-2222", "newJourna - page 3 of 19.jpg")
    first.step(10, "image downloaded")
    second.step(10, "image downloaded")

    assert "aaaaaaaa" in captured[0]
    assert "bbbbbbbb" in captured[1]
    assert captured[0] != captured[1]
