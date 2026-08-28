import type { SenpiEntryParseResult } from './parse.js';
import type { SenpiTreeIndex } from './projection.js';

/** Inclusive byte cap for a whole marker file (FileHandle read and write). */
export const SENPI_MARKER_MAX_BYTES = 1024 * 1024;
/** Maximum accepted-graph entries that may be persisted. */
export const SENPI_GRAPH_MAX_ENTRIES = 2048;
/** Maximum UTF-8 bytes of a serialized accepted-graph array. */
export const SENPI_GRAPH_MAX_BYTES = 256 * 1024;
/** Maximum persisted projected-record keys. */
export const SENPI_KEYS_MAX_ENTRIES = 2048;
/** Maximum UTF-8 bytes of a serialized projected-record key array. */
export const SENPI_KEYS_MAX_BYTES = 256 * 1024;
/** Rebuild scans allowed inside one tail call. */
export const SENPI_REBUILD_MAX_PASSES = 4;

/** One accepted tree node in marker acceptance order. */
export type SenpiAcceptedGraphEntry = {
  readonly id: string;
  readonly p: string | null;
  readonly c?: 1;
};

/** Validated optional graph. Invalid or oversize graphs are absent-state. */
export type SenpiAcceptedGraph =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly entries: readonly SenpiAcceptedGraphEntry[];
    };

/** Required keys after applying the overflow bound. */
export type SenpiProjectedKeys = {
  readonly keys: readonly string[];
  readonly overflow: boolean;
};

/**
 * UTF-8 size of compact JSON. Used for graph/key caps, not pretty-printed
 * marker files (those use {@link utf8PrettySize}).
 */
export function utf8JsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** UTF-8 size of the on-disk pretty-printed marker payload. */
export function utf8PrettySize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2));
}

/** True for finite safe integer values greater than or equal to zero. */
export function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse optional `acceptedEntries`. Invalid or oversize input is absent-state
 * and is never trusted for incremental resume.
 */
export function parseAcceptedEntries(value: unknown): SenpiAcceptedGraph {
  if (value === undefined) return { kind: 'absent' };
  if (!Array.isArray(value)) return { kind: 'absent' };
  if (value.length > SENPI_GRAPH_MAX_ENTRIES) return { kind: 'absent' };
  if (utf8JsonSize(value) > SENPI_GRAPH_MAX_BYTES) return { kind: 'absent' };
  const seen = new Set<string>();
  const entries: SenpiAcceptedGraphEntry[] = [];
  for (const item of value) {
    const parsed = parseGraphEntry(item, seen);
    if (parsed === undefined) return { kind: 'absent' };
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return { kind: 'present', entries };
}

/**
 * Require `projectedRecordKeys` as a string array. Over-cap arrays become
 * `[]` with `overflow: true` so downlevel readers see an empty key list.
 */
export function parseProjectedRecordKeys(
  value: unknown
): SenpiProjectedKeys | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(entry => typeof entry === 'string')) return undefined;
  if (
    value.length > SENPI_KEYS_MAX_ENTRIES ||
    utf8JsonSize(value) > SENPI_KEYS_MAX_BYTES
  ) {
    return { keys: [], overflow: true };
  }
  return { keys: value, overflow: false };
}

/** Optional count: safe integer, or undefined when absent/invalid. */
export function parseProjectedRecordCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isSafeNonnegativeInteger(value)) return undefined;
  return value;
}

/**
 * True when count matches nonempty keys, or when keys overflowed to `[]`.
 * Inconsistent pairs drop the count (keys remain authoritative).
 */
export function consistentProjectedRecordCount(
  keys: readonly string[],
  overflow: boolean,
  count: number | undefined
): number | undefined {
  if (keys.length === 0) return count;
  if (count === undefined) return overflow ? undefined : keys.length;
  if (overflow) return count;
  return count === keys.length ? count : undefined;
}

/** Leaf is null or a graph member. Empty graphs only accept a null leaf. */
export function graphLeafMember(
  graph: SenpiAcceptedGraph,
  leafId: string | null
): boolean {
  if (graph.kind === 'absent') return true;
  if (leafId === null) return true;
  return graph.entries.some(entry => entry.id === leafId);
}

/** Compact write form. Returns null when the graph exceeds either cap. */
export function encodeAcceptedEntries(
  entries: readonly SenpiAcceptedGraphEntry[]
): readonly SenpiAcceptedGraphEntry[] | null {
  if (entries.length > SENPI_GRAPH_MAX_ENTRIES) return null;
  if (utf8JsonSize(entries) > SENPI_GRAPH_MAX_BYTES) return null;
  return entries;
}

/** Automatic writer extras: omit an over-cap graph; keys become `[]` on overflow. */
export function fitAutomaticExtras(
  keys: readonly string[],
  graph: readonly SenpiAcceptedGraphEntry[] | undefined,
  count: number
): {
  readonly projectedRecordKeys: readonly string[];
  readonly projectedRecordCount?: number;
  readonly acceptedEntries?: readonly SenpiAcceptedGraphEntry[];
} {
  const bounded = boundProjectedRecordKeys(keys);
  const encoded = graph === undefined ? null : encodeAcceptedEntries(graph);
  return {
    projectedRecordKeys: bounded.keys,
    ...(bounded.overflow ? { projectedRecordCount: count } : {}),
    ...(encoded === null ? {} : { acceptedEntries: encoded }),
  };
}

/** Keys stay as-is when in bound; otherwise `[]`. */
export function boundProjectedRecordKeys(
  keys: readonly string[]
): SenpiProjectedKeys {
  if (
    keys.length > SENPI_KEYS_MAX_ENTRIES ||
    utf8JsonSize(keys) > SENPI_KEYS_MAX_BYTES
  ) {
    return { keys: [], overflow: true };
  }
  return { keys, overflow: false };
}

/** Build the compact accepted graph from a finished tree index. */
export function graphFromIndex(
  index: SenpiTreeIndex
): readonly SenpiAcceptedGraphEntry[] {
  return index.appendOrder.map(id => {
    const entry = index.byId.get(id);
    const parentId = index.parentById.get(id) ?? null;
    if (entry?.type === 'compaction') {
      return { id, p: parentId, c: 1 as const };
    }
    return { id, p: parentId };
  });
}

/**
 * Parent-resolution seeds. Compaction tags stay topology-only; prefix
 * content is never reconstructed from the graph.
 */
export function seedAcceptedGraph(
  entries: readonly SenpiAcceptedGraphEntry[]
): readonly SenpiEntryParseResult[] {
  return entries.map(entry => ({
    kind: 'unknown' as const,
    tag: 'accepted_parent',
    entry: {
      type: 'accepted_parent',
      id: entry.id,
      parentId: entry.p,
      timestamp: '1970-01-01T00:00:00.000Z',
    },
    raw: { type: 'accepted_parent', id: entry.id },
  }));
}

/**
 * True when every new tree entry is a linear continuation of `leafId`.
 * Branch, compaction, duplicate, or missing parent forces a rebuild.
 */
export function isPureAppendDelta(
  graph: readonly SenpiAcceptedGraphEntry[],
  leafId: string | null,
  delta: readonly SenpiEntryParseResult[]
): boolean {
  const known = new Set(graph.map(entry => entry.id));
  let leaf = leafId ?? graph.at(-1)?.id ?? null;
  for (const input of delta) {
    if (input.kind === 'invalid') continue;
    const entry = input.entry;
    if (entry.type === 'session') continue;
    if (entry.id.length === 0) return false;
    if (known.has(entry.id)) return false;
    const parentId =
      'parentId' in entry && typeof entry.parentId === 'string'
        ? entry.parentId
        : 'parentId' in entry && entry.parentId === null
          ? null
          : undefined;
    if (parentId === undefined) return false;
    if (parentId !== null && !known.has(parentId)) return false;
    if (entry.type === 'compaction') return false;
    if (leaf !== null && parentId !== leaf) return false;
    if (leaf === null && parentId !== null) return false;
    known.add(entry.id);
    leaf = entry.id;
  }
  return true;
}

function parseGraphEntry(
  value: unknown,
  seen: ReadonlySet<string>
): SenpiAcceptedGraphEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
    return undefined;
  }
  const parent = parentField(value);
  if (parent === undefined) return undefined;
  if (typeof parent === 'string' && !seen.has(parent)) return undefined;
  const compaction = compactionTag(value['c'] ?? value['compaction']);
  if (compaction === undefined) return undefined;
  return compaction ? { id, p: parent, c: 1 } : { id, p: parent };
}

function parentField(
  value: Record<string, unknown>
): string | null | undefined {
  const hasParentId = Object.hasOwn(value, 'parentId');
  const hasP = Object.hasOwn(value, 'p');
  if (!hasParentId && !hasP) return undefined;
  const parentId = hasParentId ? asParent(value['parentId']) : undefined;
  const compact = hasP ? asParent(value['p']) : undefined;
  if (hasParentId && parentId === undefined) return undefined;
  if (hasP && compact === undefined) return undefined;
  if (hasParentId && hasP && parentId !== compact) return undefined;
  if (hasP) return compact ?? null;
  return parentId ?? null;
}

function asParent(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function compactionTag(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  if (value === 1 || value === true) return true;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
