import {
  byteCursorChanged,
  checkpointRevision,
} from '../../internal/incremental.js';
import { fitAutomaticExtras, graphFromIndex } from './accepted-graph.js';
import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  reduceSenpiProjection,
} from './blocks.js';
import type { InternalSenpiSessionCheckpointState } from './checkpoint-internal-types.js';
import {
  projectSenpiBranch,
  resolveSenpiLeaf,
  type SenpiProjectionResult,
} from './projection.js';
import {
  persistSenpiTailCheckpoint,
  senpiProjectionExceedsResultLimit,
} from './tail-checkpoint-status.js';
import { throwMissingSenpiSessionSource } from './missing-session-source.js';
import { hasUnsafeProjectionFailure, invalidProjection } from './tail-parse.js';
import type { SenpiProjectRequest } from './tail-project-request.js';
import { reductionFromRecords, tailLeaf } from './tail-projection-result.js';
import {
  shrinkCheckpoint,
  spliceMutation,
  tailPositionFields,
} from './tail-result.js';
import type {
  SenpiSessionSpliceMutation,
  SenpiSessionTailResult,
  SenpiTailDiagnostic,
} from './tail-types.js';

/** Project parsed entries, build one splice, and commit only safe state. */
export async function projectAndCommit(
  args: SenpiProjectRequest
): Promise<SenpiSessionTailResult> {
  const {
    parsed,
    graphSeeds,
    previousKeys,
    previousCount,
    includeOffPath,
    reset,
    marker,
    supplied,
    delta,
  } = args;
  const diagnostics: SenpiTailDiagnostic[] = [...parsed.diagnostics];
  let invalidationMessage = args.invalidationMessage;
  const sessionId =
    parsed.sessionId ?? supplied?.sessionId ?? marker?.sessionId ?? null;
  if (
    reset &&
    supplied !== undefined &&
    sessionId !== null &&
    sessionId !== supplied.sessionId
  ) {
    invalidationMessage = 'session header id changed';
  }
  if (invalidationMessage !== null) {
    diagnostics.push({
      code: 'checkpoint_invalid',
      message: `Saved checkpoint was discarded: ${invalidationMessage}.`,
    });
  }

  const baseRevision = supplied?.revision ?? marker?.revision ?? 0;
  const previousRecords = reset ? [] : (supplied?.state?.records ?? []);
  const previousByteOffset = reset ? 0 : (args.priorCursor?.offset ?? 0);
  const seedIds = new Set(
    graphSeeds.map(input =>
      input.kind === 'known' || input.kind === 'unknown' ? input.entry.id : ''
    )
  );
  const rawResolution = resolveSenpiLeaf(parsed.inputs);
  const terminalInvalid = parsed.terminalMalformed;
  const projection = terminalInvalid
    ? invalidProjection(rawResolution)
    : projectSenpiBranch(
        parsed.inputs,
        rawResolution.leafId,
        args.options.includeOffPath === undefined
          ? {}
          : { includeOffPath: args.options.includeOffPath }
      );
  diagnostics.push(
    ...projection.warnings.map(warning => ({
      code: warning.code,
      message: warning.message,
      ...(warning.entryId === undefined ? {} : { entryId: warning.entryId }),
      ...(warning.relatedId === undefined
        ? {}
        : { relatedId: warning.relatedId }),
    }))
  );

  const visibleRecords =
    seedIds.size > 0
      ? projection.records.filter(record => !seedIds.has(record.entryId))
      : projection.records;
  const visibleProjection: SenpiProjectionResult =
    seedIds.size > 0
      ? {
          ...projection,
          kind:
            projection.kind === 'invalid'
              ? 'invalid'
              : visibleRecords.length === 0
                ? 'empty'
                : 'projected',
          records: visibleRecords,
        }
      : projection;
  const mutation = spliceMutation(
    previousKeys,
    previousCount,
    seedIds.size > 0 ? visibleRecords : projection.records,
    visibleRecords
  );
  const nextCursor = delta.cursor;
  const fileSize = delta.fileSize;
  if (nextCursor === null || fileSize === null) {
    throwMissingSenpiSessionSource(args.sessionPath);
  }
  const stateChanged =
    mutation !== null || byteCursorChanged(args.priorCursor, nextCursor);
  const revision = checkpointRevision(baseRevision, stateChanged);
  const mutations: readonly SenpiSessionSpliceMutation[] =
    mutation === null ? [] : [{ ...mutation, baseRevision, revision }];
  const previousReduction =
    reset || seedIds.size > 0
      ? { state: EMPTY_SENPI_BLOCK_REDUCTION_STATE }
      : previousRecords.length > 0
        ? reductionFromRecords(previousRecords, projection)
        : { state: EMPTY_SENPI_BLOCK_REDUCTION_STATE };
  const reduction = reduceSenpiProjection(
    previousReduction.state,
    visibleProjection
  );
  const fullKeys =
    seedIds.size > 0
      ? [...previousKeys, ...visibleRecords.map(record => record.key)]
      : projection.records.map(record => record.key);
  const extras = fitAutomaticExtras(
    fullKeys,
    projection.kind === 'invalid'
      ? undefined
      : graphFromIndex(projection.index),
    seedIds.size > 0
      ? (previousCount ?? previousKeys.length) + visibleRecords.length
      : projection.records.length
  );
  const state: InternalSenpiSessionCheckpointState = {
    inputs: parsed.inputs,
    records: visibleRecords,
    offPath: projection.offPath.filter(record => !seedIds.has(record.entryId)),
    parseDiagnostics: parsed.diagnostics,
    diagnostics,
    includeOffPath,
  };
  const checkpoint = shrinkCheckpoint({
    sessionPathDigest: args.sessionPathDigest,
    sessionId: sessionId ?? '',
    device: nextCursor.device,
    inode: nextCursor.inode,
    generation: nextCursor.generation,
    offset: nextCursor.offset,
    lineNumber: nextCursor.lineNumber,
    headDigest: nextCursor.headDigest,
    boundaryDigest: nextCursor.boundaryDigest,
    baseRevision: marker?.revision ?? supplied?.baseRevision ?? 0,
    leafId: terminalInvalid ? null : projection.leafId,
    pending: nextCursor.pending ?? null,
    revision,
    state,
    ...extras,
  });
  const blocksCommit =
    hasUnsafeProjectionFailure(
      diagnostics,
      projection,
      nextCursor.pending ?? null
    ) ||
    diagnostics.some(
      item => item.code === 'missing_parent' || item.code === 'duplicate_id'
    );
  const exceedsResultLimit = senpiProjectionExceedsResultLimit(
    visibleRecords,
    args.options.maxResultBytes,
    args.options.maxResultRecords
  );
  const checkpointStatus = await persistSenpiTailCheckpoint({
    sessionPath: args.sessionPath,
    checkpoint,
    markerOptions: args.markerOptions,
    checkpointMode: args.options.checkpointMode,
    stateChanged,
    blocksCommit,
    exceedsResultLimit,
  });
  return {
    records: visibleRecords,
    mutations,
    changes: reduction.changes,
    offPath: projection.offPath.filter(record => !seedIds.has(record.entryId)),
    diagnostics,
    leaf: terminalInvalid
      ? { kind: 'invalid', leafId: null }
      : tailLeaf(rawResolution),
    previousByteOffset,
    nextByteOffset: nextCursor.offset,
    fileSize,
    generation: nextCursor.generation,
    revision,
    reset,
    scanStatus: delta.scanStatus,
    scannedBytes: delta.scannedBytes,
    scannedLines: delta.scannedLines,
    ...tailPositionFields(args.priorCursor, nextCursor, baseRevision, revision),
    checkpoint,
    checkpointStatus,
  };
}
