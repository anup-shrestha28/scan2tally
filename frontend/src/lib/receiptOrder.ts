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

/** Sort detected voucher numbers ascending; receipts without one go last. */
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

    const leftCreated = Date.parse(left.created_at || '') || 0;
    const rightCreated = Date.parse(right.created_at || '') || 0;
    return leftCreated - rightCreated || left.id.localeCompare(right.id);
  });
}
