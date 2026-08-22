import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';

/** On-disk marker schema version persisted as `markerVersion`. */
export const SENPI_MARKER_VERSION = 1;

const STALE_MARKER_LOCK_MS = 30_000;
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
  return createHash('sha256').update(resolve(sessionPath)).digest('hex');
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
      : resolveAllowedMarkerDir(options.markerDir, options.allowedMarkerRoots);
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
 * @throws If the checkpoint is stale, malformed, for another path, or the
 *   custom marker directory fails the allowed-root gate.
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
  await withMarkerLock(markerPath, async () => {
    const existing = await readSenpiSessionMarker(resolvedSessionPath, options);
    const revision = existing.kind === 'valid' ? existing.marker.revision : 0;
    if (checkpoint.baseRevision !== revision) {
      throw new Error(
        'Senpi session checkpoint is stale for the current marker'
      );
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
      revision: revision + 1,
      leafId: checkpoint.leafId,
      projectedRecordKeys: [...checkpoint.projectedRecordKeys],
      markerVersion: SENPI_MARKER_VERSION,
    };
    await writePrivateJson(markerPath, marker);
  });
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

function resolveAllowedMarkerDir(
  markerDir: string,
  explicitRoots?: readonly string[]
): string {
  const resolvedDir = resolve(markerDir);
  const roots =
    explicitRoots !== undefined
      ? normalizeAllowedMarkerRoots(explicitRoots)
      : parseAllowedMarkerRoots();
  if (roots.length === 0) {
    throw new Error(
      'Custom markerDir requires allowedMarkerRoots (or SENPI_TAIL_MARKER_ROOTS) to include an allowed root'
    );
  }
  if (!roots.some(root => isWithinPath(resolvedDir, root))) {
    throw new Error(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
  }
  return resolvedDir;
}

function normalizeAllowedMarkerRoots(
  roots: readonly string[]
): readonly string[] {
  return roots
    .map(root => root.trim())
    .filter(root => root.length > 0)
    .map(root => resolve(root));
}

function parseAllowedMarkerRoots(): readonly string[] {
  const raw = process.env[MARKER_ROOTS_ENV];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(delimiter)
    .map(root => root.trim())
    .filter(root => root.length > 0)
    .map(root => resolve(root));
}

function isWithinPath(child: string, parent: string): boolean {
  const parentPrefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(parentPrefix);
}

function sanitizeMarkerBase(raw: string): string {
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length === 0 || sanitized === '.' || sanitized === '..'
    ? 'session'
    : sanitized;
}

async function withMarkerLock<T>(
  markerPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = `${markerPath}.lock`;
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!(await removeStaleMarkerLock(lockPath))) {
      throw new Error(`Senpi session marker is locked: '${markerPath}'`);
    }
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (retryError: unknown) {
      if (hasErrorCode(retryError, 'EEXIST')) {
        throw new Error(`Senpi session marker is locked: '${markerPath}'`);
      }
      throw retryError;
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleMarkerLock(lockPath: string): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= STALE_MARKER_LOCK_MS) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
