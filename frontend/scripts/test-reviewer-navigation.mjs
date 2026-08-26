/**
 * Tests for the reviewer's navigation and hand-back bookkeeping.
 *
 * Run with: node scripts/test-reviewer-navigation.mjs   (or `npm test`)
 *
 * Both functions here were reported as user-visible faults:
 *   - the reviewer opening on somebody else's voucher and photo
 *   - corrections vanishing after a trip to the export screen and back
 *
 * Neither is visible in a type check or a build, so they are pinned here.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/lib/reviewerNavigation.ts'), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { groupTransactionsByReceipt, resolveStartIndex, amountVerdictIsStale } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

const orderSource = readFileSync(resolve(here, '../src/lib/receiptOrder.ts'), 'utf8');
const { code: orderCode } = await transform(orderSource, { loader: 'ts', format: 'esm' });
const { sortReceiptsByVoucherNo, orderGroupedReceiptIds } = await import(
  `data:text/javascript;base64,${Buffer.from(orderCode).toString('base64')}`
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

const receipts = ids => ids.map(id => ({ id }));

// ===================================================================
// resolveStartIndex — which page the reviewer opens on.
// ===================================================================
{
  const visible = receipts(['a', 'b', 'c', 'd']);

  equal('an explicit request wins', 0, resolveStartIndex(visible, 'c', 0));
  equal('...including a non-zero one', 2, resolveStartIndex(visible, 'a', 2));

  // The reported bug: App passed a literal 0 on every entry, so this branch
  // was unreachable and every receipt opened as the first one.
  equal('with no request, the selected receipt decides', 2, resolveStartIndex(visible, 'c'));
  equal('...and the last receipt is reachable', 3, resolveStartIndex(visible, 'd'));
  equal('...and undefined is not the same as 0', 2, resolveStartIndex(visible, 'c', undefined));

  equal('no selection falls back to the first page', 0, resolveStartIndex(visible, null));
  equal('a receipt not in the visible list falls back too', 0, resolveStartIndex(visible, 'zz'));
  equal('an empty list is still a valid index', 0, resolveStartIndex([], 'a'));
  check('never returns a negative index',
    [resolveStartIndex(visible, 'zz'), resolveStartIndex(visible, 'a', -5)].every(i => i >= 0));
}
{
  // Focused mode: the visible list is only the imbalanced receipts, and the
  // redirect after "Fix imbalanced receipts" must land on the one it named.
  const focused = receipts(['b', 'd']);
  equal('focused mode positions by receipt, not by batch order', 1,
    resolveStartIndex(focused, 'd'));
  equal('...and the first of the focused set is index 0', 0,
    resolveStartIndex(focused, 'b'));
  equal('a balanced receipt is not in the focused list, so page 1', 0,
    resolveStartIndex(focused, 'a'));
}

// ===================================================================
// groupTransactionsByReceipt — carrying the reviewer's edits back.
// ===================================================================
const row = (id, receipt_id, amount) => ({ id, receipt_id, debit_amount: amount });

{
  const previous = { r1: [row('t1', 'r1', 100)], r2: [row('t9', 'r2', 5)] };
  // The reviewer corrected t1 and handed the whole voucher back.
  const handedBack = [row('t1', 'r1', 32137)];

  const next = groupTransactionsByReceipt(handedBack, previous);
  equal('the edited value replaces the old one', 32137, next.r1[0].debit_amount);
  equal('a receipt not in the hand-back is left alone', previous.r2, next.r2);
}
{
  // The regression that mattered: a row DELETED in the reviewer.
  // The old row-by-row merge filtered each incoming row out and appended it
  // back, so anything no longer present simply stayed — and a voucher balanced
  // by deleting a duplicate line came back still out of balance.
  const previous = { r1: [row('t1', 'r1', 100), row('t2', 'r1', 100)] };
  const handedBack = [row('t1', 'r1', 100)];

  const next = groupTransactionsByReceipt(handedBack, previous);
  equal('a deleted row does not come back', ['t1'], next.r1.map(r => r.id));
}
{
  // ...and order, which the append-merge also lost.
  const previous = { r1: [row('t1', 'r1', 1), row('t2', 'r1', 2), row('t3', 'r1', 3)] };
  const handedBack = [row('t1', 'r1', 1), row('t2', 'r1', 999), row('t3', 'r1', 3)];

  const next = groupTransactionsByReceipt(handedBack, previous);
  equal('an edited row keeps its position', ['t1', 't2', 't3'], next.r1.map(r => r.id));
  equal('...with the edit applied in place', 999, next.r1[1].debit_amount);
}
{
  const handedBack = [
    row('t1', 'r1', 1), row('t2', 'r2', 2), row('t3', 'r1', 3), row('t4', 'r3', 4),
  ];
  const next = groupTransactionsByReceipt(handedBack, {});
  equal('rows are filed under their own receipt', ['t1', 't3'], next.r1.map(r => r.id));
  equal('...across all receipts', ['r1', 'r2', 'r3'], Object.keys(next).sort());
}
{
  // A row with no receipt cannot be filed and must not become a "undefined" key.
  const next = groupTransactionsByReceipt(
    [row('t1', 'r1', 1), { id: 't2', debit_amount: 2 }, row('t3', null, 3)],
    {}
  );
  equal('unattached rows are dropped rather than mis-filed', ['r1'], Object.keys(next));
}
{
  equal('an empty hand-back changes nothing', { r1: [] }, groupTransactionsByReceipt([], { r1: [] }));
  equal('no previous map is fine', {}, groupTransactionsByReceipt([]));
}
{
  // The previous map must not be mutated: App holds it in state.
  const previous = { r1: [row('t1', 'r1', 100)] };
  const snapshot = JSON.stringify(previous);
  groupTransactionsByReceipt([row('t1', 'r1', 999)], previous);
  equal('the previous map is left untouched', snapshot, JSON.stringify(previous));
}

// ===================================================================
// The canonical receipt order: voucher number first, then file name.
//
// Reported as "receipts appear in a random order". Two causes: uploads run
// several files in parallel, so created_at within one burst lands in whatever
// order the network finished; and the export screen ran its OWN sort that put
// number-less receipts FIRST — the opposite of the table and the reviewer.
// ===================================================================
{
  // The reported batch: bill7 carries voucher 17; the other five have no
  // number and their upload timestamps landed scrambled by the parallelism.
  const scrambled = [
    { id: 'r-bill3', filename: 'bill3.jpg', created_at: '2026-08-26T15:55:03Z' },
    { id: 'r-bill7', filename: 'bill7.jpg', created_at: '2026-08-26T15:55:05Z' },
    { id: 'r-bill',  filename: 'bill.jpg',  created_at: '2026-08-26T15:55:04Z' },
    { id: 'r-bill6', filename: 'bill6.jpg', created_at: '2026-08-26T15:55:01Z' },
    { id: 'r-bill2', filename: 'bill2.jpg', created_at: '2026-08-26T15:55:06Z' },
    { id: 'r-bill4', filename: 'bill4.jpg', created_at: '2026-08-26T15:55:02Z' },
  ];
  const tx = { 'r-bill7': [{ voucher_no: '17' }] };

  equal(
    'the numbered voucher leads; the rest follow in file-name order',
    ['r-bill7', 'r-bill', 'r-bill2', 'r-bill3', 'r-bill4', 'r-bill6'],
    sortReceiptsByVoucherNo(scrambled, tx).map(r => r.id)
  );
  check(
    '...and scrambled upload times cannot disturb it',
    JSON.stringify(sortReceiptsByVoucherNo([...scrambled].reverse(), tx).map(r => r.id)) ===
      JSON.stringify(sortReceiptsByVoucherNo(scrambled, tx).map(r => r.id))
  );
}
{
  // Natural comparison, so bill10 does not land between bill1 and bill2.
  const receipts = [
    { id: 'a', filename: 'bill10.jpg', created_at: '2026-08-26T10:00:00Z' },
    { id: 'b', filename: 'bill2.jpg',  created_at: '2026-08-26T10:00:01Z' },
    { id: 'c', filename: 'bill1.jpg',  created_at: '2026-08-26T10:00:02Z' },
  ];
  equal('file names compare numerically, not alphabetically',
    ['c', 'b', 'a'], sortReceiptsByVoucherNo(receipts, {}).map(r => r.id));
}
{
  // The export screen's view of the same order: it holds grouped rows, not
  // receipts, and must come out identical — its own sort used to put the
  // number-less receipts first.
  const receipts = [
    { id: 'r1', filename: 'bill.jpg',  created_at: '2026-08-26T10:00:00Z' },
    { id: 'r2', filename: 'bill7.jpg', created_at: '2026-08-26T10:00:01Z' },
    { id: 'r3', filename: 'bill2.jpg', created_at: '2026-08-26T10:00:02Z' },
  ];
  const grouped = {
    r1: [{ voucher_no: '' }],
    r2: [{ voucher_no: '17' }],
    r3: [{ voucher_no: '' }],
  };
  equal('the export orders voucher blocks exactly like the reviewer',
    ['r2', 'r1', 'r3'], orderGroupedReceiptIds(receipts, grouped));

  equal('rows whose receipt is gone are kept at the end, never dropped',
    ['r2', 'r1', 'r3', 'orphan'],
    orderGroupedReceiptIds(receipts, { ...grouped, orphan: [{ voucher_no: '' }] }));

  equal('an empty group is not given a voucher block',
    ['r2', 'r3'],
    orderGroupedReceiptIds(receipts, { r2: grouped.r2, r3: grouped.r3, r1: [] }));

  equal('no receipts at all falls back to first-seen order',
    ['r1', 'r3'],
    orderGroupedReceiptIds([], { r1: grouped.r1, r3: grouped.r3 }));
}

// ===================================================================
// When the extraction's own verdict about a row stops applying.
//
// Reported as inconsistent colouring: one voucher showed an amber amount, the
// next a rose one, the next nothing, with no way to tell why. Part of it was
// this — an amber "the passes disagreed" flag left sitting on a figure the
// reviewer had since typed themselves, describing a number that no longer
// existed.
// ===================================================================
{
  check('editing a debit amount discards it', amountVerdictIsStale('debit_amount'));
  check('editing a credit amount discards it', amountVerdictIsStale('credit_amount'));

  // Everything else leaves it alone: the verdict is about the amount, and
  // renaming a ledger or retyping a narration says nothing about the figure.
  for (const field of ['ledger_name', 'narration', 'entry_type', 'voucher_no', 'voucher_date']) {
    check(`editing ${field} keeps it`, !amountVerdictIsStale(field));
  }
}

// ===================================================================
// Opening the reviewer once a batch finishes extracting.
//
// Reported as "6 receipts extracted and it opened on number 2". The batch
// workspace picked the first receipt of the run in UPLOAD order and handed it
// over; the reviewer paginates by VOUCHER number, so that receipt landed on
// whatever page it sorted to. Both sides have to mean the same thing by "the
// first one", which they now do by using the same sort.
// ===================================================================
{
  // Uploaded bill1..bill4, but their voucher numbers run in another order.
  const uploaded = [
    { id: 'bill1', created_at: '2026-08-25T10:00:00Z' },
    { id: 'bill2', created_at: '2026-08-25T10:01:00Z' },
    { id: 'bill3', created_at: '2026-08-25T10:02:00Z' },
    { id: 'bill4', created_at: '2026-08-25T10:03:00Z' },
  ];
  const txByReceipt = {
    bill1: [{ voucher_no: '17' }],
    bill2: [{ voucher_no: '4' }],
    bill3: [{ voucher_no: '9' }],
    bill4: [{ voucher_no: '22' }],
  };

  const displayed = sortReceiptsByVoucherNo(uploaded, txByReceipt);
  equal('the reviewer displays them by voucher number',
    ['bill2', 'bill3', 'bill1', 'bill4'], displayed.map(r => r.id));

  // What the workspace hands over after the whole batch extracts.
  const chosen = sortReceiptsByVoucherNo(uploaded, txByReceipt)[0];
  equal('the batch opens on the receipt the reviewer shows first', 'bill2', chosen.id);
  equal('...which is page 1', 0, resolveStartIndex(displayed, chosen.id));

  // The old behaviour, kept here to show what it cost: upload order picked
  // bill1, which is the third page.
  equal('picking by upload order would have opened page 3', 2,
    resolveStartIndex(displayed, uploaded[0].id));
}
{
  // A partial retry should still land on the first RETRIED receipt, not on
  // page 1 of the batch.
  const all = [
    { id: 'a', created_at: '2026-08-25T10:00:00Z' },
    { id: 'b', created_at: '2026-08-25T10:01:00Z' },
    { id: 'c', created_at: '2026-08-25T10:02:00Z' },
  ];
  const tx = { a: [{ voucher_no: '1' }], b: [{ voucher_no: '2' }], c: [{ voucher_no: '3' }] };
  const displayed = sortReceiptsByVoucherNo(all, tx);
  const rerun = all.filter(r => r.id === 'c' || r.id === 'b');

  const chosen = sortReceiptsByVoucherNo(rerun, tx)[0];
  equal('a retry of b and c opens on b', 'b', chosen.id);
  equal('...at its real page', 1, resolveStartIndex(displayed, chosen.id));
}

// ===================================================================
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(
  failures === 0
    ? `\nall ${results.length} reviewer-navigation checks passed`
    : `\n${failures} of ${results.length} CHECKS FAILED`
);
process.exit(failures === 0 ? 0 : 1);
