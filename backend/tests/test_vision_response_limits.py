"""What happens when a vision request runs out of output budget.

gpt-5.x models reason before they answer, and those reasoning tokens are billed
against the same `max_completion_tokens` ceiling as the JSON. Exhaust it and the
API does not return half a voucher — it returns `finish_reason="length"` with the
content field EMPTY.

That is byte-for-byte identical to the model saying "there is nothing here",
which is why a legible voucher used to be reported to the operator as "The
uploaded image is not a journal entry. Please check." The reviewer then goes and
squints at a perfectly good scan. These tests hold the two cases apart.
"""

import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


def _response(content, finish_reason="stop", completion_tokens=120, reasoning_tokens=90):
    """The shape of the SDK object that `_openai_vision_json` reads."""
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(
            finish_reason=finish_reason,
            message=types.SimpleNamespace(content=content),
        )],
        usage=types.SimpleNamespace(
            completion_tokens=completion_tokens,
            completion_tokens_details=types.SimpleNamespace(reasoning_tokens=reasoning_tokens),
        ),
    )


@pytest.fixture
def vision(monkeypatch):
    """Drives `_openai_vision_json` against a canned SDK response."""
    def install(response):
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=lambda **kwargs: response)
            )
        )
        # raising=False because `openai_client` is only bound when
        # AI_PROVIDER=openai, so on a developer machine configured for Gemini the
        # attribute does not exist yet and these tests would fail on the patch
        # itself rather than on anything they are checking.
        monkeypatch.setattr(main, "openai_client", client, raising=False)
    return install


# ------------------------------------------------------- budget exhaustion

def test_exhausted_output_budget_raises_rather_than_reading_as_empty(vision):
    vision(_response(None, finish_reason="length", completion_tokens=32000, reasoning_tokens=32000))

    with pytest.raises(main.VisionResponseTruncated):
        main._openai_vision_json("prompt", "b64", "image/jpeg")


def test_truncation_is_detected_before_the_content_is_parsed(vision):
    """A partially written body must not reach json.loads and surface as a
    syntax error — the cause is the ceiling, not malformed output."""
    vision(_response('{"transactions": [{"ledger_na', finish_reason="length"))

    with pytest.raises(main.VisionResponseTruncated):
        main._openai_vision_json("prompt", "b64", "image/jpeg")


def test_truncation_message_names_the_setting_that_fixes_it():
    message = main.extraction_error_message("OpenAI Vision", main.VisionResponseTruncated("x"))

    assert message == main.VISION_RESPONSE_TRUNCATED_ERROR
    assert "OPENAI_MAX_COMPLETION_TOKENS" in message
    # The one thing it must never say, because the image is fine.
    assert message != main.INVALID_JOURNAL_IMAGE_ERROR
    assert "not a journal entry" not in message


def test_an_exhausted_budget_is_not_reported_as_a_bad_image():
    truncated = main.extraction_error_message("OpenAI Vision", main.VisionResponseTruncated("x"))
    genuinely_empty = main.INVALID_JOURNAL_IMAGE_ERROR

    assert truncated != genuinely_empty


# ------------------------------------------------------- the honest empty case

def test_empty_content_that_finished_normally_still_reads_as_nothing_found(vision):
    """A model that stops of its own accord having found nothing is a real
    "not a journal entry", and must keep reporting as one."""
    vision(_response("", finish_reason="stop"))

    assert main._openai_vision_json("prompt", "b64", "image/jpeg") == {}
    assert main.openai_transcribe("b64", "image/jpeg") == []


def test_normal_response_is_parsed(vision):
    payload = {"transactions": [{"ledger_name": "Freight outward", "debit_amount": 1237.35}]}
    vision(_response(json.dumps(payload)))

    assert main._openai_vision_json("prompt", "b64", "image/jpeg") == payload
    # Each row carries the voucher number read from the header, falling back to
    # None when the response omitted it, as this one does.
    assert main.openai_transcribe("b64", "image/jpeg") == [
        {"ledger_name": "Freight outward", "debit_amount": 1237.35, "voucher_no": None}
    ]


# ------------------------------------------------------- the budget itself

def test_reasoning_models_get_the_configured_ceiling():
    params = main.openai_sampling_params("gpt-5.5")

    assert params == {"max_completion_tokens": main.OPENAI_MAX_COMPLETION_TOKENS}


def test_ceiling_clears_a_measured_dense_voucher_with_room_to_spare():
    """A real 11-row voucher measured 5,258 completion tokens, 4,606 of them
    reasoning. The old ceiling of 8,000 sat only 1.5x above that, which is what
    made a slightly denser page fail."""
    measured_dense_voucher = 5258

    assert main.OPENAI_MAX_COMPLETION_TOKENS >= measured_dense_voucher * 4


def test_non_reasoning_models_keep_their_own_parameter_names():
    """gpt-4o rejects max_completion_tokens, and accepts a temperature that the
    gpt-5 family refuses."""
    params = main.openai_sampling_params("gpt-4o")

    assert "max_completion_tokens" not in params
    assert params["max_tokens"] == 3000
    assert params["temperature"] == 0
