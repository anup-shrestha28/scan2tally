"""Resolving handwritten ledger names against an organisation's chart of accounts.

A voucher is written by hand, so the name on the paper is whatever the person
holding the pen felt like: "Frieght outward", "freight-outward", "FREIGHT OUT".
Tally recognises none of those unless they match a ledger that already exists in
the company, and an unrecognised name is not a cosmetic problem — on import Tally
either rejects the voucher outright or quietly creates a SECOND ledger, splitting
one account's balance across two without anyone noticing.

So this module answers one question about one extracted name: which real ledger
does it mean? Its more important job is knowing when it cannot tell. A guess that
gets applied silently is worse than no guess, because nothing downstream will
ever question it, so only a certain match rewrites a name. Anything less comes
back as a suggestion for a person to confirm.

Deliberately free of any I/O, database or model dependency, so the rule that
decides where money is posted can be tested directly.
"""

import re
from difflib import SequenceMatcher
from typing import Iterable, List, Optional

# Match states, mirroring the `ledger_match` enum in the schema.
EXACT = "Exact"          # the name is a ledger, give or take spacing and case
ALIAS = "Alias"          # the name is a spelling the accountant registered
SUGGESTED = "Suggested"  # close to a ledger, but close is not the same as right
UNMATCHED = "Unmatched"  # checked against the chart of accounts and not found
UNCHECKED = "Unchecked"  # there was no chart of accounts to check against

# How similar a name must be before it is worth showing anyone.
#
# Tuned so that a misspelling of one ledger is offered ("Frieght outward" ->
# "Freight outward", 0.93) while two genuinely different ledgers that happen to
# share a word are not ("TDS payable" vs "VAT payable", 0.70). Set it lower and
# the reviewer is invited to confirm wrong accounts; higher and real typos stop
# being caught.
SUGGESTION_THRESHOLD = 0.82

_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


def match_key(name: str) -> str:
    """The normalised form two ledger names are compared by.

    Case and punctuation are how the same account ends up written five ways, so
    they are removed before anything is compared: "TDS Payable", "tds-payable"
    and "T.D.S. PAYABLE" all reduce to `tdspayable`.

    This rule is duplicated in two other places that must agree with it — the
    `match_key` generated column in supabase_schema.sql, and `ledgerMatchKey` in
    frontend/src/lib/db.ts. If they disagree, a name matches in one part of the
    system and not another, which is far more confusing than not matching at all.
    """
    return _NON_ALPHANUMERIC.sub("", (name or "").lower())


def _tokens(name: str) -> set:
    """The distinct words in a name, normalised the same way as `match_key`."""
    return {token for token in _NON_ALPHANUMERIC.split((name or "").lower()) if token}


def build_index(ledgers: Iterable[dict]) -> List[dict]:
    """Prepares a chart of accounts for repeated matching.

    Every row of every voucher is matched against the whole list, so the
    normalisation is done once here rather than thousands of times below.
    Inactive ledgers are dropped: retiring a ledger is precisely a statement that
    new vouchers should stop being posted to it.
    """
    index = []
    for ledger in ledgers or []:
        name = (ledger.get("name") or "").strip()
        if not name or ledger.get("is_active") is False:
            continue

        aliases = [a for a in (ledger.get("aliases") or []) if a and a.strip()]
        index.append({
            "id": ledger.get("id"),
            "name": name,
            "key": match_key(name),
            "tokens": _tokens(name),
            "alias_keys": {match_key(a) for a in aliases},
        })
    return index


def _similarity(query_key: str, query_tokens: set, entry: dict) -> float:
    """How alike two ledger names are, on a 0-1 scale.

    Two different measures, because each is blind where the other sees:

      * Character similarity catches typos and transpositions, which is most of
        what handwriting produces, but it punishes reordering severely.
      * Word overlap ignores order entirely, so "Outward Freight" still matches
        "Freight Outward" — which character-by-character looks quite different.

    The better of the two wins rather than an average: each is evidence of a
    match, and averaging lets the blind one veto the one that can see.
    """
    characters = SequenceMatcher(None, query_key, entry["key"]).ratio()

    union = query_tokens | entry["tokens"]
    words = len(query_tokens & entry["tokens"]) / len(union) if union else 0.0

    return max(characters, words)


def match_ledger(name: str, index: List[dict]) -> dict:
    """Resolves one extracted ledger name against the chart of accounts.

    Returns what should be stored on the transaction row:

        ledger_id     the ledger it resolved to, or None
        ledger_name   the name to export — the canonical Tally spelling once the
                      match is certain, otherwise the name exactly as written
        ledger_match  one of the states at the top of this module
        score         similarity behind a suggestion, None otherwise

    Note what does NOT happen for a suggestion: the name is left alone. Writing a
    merely-probable ledger name into the field that gets exported would post real
    money to an account nobody chose, and it would look identical to a match that
    was certain.
    """
    written = (name or "").strip()

    if not index:
        # No chart of accounts to check against. Saying "Unmatched" here would
        # flag every row of every voucher at an organisation that has simply not
        # entered their ledgers yet, which trains people to ignore the flag.
        return {"ledger_id": None, "ledger_name": written,
                "ledger_match": UNCHECKED, "score": None}

    key = match_key(written)
    if not key:
        return {"ledger_id": None, "ledger_name": written,
                "ledger_match": UNMATCHED, "score": None}

    for entry in index:
        if entry["key"] == key:
            return {"ledger_id": entry["id"], "ledger_name": entry["name"],
                    "ledger_match": EXACT, "score": 1.0}

    for entry in index:
        if key in entry["alias_keys"]:
            return {"ledger_id": entry["id"], "ledger_name": entry["name"],
                    "ledger_match": ALIAS, "score": 1.0}

    tokens = _tokens(written)
    best: Optional[dict] = None
    best_score = 0.0
    for entry in index:
        score = _similarity(key, tokens, entry)
        if score > best_score:
            best, best_score = entry, score

    if best and best_score >= SUGGESTION_THRESHOLD:
        return {"ledger_id": best["id"], "ledger_name": written,
                "ledger_match": SUGGESTED, "score": round(best_score, 3)}

    return {"ledger_id": None, "ledger_name": written,
            "ledger_match": UNMATCHED, "score": None}


def apply_to_rows(rows: List[dict], ledgers: Iterable[dict]) -> List[str]:
    """Matches every row of a voucher in place, and reports what needs attention.

    The returned notes go into the receipt's verification warnings, which is
    where the reviewer already looks. An unmatched ledger is not an extraction
    failure — the amounts may be read perfectly — so it never fails the receipt;
    it just has to be impossible to miss before the file reaches Tally.
    """
    index = build_index(ledgers)

    for row in rows:
        result = match_ledger(row.get("ledger_name"), index)
        row["ledger_id"] = result["ledger_id"]
        row["ledger_name"] = result["ledger_name"]
        row["ledger_match"] = result["ledger_match"]
        row["ledger_match_score"] = result["score"]

    if not index:
        return []

    unmatched = [r["ledger_name"] for r in rows if r["ledger_match"] == UNMATCHED]
    suggested = [r["ledger_name"] for r in rows if r["ledger_match"] == SUGGESTED]

    notes = []
    if unmatched:
        notes.append(
            f"{_count(unmatched, 'ledger name')} not in your chart of accounts "
            f"({_listing(unmatched)}). Pick the right ledger before exporting, or "
            f"Tally will create a new account under that name."
        )
    if suggested:
        notes.append(
            f"{_count(suggested, 'ledger name')} close to an existing ledger but "
            f"not an exact match ({_listing(suggested)}). Please confirm each one."
        )
    return notes


def _count(items: List[str], noun: str) -> str:
    return f"1 {noun} is" if len(items) == 1 else f"{len(items)} {noun}s are"


def _listing(items: List[str], limit: int = 4) -> str:
    """Names the offenders, without letting a bad voucher produce a wall of text."""
    unique = list(dict.fromkeys(items))
    shown = ", ".join(f'"{name}"' for name in unique[:limit])
    remaining = len(unique) - limit
    return f"{shown} and {remaining} more" if remaining > 0 else shown
