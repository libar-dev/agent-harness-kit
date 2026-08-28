import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  reduceSenpiProjection,
} from './blocks.js';
import type { resolveSenpiLeaf, SenpiProjectionResult } from './projection.js';
import type { SenpiTailLeaf } from './tail-types.js';

/** Reconstruct reduction state from previously projected records. */
export function reductionFromRecords(
  records: SenpiProjectionResult['records'],
  current: SenpiProjectionResult
): ReturnType<typeof reduceSenpiProjection> {
  const prior: SenpiProjectionResult = {
    ...current,
    kind: records.length === 0 ? 'empty' : 'projected',
    leafId: records.at(-1)?.entryId ?? null,
    records,
    offPath: [],
    warnings: [],
    complete: true,
  };
  return reduceSenpiProjection(EMPTY_SENPI_BLOCK_REDUCTION_STATE, prior);
}

/** Convert internal leaf resolution to the stable tail result union. */
export function tailLeaf(
  resolution: ReturnType<typeof resolveSenpiLeaf>
): SenpiTailLeaf {
  if (resolution.kind === 'empty') return { kind: 'empty', leafId: null };
  if (resolution.kind === 'resolved') {
    return { kind: 'resolved', leafId: resolution.leafId };
  }
  return { kind: 'invalid', leafId: resolution.leafId };
}
