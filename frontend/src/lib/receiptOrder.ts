import { Receipt, Transaction } from '../types';

/** A receipt is one voucher, so the first extracted row carries its number. */
export function voucherNoForReceipt(
  receipt: Receipt,
  transactionsByReceipt: Record<string, Transaction[]> = {},
): string {
  return String(
    transactionsByReceipt[receipt.id]?.find(transaction => transaction.voucher_no)?.voucher_no
      ?? ''
  ).trim();
}

/** Groups extracted receipts that appear to carry the same voucher number. */
export function duplicateVoucherGroups(
  receipts: Receipt[],
  transactionsByReceipt: Record<string, Transaction[]> = {},
): Array<{ voucherNo: string; receipts: Receipt[] }> {
  const groups = new Map<string, { voucherNo: string; receipts: Receipt[] }>();
  for (const receipt of receipts) {
    const voucherNo = voucherNoForReceipt(receipt, transactionsByReceipt);
    if (!voucherNo) continue;

    // Treat numeric forms such as "001" and "1" as the same voucher number.
    const normalized = /^\d+$/.test(voucherNo)
      ? String(Number(voucherNo))
      : voucherNo.replace(/\s+/g, ' ').toLocaleLowerCase();
    const group = groups.get(normalized) || { voucherNo, receipts: [] };
    group.receipts.push(receipt);
    groups.set(normalized, group);
  }
  return [...groups.values()].filter(group => group.receipts.length > 1);
}

/**
 * THE canonical receipt order. The batch file table, the reviewer's pages, the
 * export preview and the generated .xlsx must all agree on it, so page 3 of the
 * reviewer is voucher 3 of the spreadsheet — any stage ordering for itself is
 * how "the receipts look random" happened.
 *
 * The rule, in words: receipts whose extracted rows carry a voucher number come
 * first, in voucher-number order — that is the sequence the accountant wrote
 * them in. The rest follow in natural file-name order.
 *
 * File name, deliberately NOT upload time, as the tiebreak. Uploads run several
 * files in parallel, so within one burst the created_at timestamps land in
 * whatever order the network finished — which is the "random" order users see.
 * File names are stable, and for the common cases they encode the real
 * sequence: bill, bill2, bill3…, or a phone camera's IMG_0993, IMG_0994…,
 * which is the order the vouchers were photographed. Upload time still decides
 * between identical names, and the id makes the whole order total.
 */
export function sortReceiptsByVoucherNo(
  receipts: Receipt[],
  transactionsByReceipt: Record<string, Transaction[]> = {},
): Receipt[] {
  return [...receipts].sort((left, right) => {
    const leftNo = voucherNoForReceipt(left, transactionsByReceipt);
    const rightNo = voucherNoForReceipt(right, transactionsByReceipt);
    if (leftNo && !rightNo) return -1;
    if (!leftNo && rightNo) return 1;
    if (leftNo && rightNo) {
      const voucherOrder = leftNo.localeCompare(rightNo, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (voucherOrder !== 0) return voucherOrder;
    }

    const nameOrder = (left.filename || '').localeCompare(right.filename || '', undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (nameOrder !== 0) return nameOrder;

    const leftCreated = Date.parse(left.created_at || '') || 0;
    const rightCreated = Date.parse(right.created_at || '') || 0;
    return leftCreated - rightCreated || left.id.localeCompare(right.id);
  });
}

/**
 * The canonical order for callers that hold rows grouped by receipt id rather
 * than receipts — the export screen, which receives one flat list.
 *
 * Ids that appear in the groups but not in `receipts` (rows whose receipt is
 * gone, or rows carrying no receipt at all) are kept, in first-seen order, at
 * the end — an export must never silently drop a voucher block.
 */
export function orderGroupedReceiptIds(
  receipts: Receipt[],
  transactionsByReceipt: Record<string, Transaction[]>,
): string[] {
  const ordered = sortReceiptsByVoucherNo(receipts, transactionsByReceipt)
    .map(receipt => receipt.id)
    .filter(id => (transactionsByReceipt[id] || []).length > 0);
  const known = new Set(ordered);
  const leftovers = Object.keys(transactionsByReceipt).filter(
    id => !known.has(id) && (transactionsByReceipt[id] || []).length > 0,
  );
  return [...ordered, ...leftovers];
}
