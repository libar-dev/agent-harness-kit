/**
 * Internal string ordering helper shared across the processing modules.
 *
 * Several processing modules sort by ISO timestamps, filenames, or stable IDs.
 * They all need the same lexicographic comparator, so it lives here once rather
 * than being copy-pasted per module. This is an internal utility and is
 * deliberately NOT re-exported from `index.ts` (the public processing barrel).
 */

/**
 * Lexicographic comparator returning -1, 0, or 1.
 *
 * Suitable for `Array.prototype.sort` over strings (timestamps, filenames,
 * stable IDs). Returns a normalized {-1, 0, 1} rather than relying on
 * subtraction, which is undefined for strings.
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
