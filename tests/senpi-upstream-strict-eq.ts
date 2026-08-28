/**
 * Lossless strict equality: Object.is, all own keys (incl. symbols), array holes.
 * Arrays compare every Reflect.ownKeys entry except intrinsic `length`.
 */

function comparableKeys(
  value: unknown,
  isArr: boolean
): readonly PropertyKey[] {
  if (typeof value !== 'object' || value === null) return [];
  return Reflect.ownKeys(value).filter(k => !(isArr && k === 'length'));
}

function sameKeySet(
  a: readonly PropertyKey[],
  b: readonly PropertyKey[]
): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const k of a) {
    if (!setB.has(k)) return false;
  }
  return true;
}

export function strictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === 'bigint') return a === b;
  if (typeof a !== 'object') return false;
  if (typeof b !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  const keysA = comparableKeys(a, aArr);
  const keysB = comparableKeys(b, bArr);
  if (!sameKeySet(keysA, keysB)) return false;

  for (const key of keysA) {
    if (!strictEqual(Reflect.get(a, key), Reflect.get(b, key))) return false;
  }
  return true;
}
