import type { Ledger, LedgerMatchState } from '../types';

/**
 * Pure rules about ledger names.
 *
 * Kept apart from db.ts deliberately: this file decides which account a voucher
 * line is posted to, which makes it the part of the frontend most worth testing
 * directly, and it can only be tested directly if it drags in neither React nor
 * a Supabase client.
 */

/**
 * The normalised form two ledger names are compared by.
 *
 * Case and punctuation are how one account ends up written five ways, so they
 * are removed before anything is compared: 'TDS Payable', 'tds-payable' and
 * 'T.D.S. PAYABLE' all reduce to `tdspayable`.
 *
 * This rule is duplicated in two other places that must agree with it — the
 * `match_key` generated column in supabase_schema.sql, and `match_key` in
 * backend/ledger_matching.py. If they disagree, a name matches in one part of
 * the system and not another, which is more confusing than not matching at all.
 * backend/tests/test_match_key_agreement.py exists to catch exactly that drift.
 */
export function ledgerMatchKey(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolves a name a person typed against the chart of accounts.
 *
 * Only exact and registered-alias matches, deliberately. The fuzzy scoring that
 * produces suggestions lives on the server, where extraction runs; reimplementing
 * it here would be a second copy of the rule that decides where money is posted,
 * free to drift from the first. Someone typing into the reviewer has the picker
 * right there, so the case this needs to handle is "they chose a real ledger".
 */
export function resolveLedgerName(
  name: string,
  ledgers: Ledger[]
): { ledger_id: string | null; ledger_name: string; ledger_match: LedgerMatchState } {
  const written = (name || '').trim();
  if (!ledgers.length) {
    // No chart of accounts to check against. Calling this 'Unmatched' would flag
    // every row at an organisation that simply has not entered their ledgers yet.
    return { ledger_id: null, ledger_name: written, ledger_match: 'Unchecked' };
  }

  const key = ledgerMatchKey(written);
  if (!key) return { ledger_id: null, ledger_name: written, ledger_match: 'Unmatched' };

  const exact = ledgers.find(l => ledgerMatchKey(l.name) === key);
  if (exact) return { ledger_id: exact.id, ledger_name: exact.name, ledger_match: 'Exact' };

  const alias = ledgers.find(l => l.aliases.some(a => ledgerMatchKey(a) === key));
  if (alias) return { ledger_id: alias.id, ledger_name: alias.name, ledger_match: 'Alias' };

  return { ledger_id: null, ledger_name: written, ledger_match: 'Unmatched' };
}

/**
 * Splits a pasted chart of accounts into entries.
 *
 * Accepts a bare name per line, or a name followed by its Tally group after a
 * pipe, comma or tab — which covers pasting a column out of a spreadsheet as
 * well as typing the list by hand.
 */
export function parsePastedLedgers(text: string): { name: string; parentGroup?: string }[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, parentGroup] = line.split(/\s*[|,\t]\s*/);
      return { name: (name || '').trim(), parentGroup: (parentGroup || '').trim() || undefined };
    })
    .filter(entry => entry.name.length > 0);
}
