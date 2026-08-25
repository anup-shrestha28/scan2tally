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
const { findImbalanceSuspects, classifyMisread, describeMisread } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

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
  // ...but a weak match is still better than silence when it is all there is.
  const { rows, difference } = voucher(Dr(52137), Cr(32137));
  const found = findImbalanceSuspects(rows, difference);
  check(
    'a lone weak match is still offered',
    found.length > 0 && found.every(s => s.kind === 'one-digit-different'),
    JSON.stringify(found)
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
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(
  failures === 0
    ? `\nall ${results.length} imbalance checks passed`
    : `\n${failures} of ${results.length} CHECKS FAILED`
);
process.exit(failures === 0 ? 0 : 1);
