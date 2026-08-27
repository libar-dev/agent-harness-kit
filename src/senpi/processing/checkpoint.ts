import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { withMarkerLock } from '../../internal/marker-lock.js';
import {
  createMarkerPathDigest,
  hasErrorCode,
  resolveAllowedMarkerDir,
  sanitizeMarkerBase,
  writePrivateJson,
} from '../../internal/marker-store.js';
import { checkpointRevision } from '../../internal/incremental.js';
import { StaleCheckpointConflict } from '../../processing/stale-checkpoint-conflict.js';
import type { SenpiEntryParseResult } from './parse.js';
import type {
  SenpiOffPathRecord,
  SenpiProjectionRecord,
} from './projection.js';
import type { SenpiTailDiagnostic } from './tail.js';

export {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  isStaleCheckpointConflict,
} from '../../processing/stale-checkpoint-conflict.js';

/** On-disk marker schema version persisted as `markerVersion`. */
export const SENPI_MARKER_VERSION = 1;

const MARKER_ROOTS_ENV = 'SENPI_TAIL_MARKER_ROOTS';

/**
 * Persisted senpi session checkpoint marker.
 *
 * Identity fields use the jsonl-cursor vocabulary: `device`/`inode` are
 * decimal strings, `generation` counts identity or content resets, and the
 * head/boundary digests are SHA-256 hex of the committed prefix windows.
 * This module never parses session entries or chooses a branch leaf.
 */
export interface SenpiSessionMarker {
  readonly sessionPathDigest: string;
  readonly sessionId: string;
  readonly device: string;
  readonly inode: string;
  readonly generation: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly revision: number;
  readonly leafId: string | null;
  readonly projectedRecordKeys: readonly string[];
  readonly markerVersion: typeof SENPI_MARKER_VERSION;
}

/** Adapter-local semantic state carried between incremental tail passes. */
export interface SenpiSessionCheckpointState {
  readonly inputs: readonly SenpiEntryParseResult[];
  readonly records: readonly SenpiProjectionRecord[];
  readonly offPath: readonly SenpiOffPathRecord[];
  readonly parseDiagnostics: readonly SenpiTailDiagnostic[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly includeOffPath: boolean;
}

/**
 * Caller-held checkpoint accepted by {@link commitSenpiSessionCheckpoint}.
 *
 * `baseRevision` must equal the currently persisted marker revision (0 when
 * no valid marker exists). The written marker stores `baseRevision + 1`.
 */
export interface SenpiSessionCheckpoint {
  readonly sessionPathDigest: string;
  readonly sessionId: string;
  readonly device: string;
  readonly inode: string;
  readonly generation: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly baseRevision: number;
  readonly leafId: string | null;
  readonly projectedRecordKeys: readonly string[];
  /** Semantic revision produced by the pass that returned this checkpoint. */
  readonly revision?: number;
  /** Parsed state used only for caller-supplied incremental continuation. */
  readonly state?: SenpiSessionCheckpointState;
}

/** Marker destination and root-gate controls for commit and read. */
export interface SenpiSessionCheckpointCommitOptions {
  /** Custom marker directory. Default: `<dirname(sessionPath)>/.tail-markers`. */
  readonly markerDir?: string;
  /**
   * Roots allowed to contain a custom `markerDir`. When defined, including as
   * an empty array, these take precedence over `SENPI_TAIL_MARKER_ROOTS`.
   * Ignored when `markerDir` is omitted.
   */
  readonly allowedMarkerRoots?: readonly string[];
}

/** Observed file identity used by the invalidation predicate. */
export interface SenpiCheckpointObservedState {
  readonly device: string;
  readonly inode: string;
  readonly fileSize: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  /**
   * True when the marker offset is 0 or the preceding file byte is 0x0a.
   * The predicate does not read the session file; the caller supplies this.
   */
  readonly offsetAtLineBoundary: boolean;
}

/** Why {@link evaluateSenpiCheckpointInvalidation} rejected a marker. */
export type SenpiCheckpointInvalidationReason =
  | 'malformed_marker'
  | 'inode_changed'
  | 'size_below_offset'
  | 'head_digest_changed'
  | 'boundary_digest_changed'
  | 'offset_not_at_line_boundary';

/** Result of the pure invalidation predicate. */
export interface SenpiCheckpointInvalidation {
  readonly invalidate: boolean;
  readonly reason: SenpiCheckpointInvalidationReason | null;
}

/** Outcome of reading a marker file without throwing on corrupt contents. */
export type SenpiSessionMarkerReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly marker: SenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };

/** Outcome of parsing an in-memory marker value. */
export type SenpiSessionMarkerParseResult =
  | { readonly kind: 'valid'; readonly marker: SenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };

/**
 * SHA-256 hex digest of the resolved session JSONL path.
 *
 * @param sessionPath - Session JSONL path.
 * @returns Hex digest used as `sessionPathDigest` and in the marker filename.
 */
export function createSenpiSessionPathDigest(sessionPath: string): string {
  return createMarkerPathDigest(sessionPath);
}

/**
 * Resolve the senpi-prefixed marker filename for a session JSONL path.
 *
 * Default location: `<dirname(sessionPath)>/.tail-markers/`. A custom
 * `markerDir` is accepted only when it falls inside an allowed root.
 *
 * Root-gate semantics (independent of the Claude adapter, same rules):
 * - omitted `markerDir` skips the gate and uses the default directory
 * - defined `allowedMarkerRoots`, including `[]`, wins over the env var
 * - otherwise `SENPI_TAIL_MARKER_ROOTS` (path-delimited) is the allow-list
 * - no usable root, or a directory outside every root, throws
 *
 * @param sessionPath - Session JSONL path whose digest names the marker.
 * @param options - Custom directory and allowed roots.
 * @returns Absolute path to the senpi-prefixed marker file.
 * @throws If a custom `markerDir` has no allowed root or is outside every root.
 */
export function getSenpiSessionMarkerPath(
  sessionPath: string,
  options: SenpiSessionCheckpointCommitOptions = {}
): string {
  const resolvedSessionPath = resolve(sessionPath);
  const dir =
    options.markerDir === undefined
      ? resolve(dirname(resolvedSessionPath), '.tail-markers')
      : resolveAllowedMarkerDir(options.markerDir, {
          allowedMarkerRoots: options.allowedMarkerRoots,
          rootsEnvVar: MARKER_ROOTS_ENV,
          emptyRootsMessage:
            'Custom markerDir requires allowedMarkerRoots (or SENPI_TAIL_MARKER_ROOTS) to include an allowed root',
        });
  const digest = createSenpiSessionPathDigest(resolvedSessionPath);
  const base = sanitizeMarkerBase(basename(resolvedSessionPath, '.jsonl'));
  return join(dir, `senpi-${base}-${digest.slice(0, 16)}.json`);
}

/**
 * Parse an unknown value as a senpi session marker.
 *
 * Malformed input, including the wrong `markerVersion`, yields
 * `{ kind: 'invalid' }` and never throws.
 *
 * @param value - Decoded JSON or any other candidate.
 * @returns A valid marker or an invalid result with a diagnostic.
 */
export function parseSenpiSessionMarker(
  value: unknown
): SenpiSessionMarkerParseResult {
  if (!isRecord(value)) {
    return { kind: 'invalid', error: 'marker is not an object' };
  }
  if (value['markerVersion'] !== SENPI_MARKER_VERSION) {
    return { kind: 'invalid', error: 'unsupported markerVersion' };
  }
  const projectedRecordKeys = parseProjectedRecordKeys(
    value['projectedRecordKeys']
  );
  if (
    typeof value['sessionPathDigest'] !== 'string' ||
    typeof value['sessionId'] !== 'string' ||
    typeof value['device'] !== 'string' ||
    typeof value['inode'] !== 'string' ||
    !isSafeNonnegativeInteger(value['generation']) ||
    !isSafeNonnegativeInteger(value['offset']) ||
    !isSafeNonnegativeInteger(value['lineNumber']) ||
    value['lineNumber'] < 1 ||
    typeof value['headDigest'] !== 'string' ||
    typeof value['boundaryDigest'] !== 'string' ||
    !isSafeNonnegativeInteger(value['revision']) ||
    !isLeafId(value['leafId']) ||
    projectedRecordKeys === undefined
  ) {
    return { kind: 'invalid', error: 'marker fields are malformed' };
  }
  return {
    kind: 'valid',
    marker: {
      sessionPathDigest: value['sessionPathDigest'],
      sessionId: value['sessionId'],
      device: value['device'],
      inode: value['inode'],
      generation: value['generation'],
      offset: value['offset'],
      lineNumber: value['lineNumber'],
      headDigest: value['headDigest'],
      boundaryDigest: value['boundaryDigest'],
      revision: value['revision'],
      leafId: value['leafId'],
      projectedRecordKeys,
      markerVersion: SENPI_MARKER_VERSION,
    },
  };
}

/**
 * Decide whether a persisted marker must be discarded.
 *
 * This predicate is pure: it never reads the filesystem, never parses session
 * entries, and never chooses a branch. The caller supplies observed file
 * identity and whether `marker.offset` sits on a JSONL line boundary.
 *
 * Contract — `invalidate` is `true` when any of the following hold, checked
 * in this order (first match wins):
 * 1. `marker` is not a well-formed {@link SenpiSessionMarker} (`malformed_marker`)
 * 2. observed `device` or `inode` differs (`inode_changed`)
 * 3. observed `fileSize` is strictly less than `marker.offset` (`size_below_offset`)
 * 4. observed `headDigest` differs (`head_digest_changed`)
 * 5. observed `boundaryDigest` differs (`boundary_digest_changed`)
 * 6. `offsetAtLineBoundary` is false (`offset_not_at_line_boundary`)
 *
 * A well-formed marker that matches identity, size, both digests, and a line
 * boundary returns `{ invalidate: false, reason: null }`.
 *
 * @param marker - Persisted marker or any malformed stand-in.
 * @param observed - Current file identity, size, digests, and boundary flag.
 * @returns Whether the marker is unusable and the first matching reason.
 */
export function evaluateSenpiCheckpointInvalidation(
  marker: unknown,
  observed: SenpiCheckpointObservedState
): SenpiCheckpointInvalidation {
  const parsed = parseSenpiSessionMarker(marker);
  if (parsed.kind === 'invalid') {
    return { invalidate: true, reason: 'malformed_marker' };
  }
  const current = parsed.marker;
  if (current.device !== observed.device || current.inode !== observed.inode) {
    return { invalidate: true, reason: 'inode_changed' };
  }
  if (observed.fileSize < current.offset) {
    return { invalidate: true, reason: 'size_below_offset' };
  }
  if (current.headDigest !== observed.headDigest) {
    return { invalidate: true, reason: 'head_digest_changed' };
  }
  if (current.boundaryDigest !== observed.boundaryDigest) {
    return { invalidate: true, reason: 'boundary_digest_changed' };
  }
  if (!observed.offsetAtLineBoundary) {
    return { invalidate: true, reason: 'offset_not_at_line_boundary' };
  }
  return { invalidate: false, reason: null };
}

/**
 * Read the senpi marker for a session path without throwing on corrupt bytes.
 *
 * Missing files are `{ kind: 'missing' }`. Unreadable, non-JSON, or schema-
 * invalid contents are `{ kind: 'invalid' }`. A digest that does not match
 * `sessionPath` is also invalid.
 *
 * @param sessionPath - Session JSONL path whose marker should be loaded.
 * @param options - Same destination controls as commit.
 * @returns Missing, valid, or invalid — never throws for marker contents.
 * @throws If a custom `markerDir` fails the allowed-root gate.
 */
export async function readSenpiSessionMarker(
  sessionPath: string,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<SenpiSessionMarkerReadResult> {
  const resolvedSessionPath = resolve(sessionPath);
  const sessionPathDigest = createSenpiSessionPathDigest(resolvedSessionPath);
  const markerPath = getSenpiSessionMarkerPath(resolvedSessionPath, options);
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    return { kind: 'invalid', error: 'marker file is unreadable' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', error: 'marker JSON is malformed' };
  }
  const parsed = parseSenpiSessionMarker(decoded);
  if (parsed.kind === 'invalid') {
    return parsed;
  }
  if (parsed.marker.sessionPathDigest !== sessionPathDigest) {
    return { kind: 'invalid', error: 'sessionPathDigest does not match path' };
  }
  return parsed;
}

/**
 * Persist a checkpoint by atomically replacing the senpi marker file.
 *
 * The write runs under an internal mkdir/O_EXCL directory lock. The payload
 * is written to a sibling temp file and renamed into place. A failed write
 * deletes the temp file and does not leave `.tmp` litter.
 *
 * @param sessionPath - Session JSONL path that produced the checkpoint.
 * @param checkpoint - Cursor, projection keys, and expected base revision.
 * @param options - Marker destination and root allow-list.
 * @returns After the marker has been replaced.
 * @throws {@link StaleCheckpointConflict} if `baseRevision` does not match
 *   the current marker revision. Also throws if the checkpoint is malformed,
 *   for another path, or the custom marker directory fails the allowed-root
 *   gate.
 */
export async function commitSenpiSessionCheckpoint(
  sessionPath: string,
  checkpoint: SenpiSessionCheckpoint,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<void> {
  const resolvedSessionPath = resolve(sessionPath);
  const sessionPathDigest = createSenpiSessionPathDigest(resolvedSessionPath);
  if (checkpoint.sessionPathDigest !== sessionPathDigest) {
    throw new Error('Senpi session checkpoint does not match the session path');
  }
  validateCheckpointFields(checkpoint);
  const markerPath = getSenpiSessionMarkerPath(resolvedSessionPath, options);
  await withMarkerLock(
    markerPath,
    async () => {
      const existing = await readSenpiSessionMarker(
        resolvedSessionPath,
        options
      );
      const revision = existing.kind === 'valid' ? existing.marker.revision : 0;
      if (checkpoint.baseRevision !== revision) {
        throw new StaleCheckpointConflict({
          expectedRevision: checkpoint.baseRevision,
          actualRevision: revision,
        });
      }
      const marker: SenpiSessionMarker = {
        sessionPathDigest,
        sessionId: checkpoint.sessionId,
        device: checkpoint.device,
        inode: checkpoint.inode,
        generation: checkpoint.generation,
        offset: checkpoint.offset,
        lineNumber: checkpoint.lineNumber,
        headDigest: checkpoint.headDigest,
        boundaryDigest: checkpoint.boundaryDigest,
        revision: checkpointRevision(revision, true),
        leafId: checkpoint.leafId,
        projectedRecordKeys: [...checkpoint.projectedRecordKeys],
        markerVersion: SENPI_MARKER_VERSION,
      };
      await writePrivateJson(markerPath, marker);
    },
    { lockedLabel: 'Senpi session marker' }
  );
}

function validateCheckpointFields(checkpoint: SenpiSessionCheckpoint): void {
  if (
    typeof checkpoint.sessionId !== 'string' ||
    typeof checkpoint.device !== 'string' ||
    typeof checkpoint.inode !== 'string' ||
    !isSafeNonnegativeInteger(checkpoint.generation) ||
    !isSafeNonnegativeInteger(checkpoint.offset) ||
    !isSafeNonnegativeInteger(checkpoint.lineNumber) ||
    checkpoint.lineNumber < 1 ||
    typeof checkpoint.headDigest !== 'string' ||
    typeof checkpoint.boundaryDigest !== 'string' ||
    !isSafeNonnegativeInteger(checkpoint.baseRevision) ||
    !isLeafId(checkpoint.leafId) ||
    parseProjectedRecordKeys(checkpoint.projectedRecordKeys) === undefined
  ) {
    throw new Error('Senpi session checkpoint is malformed');
  }
}

function parseProjectedRecordKeys(
  value: unknown
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(entry => typeof entry === 'string')) return undefined;
  return value;
}

function isLeafId(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
