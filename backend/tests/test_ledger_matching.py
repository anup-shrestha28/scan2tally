"""Which ledger a handwritten name resolves to.

This is the rule that decides where money is posted. A wrong Exact match sends a
voucher to the wrong account with a tick beside it; a wrong Unmatched sends a
duplicate account into the client's Tally. Both are silent, so both are tested.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ledger_matching as lm


CHART = [
    {"id": "freight", "name": "Freight Outward", "aliases": [], "is_active": True},
    {"id": "carriage-t", "name": "Carriage Outward - Transportation", "aliases": [], "is_active": True},
    {"id": "carriage-l", "name": "Carriage Outward - Labour", "aliases": [], "is_active": True},
    {"id": "tds", "name": "TDS Payable", "aliases": ["TDS", "T.D.S."], "is_active": True},
    {"id": "vat", "name": "VAT Payable", "aliases": [], "is_active": True},
    {"id": "bank", "name": "Bank Account", "aliases": ["Bank A/c", "bank ac"], "is_active": True},
    {"id": "retired", "name": "Old Suspense", "aliases": [], "is_active": False},
]


@pytest.fixture
def index():
    return lm.build_index(CHART)


# ------------------------------------------------------------------ match_key

@pytest.mark.parametrize("written, expected", [
    ("TDS Payable", "tdspayable"),
    ("tds-payable", "tdspayable"),
    ("T.D.S. PAYABLE", "tdspayable"),
    ("  Freight   Outward  ", "freightoutward"),
    ("Carriage Outward - Labour", "carriageoutwardlabour"),
    ("", ""),
    (None, ""),
])
def test_match_key_collapses_the_ways_one_name_gets_written(written, expected):
    assert lm.match_key(written) == expected


# ------------------------------------------------------------------ certain matches

@pytest.mark.parametrize("written", [
    "Freight Outward", "freight outward", "FREIGHT-OUTWARD", "  Freight.Outward  ",
])
def test_spelling_variations_are_an_exact_match(written, index):
    result = lm.match_ledger(written, index)
    assert result["ledger_match"] == lm.EXACT
    assert result["ledger_id"] == "freight"
    # The canonical spelling replaces what was written; that is the whole point.
    assert result["ledger_name"] == "Freight Outward"


def test_a_registered_alias_resolves_to_the_real_ledger(index):
    result = lm.match_ledger("Bank A/c", index)
    assert result["ledger_match"] == lm.ALIAS
    assert result["ledger_id"] == "bank"
    assert result["ledger_name"] == "Bank Account"


def test_alias_matching_ignores_punctuation_too(index):
    assert lm.match_ledger("bank-ac", index)["ledger_id"] == "bank"


# ------------------------------------------------------------------ suggestions

def test_a_misspelling_is_suggested_but_never_applied(index):
    result = lm.match_ledger("Frieght Outward", index)
    assert result["ledger_match"] == lm.SUGGESTED
    assert result["ledger_id"] == "freight"
    # Critical: the name is left exactly as written. Rewriting it would post
    # money to an account nobody chose, and would look identical to a certainty.
    assert result["ledger_name"] == "Frieght Outward"
    assert result["score"] >= lm.SUGGESTION_THRESHOLD


def test_reordered_words_are_suggested(index):
    result = lm.match_ledger("Outward Freight", index)
    assert result["ledger_match"] == lm.SUGGESTED
    assert result["ledger_id"] == "freight"


def test_a_near_miss_picks_the_closer_of_two_similar_ledgers(index):
    # Two ledgers share "Carriage Outward"; only the tail distinguishes them.
    result = lm.match_ledger("Carriage Outward - Labor", index)
    assert result["ledger_id"] == "carriage-l"


# ------------------------------------------------------------------ refusals

def test_two_ledgers_sharing_a_word_are_not_confused(index):
    """The failure that would matter most: posting VAT to the TDS account."""
    result = lm.match_ledger("VAT Payable", index)
    assert result["ledger_match"] == lm.EXACT
    assert result["ledger_id"] == "vat"


def test_a_genuinely_unknown_name_is_reported_not_guessed(index):
    result = lm.match_ledger("Krishna Transport", index)
    assert result["ledger_match"] == lm.UNMATCHED
    assert result["ledger_id"] is None
    assert result["ledger_name"] == "Krishna Transport"


def test_a_retired_ledger_stops_being_matched(index):
    """Retiring a ledger is exactly a statement that new vouchers should not use it."""
    result = lm.match_ledger("Old Suspense", index)
    assert result["ledger_match"] == lm.UNMATCHED
    assert result["ledger_id"] is None


def test_an_empty_name_matches_nothing(index):
    assert lm.match_ledger("", index)["ledger_match"] == lm.UNMATCHED
    assert lm.match_ledger("   ", index)["ledger_match"] == lm.UNMATCHED


# ------------------------------------------------------------------ no chart of accounts

def test_without_a_chart_of_accounts_nothing_is_flagged():
    """An organisation that has not entered its ledgers must not see a flag on
    every row of every voucher — that is how people learn to ignore flags."""
    result = lm.match_ledger("Anything At All", [])
    assert result["ledger_match"] == lm.UNCHECKED
    assert result["ledger_id"] is None
    assert result["ledger_name"] == "Anything At All"


def test_no_chart_of_accounts_produces_no_warnings():
    rows = [{"ledger_name": "Something Unknown"}]
    assert lm.apply_to_rows(rows, []) == []
    assert rows[0]["ledger_match"] == lm.UNCHECKED


# ------------------------------------------------------------------ applying to a voucher

def test_apply_to_rows_fills_in_every_row():
    rows = [
        {"ledger_name": "freight outward"},
        {"ledger_name": "Bank A/c"},
        {"ledger_name": "Krishna Transport"},
    ]
    notes = lm.apply_to_rows(rows, CHART)

    assert [r["ledger_match"] for r in rows] == [lm.EXACT, lm.ALIAS, lm.UNMATCHED]
    assert [r["ledger_name"] for r in rows] == [
        "Freight Outward", "Bank Account", "Krishna Transport"
    ]
    assert [r["ledger_id"] for r in rows] == ["freight", "bank", None]
    assert [r["ledger_match_score"] for r in rows] == [1.0, 1.0, None]

    # The reviewer has to be told, in a way that names what to look at.
    assert len(notes) == 1
    assert "Krishna Transport" in notes[0]
    assert "1 ledger name is" in notes[0]


def test_apply_to_rows_reports_suggestions_separately_from_unknowns():
    rows = [{"ledger_name": "Frieght Outward"}, {"ledger_name": "Nobody Ltd"}]
    notes = lm.apply_to_rows(rows, CHART)

    assert len(notes) == 2
    unmatched_note = next(n for n in notes if "Nobody Ltd" in n)
    suggested_note = next(n for n in notes if "Frieght Outward" in n)
    assert "not in your chart of accounts" in unmatched_note
    assert "confirm" in suggested_note


def test_a_voucher_that_fully_resolves_says_nothing():
    rows = [{"ledger_name": "Freight Outward"}, {"ledger_name": "TDS"}]
    assert lm.apply_to_rows(rows, CHART) == []


def test_the_same_unknown_name_twice_is_reported_once():
    rows = [{"ledger_name": "Nobody Ltd"}, {"ledger_name": "Nobody Ltd"}]
    notes = lm.apply_to_rows(rows, CHART)
    assert notes[0].count("Nobody Ltd") == 1


def test_a_long_list_of_unknowns_does_not_become_a_wall_of_text():
    rows = [{"ledger_name": f"Unknown Vendor {i}"} for i in range(12)]
    notes = lm.apply_to_rows(rows, CHART)
    assert "and 8 more" in notes[0]
