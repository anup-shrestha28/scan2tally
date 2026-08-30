"""Pencil on a voucher must never reach the extracted data.

Vouchers arrive with notes scribbled in pencil — expense clarifications under a
ledger name, running sums in a margin. The client's requirement is that none of
it appears in the extraction.

Measured before deciding where to enforce this: on the client's real photos, no
pixel statistic separates graphite from ballpoint. Pencil strokes in good light
sit at the same intensities as pen-stroke edges (median 130 vs edges to 150 of
255), local stroke contrast differs by ~12 grey levels between pencil-in-light
and pen-in-shadow, and black ink is exactly as unsaturated as graphite. Erasing
pixels would sooner or later erase faint pen — so the exclusion lives in the
vision prompts, where the model judges by what graphite looks like in context.

That makes the prompts THE enforcement, which is why the tests below pin their
load-bearing sentences: a prompt edit that drops them turns the feature off with
no compiler or test noticing otherwise. The observed failure mode is also pinned
— the model merging an inline pencil note into the ink ledger name above it
("Office Supplies (Gluestick)"), which is how pencil leaked 6 times out of 9 on
real photos before the rule addressed merging explicitly.
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


def tiny_jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def quiet(monkeypatch):
    monkeypatch.setattr(main, "log", lambda *parts: None)


# ------------------------------------------------- the prompts ARE the feature

def test_the_transcription_prompt_forbids_pencil_content():
    prompt = main.TRANSCRIBE_PROMPT
    assert "PENCIL" in prompt
    # The exact failure seen on real vouchers: an inline pencil note merged
    # into the ink ledger name. The rule must forbid the merge by name.
    assert "merged into the ledger name" in prompt
    assert "EMPTY cell" in prompt
    assert "never amounts, totals, dates or voucher numbers" in prompt
    # ...and must equally protect faint INK from being over-excluded.
    assert "never drop a" in prompt and "faint ink" in prompt


def test_the_totals_prompt_forbids_pencil_and_asks_for_the_flag():
    # Collapsed to single spaces: the sentences pinned here must survive
    # re-wrapping, which is a formatting choice and not a meaning change.
    prompt = " ".join(main.TOTALS_PROMPT.split())
    assert "PENCIL" in prompt
    assert "has_pencil_marks" in prompt
    # The flag must not become a channel that re-surfaces the hidden content.
    assert "Do NOT transcribe or describe the pencil content" in prompt


# ------------------------------------------------------------- flag parsing

def test_the_pencil_flag_parses_only_real_booleans():
    assert main.read_pencil_flag({"has_pencil_marks": True}) is True
    assert main.read_pencil_flag({"has_pencil_marks": False}) is False
    assert main.read_pencil_flag({}) is None
    assert main.read_pencil_flag({"has_pencil_marks": "yes"}) is None
    assert main.read_pencil_flag({"has_pencil_marks": 1}) is None


def test_the_note_names_the_fact_and_never_the_content():
    """The point of the exclusion is that pencil text stays hidden; a note that
    quoted what was ignored would re-surface it. So the note is one fixed
    sentence with nothing dynamic in it."""
    assert "pencil" in main.PENCIL_MARKS_IGNORED_NOTE.lower()
    assert "{" not in main.PENCIL_MARKS_IGNORED_NOTE
    assert "%s" not in main.PENCIL_MARKS_IGNORED_NOTE


# ------------------------------------------- the note reaches the reviewer

def run_extraction_with(monkeypatch, totals: dict, locate=lambda b, m: []) -> dict:
    monkeypatch.setattr(main, "openai_available", False)
    monkeypatch.setattr(main, "genai_available", True)
    monkeypatch.setattr(main, "OCR_CONSENSUS_RUNS", 1)
    monkeypatch.setattr(main, "gemini_transcribe", lambda b, m: [{
        "entry_type": "Dr", "ledger_name": "Office Supplies",
        "debit_amount": 395.0, "credit_amount": 0,
        "voucher_date": "2083-04-04",
        "narration": "Being Expenses Paid via Cash",
    }])
    monkeypatch.setattr(main, "gemini_read_totals", lambda b, m: totals)
    monkeypatch.setattr(main, "gemini_locate_pencil", locate)
    return asyncio.run(main.run_extraction(tiny_jpeg(), "image/jpeg", "voucher.jpg"))


BALANCED = {"stated_total_debit": 395.0, "stated_total_credit": 395.0}


def test_detected_pencil_is_reported_beside_the_rows(monkeypatch, quiet):
    """Without the note, the operator sees pencil words on the photo, finds no
    matching row, concludes the OCR missed them, and types the hidden content
    back in by hand — defeating the exclusion at the last step."""
    result = run_extraction_with(monkeypatch, {**BALANCED, "has_pencil_marks": True})

    assert result["status"] == "Extracted"
    assert main.PENCIL_MARKS_IGNORED_NOTE in result["verification"]["warnings"]


def test_a_pencil_free_voucher_gets_no_note(monkeypatch, quiet):
    result = run_extraction_with(monkeypatch, {**BALANCED, "has_pencil_marks": False})

    assert main.PENCIL_MARKS_IGNORED_NOTE not in result["verification"]["warnings"]


# ---------------------------------------------- where the pencil physically is

def test_located_notes_travel_with_the_result_as_boxes(monkeypatch, quiet):
    note = [100, 200, 140, 380]
    result = run_extraction_with(
        monkeypatch, BALANCED,
        locate=lambda b, m: [{"text": "Bora", "box": note}],
    )

    # One cover, sitting where the note was. The stored box is the FITTED one,
    # so it is compared by overlap rather than by equality.
    assert len(result["pencil_regions"]) == 1
    assert main._region_iou(result["pencil_regions"][0], note) > 0.3


def test_a_note_reading_as_the_extracted_date_is_not_covered(monkeypatch, quiet):
    """THE reported bug: the locator listed the ink-written मिति date and the
    cover hid a real field. The date is extracted data, so it is ink by
    construction, and such a box must die here."""
    date_box = [212, 615, 240, 845]
    pencil_box = [400, 200, 440, 380]
    result = run_extraction_with(
        monkeypatch, BALANCED,
        locate=lambda b, m: [
            {"text": "2083-04-04", "box": date_box},
            {"text": "Bora", "box": pencil_box},
        ],
    )

    assert len(result["pencil_regions"]) == 1
    kept = result["pencil_regions"][0]
    assert main._region_iou(kept, pencil_box) > 0.3, "lost the real pencil note"
    assert main._region_iou(kept, date_box) == 0, "still covering the ink date"


def test_a_note_reading_as_an_extracted_ledger_name_is_not_covered(monkeypatch, quiet):
    result = run_extraction_with(
        monkeypatch,
        BALANCED,
        locate=lambda b, m: [{"text": "Office Supplies", "box": [300, 200, 330, 400]}],
    )

    assert result["pencil_regions"] == []


def test_a_failed_locate_costs_only_the_masking(monkeypatch, quiet):
    """The locator is display-only. A voucher must never fail to extract
    because the model could not say where the pencil is."""
    def explode(b, m):
        raise RuntimeError("pencil locator unavailable")

    result = run_extraction_with(monkeypatch, BALANCED, locate=explode)

    assert result["status"] == "Extracted"
    assert result["pencil_regions"] == []


def test_masking_switched_off_skips_the_call_entirely(monkeypatch, quiet):
    monkeypatch.setattr(main, "PENCIL_MASKING", False)
    called = []

    result = run_extraction_with(
        monkeypatch, BALANCED, locate=lambda b, m: called.append(1) or [],
    )

    assert called == []
    assert result["pencil_regions"] == []


def test_a_broken_filter_keeps_the_covers(monkeypatch, quiet):
    """Filtering exists to REMOVE covers; when it cannot run, the covers must
    stay — a visible pencil note is the one unacceptable outcome."""
    def explode(candidates, transactions, image_bytes, log):
        raise RuntimeError("filter unavailable")

    monkeypatch.setattr(main, "filter_pencil_note_candidates", explode)
    result = run_extraction_with(
        monkeypatch,
        BALANCED,
        locate=lambda b, m: [{"text": "Bora", "box": [100, 200, 140, 380]}],
    )

    assert result["status"] == "Extracted"
    assert result["pencil_regions"] == [[100, 200, 140, 380]]


# ------------------------------------------------ the false-positive filter

def test_near_duplicate_notes_from_independent_runs_fuse_to_their_union():
    """Three locate runs describing the same note must become ONE cover,
    widened to cover every version of the box, speaking with its longest
    (most completely read) text."""
    merged = main.merge_pencil_notes([
        {"text": "- Gluestick", "box": [218, 273, 237, 297]},
        {"text": "- Gluestick, Brush", "box": [216, 277, 237, 296]},
        {"text": "Gluestick", "box": [218, 274, 239, 296]},
        {"text": "Bora", "box": [500, 500, 550, 600]},
    ])
    assert merged == [
        {"text": "- Gluestick, Brush", "box": [216, 273, 239, 297]},
        {"text": "Bora", "box": [500, 500, 550, 600]},
    ]


def test_merging_never_pairs_disjoint_notes():
    notes = [
        {"text": "a1b2", "box": [0, 0, 50, 50]},
        {"text": "c3d4", "box": [500, 500, 550, 550]},
    ]
    assert main.merge_pencil_notes(notes) == notes


ROWS = [{
    "ledger_name": "Office Supplies", "narration": "Being Expenses Paid via Cash",
    "voucher_date": "2083-04-04",
}]


def filter_with(notes, image_bytes=None, rows=ROWS):
    """The kept covers. Boxes come back FITTED to the writing, so tests
    about the keep/drop decision count covers rather than compare boxes;
    the fitting itself is pinned by its own tests below."""
    return main.filter_pencil_note_candidates(
        notes, rows, image_bytes or _voucher_bytes(90), lambda m: None)


def covers(*args, **kwargs):
    return len(filter_with(*args, **kwargs))


def _voucher_bytes(stroke_value: int) -> bytes:
    """A white voucher with a few stroke lines of the given darkness inside
    the [400, 400, 600, 600] region (normalized 0-1000 of a 200x200 image)."""
    from PIL import Image as PILImage
    image = PILImage.new("L", (200, 200), 235)
    pixels = image.load()
    for row in (85, 95, 105, 115):
        for column in range(82, 118):
            pixels[column, row] = stroke_value
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


REGION = [400, 400, 600, 600]


def test_a_note_matching_nothing_extracted_stays_covered():
    assert covers([{"text": "- Photocopy", "box": REGION}]) == 1


def test_the_date_in_any_notation_is_uncovered():
    """Digit matching, not string matching: the locator reads "मिति2083-04-04",
    "2083-4-4" or plain digits depending on the run."""
    for text in ("2083-04-04", "मिति 2083-04-04.", "20830404"):
        assert filter_with([{"text": text, "box": REGION}]) == [], text


def test_amounts_and_short_numerals_never_uncover_a_note():
    """Pencil margin sums legitimately duplicate the voucher totals, and the
    pencil page numerals are single digits — neither is evidence of ink."""
    for text in ("395", "395.00", "2", "4", "12"):
        assert covers([{"text": text, "box": REGION}]) == 1, text


def test_a_note_merely_mentioning_a_ledger_word_stays_covered():
    """Containment alone is not identity: a pencil note that happens to
    contain the word "cash" is not the ink narration."""
    rows = [{"ledger_name": "Cash", "narration": "", "voucher_date": ""}]
    assert covers([{"text": "cash paid Bora", "box": REGION}], rows=rows) == 1


def test_graphite_grey_pixels_veto_even_a_text_match():
    """Strokes measurably in the graphite-grey zone are pencil no matter what
    the text matched — the pixels are the harder evidence."""
    assert covers([{"text": "Office Supplies", "box": REGION}],
                  image_bytes=_voucher_bytes(180)) == 1


def test_an_undecodable_image_still_allows_text_rejection():
    """The pixel veto is a backstop, not a requirement: matching text alone
    uncovers when there is nothing to measure."""
    kept = main.filter_pencil_note_candidates(
        [{"text": "Office Supplies", "box": REGION}], ROWS, b"not an image",
        lambda m: None)
    assert kept == []


def test_an_avalanche_of_covers_is_discarded_wholesale(quiet):
    notes = [
        {"text": f"n{index}", "box": [index * 20, 0, index * 20 + 10, 10]}
        for index in range(main.MAX_PENCIL_REGIONS + 1)
    ]
    assert filter_with(notes) == []


# ------------------------------------------- fitting the cover to the writing

def _lined_page(lines) -> "object":
    """A white page with horizontal bands of writing at the given pixel rows.

    Each entry is (top, bottom, darkness) in a 400x400 image, standing in for
    the ink ledger name / pencil note / ink ledger name stack these vouchers
    actually carry.
    """
    import numpy as np
    page = np.full((400, 400), 235, dtype=np.uint8)
    for top, bottom, value in lines:
        page[top:bottom, 60:340] = value
    return page


# An ink line, a pencil note 8px below it, another ink line 8px below that —
# the real spacing measured on the client's voucher.
STACKED = [(100, 120, 60), (128, 146, 150), (154, 174, 60)]


def test_the_cover_never_spreads_onto_the_line_above_or_below():
    page = _lined_page(STACKED)
    # The located box hugs the pencil note (128..146 of 400 -> 320..365 of 1000).
    fitted = main.tighten_pencil_region(page, [320, 150, 365, 850])
    top_px = fitted[0] / 1000 * 400
    bottom_px = fitted[2] / 1000 * 400
    assert top_px > 120, f"cover starts at {top_px}, inside the ink line above"
    assert bottom_px < 154, f"cover ends at {bottom_px}, inside the ink line below"


def test_the_cover_still_covers_the_whole_note():
    page = _lined_page(STACKED)
    fitted = main.tighten_pencil_region(page, [320, 150, 365, 850])
    assert fitted[0] / 1000 * 400 <= 128, "the top of the note is exposed"
    assert fitted[2] / 1000 * 400 >= 146, "the bottom of the note is exposed"


def test_a_box_drawn_too_tall_is_clipped_off_the_neighbouring_ink():
    """The locator sometimes returns a box that already overlaps the ink line;
    clipping to the note's own band is what saves that ink."""
    page = _lined_page(STACKED)
    # A box spanning from inside the ink line above to inside the one below.
    fitted = main.tighten_pencil_region(page, [275, 150, 415, 850])
    assert fitted[0] / 1000 * 400 > 120, "kept part of the ink line above"
    assert fitted[2] / 1000 * 400 < 154, "kept part of the ink line below"


def test_an_isolated_note_gets_its_padding():
    """With nothing nearby, the cover may spread — that room is what hides the
    faint edge of the graphite."""
    page = _lined_page([(180, 200, 150)])
    # A box hugging the note exactly (rows 180..200 of 400).
    fitted = main.tighten_pencil_region(page, [450, 150, 500, 850])
    assert fitted[0] / 1000 * 400 < 180, "no room taken above an isolated note"
    assert fitted[2] / 1000 * 400 > 200, "no room taken below an isolated note"


def test_nothing_measurable_leaves_the_box_alone():
    import numpy as np
    # A box too small to measure is returned untouched rather than guessed at.
    tiny = [320, 150, 321, 151]
    assert main.tighten_pencil_region(_lined_page(STACKED), tiny) == tiny
    # So is one on a photo too dark to tell paper from writing.
    night = np.full((400, 400), 12, dtype=np.uint8)
    box = [320, 150, 365, 850]
    assert main.tighten_pencil_region(night, box) == box
    # Blank paper gives no rows to fit against, so the box stands as located.
    blank = np.full((400, 400), 235, dtype=np.uint8)
    assert main.tighten_pencil_region(blank, box) == box


def test_fitting_runs_on_every_kept_cover(monkeypatch, quiet):
    """The fit must not be something a later edit can quietly skip."""
    seen = []

    def spy(gray, region):
        seen.append(region)
        return [1, 2, 3, 4]

    monkeypatch.setattr(main, "tighten_pencil_region", spy)
    kept = filter_with([{"text": "- Photocopy", "box": REGION}])
    assert seen == [REGION]
    assert kept == [[1, 2, 3, 4]]


def test_the_grey_ratio_measures_what_it_claims():
    import numpy as np
    from PIL import Image as PILImage
    dark = np.asarray(PILImage.open(io.BytesIO(_voucher_bytes(90))).convert("L"))
    grey = np.asarray(PILImage.open(io.BytesIO(_voucher_bytes(180))).convert("L"))
    dark_ratio = main.graphite_grey_ratio(dark, REGION)
    grey_ratio = main.graphite_grey_ratio(grey, REGION)
    assert dark_ratio is not None and dark_ratio < main.PENCIL_GREY_VETO_RATIO
    assert grey_ratio is not None and grey_ratio >= main.PENCIL_GREY_VETO_RATIO
    # Nothing measurable: a blank region and a too-small region both decline
    # to answer rather than guessing.
    blank = np.full((200, 200), 235, dtype=np.uint8)
    assert main.graphite_grey_ratio(blank, REGION) is None
    assert main.graphite_grey_ratio(dark, [0, 0, 2, 2]) is None


def test_note_sanitizing_trusts_nothing():
    ok = main.sanitize_pencil_notes
    assert ok([{"text": "Bora", "box": [140, 380, 100, 200]}]) \
        == [{"text": "Bora", "box": [100, 200, 140, 380]}]
    # A note is its box: no box, no note. Text is optional and capped.
    assert ok([{"text": "x", "box": [1, 2, 3]}, {"text": "y"}, "junk", None]) == []
    assert ok([{"box": [100, 200, 140, 380]}]) == [{"text": "", "box": [100, 200, 140, 380]}]
    long_text = "a" * 500
    assert ok([{"text": long_text, "box": [100, 200, 140, 380]}])[0]["text"] == "a" * 200
    assert ok("not a list") == []
    assert ok([{"text": "n", "box": [0, 0, 10, 10]}] * (main.MAX_PENCIL_REGIONS + 1)) == []


def test_the_locate_prompt_pins_its_contract():
    prompt = " ".join(main.PENCIL_NOTES_PROMPT.split())
    assert "PENCIL" in prompt
    assert "pencil_notes" in prompt
    assert '"text"' in prompt and '"box"' in prompt
    # The one sentence that keeps ink, print, stamps and signatures out.
    assert "Do NOT list ink handwriting, printed text, stamps or signatures." in prompt


def test_region_sanitizing_trusts_nothing():
    """Model coordinates become drawing instructions in the browser, so every
    property is re-derived rather than believed."""
    ok = main.sanitize_pencil_regions
    assert ok([[100, 200, 140, 380]]) == [[100, 200, 140, 380]]
    # Corners in the wrong order are reordered, not rejected.
    assert ok([[140, 380, 100, 200]]) == [[100, 200, 140, 380]]
    # Out-of-range values are clamped into the 0-1000 space.
    assert ok([[-50, 200, 1400, 380]]) == [[0, 200, 1000, 380]]
    # Degenerate slivers, malformed entries and non-lists disappear.
    assert ok([[100, 200, 100, 380]]) == []
    assert ok([[100, 200, 140], "junk", None, {"y": 1}]) == []
    assert ok("not a list") == []
    assert ok(None) == []
    # Floats and numeric strings still land as clamped ints.
    assert ok([[99.6, "200", 140.2, 380]]) == [[100, 200, 140, 380]]
    # An implausible avalanche of boxes is discarded wholesale.
    assert ok([[0, 0, 10, 10]] * (main.MAX_PENCIL_REGIONS + 1)) == []


def test_an_unanswered_flag_gets_no_note(monkeypatch, quiet):
    """None means the totals request never answered — that is not evidence of
    pencil, and a note on every voucher whose totals call failed would teach
    people to ignore the note."""
    result = run_extraction_with(monkeypatch, {
        "stated_total_debit": 395.0, "stated_total_credit": 395.0,
    })

    assert main.PENCIL_MARKS_IGNORED_NOTE not in result["verification"]["warnings"]
