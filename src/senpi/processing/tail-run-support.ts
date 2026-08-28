import {
  jsonlCursorNeedsReset,
  type JsonlCursor,
  type JsonlDelta,
} from '../../internal/jsonl-cursor.js';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';
import type { ParsedLines } from './tail-parse.js';
import type { SenpiProjectRequest } from './tail-project-request.js';
import { finishRebuild, type SenpiRebuildPrior } from './tail-rebuild.js';
import type { SenpiScanLimits } from './tail-resume.js';
import type {
  SenpiSessionTailOptions,
  SenpiSessionTailResult,
} from './tail-types.js';

const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SCAN_LINES = 10_000;

/** Private scan/rebuild overrides for unbarreled integration tests. */
export interface SenpiInternalSessionTailOptions extends SenpiSessionTailOptions {
  readonly maxRebuildBytes?: number;
  readonly maxRebuildLines?: number;
  readonly checkpoint?: InternalSenpiSessionCheckpoint;
}

/** Resolve the initial invalidation message and reset baseline. */
export function initialTailBaseline(
  fromStart: boolean,
  supplied: InternalSenpiSessionCheckpoint | undefined,
  marker: InternalSenpiSessionMarker | null,
  markerError: string | null
): { readonly message: string | null; readonly reset: boolean } {
  const hasBaseline =
    supplied !== undefined || marker !== null || markerError !== null;
  const message =
    markerError ?? (fromStart && hasBaseline ? 'fromStart requested' : null);
  return { message, reset: message !== null };
}

/** Decide whether marker-only state rebuilds now or first reports invalidation. */
export async function markerOnlyRebuildDecision(
  sessionPath: string,
  resetBaseline: boolean,
  hasPriorState: boolean,
  marker: InternalSenpiSessionMarker | null,
  cursor: JsonlCursor | null
): Promise<'none' | 'rebuild' | 'stale'> {
  if (
    resetBaseline ||
    hasPriorState ||
    marker?.acceptedEntries !== undefined ||
    cursor === null
  )
    return 'none';
  return (await jsonlCursorNeedsReset(sessionPath, cursor))
    ? 'stale'
    : 'rebuild';
}

/** Reject a caller-held checkpoint produced for another session path. */
export function assertCheckpointPath(
  supplied: InternalSenpiSessionCheckpoint | undefined,
  sessionPathDigest: string
): void {
  if (
    supplied !== undefined &&
    supplied.sessionPathDigest !== sessionPathDigest
  ) {
    throw new Error('Senpi session checkpoint does not match the session path');
  }
}

/** Apply the caller-held generation when an explicit from-start scan resets. */
export function normalizeFromStartDelta(
  delta: JsonlDelta,
  fromStart: boolean,
  provided: InternalSenpiSessionCheckpoint | undefined
): JsonlDelta {
  if (!fromStart || provided === undefined || delta.cursor === null)
    return delta;
  return {
    ...delta,
    cursor: { ...delta.cursor, generation: provided.generation + 1 },
  };
}

/** Resume a private rebuild already carried by the opaque checkpoint state. */
export function resumeCarriedRebuild(args: {
  readonly sessionPath: string;
  readonly options: SenpiInternalSessionTailOptions;
  readonly markerOptions: SenpiSessionCheckpointCommitOptions;
  readonly digest: string;
  readonly marker: InternalSenpiSessionMarker | null;
  readonly supplied: InternalSenpiSessionCheckpoint | undefined;
  readonly cursor: JsonlCursor | null;
  readonly limits: SenpiScanLimits;
  readonly includeOffPath: boolean;
  readonly message: string | null;
  readonly resetBaseline: boolean;
}): Promise<SenpiSessionTailResult> | null {
  const progress = args.supplied?.state?.rebuild;
  if (progress === undefined || args.resetBaseline) return null;
  const state = args.supplied?.state;
  return finishRebuild(
    args.sessionPath,
    args.options,
    args.markerOptions,
    args.digest,
    args.marker,
    args.supplied,
    args.cursor,
    {
      inputs: state?.inputs ?? [],
      diagnostics: state?.parseDiagnostics ?? [],
      sessionId: args.supplied?.sessionId ?? args.marker?.sessionId ?? null,
      scannedBytes: progress.scannedBytes,
      scannedLines: progress.scannedLines,
    },
    args.limits,
    args.includeOffPath,
    args.message,
    false
  );
}

/** Rebuild marker-only state from byte zero or return a bounded continuation. */
export function rebuildTail(
  path: string,
  options: SenpiInternalSessionTailOptions,
  markerOptions: SenpiSessionCheckpointCommitOptions,
  digest: string,
  marker: InternalSenpiSessionMarker | null,
  supplied: InternalSenpiSessionCheckpoint | undefined,
  limits: SenpiScanLimits,
  includeOffPath: boolean,
  message: string | null
): Promise<SenpiSessionTailResult> {
  return finishRebuild(
    path,
    options,
    markerOptions,
    digest,
    marker,
    supplied,
    null,
    emptyRebuildPrior(supplied, marker),
    limits,
    includeOffPath,
    message,
    false
  );
}

/** Assemble a typed projection request without duplicating orchestration fields. */
export function projectRequest(
  sessionPath: string,
  options: SenpiInternalSessionTailOptions,
  markerOptions: SenpiSessionCheckpointCommitOptions,
  sessionPathDigest: string,
  marker: InternalSenpiSessionMarker | null,
  supplied: InternalSenpiSessionCheckpoint | undefined,
  delta: SenpiProjectRequest['delta'],
  parsed: ParsedLines,
  includeOffPath: boolean,
  reset: boolean,
  invalidationMessage: string | null,
  priorCursor: JsonlCursor | null,
  graphSeeds: SenpiProjectRequest['graphSeeds'],
  previousKeys: readonly string[],
  previousCount: number | undefined,
  limits: SenpiScanLimits
): SenpiProjectRequest {
  return {
    sessionPath,
    options,
    markerOptions,
    sessionPathDigest,
    marker,
    supplied,
    delta,
    parsed,
    includeOffPath,
    reset,
    invalidationMessage,
    priorCursor,
    graphSeeds,
    previousKeys,
    previousCount,
    limits,
  };
}

/** Resolve fixed production limits or private test overrides. */
export function resolveTailLimits(
  options: SenpiInternalSessionTailOptions
): SenpiScanLimits {
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  return {
    ...(options.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: options.maxLineBytes }),
    maxScanBytes,
    maxScanLines,
    maxRebuildBytes: options.maxRebuildBytes ?? maxScanBytes * 4,
    maxRebuildLines: options.maxRebuildLines ?? maxScanLines * 4,
  };
}

/** Select only marker-store options from public tail options. */
export function tailCheckpointOptions(
  options: SenpiSessionTailOptions
): SenpiSessionCheckpointCommitOptions {
  return {
    ...(options.markerDir === undefined
      ? {}
      : { markerDir: options.markerDir }),
    ...(options.allowedMarkerRoots === undefined
      ? {}
      : { allowedMarkerRoots: options.allowedMarkerRoots }),
  };
}

/** Create empty aggregate state for an exact rebuild. */
export function emptyRebuildPrior(
  supplied: InternalSenpiSessionCheckpoint | undefined,
  marker: InternalSenpiSessionMarker | null
): SenpiRebuildPrior {
  return {
    inputs: [],
    diagnostics: [],
    sessionId: supplied?.sessionId ?? marker?.sessionId ?? null,
    scannedBytes: 0,
    scannedLines: 0,
  };
}
