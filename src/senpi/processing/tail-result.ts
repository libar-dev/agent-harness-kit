import type {
  JsonlCursor,
  JsonlScanStatus,
} from '../../internal/jsonl-cursor.js';
import { SENPI_MARKER_MAX_BYTES, utf8PrettySize } from './accepted-graph.js';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionCheckpointState,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type {} from './checkpoint-types.js';
import {
  computeProjectionMutation,
  type SenpiProjectionMutation,
  type SenpiProjectionRecord,
} from './projection.js';
import { unwrittenCheckpointStatus } from './tail-checkpoint-status.js';
import type { rebuildFromZero } from './tail-resume.js';
import type {
  SenpiSessionTailResult,
  SenpiTailDiagnostic,
  SenpiTailPosition,
} from './tail-types.js';

/**
 * Build position fields and movement from cursor and projection revisions.
 *
 * @param previousCursor - Cursor observed before the bounded scan.
 * @param nextCursor - Cursor reached by the bounded scan.
 * @param previousRevision - Projection revision before reconciliation.
 * @param nextRevision - Projection revision after reconciliation.
 * @returns Previous/next semantic positions and their movement predicate.
 */
export function tailPositionFields(
  previousCursor: JsonlCursor | null,
  nextCursor: JsonlCursor,
  previousRevision: number,
  nextRevision: number
): Pick<SenpiSessionTailResult, 'previousPosition' | 'nextPosition' | 'moved'> {
  const previousPosition = tailPosition(previousCursor, previousRevision);
  const nextPosition = tailPosition(nextCursor, nextRevision);
  return {
    previousPosition,
    nextPosition,
    moved: !positionsEqual(previousPosition, nextPosition),
  };
}

function tailPosition(
  cursor: JsonlCursor | null,
  projectionRevision: number
): SenpiTailPosition {
  return {
    generation: cursor?.generation ?? 0,
    offset: cursor?.offset ?? 0,
    lineNumber: cursor?.lineNumber ?? 1,
    pendingKind: cursor?.pending?.kind ?? null,
    projectionRevision,
  };
}

function positionsEqual(
  left: SenpiTailPosition,
  right: SenpiTailPosition
): boolean {
  return (
    left.generation === right.generation &&
    left.offset === right.offset &&
    left.lineNumber === right.lineNumber &&
    left.pendingKind === right.pendingKind &&
    left.projectionRevision === right.projectionRevision
  );
}

/** Build a safe-stop result that carries bounded rebuild continuation state. */
export function deferredResult(
  sessionPathDigest: string,
  marker: InternalSenpiSessionMarker | null,
  supplied: InternalSenpiSessionCheckpoint | undefined,
  outcome: Extract<
    Awaited<ReturnType<typeof rebuildFromZero>>,
    { kind: 'deferred' }
  >,
  includeOffPath: boolean,
  invalidationMessage: string | null,
  checkpointMode?: 'automatic' | 'manual'
): SenpiSessionTailResult {
  const diagnostics: SenpiTailDiagnostic[] = [...outcome.parsed.diagnostics];
  if (invalidationMessage !== null) {
    diagnostics.push({
      code: 'checkpoint_invalid',
      message: `Saved checkpoint was discarded: ${invalidationMessage}.`,
    });
  }
  const revision = supplied?.revision ?? marker?.revision ?? 0;
  const offset = marker?.offset ?? supplied?.offset ?? 0;
  const baseline = marker ?? supplied;
  const checkpoint: InternalSenpiSessionCheckpoint = {
    sessionPathDigest,
    sessionId:
      outcome.parsed.sessionId ??
      supplied?.sessionId ??
      marker?.sessionId ??
      '',
    device: baseline?.device ?? outcome.progress.cursor.device,
    inode: baseline?.inode ?? outcome.progress.cursor.inode,
    generation: baseline?.generation ?? outcome.progress.cursor.generation,
    offset,
    lineNumber: baseline?.lineNumber ?? 1,
    headDigest: baseline?.headDigest ?? outcome.progress.cursor.headDigest,
    boundaryDigest:
      baseline?.boundaryDigest ?? outcome.progress.cursor.boundaryDigest,
    baseRevision: marker?.revision ?? supplied?.baseRevision ?? 0,
    leafId: marker?.leafId ?? supplied?.leafId ?? null,
    projectedRecordKeys:
      marker?.projectedRecordKeys ?? supplied?.projectedRecordKeys ?? [],
    ...(marker?.projectedRecordCount === undefined
      ? {}
      : { projectedRecordCount: marker.projectedRecordCount }),
    ...(marker?.acceptedEntries === undefined
      ? {}
      : { acceptedEntries: marker.acceptedEntries }),
    pending: marker?.pending ?? supplied?.pending ?? null,
    revision,
    state: {
      inputs: outcome.parsed.inputs,
      records: [],
      offPath: [],
      parseDiagnostics: outcome.parsed.diagnostics,
      diagnostics,
      includeOffPath,
      rebuild: outcome.progress,
    },
  };
  return {
    records: [],
    mutations: [],
    changes: [],
    offPath: [],
    diagnostics,
    leaf:
      checkpoint.leafId === null
        ? { kind: 'empty', leafId: null }
        : { kind: 'resolved', leafId: checkpoint.leafId },
    previousByteOffset: offset,
    nextByteOffset: offset,
    fileSize: outcome.fileSize,
    generation: checkpoint.generation,
    revision,
    reset: false,
    scanStatus: outcome.scanStatus,
    scannedBytes: outcome.scannedBytes,
    scannedLines: outcome.scannedLines,
    ...tailPositionFields(
      outcome.previousCursor,
      outcome.progress.cursor,
      revision,
      revision
    ),
    checkpoint,
    checkpointStatus: unwrittenCheckpointStatus(checkpointMode),
  };
}

/** Compute the externally visible suffix splice, including overflow fallback. */
export function spliceMutation(
  previousKeys: readonly string[],
  previousCount: number | undefined,
  mutationRecords: readonly SenpiProjectionRecord[],
  visibleRecords: readonly SenpiProjectionRecord[]
): SenpiProjectionMutation | null {
  if (previousKeys.length === 0 && (previousCount ?? 0) > 0) {
    if (visibleRecords.length === 0) return null;
    return {
      index: previousCount ?? 0,
      deleteCount: 0,
      records: visibleRecords,
      removedRecordKeys: [],
    };
  }
  return computeProjectionMutation(previousKeys, mutationRecords);
}

/** Remove optional marker state in deterministic size-priority order. */
export function shrinkCheckpoint(
  checkpoint: InternalSenpiSessionCheckpoint
): InternalSenpiSessionCheckpoint {
  if (utf8PrettySize(markerProbe(checkpoint)) <= SENPI_MARKER_MAX_BYTES) {
    return checkpoint;
  }
  const { acceptedEntries: _omitGraph, ...withoutGraphFields } = checkpoint;
  const withoutGraph: InternalSenpiSessionCheckpoint = withoutGraphFields;
  if (utf8PrettySize(markerProbe(withoutGraph)) <= SENPI_MARKER_MAX_BYTES) {
    return withoutGraph;
  }
  return {
    ...withoutGraph,
    projectedRecordKeys: [],
    projectedRecordCount:
      checkpoint.projectedRecordCount ?? checkpoint.projectedRecordKeys.length,
  };
}

/** Build an unchanged incremental result without rewriting the marker. */
export function unchangedResult(
  supplied: InternalSenpiSessionCheckpoint,
  state: InternalSenpiSessionCheckpointState,
  cursor: JsonlCursor,
  fileSize: number,
  revision: number,
  scanStatus: JsonlScanStatus,
  scannedBytes: number,
  scannedLines: number,
  checkpointMode?: 'automatic' | 'manual'
): SenpiSessionTailResult {
  return {
    records: state.records,
    mutations: [],
    changes: [],
    offPath: state.offPath,
    diagnostics: state.diagnostics,
    leaf:
      supplied.leafId === null
        ? { kind: 'empty', leafId: null }
        : { kind: 'resolved', leafId: supplied.leafId },
    previousByteOffset: cursor.offset,
    nextByteOffset: cursor.offset,
    fileSize,
    generation: cursor.generation,
    revision,
    reset: false,
    scanStatus,
    scannedBytes,
    scannedLines,
    ...tailPositionFields(cursor, cursor, revision, revision),
    checkpoint: { ...supplied, revision, state },
    checkpointStatus: unwrittenCheckpointStatus(checkpointMode),
  };
}

function markerProbe(
  checkpoint: InternalSenpiSessionCheckpoint
): Record<string, unknown> {
  return {
    sessionPathDigest: checkpoint.sessionPathDigest,
    sessionId: checkpoint.sessionId,
    device: checkpoint.device,
    inode: checkpoint.inode,
    generation: checkpoint.generation,
    offset: checkpoint.offset,
    lineNumber: checkpoint.lineNumber,
    headDigest: checkpoint.headDigest,
    boundaryDigest: checkpoint.boundaryDigest,
    revision: (checkpoint.revision ?? 0) + 1,
    leafId: checkpoint.leafId,
    projectedRecordKeys: checkpoint.projectedRecordKeys,
    markerVersion: 1,
    pending: checkpoint.pending ?? null,
    ...(checkpoint.projectedRecordCount === undefined
      ? {}
      : { projectedRecordCount: checkpoint.projectedRecordCount }),
    ...(checkpoint.acceptedEntries === undefined
      ? {}
      : { acceptedEntries: checkpoint.acceptedEntries }),
  };
}
