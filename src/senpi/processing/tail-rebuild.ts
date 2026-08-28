import type { JsonlCursor } from '../../internal/jsonl-cursor.js';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';
import type { SenpiEntryParseResult } from './parse.js';
import { projectAndCommit } from './tail-project.js';
import { deferredResult } from './tail-result.js';
import { rebuildFromZero, type SenpiScanLimits } from './tail-resume.js';
import type { SenpiInternalSessionTailOptions } from './tail-run-support.js';
import type {
  SenpiSessionTailResult,
  SenpiTailDiagnostic,
} from './tail-types.js';

/** Accumulated parse state at the start of a bounded rebuild pass. */
export interface SenpiRebuildPrior {
  readonly inputs: readonly SenpiEntryParseResult[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly sessionId: string | null;
  readonly scannedBytes: number;
  readonly scannedLines: number;
}

/** Finish or defer an exact bounded rebuild from byte zero. */
export async function finishRebuild(
  sessionPath: string,
  options: SenpiInternalSessionTailOptions,
  markerOptions: SenpiSessionCheckpointCommitOptions,
  sessionPathDigest: string,
  marker: InternalSenpiSessionMarker | null,
  supplied: InternalSenpiSessionCheckpoint | undefined,
  start: JsonlCursor | null,
  prior: SenpiRebuildPrior,
  limits: SenpiScanLimits,
  includeOffPath: boolean,
  invalidationMessage: string | null,
  reset: boolean
): Promise<SenpiSessionTailResult> {
  const outcome = await rebuildFromZero(sessionPath, start, prior, limits);
  if (outcome.kind === 'deferred') {
    return deferredResult(
      sessionPathDigest,
      marker,
      supplied,
      outcome,
      includeOffPath,
      invalidationMessage
    );
  }
  const generation =
    marker?.generation ?? supplied?.generation ?? outcome.cursor.generation;
  return projectAndCommit({
    sessionPath,
    options,
    markerOptions,
    sessionPathDigest,
    marker,
    supplied,
    delta: {
      cursor: { ...outcome.cursor, generation },
      fileSize: outcome.fileSize,
      reset: reset || outcome.reset,
    },
    parsed: outcome.parsed,
    includeOffPath,
    reset: reset || outcome.reset,
    invalidationMessage: outcome.reset
      ? (invalidationMessage ?? 'source identity or committed content changed')
      : invalidationMessage,
    priorCursor: start,
    graphSeeds: [],
    previousKeys: reset
      ? []
      : (supplied?.state?.records.map(record => record.key) ??
        marker?.projectedRecordKeys ??
        supplied?.projectedRecordKeys ??
        []),
    previousCount: reset ? undefined : marker?.projectedRecordCount,
    limits,
  });
}
