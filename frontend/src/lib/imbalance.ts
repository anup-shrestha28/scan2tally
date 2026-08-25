/**
 * Which row is most likely responsible for a voucher not balancing.
 *
 * "Debit 32,137.00, Credit 3,213.00" tells a reviewer that something is wrong
 * and nothing at all about where. On a four-line voucher they can find it; on a
 * fifteen-line one they re-read every amount against the photo.
 *
 * The useful observation is that ANY single row can be changed to make a
 * voucher balance — set it to its own amount plus the shortfall and the totals
 * meet. So "editing this row would balance the voucher" is true of every row and
 * therefore says nothing. What distinguishes the row that is actually wrong is
 * that the value it would need to be is one a reader could plausibly have
 * MISREAD as the value on screen:
 *
 *     the voucher says   32137
 *     the extraction got  3213      — the same digits, one dropped
 *
 * That is a specific, checkable relationship rather than a guess, and it is how
 * handwritten digits actually go wrong: a dropped or doubled digit, a decimal
 * point in the wrong place, two digits swapped, one digit read as another.
 *
 * Nothing here edits anything. It proposes a value for a person to accept or
 * ignore, which matters because the check cannot prove the row is the wrong
 * one — only that it is the one worth looking at first.
 */

/** How the amount on screen could have come from the amount suggested. */
export type MisreadKind =
  | 'digit-missing'
  | 'extra-digit'
  | 'decimal-point'
  | 'digits-swapped'
  | 'one-digit-different';

export interface ImbalanceSuspect {
  transactionId: string;
  side: 'debit' | 'credit';
  /** What the row says now. */
  current: number;
  /** What it would have to be for the voucher to balance. */
  suggested: number;
  kind: MisreadKind;
}

/** Just enough of a transaction to judge it; anything wider also satisfies this. */
export interface ImbalanceCandidateRow {
  id: string;
  entry_type?: string | null;
  debit_amount?: number | null;
  credit_amount?: number | null;
}

/**
 * Below this the voucher counts as balanced. Deliberately the same 0.05 the
 * reviewer's own balance badge uses, so a voucher can never be shown as out of
 * balance while this reports nothing to look at.
 */
const BALANCED_WITHIN = 0.05;

/**
 * A decimal point in the wrong place is a real misreading; a suggestion a
 * thousand times the amount on screen is not a misreading, it is nonsense, and
 * offering it would cost more trust than the occasional correct catch is worth.
 */
const MAX_DECIMAL_SHIFT = 1000;

/**
 * The relationships specific enough to be worth raising.
 *
 * Each constrains the DIGIT SEQUENCE — one string is the other with a character
 * deleted, or the same characters with the point moved, or the same characters
 * with two adjacent ones swapped. Those do not hold by accident.
 *
 * 'one-digit-different' is deliberately NOT here, and is never offered.
 * Changing one digit position changes a number by exactly d x 10^k, so the
 * relationship can only hold when the imbalance ITSELF is d x 10^k — and the
 * moment it is, it holds for every row carrying a digit able to absorb it
 * without borrowing, which is roughly a fifth of amounts. A real voucher 80.00
 * out lit up four of its twelve rows this way, three of them perfectly correct.
 *
 * It is a fact about the imbalance, not about the row, so it can never single
 * one out. It stays in MisreadKind because classifyMisread still reports it
 * honestly and the tests pin that reasoning; it simply is not evidence.
 */
const STRONG_KINDS: readonly MisreadKind[] = [
  'digit-missing',
  'extra-digit',
  'decimal-point',
  'digits-swapped',
];

/**
 * More candidates than this and there is no finger to point.
 *
 * Two can be genuine — a debit reading high and a credit reading low explain
 * the same gap equally well, and saying "one of these two" is honest. Beyond
 * that the reviewer is being asked to search a shortlist barely smaller than
 * the voucher, with red on rows that are right, which costs more trust than the
 * occasional catch is worth.
 */
const MAX_SUSPECTS = 2;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The digits a person would see written down, with the decimal point and any
 * trailing zeros removed — so 321.37 and 32,137.00 both come out as "32137"
 * and can be recognised as the same digits in the wrong place.
 *
 * The fraction is trimmed separately from the whole part on purpose: stripping
 * trailing zeros from the joined string would turn 3,210.00 into "321".
 */
function significantDigits(value: number): string {
  const [whole, fraction] = Math.abs(value).toFixed(2).split('.');
  return (whole + fraction.replace(/0+$/, '')).replace(/^0+/, '');
}

/** Whether deleting exactly one character from `longer` produces `shorter`. */
function isOneDeletionApart(shorter: string, longer: string): boolean {
  if (longer.length - shorter.length !== 1) return false;
  let read = 0;
  let skipped = 0;
  for (let index = 0; index < longer.length; index += 1) {
    if (read < shorter.length && shorter[read] === longer[index]) {
      read += 1;
      continue;
    }
    skipped += 1;
    if (skipped > 1) return false;
  }
  return read === shorter.length;
}

function differingPositions(left: string, right: string): number[] {
  const positions: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) positions.push(index);
  }
  return positions;
}

/**
 * How `current` could have been misread from `suggested`, or null if it could
 * not plausibly have been — which is the answer for most rows, and is the whole
 * point: a hint on every row is a hint on none.
 */
export function classifyMisread(current: number, suggested: number): MisreadKind | null {
  if (current <= 0 || suggested <= 0) return null;

  const seen = significantDigits(current);
  const wanted = significantDigits(suggested);
  if (!seen || !wanted) return null;

  if (seen === wanted) {
    const ratio = Math.max(current, suggested) / Math.min(current, suggested);
    return ratio <= MAX_DECIMAL_SHIFT ? 'decimal-point' : null;
  }

  if (seen.length === wanted.length) {
    const differing = differingPositions(seen, wanted);
    if (
      differing.length === 2 &&
      differing[1] === differing[0] + 1 &&
      seen[differing[0]] === wanted[differing[1]] &&
      seen[differing[1]] === wanted[differing[0]]
    ) {
      return 'digits-swapped';
    }
    return differing.length === 1 ? 'one-digit-different' : null;
  }

  if (isOneDeletionApart(seen, wanted)) return 'digit-missing';
  if (isOneDeletionApart(wanted, seen)) return 'extra-digit';
  return null;
}

/**
 * The rows worth re-reading, given how far out of balance the voucher is.
 *
 * `difference` is total debit minus total credit. A debit row that is too high
 * and a credit row that is too low are both consistent with the same
 * difference, so both sides are considered; usually only one produces a
 * positive amount, and rarely does more than one produce a plausible misreading.
 *
 * Returns only relationships that constrain the digit sequence (STRONG_KINDS),
 * and only while there are few enough of them to constitute pointing at
 * something. Frequently that is nothing at all, which is the correct answer far
 * more often than it looks: red on a row that is right costs more than a missed
 * catch, because the next red one gets ignored too.
 */
export function findImbalanceSuspects(
  rows: readonly ImbalanceCandidateRow[],
  difference: number
): ImbalanceSuspect[] {
  if (!Number.isFinite(difference) || Math.abs(difference) < BALANCED_WITHIN) return [];

  const suspects: ImbalanceSuspect[] = [];
  for (const row of rows) {
    const isDebit = row.entry_type === 'Dr';
    const current = round2(Number(isDebit ? row.debit_amount : row.credit_amount) || 0);
    // A blank row is a row nobody filled in, not a row somebody misread.
    if (current <= 0) continue;

    const suggested = round2(isDebit ? current - difference : current + difference);
    const kind = classifyMisread(current, suggested);
    if (!kind) continue;

    suspects.push({
      transactionId: row.id,
      side: isDebit ? 'debit' : 'credit',
      current,
      suggested,
      kind,
    });
  }

  const evidence = suspects.filter(suspect => STRONG_KINDS.includes(suspect.kind));
  return evidence.length <= MAX_SUSPECTS ? evidence : [];
}

/** Why this row is being questioned, in words a reviewer can check against the photo. */
export function describeMisread(suspect: ImbalanceSuspect): string {
  const money = (value: number) =>
    `Rs. ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const because: Record<MisreadKind, string> = {
    'digit-missing': 'the same digits with one missing',
    'extra-digit': 'the same digits with one extra',
    'decimal-point': 'the same digits with the decimal point moved',
    'digits-swapped': 'the same digits with two swapped',
    'one-digit-different': 'the same amount with one digit different',
  };

  return (
    `This row reads ${money(suspect.current)}. Reading it as ${money(suspect.suggested)} ` +
    `would balance the voucher, and ${money(suspect.current)} is ${because[suspect.kind]} — ` +
    'a common misreading of handwriting. Check it against the image, then click to use it.'
  );
}
