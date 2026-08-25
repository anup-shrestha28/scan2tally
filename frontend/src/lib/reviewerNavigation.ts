/**
 * The two pieces of reviewer bookkeeping that are worth stating in one place.
 *
 * Both existed inline and both went wrong in ways that were invisible until a
 * reviewer noticed the app showing them somebody else's voucher, or their own
 * corrections gone. They are pure, so they can be pinned by tests; the
 * components around them cannot be.
 */

/** Just enough of a transaction to file it under a receipt. */
export interface ReceiptScopedRow {
  id?: string;
  receipt_id?: string | null;
}

/** Just enough of a receipt to find it in a list. */
export interface IdentifiableReceipt {
  id: string;
}

/**
 * Re-groups a flat list of rows, as the export screen carries them, back into
 * a per-receipt map.
 *
 * A receipt that appears in `rows` is REPLACED outright. That is the whole
 * contract, and the reason for it: the previous implementation merged row by
 * row — filtering each incoming row out of the old array and appending it back
 * — which meant a row the reviewer had DELETED was never removed, so a voucher
 * balanced by deleting a duplicate line came back still out of balance. It also
 * moved every edited row to the end of its voucher.
 *
 * Receipts absent from `rows` keep whatever was already known about them, so
 * this can be handed a partial list without erasing the rest of the batch.
 */
export function groupTransactionsByReceipt<Row extends ReceiptScopedRow>(
  rows: readonly Row[],
  previous: Readonly<Record<string, Row[]>> = {},
): Record<string, Row[]> {
  const grouped: Record<string, Row[]> = {};
  for (const row of rows) {
    if (!row.receipt_id) continue;
    (grouped[row.receipt_id] = grouped[row.receipt_id] || []).push(row);
  }
  return { ...previous, ...grouped };
}

/**
 * Which page the reviewer should open on.
 *
 * `requested` is the caller having an opinion — "review the whole batch" asks
 * for 0. Undefined means it does not, and the position is then taken from
 * whichever receipt was selected. That distinction is the entire point: App
 * used to pass a literal 0 to the reviewer on every entry, which pinned it to
 * the first receipt no matter which one had been chosen, so opening one
 * particular voucher, and the redirect after "Fix imbalanced receipts", both
 * landed on somebody else's row and photo.
 *
 * Never returns a negative index. A selected receipt that is not in the visible
 * list — filtered out by focused mode, or deleted — falls back to the first
 * page rather than to nothing at all.
 */
export function resolveStartIndex(
  visibleReceipts: readonly IdentifiableReceipt[],
  selectedReceiptId: string | null | undefined,
  requested?: number,
): number {
  if (requested !== undefined) return Math.max(0, requested);
  if (!selectedReceiptId) return 0;
  return Math.max(0, visibleReceipts.findIndex(receipt => receipt.id === selectedReceiptId));
}
