/**
 * Tests for the imbalance suspect finder.
 *
 * Run with: node scripts/test-imbalance.mjs   (or `npm test`)
 *
 * There is no test runner in this project and adding one for a single pure
 * module would be a heavier change than the module. esbuild is already present
 * as a Vite dependency, so the TypeScript is transpiled in memory and imported
 * as a data: URL — no build step, no new dependency, and the real source is
 * what runs.
 *
 * What is being guarded: this feature points a finger at a specific amount on
 * an accounting document. Pointing at the wrong row is worse than pointing at
 * none, so the cases below are mostly about when it must stay quiet.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/lib/imbalance.ts'), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const {
  findImbalanceSuspects,
  findStatedTotalDiscrepancies,
  summarizeStatedDiscrepancies,
  classifyMisread,
  describeMisread,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
}

function equal(name, expected, actual) {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  check(name, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Builds rows and works out the difference the reviewer would be showing. */
function voucher(...rows) {
  const withIds = rows.map((row, index) => ({ id: `r${index + 1}`, ...row }));
  const debit = withIds.reduce((sum, r) => sum + (r.debit_amount || 0), 0);
  const credit = withIds.reduce((sum, r) => sum + (r.credit_amount || 0), 0);
  return { rows: withIds, difference: Math.round((debit - credit) * 100) / 100 };
}

const Dr = (debit_amount) => ({ entry_type: 'Dr', debit_amount, credit_amount: 0 });
const Cr = (credit_amount) => ({ entry_type: 'Cr', debit_amount: 0, credit_amount });

// ===================================================================
// The real voucher this was built for: 32137 written, 3213 extracted.
// ===================================================================
{
  const { rows, difference } = voucher(
    Dr(26775), Dr(4725), Dr(637), Cr(3213)
  );
  const found = findImbalanceSuspects(rows, difference);

  equal('the real voucher: exactly one row is questioned', 1, found.length);
  equal('...and it is the Bank credit row', 'r4', found[0]?.transactionId);
  equal('...suggested the amount actually written', 32137, found[0]?.suggested);
  equal('...recognised as a dropped digit', 'digit-missing', found[0]?.kind);
  check(
    '...and the explanation names both amounts',
    describeMisread(found[0]).includes('3,213.00') &&
      describeMisread(found[0]).includes('32,137.00')
  );
  check(
    '...applying the suggestion balances the voucher',
    Math.abs((26775 + 4725 + 637) - 32137) < 0.005
  );
}

// ===================================================================
// It must stay quiet when there is nothing trustworthy to say.
// ===================================================================
{
  const { rows, difference } = voucher(Dr(1000), Cr(1000));
  equal('a balanced voucher produces nothing', [], findImbalanceSuspects(rows, difference));
}
{
  // 1000 vs 1234: no single-digit relationship on any row.
  const { rows, difference } = voucher(Dr(1000), Cr(1234));
  equal('an unexplainable gap produces nothing', [], findImbalanceSuspects(rows, difference));
}
{
  const { rows, difference } = voucher(Dr(500), Cr(500.02));
  equal(
    'a rounding-sized gap counts as balanced',
    [],
    findImbalanceSuspects(rows, difference)
  );
}
{
  // The correction would have to be negative, which is not a misreading.
  const { rows, difference } = voucher(Dr(100), Cr(5000));
  const found = findImbalanceSuspects(rows, difference);
  check(
    'no row is offered a negative or zero amount',
    found.every(s => s.suggested > 0),
    JSON.stringify(found)
  );
}
{
  const { rows, difference } = voucher(Dr(3213), Cr(0));
  const found = findImbalanceSuspects(rows, difference);
  check(
    'a blank row is never called a misreading',
    found.every(s => s.transactionId !== 'r2'),
    JSON.stringify(found)
  );
}

// ===================================================================
// The other misreadings that actually happen to handwritten digits.
// ===================================================================
equal('a dropped digit', 'digit-missing', classifyMisread(3213, 32137));
equal('an extra digit', 'extra-digit', classifyMisread(32137, 3213));
equal('a misplaced decimal point', 'decimal-point', classifyMisread(321.37, 32137));
equal('two digits swapped', 'digits-swapped', classifyMisread(32173, 32137));
equal('one digit read as another', 'one-digit-different', classifyMisread(32135, 32137));
equal('an unrelated amount', null, classifyMisread(1000, 7642));

// Trailing zeros in the whole part must survive the fraction being trimmed:
// stripping zeros off the joined string would turn 3210.00 into "321".
equal('3210 is not mistaken for 321', 'digit-missing', classifyMisread(3210, 32107));
equal('3210 vs 321 is still a dropped digit', 'digit-missing', classifyMisread(321, 3210));

// A decimal point moved too far is not a misreading, it is nonsense.
equal('a 100x decimal shift is offered', 'decimal-point', classifyMisread(3.21, 321));
equal('a 100000x decimal shift is not', null, classifyMisread(3.21, 321000));

// ===================================================================
// Confidence tiers: a coincidence must not outrank real evidence.
// ===================================================================
{
  // r2 (credit 3213 -> 32137) is a dropped digit. r1 (debit 61061 -> 32137)
  // is nothing. Only the real one should surface.
  const { rows, difference } = voucher(Dr(61061), Cr(3213), Cr(28924));
  const found = findImbalanceSuspects(rows, difference);
  equal('only the digit-shaped row is offered', ['r2'], found.map(s => s.transactionId));
}
{
  // The tiering, which is what stops this feature becoming noise.
  //
  // Off by 20,000, which is a single digit times a power of ten — so any row
  // whose amount has a digit that could absorb it matches weakly:
  //   r1 debit  56,137 -> 36,137   one digit different  (coincidence)
  //   r3 credit 32,137 -> 52,137   one digit different  (coincidence)
  // while one row matches for a real reason:
  //   r2 credit  4,000 -> 24,000   a dropped leading digit
  // Three hints would send the reviewer hunting; one sends them to the row.
  const { rows, difference } = voucher(Dr(56137), Cr(4000), Cr(32137));
  equal('the coincidences are 20,000 apart as intended', 20000, difference);

  const found = findImbalanceSuspects(rows, difference);
  equal('only the strongly-shaped row is offered', ['r2'], found.map(s => s.transactionId));
  equal('...as a dropped digit', 'digit-missing', found[0]?.kind);
  check(
    '...and the coincidences would otherwise have matched',
    classifyMisread(56137, 36137) === 'one-digit-different' &&
      classifyMisread(32137, 52137) === 'one-digit-different'
  );
}
{
  // A single changed digit is never offered, however few rows match it.
  // 52,137 and 32,137 are 20,000 apart and each explains the gap as one digit,
  // which is precisely the relationship that means nothing.
  const { rows, difference } = voucher(Dr(52137), Cr(32137));
  const found = findImbalanceSuspects(rows, difference);
  equal('a one-digit difference is never offered on its own', [], found);
  equal(
    '...though it is still reported honestly when asked directly',
    'one-digit-different',
    classifyMisread(52137, 32137)
  );
}

// ===================================================================
// Regression: bill7.jpg, reported as "why is a correct amount red?"
//
// Twelve lines, 80.00 out. The debits sum to 45,068.76, exactly the जम्मा the
// voucher itself states, so the error is on the credit side — Aakash Bhairab
// reads 3,480.00 where the voucher says 3,400.00.
//
// The trap: 80 is a single digit times a power of ten, so "one digit
// different" holds for EVERY row with a tens digit that can absorb 8 without
// borrowing. Four rows matched, three of them perfectly correct. A shortlist
// of four out of twelve, with red on rows that are right, is worse than
// staying quiet.
// ===================================================================
{
  const { rows, difference } = voucher(
    Dr(8703.76),                      // Freight outward
    Dr(9800),                         // Carriage outward - Transportation
    Dr(26565),                        // Carriage outward - labor
    Cr(114.88),                       // TDS payable
    Cr(1127),                         // VAT payable
    Cr(265),                          // TDS payable
    Cr(3480),                         // Aakash Bhairab — should read 3,400.00
    Cr(278.76),                       // National Carriers
    Cr(3395.17),                      // Krishna Transport
    Cr(1204.20),                      // Shree Carriers
    Cr(310.75),                       // Cash
    Cr(34973)                         // Sundry payable
  );

  equal('bill7: the voucher is 80.00 out', -80, difference);
  equal('bill7: no row is accused', [], findImbalanceSuspects(rows, difference));

  // The individual coincidences are still there; they are simply not evidence.
  equal('bill7: the correct Freight row would have matched', 'one-digit-different',
    classifyMisread(8703.76, 8783.76));
  equal('bill7: the correct Krishna row would have matched', 'one-digit-different',
    classifyMisread(3395.17, 3315.17));
  equal('bill7: so would the genuinely wrong row', 'one-digit-different',
    classifyMisread(3480, 3400));
}

// ===================================================================
// The cap: too many candidates means there is no finger to point.
// ===================================================================
{
  // Off by 40,000, which every row here can explain as a dropped leading 4.
  // Four equally good answers is not an answer.
  const { rows, difference } = voucher(Dr(47000), Cr(4000), Cr(2000), Cr(1000));
  equal('the cap case is 40,000 out as intended', 40000, difference);
  // The debit reads one digit too many; the credits each read one too few.
  // Different names, both strong, all four equally believable.
  equal(
    'each of the four rows really does match',
    ['extra-digit', 'digit-missing', 'digit-missing', 'digit-missing'],
    [
      classifyMisread(47000, 7000),
      classifyMisread(4000, 44000),
      classifyMisread(2000, 42000),
      classifyMisread(1000, 41000),
    ]
  );
  equal(
    'more than two candidates means none is shown',
    [],
    findImbalanceSuspects(rows, difference)
  );
}
{
  // Both a strong and a weak match exist; the weak one must be dropped.
  // Dr 3213, Cr 32137 -> difference -28924.
  //   r1 debit  3213 -> 3213 + 28924 = 32137  (dropped digit, strong)
  //   r2 credit 32137 -> 32137 - 28924 = 3213 (extra digit, strong)
  const { rows, difference } = voucher(Dr(3213), Cr(32137));
  const found = findImbalanceSuspects(rows, difference);
  check(
    'both sides can be offered when both are plausible',
    found.length === 2 && found.every(s => ['digit-missing', 'extra-digit'].includes(s.kind)),
    JSON.stringify(found)
  );
}

// ===================================================================
// Sign handling: debit-heavy and credit-heavy must both work.
// ===================================================================
{
  // Credit exceeds debit: a DEBIT row is the one reading low.
  const { rows, difference } = voucher(Dr(3213), Cr(26775), Cr(4725), Cr(637));
  const found = findImbalanceSuspects(rows, difference);
  equal('credit-heavy voucher points at the debit row', ['r1'], found.map(s => s.transactionId));
  equal('...with the written amount suggested', 32137, found[0]?.suggested);
}

// ===================================================================
// Fractions, which is where floating point would bite.
// ===================================================================
{
  const { rows, difference } = voucher(Dr(1234.56), Cr(123.456 * 10));
  equal('equal amounts with fractions balance', [], findImbalanceSuspects(rows, difference));
}
{
  // 1,234.50 against 123.45. Genuinely ambiguous: either the debit has a
  // decimal point too far right or the credit has one too far left, and
  // nothing here can tell which. Offering both is the honest answer, and each
  // suggestion has to be the one that fixes THAT row.
  const { rows, difference } = voucher(Dr(1234.5), Cr(123.45));
  const found = findImbalanceSuspects(rows, difference);
  equal('a decimal slip is caught on both plausible rows', 2, found.length);
  check(
    'every suggestion is a decimal-point slip',
    found.every(s => s.kind === 'decimal-point'),
    JSON.stringify(found)
  );
  equal(
    'each row is offered the amount that balances it',
    [{ id: 'r1', suggested: 123.45 }, { id: 'r2', suggested: 1234.5 }],
    found.map(s => ({ id: s.transactionId, suggested: s.suggested }))
  );
}

// ===================================================================
// Degenerate input must not throw.
// ===================================================================
equal('no rows', [], findImbalanceSuspects([], 100));
equal('NaN difference', [], findImbalanceSuspects([{ id: 'r1', ...Dr(10) }], NaN));
check('missing amounts do not throw', (() => {
  try {
    findImbalanceSuspects([{ id: 'r1', entry_type: 'Dr' }, { id: 'r2', entry_type: 'Cr' }], 500);
    return true;
  } catch {
    return false;
  }
})());

// ===================================================================
// Which SIDE disagrees with the voucher's own जम्मा row.
//
// This is the one thing that can say where an imbalance lives. Comparing debit
// to credit only proves they differ; the जम्मा row is a third opinion, written
// on the voucher, and it decides which column is at fault.
// ===================================================================
{
  // bill7 again, with the totals the extraction actually read off it.
  const { rows } = voucher(
    Dr(8703.76), Dr(9800), Dr(26565),
    Cr(114.88), Cr(1127), Cr(265), Cr(3480), Cr(278.76),
    Cr(3395.17), Cr(1204.20), Cr(310.75), Cr(34973)
  );
  const stated = { debit: 45068.76, credit: 45068.76 };
  const found = findStatedTotalDiscrepancies(rows, stated);

  equal('bill7: exactly one side is named', 1, found.length);
  equal('bill7: and it is the credit column', 'credit', found[0]?.side);
  equal('bill7: reported as 80.00 too much', 80, found[0]?.difference);
  equal('bill7: quoting what the rows add up to', 45148.76, found[0]?.computed);
  equal('bill7: and what the voucher says', 45068.76, found[0]?.stated);
  check(
    'bill7: the debit column is NOT accused — it matches the जम्मा exactly',
    !found.some(item => item.side === 'debit')
  );
}
{
  // Correcting the row clears the warning, since it is recomputed from the grid.
  const { rows } = voucher(
    Dr(8703.76), Dr(9800), Dr(26565),
    Cr(114.88), Cr(1127), Cr(265), Cr(3400), Cr(278.76),
    Cr(3395.17), Cr(1204.20), Cr(310.75), Cr(34973)
  );
  equal(
    'bill7: fixing 3,480 to 3,400 silences it',
    [],
    findStatedTotalDiscrepancies(rows, { debit: 45068.76, credit: 45068.76 })
  );
}
{
  const { rows } = voucher(Dr(500), Cr(500));
  equal('a voucher matching its जम्मा says nothing', [],
    findStatedTotalDiscrepancies(rows, { debit: 500, credit: 500 }));

  // Balanced against itself but wrong against the voucher: two errors that
  // cancel out, which the debit-versus-credit check cannot see at all.
  const both = findStatedTotalDiscrepancies(rows, { debit: 600, credit: 600 });
  equal('a balanced voucher can still disagree with its जम्मा', 2, both.length);
  equal('...naming both columns', ['debit', 'credit'], both.map(i => i.side));
  equal('...each 100.00 short', [-100, -100], both.map(i => i.difference));
}
{
  const { rows } = voucher(Dr(500), Cr(400));
  equal('an unreadable जम्मा row says nothing', [],
    findStatedTotalDiscrepancies(rows, { debit: null, credit: null }));
  equal('no totals at all says nothing', [], findStatedTotalDiscrepancies(rows, null));
  equal('undefined says nothing', [], findStatedTotalDiscrepancies(rows, undefined));

  // Half a reading is still worth using.
  const half = findStatedTotalDiscrepancies(rows, { debit: null, credit: 500 });
  equal('one readable side is still checked', ['credit'], half.map(i => i.side));
  equal('...reported as 100.00 too little', -100, half[0]?.difference);
}
{
  const { rows } = voucher(Dr(500.02), Cr(500));
  equal('a rounding-sized difference is not a discrepancy', [],
    findStatedTotalDiscrepancies(rows, { debit: 500, credit: 500 }));
}
{
  equal('no rows against a stated total reports the shortfall',
    [-100, -100],
    findStatedTotalDiscrepancies([], { debit: 100, credit: 100 }).map(i => i.difference));
}

// ===================================================================
// How the जम्मा disagreements are presented.
//
// Reported: a voucher whose rows balanced at 45,068.76 while its जम्मा read
// 14,408.35 showed TWO long column warnings under a green "Voucher balanced"
// badge. Both sides off by the same amount with balanced rows is one fact
// about the whole voucher, not two facts about its columns.
// ===================================================================
{
  const { rows } = voucher(Dr(45068.76), Cr(45068.76));
  const summary = summarizeStatedDiscrepancies(
    findStatedTotalDiscrepancies(rows, { debit: 14408.35, credit: 14408.35 })
  );
  equal('balanced rows vs a different जम्मा collapse to one notice', 'voucher', summary?.kind);
  equal('...quoting the जम्मा', 14408.35, summary?.stated);
  equal('...and what the rows add up to', 45068.76, summary?.computed);
}
{
  // The earlier real case: debit matches the जम्मा exactly, credit is 30 over.
  const { rows } = voucher(Dr(45068.76), Cr(45098.76));
  const summary = summarizeStatedDiscrepancies(
    findStatedTotalDiscrepancies(rows, { debit: 45068.76, credit: 45068.76 })
  );
  equal('a single side stays a column notice', 'column', summary?.kind);
  equal('...naming only the credit column', ['credit'], summary?.sides?.map(s => s.side) ?? null);
}
{
  // Both sides wrong by DIFFERENT amounts (the rows do not balance): two real
  // column problems, and collapsing them would hide one.
  const { rows } = voucher(Dr(150), Cr(170));
  const summary = summarizeStatedDiscrepancies(
    findStatedTotalDiscrepancies(rows, { debit: 100, credit: 100 })
  );
  equal('unequal disagreements stay per-column', 'column', summary?.kind);
  equal('...with both columns named', ['debit', 'credit'], summary?.sides?.map(s => s.side) ?? null);
}
{
  // A जम्मा that states two different totals is itself suspect; collapsing to
  // one figure would misquote one of them.
  const { rows } = voucher(Dr(150), Cr(150));
  const summary = summarizeStatedDiscrepancies(
    findStatedTotalDiscrepancies(rows, { debit: 100, credit: 120 })
  );
  equal('differing stated totals stay per-column', 'column', summary?.kind);
}
equal('nothing to summarize is null', null, summarizeStatedDiscrepancies([]));

// ===================================================================
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(
  failures === 0
    ? `\nall ${results.length} imbalance checks passed`
    : `\n${failures} of ${results.length} CHECKS FAILED`
);
process.exit(failures === 0 ? 0 : 1);
