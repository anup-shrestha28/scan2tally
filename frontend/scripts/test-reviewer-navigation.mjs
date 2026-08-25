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
const { groupTransactionsByReceipt, resolveStartIndex } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

const orderSource = readFileSync(resolve(here, '../src/lib/receiptOrder.ts'), 'utf8');
const { code: orderCode } = await transform(orderSource, { loader: 'ts', format: 'esm' });
const { sortReceiptsByVoucherNo } = await import(
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
