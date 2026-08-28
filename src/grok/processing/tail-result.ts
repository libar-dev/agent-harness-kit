import type { JsonlCursor, JsonlDelta } from '../../internal/jsonl-cursor.js';
import type {
  GrokSessionTailResult,
  GrokSourceTailResult,
  GrokTailRecord,
  GrokTailSourceKind,
} from './tail-types.js';

/** Build one source-level accounting result from a bounded cursor delta. */
export function grokSourceResult(
  sourceKind: GrokTailSourceKind,
  sourcePath: string,
  previousCursor: JsonlCursor | null,
  delta: JsonlDelta,
  records: readonly GrokTailRecord[]
): GrokSourceTailResult {
  return {
    sourceKind,
    sourcePath,
    status: delta.fileSize === null ? 'missing' : 'read',
    recordCount: records.filter(record => record.sourceKind === sourceKind)
      .length,
    generation: delta.cursor?.generation ?? previousCursor?.generation ?? 0,
    previousByteOffset: previousCursor?.offset ?? 0,
    newByteOffset: delta.cursor?.offset ?? previousCursor?.offset ?? 0,
    fileSize: delta.fileSize,
    reset: delta.reset,
  };
}

/** Apply one explicit from-start generation transition to a neutral delta. */
export function applyGrokFromStartGeneration(
  delta: JsonlDelta,
  previousCursor: JsonlCursor | null,
  fromStart: boolean | undefined
): JsonlDelta {
  if (fromStart !== true || previousCursor === null || delta.cursor === null) {
    return delta;
  }
  return {
    ...delta,
    cursor: {
      ...delta.cursor,
      generation: previousCursor.generation + 1,
    },
  };
}

/** True when any source cursor already committed bytes. */
export function hasPriorGrokBytes(
  cursors: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>
): boolean {
  return Object.values(cursors).some(cursor => (cursor?.offset ?? 0) > 0);
}

/** True when a watch reconcile carries observable records, diagnostics, or resets. */
export function isObservableGrokResult(result: GrokSessionTailResult): boolean {
  return (
    result.records.length > 0 ||
    result.diagnostics.length > 0 ||
    result.resets.length > 0
  );
}
