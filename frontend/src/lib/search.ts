export type SearchableValue = string | number | boolean | Date | null | undefined;

/**
 * Produces a stable search representation that ignores case, accents,
 * punctuation, and repeated whitespace.
 */
export function normalizeSearchText(value: SearchableValue): string {
  if (value === null || value === undefined) return '';

  const text = value instanceof Date ? value.toISOString() : String(value);

  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Matches every normalized query token against the combined visible fields.
 * Tokens may match different fields, e.g. "john test organization" can match
 * a user's name and organization at the same time.
 */
export function matchesSearch(
  query: SearchableValue,
  fields: readonly SearchableValue[],
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const haystack = fields
    .map(normalizeSearchText)
    .filter(Boolean)
    .join(' ');

  if (!haystack) return false;

  return normalizedQuery.split(' ').every(token => haystack.includes(token));
}

/** Filters a collection using the same normalized multi-field matching rules. */
export function filterBySearch<T>(
  items: readonly T[],
  query: SearchableValue,
  getFields: (item: T) => readonly SearchableValue[],
): T[] {
  if (!normalizeSearchText(query)) return [...items];
  return items.filter(item => matchesSearch(query, getFields(item)));
}
