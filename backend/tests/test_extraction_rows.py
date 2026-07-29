"""Turning model output into rows the transactions table will accept.

Everything here is about money landing on the correct side of a voucher. The
CHECK constraint catches a row with amounts on both sides, but nothing in the
database catches a figure that quietly ends up on the wrong one — it balances,
it imports, and it is wrong. That is what these tests are for.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


IDS = dict(
    receipt_id="r-1",
    batch_id="b-1",
    organization_id="o-1",
    updated_by="u-1",
)


# ------------------------------------------------------------------ number coercion

@pytest.mark.parametrize("value, expected", [
    (1237.35, 1237.35),
    (690, 690.0),
    ("1237.35", 1237.35),
    # Models routinely return grouped strings; reading this as 14 would be a
    # thousand-fold error that still looks like a plausible amount.
    ("14,408.35", 14408.35),
    ("  1,020.23  ", 1020.23),
    (None, 0.0),
    ("", 0.0),
    ("not a number", 0.0),
    ({}, 0.0),
])
def test_amounts_are_read_tolerantly(value, expected):
    assert main._to_float(value) == expected


# ------------------------------------------------------------------ row normalisation

def test_a_well_formed_row_survives_intact():
    rows = main.normalize_transaction_rows([{
        "voucher_date": "2083-03-15",
        "voucher_type": "Journal",
        "entry_type": "Dr",
        "ledger_name": "Freight outward",
        "debit_amount": 1237.35,
        "credit_amount": 0,
        "narration": "(Being Expenses Recorded)",
    }], **IDS)

    assert len(rows) == 1
    row = rows[0]
    assert row["entry_type"] == "Dr"
    assert row["debit_amount"] == 1237.35
    assert row["credit_amount"] == 0
    assert row["ledger_name"] == "Freight outward"
    assert row["position"] == 0
    assert row["receipt_id"] == "r-1"
    assert row["organization_id"] == "o-1"


def test_the_unused_side_is_exactly_zero():
    """The transactions_single_sided CHECK rejects anything else, so a credit row
    carrying a stray debit figure would lose the whole voucher."""
    rows = main.normalize_transaction_rows([{
        "entry_type": "Cr",
        "ledger_name": "TDS payable",
        # A model that reports both sides on one row is not unheard of.
        "debit_amount": 99.0,
        "credit_amount": 16.42,
    }], **IDS)

    assert rows[0]["credit_amount"] == 16.42
    assert rows[0]["debit_amount"] == 0


def test_a_flat_amount_lands_on_the_side_the_row_declares():
    debit = main.normalize_transaction_rows(
        [{"entry_type": "Dr", "ledger_name": "X", "amount": 500}], **IDS)[0]
    credit = main.normalize_transaction_rows(
        [{"entry_type": "Cr", "ledger_name": "Y", "amount": 500}], **IDS)[0]

    assert (debit["debit_amount"], debit["credit_amount"]) == (500, 0)
    assert (credit["credit_amount"], credit["debit_amount"]) == (500, 0)


def test_a_missing_side_is_inferred_from_where_the_money_is():
    rows = main.normalize_transaction_rows([
        {"ledger_name": "A", "debit_amount": 100},
        {"ledger_name": "B", "credit_amount": 100},
    ], **IDS)

    assert rows[0]["entry_type"] == "Dr"
    assert rows[1]["entry_type"] == "Cr"


def test_an_unrecognised_side_is_not_trusted():
    row = main.normalize_transaction_rows(
        [{"entry_type": "Debit", "ledger_name": "A", "debit_amount": 100}], **IDS)[0]
    assert row["entry_type"] == "Dr"
    assert row["debit_amount"] == 100


def test_legacy_ledger_fields_are_still_understood():
    debit = main.normalize_transaction_rows(
        [{"entry_type": "Dr", "debit_ledger": "Old Debit Name", "debit_amount": 10}], **IDS)[0]
    credit = main.normalize_transaction_rows(
        [{"entry_type": "Cr", "credit_ledger": "Old Credit Name", "credit_amount": 10}], **IDS)[0]

    assert debit["ledger_name"] == "Old Debit Name"
    assert credit["ledger_name"] == "Old Credit Name"


def test_row_order_is_preserved():
    """A voucher read out of order is a voucher nobody can check against the paper."""
    rows = main.normalize_transaction_rows(
        [{"ledger_name": n, "debit_amount": 1} for n in "ABCDE"], **IDS)
    assert [r["position"] for r in rows] == [0, 1, 2, 3, 4]
    assert [r["ledger_name"] for r in rows] == list("ABCDE")


def test_an_uncertain_amount_stays_flagged():
    rows = main.normalize_transaction_rows(
        [{"ledger_name": "A", "debit_amount": 1, "needs_review": True}], **IDS)
    assert rows[0]["needs_review"] is True


def test_the_original_reading_is_kept_for_audit():
    original = {"entry_type": "Dr", "ledger_name": "A", "debit_amount": "1,000.00"}
    rows = main.normalize_transaction_rows([original], **IDS)
    assert rows[0]["raw_extracted_data"] == original


def test_an_empty_extraction_produces_no_rows():
    assert main.normalize_transaction_rows([], **IDS) == []


# ------------------------------------------------------------------ reconciliation

def test_a_voucher_that_reconciles_raises_nothing():
    transactions = [
        {"debit_amount": 1237.35, "credit_amount": 0},
        {"debit_amount": 13171.00, "credit_amount": 0},
        {"debit_amount": 0, "credit_amount": 14408.35},
    ]
    result = main.verify_against_stated_totals(
        transactions, {"debit": 14408.35, "credit": 14408.35})

    assert result["balanced"] is True
    assert result["reconciles"] is True
    assert result["warnings"] == []


def test_an_unbalanced_voucher_is_reported():
    result = main.verify_against_stated_totals(
        [{"debit_amount": 100, "credit_amount": 0}], {})
    assert result["balanced"] is False
    assert any("does not equal" in w for w in result["warnings"])


def test_a_misread_row_is_caught_against_the_printed_total():
    """The voucher states 14,408.35 but the rows sum to less: one cell was misread."""
    transactions = [
        {"debit_amount": 1237.35, "credit_amount": 0},
        {"debit_amount": 12171.00, "credit_amount": 0},
        {"debit_amount": 0, "credit_amount": 13408.35},
    ]
    result = main.verify_against_stated_totals(
        transactions, {"debit": 14408.35, "credit": 14408.35})

    assert result["reconciles"] is False
    assert any("जम्मा" in w for w in result["warnings"])


def test_without_a_stated_total_no_claim_is_made():
    """Silence about the voucher's own total must not read as agreement with it."""
    result = main.verify_against_stated_totals(
        [{"debit_amount": 100, "credit_amount": 0}, {"debit_amount": 0, "credit_amount": 100}], {})
    assert result["checked_against_voucher"] is False
    assert result["reconciles"] is None


def test_reconciliation_never_rewrites_an_amount():
    transactions = [{"debit_amount": 100, "credit_amount": 0}]
    main.verify_against_stated_totals(transactions, {"debit": 999})
    assert transactions[0]["debit_amount"] == 100


# ------------------------------------------------------------------ consensus across runs

def _row(ledger, amount, side="Dr"):
    return {
        "entry_type": side, "ledger_name": ledger,
        "debit_amount": amount if side == "Dr" else 0,
        "credit_amount": amount if side == "Cr" else 0,
    }


def test_runs_that_agree_produce_an_unflagged_reading():
    run = [_row("Freight", 1237.35), _row("Bank", 1237.35, "Cr")]
    merged, notes = main.build_consensus([run, list(run), list(run)])

    assert notes == []
    assert [r.get("needs_review") for r in merged] == [None, None]
    assert merged[0]["debit_amount"] == 1237.35


def test_a_cell_the_model_cannot_read_is_flagged_not_averaged():
    """Two runs say 690.00, one says 690.12. The majority is used as a starting
    point, but presenting it as verified is what the flag exists to prevent."""
    merged, notes = main.build_consensus([
        [_row("VAT payable", 690.00)],
        [_row("VAT payable", 690.12)],
        [_row("VAT payable", 690.00)],
    ])

    assert merged[0]["debit_amount"] == 690.00
    assert merged[0]["needs_review"] is True
    assert len(notes) == 1
    assert "690.00" in notes[0] and "690.12" in notes[0]


def test_runs_disagreeing_on_row_count_take_the_common_shape_and_say_so():
    two_rows = [_row("A", 10), _row("B", 10, "Cr")]
    merged, notes = main.build_consensus([two_rows, list(two_rows), [_row("A", 10)]])

    assert len(merged) == 2
    assert any("how many rows" in n for n in notes)


def test_a_single_run_cannot_disagree_with_itself():
    merged, notes = main.build_consensus([[_row("A", 10)]])
    assert notes == []
    assert merged[0].get("needs_review") is not True


def test_no_transcripts_is_not_a_crash():
    assert main.build_consensus([]) == ([], [])
