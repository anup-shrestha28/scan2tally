"""The three copies of the ledger normalisation rule must agree.

`match_key` decides whether two spellings are the same account, and it exists in
three places for three good reasons: Postgres needs it to reject duplicate
ledgers, the server needs it to match extracted names, and the browser needs it
to resolve a name someone typed without a round trip.

Three copies of a rule is three chances to change one of them. The symptom would
not be an error — a name would simply match in one part of the system and not in
another, which is far harder to notice than a failure and far more confusing to
diagnose. So this test compares the copies directly on the awkward inputs.

The Postgres copy is checked too when a database is reachable; it is skipped
otherwise, so the suite still runs offline.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ledger_matching as lm

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FRONTEND = os.path.join(REPO_ROOT, "frontend")
LEDGERS_TS = os.path.join(FRONTEND, "src", "lib", "ledgers.ts")

# Deliberately awkward: the spacing, punctuation and casing that real handwritten
# vouchers produce, plus the edges where implementations tend to diverge.
NAMES = [
    "Freight Outward",
    "freight outward",
    "FREIGHT-OUTWARD",
    "  Freight   Outward  ",
    "Carriage Outward - Labour",
    "T.D.S. PAYABLE",
    "Bank A/c",
    "Sundry Payable (Misc)",
    "Account #12",
    "50% Advance",
    "Ram & Shyam Traders",
    "Café Expenses",
    "भाडा खर्च",
    "Mixed भाडा 123",
    "___",
    "",
    "   ",
]


def _node_available() -> bool:
    return shutil.which("node") is not None and os.path.isdir(
        os.path.join(FRONTEND, "node_modules", "esbuild")
    )


@pytest.mark.skipif(not _node_available(),
                    reason="node and frontend/node_modules are needed to run the browser copy")
def test_the_browser_copy_agrees_with_the_server():
    """Runs the real TypeScript, rather than a Python restatement of it.

    Transpiled with the esbuild that Vite already depends on, so this needs no
    test framework and no dependency the project does not already have.
    """
    with tempfile.TemporaryDirectory() as workspace:
        bundle = os.path.join(workspace, "ledgers.mjs")
        subprocess.run(
            [os.path.join(FRONTEND, "node_modules", ".bin", "esbuild"),
             LEDGERS_TS, "--format=esm", f"--outfile={bundle}", "--log-level=error"],
            check=True, cwd=FRONTEND,
        )

        driver = os.path.join(workspace, "run.mjs")
        with open(driver, "w", encoding="utf-8") as handle:
            handle.write(
                "import { ledgerMatchKey } from './ledgers.mjs';\n"
                "const names = JSON.parse(process.argv[2]);\n"
                "console.log(JSON.stringify(names.map(ledgerMatchKey)));\n"
            )

        completed = subprocess.run(
            ["node", driver, json.dumps(NAMES)],
            check=True, capture_output=True, text=True, cwd=workspace,
        )

    from_browser = json.loads(completed.stdout)
    from_server = [lm.match_key(name) for name in NAMES]

    mismatches = [
        (name, browser, server)
        for name, browser, server in zip(NAMES, from_browser, from_server)
        if browser != server
    ]
    assert not mismatches, (
        "frontend/src/lib/ledgers.ts and backend/ledger_matching.py disagree: "
        f"{mismatches}"
    )


@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"),
                    reason="set TEST_DATABASE_URL to also check the Postgres copy")
def test_the_database_copy_agrees_with_the_server():
    """Checks the `match_key` generated column against the same names.

    Not run by default: the unique index that keeps one account from being held
    under two spellings is only as good as this expression, but proving it needs
    a live database. Point TEST_DATABASE_URL at a throwaway one to include it.
    """
    psql = shutil.which("psql")
    if not psql:
        pytest.skip("psql is not installed")

    # Evaluated as an expression, so nothing is written and no table is needed.
    values = ",".join(f"({_quote(name)})" for name in NAMES)
    query = (
        f"SELECT lower(regexp_replace(n, '[^A-Za-z0-9]+', '', 'g')) "
        f"FROM (VALUES {values}) AS t(n);"
    )
    completed = subprocess.run(
        [psql, os.environ["TEST_DATABASE_URL"], "-tA", "-c", query],
        check=True, capture_output=True, text=True,
    )

    from_database = completed.stdout.split("\n")[:len(NAMES)]
    from_server = [lm.match_key(name) for name in NAMES]

    mismatches = [
        (name, database, server)
        for name, database, server in zip(NAMES, from_database, from_server)
        if database != server
    ]
    assert not mismatches, (
        "the match_key column in supabase_schema.sql and "
        f"backend/ledger_matching.py disagree: {mismatches}"
    )


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
