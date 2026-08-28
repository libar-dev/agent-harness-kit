import type { GrokRecordOrigin } from './blocks.js';
import type { GrokTailRecord, GrokTailSourceKind } from './tail-types.js';

/** Compare records by timestamp, source, generation, and byte range. */
export function compareGrokTailRecords(
  left: GrokTailRecord,
  right: GrokTailRecord
): number {
  if (left.effectiveTimestamp !== right.effectiveTimestamp) {
    return left.effectiveTimestamp < right.effectiveTimestamp ? -1 : 1;
  }
  const sourceDifference =
    sourceRank(left.sourceKind) - sourceRank(right.sourceKind);
  if (sourceDifference !== 0) return sourceDifference;
  if (left.generation !== right.generation) {
    return left.generation < right.generation ? -1 : 1;
  }
  if (left.byteStart !== right.byteStart) {
    return left.byteStart < right.byteStart ? -1 : 1;
  }
  return left.byteEnd - right.byteEnd;
}

/** Stable source iteration order used by markers and record ordering. */
export function grokSourceKinds(): readonly GrokTailSourceKind[] {
  return ['updates', 'events'];
}

/** Stable identity key for one normalized source origin. */
export function grokOriginKey(origin: GrokRecordOrigin): string {
  return `${origin.sourceId}:${String(origin.generation)}:${String(origin.byteStart)}:${String(origin.byteEnd)}`;
}

function sourceRank(sourceKind: GrokTailSourceKind): number {
  return sourceKind === 'updates' ? 0 : 1;
}
