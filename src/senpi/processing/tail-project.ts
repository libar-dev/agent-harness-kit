import {
  byteCursorChanged,
  checkpointRevision,
} from '../../internal/incremental.js';
import type { JsonlCursor } from '../../internal/jsonl-cursor.js';
import { fitAutomaticExtras, graphFromIndex } from './accepted-graph.js';
import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  reduceSenpiProjection,
} from './blocks.js';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionCheckpointState,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';
import { commitSenpiSessionCheckpointInternal } from './checkpoint-write.js';
import type { SenpiEntryParseResult } from './parse.js';
import {
  projectSenpiBranch,
  resolveSenpiLeaf,
  type SenpiProjectionResult,
} from './projection.js';
import {
  hasUnsafeProjectionFailure,
  invalidProjection,
  type ParsedLines,
} from './tail-parse.js';
import { reductionFromRecords, tailLeaf } from './tail-projection-result.js';
import { shrinkCheckpoint, spliceMutation } from './tail-result.js';
import type { SenpiScanLimits } from './tail-resume.js';
import type { SenpiInternalSessionTailOptions } from './tail-run-support.js';
import type {
  SenpiSessionSpliceMutation,
  SenpiSessionTailResult,
  SenpiTailDiagnostic,
} from './tail-types.js';

/** Complete inputs for projection and optional automatic marker commit. */
export interface SenpiProjectRequest {
  readonly sessionPath: string;
  readonly options: SenpiInternalSessionTailOptions;
  readonly markerOptions: SenpiSessionCheckpointCommitOptions;
  readonly sessionPathDigest: string;
  readonly marker: InternalSenpiSessionMarker | null;
  readonly supplied: InternalSenpiSessionCheckpoint | undefined;
  readonly delta: {
    readonly cursor: JsonlCursor | null;
    readonly fileSize: number | null;
    readonly reset: boolean;
  };
  readonly parsed: ParsedLines;
  readonly includeOffPath: boolean;
  readonly reset: boolean;
  readonly invalidationMessage: string | null;
  readonly priorCursor: JsonlCursor | null;
  readonly graphSeeds: readonly SenpiEntryParseResult[];
  readonly previousKeys: readonly string[];
  readonly previousCount: number | undefined;
  readonly limits: SenpiScanLimits;
}

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
    throw new Error(
      `Missing required Senpi session source '${args.sessionPath}'`
    );
  }
  const stateChanged =
    reset ||
    mutation !== null ||
    byteCursorChanged(args.priorCursor, nextCursor);
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
  if (
    args.options.checkpointMode !== 'manual' &&
    stateChanged &&
    !blocksCommit
  ) {
    await commitSenpiSessionCheckpointInternal(
      args.sessionPath,
      checkpoint,
      args.markerOptions
    );
  }
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
    checkpoint,
  };
}
