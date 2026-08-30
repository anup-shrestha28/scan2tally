"""What actually gets uploaded to the vision provider, and what it costs.

The extraction pipeline sends the same voucher to OCR_CONSENSUS_RUNS+1 requests
at once. Every byte and every CPU cycle spent turning one image into a request
payload is therefore spent that many times over, which is how an invisible
detail in an SDK became the slowest part of reading a receipt:

  google-generativeai's `_pil_to_blob` does not upload a PIL Image. It
  re-encodes it as LOSSLESS WebP first. On a 4032x3024 phone photo that measured
  ~7s of CPU and turned 3MB into 8MB — per request, four times per receipt, on a
  512MB shared-CPU instance.

These tests pin the two properties that fix depends on: nothing hands a PIL
Image to the SDK any more, and the image is sized once and shared. They also pin
the correctness constraints that a resize could quietly break — EXIF rotation,
transparency, and never failing an extraction over an optimisation.
"""

import asyncio
import io
import os
import sys
import types

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


# ----------------------------------------------------------------- fixtures

def photo(width=4032, height=3024, *, orientation=None, mode="RGB", fmt="JPEG"):
    """An image the way a camera or scanner would hand it over."""
    image = Image.new(mode, (width, height), "white" if mode != "RGBA" else (255, 255, 255, 255))
    # Some ink, so the encoders have real content to chew on.
    for y in range(0, height, max(1, height // 12)):
        for x in range(0, width, 3):
            image.putpixel((x, y), (0, 0, 0) if mode == "RGB" else tuple([0] * len(image.getbands())))
    buffer = io.BytesIO()
    save_kwargs = {}
    if fmt == "JPEG":
        save_kwargs["quality"] = 90
        if orientation is not None:
            exif = Image.Exif()
            exif[274] = orientation
            save_kwargs["exif"] = exif
    image.save(buffer, format=fmt, **save_kwargs)
    return buffer.getvalue()


@pytest.fixture
def quiet(monkeypatch):
    """Silences the log so a failing assertion is the only output."""
    monkeypatch.setattr(main, "log", lambda *parts: None)


@pytest.fixture
def gemini(monkeypatch):
    """Captures what `_gemini_vision_json` hands the SDK, against a canned reply."""
    captured = {}

    def install(text):
        def generate_content(*, model, contents, config):
            captured["model"] = model
            captured["contents"] = contents
            captured["config"] = config
            return types.SimpleNamespace(
                candidates=[types.SimpleNamespace(
                    finish_reason=types.SimpleNamespace(name="STOP")
                )],
                text=text,
            )

        monkeypatch.setattr(
            main, "genai_client",
            types.SimpleNamespace(
                models=types.SimpleNamespace(generate_content=generate_content)
            ),
        )
        return captured

    return install


# ------------------------------------------------- the SDK never sees a PIL Image

def test_gemini_is_handed_bytes_and_never_a_pil_image(gemini, quiet):
    """The regression itself: a PIL Image argument costs a lossless WebP encode.

    Asserting on the *type* rather than on timing is deliberate. A duration
    assertion would be flaky on shared CI; the type is the actual defect, and it
    cannot come back without this failing.
    """
    captured = gemini('{"transactions": []}')
    raw = photo(800, 600)

    main.gemini_transcribe(raw, "image/jpeg")

    prompt_part, image_part = captured["contents"]
    assert prompt_part.text
    assert not isinstance(image_part, Image.Image), (
        "a PIL Image here makes the SDK re-encode to lossless WebP on every call"
    )
    assert image_part.inline_data.data == raw, "the original bytes, not a re-encode"


def test_the_totals_request_uses_the_same_shape(gemini, quiet):
    """Both Gemini entry points must benefit; the totals call is one of the four."""
    captured = gemini('{"stated_total_debit": 1.0}')
    raw = photo(800, 600)

    assert main.gemini_read_totals(raw, "image/jpeg") == {"stated_total_debit": 1.0}
    assert not isinstance(captured["contents"][1], Image.Image)


def test_the_declared_media_type_reaches_the_provider(gemini, quiet):
    """A PNG must not be announced as a JPEG; the provider decodes by this field."""
    captured = gemini('{"transactions": []}')

    main.gemini_transcribe(b"\x89PNG fake", "image/png")

    assert captured["contents"][1].inline_data.mime_type == "image/png"


def test_the_request_asks_for_reduced_thinking(gemini, quiet):
    """The largest single lever on how long a receipt takes.

    Reading a voucher is perception, not reasoning, and the deliberation was
    measured at 26.3s per pass against 6.0s with it turned down.
    """
    captured = gemini('{"transactions": []}')

    main.gemini_transcribe(photo(800, 600), "image/jpeg")

    thinking = captured["config"].thinking_config
    assert thinking is not None, "no thinking config means the model decides, slowly"
    assert str(thinking.thinking_level).upper().endswith("LOW")


def test_thinking_can_be_handed_back_to_the_model(gemini, monkeypatch, quiet):
    """An escape hatch, in case a voucher genuinely needs more deliberation."""
    monkeypatch.setattr(main, "GEMINI_THINKING_LEVEL", "default")
    captured = gemini('{"transactions": []}')

    main.gemini_transcribe(photo(800, 600), "image/jpeg")

    assert captured["config"].thinking_config is None


def test_a_higher_thinking_level_is_passed_through(gemini, monkeypatch, quiet):
    monkeypatch.setattr(main, "GEMINI_THINKING_LEVEL", "high")
    captured = gemini('{"transactions": []}')

    main.gemini_transcribe(photo(800, 600), "image/jpeg")

    assert str(captured["config"].thinking_config.thinking_level).upper().endswith("HIGH")


def test_function_calling_is_disabled(gemini, quiet):
    """No tools are declared, so leaving it on only costs a warning and a scan."""
    captured = gemini('{"transactions": []}')

    main.gemini_transcribe(photo(800, 600), "image/jpeg")

    assert captured["config"].automatic_function_calling.disable is True


def test_a_truncated_response_is_not_mistaken_for_an_unreadable_voucher(monkeypatch, quiet):
    """Same contract as before the SDK change: MAX_TOKENS raises, it never
    silently reads as "there is nothing on this page"."""
    def generate_content(*, model, contents, config):
        return types.SimpleNamespace(
            candidates=[types.SimpleNamespace(
                finish_reason=types.SimpleNamespace(name="MAX_TOKENS")
            )],
            text="",
        )

    monkeypatch.setattr(
        main, "genai_client",
        types.SimpleNamespace(
            models=types.SimpleNamespace(generate_content=generate_content)
        ),
    )

    with pytest.raises(main.VisionResponseTruncated):
        main.gemini_transcribe(photo(800, 600), "image/jpeg")


def test_an_empty_response_reads_as_nothing_found_rather_than_an_error(gemini, quiet):
    gemini(None)

    assert main.gemini_transcribe(photo(800, 600), "image/jpeg") == []


def test_a_markdown_fenced_response_is_still_parsed(gemini, quiet):
    """Gemini sometimes fences the JSON despite the JSON response type."""
    gemini('```json\n{"transactions": [{"ledger_name": "Cash"}]}\n```')

    rows = main.gemini_transcribe(photo(800, 600), "image/jpeg")

    assert [r["ledger_name"] for r in rows] == ["Cash"]


# --------------------------------------------------------------- the resize

def test_an_oversized_photo_is_reduced_to_the_ceiling(monkeypatch, quiet):
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)

    prepared, media_type = main.prepare_vision_image(photo(4032, 3024), "image/jpeg")

    assert media_type == "image/jpeg"
    assert max(Image.open(io.BytesIO(prepared)).size) == 2200


def test_the_aspect_ratio_survives_the_resize(monkeypatch, quiet):
    """A stretched voucher reads worse, not faster."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)

    prepared, _ = main.prepare_vision_image(photo(4032, 3024), "image/jpeg")

    width, height = Image.open(io.BytesIO(prepared)).size
    assert abs((width / height) - (4032 / 3024)) < 0.01


def test_an_image_already_within_the_ceiling_is_passed_through_untouched(monkeypatch, quiet):
    """Re-encoding a small image could only lose detail, so it must not happen."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    raw = photo(1600, 1200)

    prepared, media_type = main.prepare_vision_image(raw, "image/jpeg")

    assert prepared is raw, "an in-budget image must be handed over byte-for-byte"
    assert media_type == "image/jpeg"


def test_the_resize_can_be_switched_off(monkeypatch, quiet):
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 0)
    raw = photo(4032, 3024)

    prepared, _ = main.prepare_vision_image(raw, "image/jpeg")

    assert prepared is raw


def test_the_resize_actually_shrinks_the_upload(monkeypatch, quiet):
    """The point of the exercise, stated as a property rather than a duration."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    raw = photo(4032, 3024)

    prepared, _ = main.prepare_vision_image(raw, "image/jpeg")

    assert len(prepared) < len(raw)


# ----------------------------------------------------- correctness of the resize

@pytest.mark.parametrize("orientation", [3, 6, 8])
def test_a_rotated_photo_arrives_upright(monkeypatch, quiet, orientation):
    """Phones store rotation as a tag, and re-encoding drops the tag.

    So the rotation has to be applied to the pixels here. Without this the model
    is asked to read a voucher lying on its side.
    """
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    # Stored landscape; the tag says it should be displayed portrait.
    raw = photo(4032, 3024, orientation=orientation)

    prepared, _ = main.prepare_vision_image(raw, "image/jpeg")

    width, height = Image.open(io.BytesIO(prepared)).size
    if orientation in (6, 8):
        assert height > width, "a quarter-turn tag must leave the pixels portrait"
    else:
        assert width > height, "a half-turn tag must leave the pixels landscape"


def test_a_small_but_rotated_photo_is_still_straightened(monkeypatch, quiet):
    """Being within the size ceiling is no reason to leave it sideways."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    raw = photo(1600, 1200, orientation=6)

    prepared, _ = main.prepare_vision_image(raw, "image/jpeg")

    assert prepared is not raw
    width, height = Image.open(io.BytesIO(prepared)).size
    assert height > width


def test_an_upright_photo_is_not_re_encoded_just_for_having_a_tag(monkeypatch, quiet):
    """Orientation 1 means "already upright" and must not trigger a re-encode."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    raw = photo(1600, 1200, orientation=1)

    prepared, _ = main.prepare_vision_image(raw, "image/jpeg")

    assert prepared is raw


def test_transparency_is_flattened_onto_white_not_black(monkeypatch, quiet):
    """`convert("RGB")` drops the alpha channel and keeps whatever was under it.

    Transparent pixels are conventionally stored as transparent BLACK, so simply
    dropping alpha turns a scan's clear margin into a black one and the voucher
    into white-on-black. The colour under the alpha is set to black here for
    exactly that reason — a transparent *white* would pass either way and prove
    nothing.
    """
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 1000)
    transparent = Image.new("RGBA", (2400, 1800), (0, 0, 0, 0))
    buffer = io.BytesIO()
    transparent.save(buffer, format="PNG")

    prepared, media_type = main.prepare_vision_image(buffer.getvalue(), "image/png")

    assert media_type == "image/jpeg"
    corner = Image.open(io.BytesIO(prepared)).convert("RGB").getpixel((5, 5))
    assert min(corner) > 200, f"transparent margin came out dark: {corner}"


def test_a_greyscale_scan_is_handled(monkeypatch, quiet):
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 1000)
    grey = Image.new("L", (2400, 1800), 220)
    buffer = io.BytesIO()
    grey.save(buffer, format="PNG")

    prepared, media_type = main.prepare_vision_image(buffer.getvalue(), "image/png")

    assert media_type == "image/jpeg"
    assert max(Image.open(io.BytesIO(prepared)).size) == 1000


# ------------------------------------------------- it can never break extraction

def test_undecodable_bytes_are_passed_through_rather_than_raising(monkeypatch, quiet):
    """A file PIL cannot read is the provider's problem to report, not a crash here."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    junk = b"this is not an image at all"

    prepared, media_type = main.prepare_vision_image(junk, "image/jpeg")

    assert prepared is junk
    assert media_type == "image/jpeg"


def test_a_failure_inside_the_encoder_is_swallowed(monkeypatch, quiet):
    """Whatever goes wrong in here, the receipt still gets read."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)

    def explode(*args, **kwargs):
        raise MemoryError("no room to resize")

    monkeypatch.setattr(main.Image, "open", explode)
    raw = photo(4032, 3024)

    prepared, media_type = main.prepare_vision_image(raw, "image/jpeg")

    assert prepared is raw
    assert media_type == "image/jpeg"


def test_a_pdf_is_left_entirely_alone(monkeypatch, quiet):
    """Only raster images are ours to resize; a PDF must reach the provider intact."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 2200)
    pdf = b"%PDF-1.4 not really a pdf but not an image either"

    prepared, media_type = main.prepare_vision_image(pdf, "application/pdf")

    assert prepared is pdf
    assert media_type == "application/pdf"


def test_a_vaguely_typed_image_is_still_labelled_as_an_image(monkeypatch, quiet):
    """Storage sometimes reports a generic type for a perfectly good JPEG.

    Passing that string through would have the provider reject a readable image,
    so anything that is not a PDF is announced as an image — which is what the
    callers themselves did before this function existed.
    """
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 0)
    raw = photo(800, 600)

    prepared, media_type = main.prepare_vision_image(raw, "application/octet-stream")

    assert prepared is raw
    assert media_type == "image/jpeg"


def test_a_vaguely_typed_oversized_image_is_still_resized(monkeypatch, quiet):
    """PIL reads the format from the bytes, so a vague label must not skip the resize."""
    monkeypatch.setattr(main, "VISION_IMAGE_MAX_EDGE", 1200)

    prepared, media_type = main.prepare_vision_image(
        photo(4032, 3024), "application/octet-stream"
    )

    assert media_type == "image/jpeg"
    assert max(Image.open(io.BytesIO(prepared)).size) == 1200


# --------------------------------------------- prepared once, shared by all calls

def test_every_concurrent_pass_shares_one_prepared_image(monkeypatch, quiet):
    """The whole saving depends on this: resize once, not once per request.

    Four requests each preparing their own copy would restore exactly the cost
    this change removed, so the count is asserted rather than assumed.
    """
    monkeypatch.setattr(main, "openai_available", False)
    monkeypatch.setattr(main, "genai_available", True)
    monkeypatch.setattr(main, "OCR_CONSENSUS_RUNS", 3)
    # The pencil locator is a live network call and must never run in a unit
    # test. It shares the same prepared bytes, which the assertion covers.
    monkeypatch.setattr(main, "gemini_locate_pencil", lambda b, m: [])

    prepares = []
    real_prepare = main.prepare_vision_image

    def counting_prepare(raw_bytes, content_type):
        prepares.append(content_type)
        return real_prepare(raw_bytes, content_type)

    monkeypatch.setattr(main, "prepare_vision_image", counting_prepare)

    handed = []

    def fake_transcribe(image_bytes, media_type):
        handed.append(image_bytes)
        return [{"ledger_name": "Cash", "entry_type": "Dr", "debit_amount": 5.0, "credit_amount": 0}]

    def fake_totals(image_bytes, media_type):
        handed.append(image_bytes)
        return {"stated_total_debit": 5.0, "stated_total_credit": 5.0}

    monkeypatch.setattr(main, "gemini_transcribe", fake_transcribe)
    monkeypatch.setattr(main, "gemini_read_totals", fake_totals)

    result = asyncio.run(
        main.run_extraction(photo(4032, 3024), "image/jpeg", "voucher.jpg")
    )

    assert result["status"] == "Extracted"
    assert len(prepares) == 1, f"the image was prepared {len(prepares)} times, expected once"
    assert len(handed) == 4, "3 transcription passes plus the totals read"
    assert all(payload is handed[0] for payload in handed), (
        "every pass must receive the identical prepared buffer"
    )
