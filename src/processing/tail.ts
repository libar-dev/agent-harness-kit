/**
 * Tail mode — appended-block `SessionBlock` emission for live consumers.
 *
 * Live-ingest consumers can stream new blocks into a database as Claude Code
 * appends to its session JSONL files.
 *
 * Workflow:
 *   1. Consumer (e.g., a Rust backend with a notify watcher) detects
 *      a session file changed.
 *   2. Consumer calls `tailBlocks(jsonlPath)` — gets back only blocks added
 *      since the last successful tail call.
 *   3. Consumer upserts blocks into DB (idempotent via stable `id` field).
 *   4. Marker advances to the new file size so the next
 *      call returns only newer blocks.
 *
 * Resilience properties:
 *   - Append-only safety: byte-offset markers exploit Claude Code's
 *     monotonic-append write pattern.
 *   - At-least-once delivery: marker is written only after blocks are produced;
 *     if the consumer crashes mid-ingest, next call reproduces the same blocks
 *     (idempotent via stable IDs).
 *   - Stale marker: if the file shrank (rotated, deleted), tail falls back
 *     to a full scan from byte 0.
 *   - Missing tool_name: tool_result blocks reference tool_use_id from
 *     prior lines. Tail caches the tool-use name map for already-complete
 *     bytes, then extends it from appended lines before emitting new blocks.
 */

import {
  open,
  readFile,
  readdir,
  stat,
  writeFile,
  mkdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { buildToolNameMap } from './denoiser.js';
import { decomposeHistoryLine } from './block-decomposition.js';
import { compareStrings } from './ordering.js';
import { StaleCheckpointConflict } from './stale-checkpoint-conflict.js';
import {
  safeValidateRawHistoryLine,
  safeValidateRawTranscriptPayloadMetadata,
} from '../validation/validators.js';
import type { RawTranscriptPayloadMetadataSchema } from '../validation/schemas.js';
import { isRecord } from '../utils/index.js';
import {
  LeaseLockBusyError,
  leaseTokenSchema,
  withLeaseLock,
  type ExpiredLeaseToken,
  type LeaseLockOptions,
  type LeaseTokenContext,
} from '../internal/lease-lock.js';
import type {
  RawHistoryLine,
  RawTranscriptRecord,
  RawTranscriptRedactionMode,
  RawTranscriptSession,
  RawTranscriptSessionCheckpoint,
  RawTranscriptSessionTailResult,
  RawTranscriptSourceKind,
  RawTranscriptSourceTailResult,
  RawTranscriptTailResult,
  SessionBlock,
  TailProcessingCounts,
} from './types.js';

// Marker — persists last-emitted byte offset per session

export interface TailMarker {
  /** Byte offset in the JSONL file up to which blocks have been emitted. */
  readonly byteOffset: number;
  /** ISO timestamp of last successful tail. */
  readonly lastTailAt: string;
  /** File size when marker was written, for rollback detection. */
  readonly fileSize: number;
}

/**
 * Resolve marker file path for a given session JSONL.
 *
 * Default location: `<dirname(jsonlPath)>/.tail-markers/<basename>.json`.
 * Override via `markerDir` option for write-restricted source dirs (e.g.,
 * `~/.claude/projects/...` is owned by Claude Code; a consumer would set
 * `markerDir` to its own state dir).
 *
 * @param jsonlPath - Session JSONL path whose basename identifies the marker.
 * @param markerDir - Custom marker directory. When omitted, markers are stored
 *   under `<dirname(jsonlPath)>/.tail-markers/` without allow-list validation.
 * @param allowedMarkerRoots - Per-call roots allowed to contain `markerDir`.
 *   When defined, including as an empty array, these roots take precedence over
 *   `CLAUDE_TAIL_MARKER_ROOTS`. Ignored when `markerDir` is omitted.
 * @returns Absolute path to the session marker file.
 * @throws If a custom `markerDir` has no allowed root or falls outside every
 *   allowed root.
 */
export function getMarkerPath(
  jsonlPath: string,
  markerDir?: string,
  allowedMarkerRoots?: readonly string[]
): string {
  const dir =
    markerDir === undefined
      ? resolve(dirname(jsonlPath), '.tail-markers')
      : resolveAllowedMarkerDir(markerDir, allowedMarkerRoots);
  const base = sanitizeMarkerBase(basename(jsonlPath, '.jsonl'));
  return join(dir, `${base}.json`);
}

/**
 * Resolve the marker path used by `tailRawTranscriptSessionRecords`.
 *
 * The filename includes a digest of the absolute main JSONL path so one custom
 * marker directory can safely hold sessions from multiple projects. Marker
 * roots use the same validation rules as `getMarkerPath`.
 *
 * @param mainJsonlPath - Path to the session's main JSONL file.
 * @param markerDir - Custom marker directory, or the main file's local marker directory.
 * @param allowedMarkerRoots - Roots permitted to contain a custom marker directory.
 * @returns Absolute path to the session-level marker file.
 */
export function getRawTranscriptSessionMarkerPath(
  mainJsonlPath: string,
  markerDir?: string,
  allowedMarkerRoots?: readonly string[]
): string {
  const resolvedMainPath = resolve(mainJsonlPath);
  const dir =
    markerDir === undefined
      ? resolve(dirname(resolvedMainPath), '.tail-markers')
      : resolveAllowedMarkerDir(markerDir, allowedMarkerRoots);
  const sessionId = sanitizeMarkerBase(basename(resolvedMainPath, '.jsonl'));
  const pathDigest = createRawTranscriptSessionPathDigest(resolvedMainPath);
  return join(dir, `${sessionId}-${pathDigest.slice(0, 16)}.raw-session.json`);
}

function createRawTranscriptSessionPathDigest(mainJsonlPath: string): string {
  return createHash('sha256').update(resolve(mainJsonlPath)).digest('hex');
}

/**
 * Read and validate a tail marker file.
 *
 * @param markerPath - Path to the marker JSON file.
 * @returns The validated marker, or `null` when the file is missing,
 *   unreadable, or invalid.
 */
export async function readMarker(
  markerPath: string
): Promise<TailMarker | null> {
  try {
    const raw = await readFile(markerPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isTailMarker(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isTailMarker(value: unknown): value is TailMarker {
  return (
    isRecord(value) &&
    typeof value['byteOffset'] === 'number' &&
    typeof value['lastTailAt'] === 'string' &&
    typeof value['fileSize'] === 'number'
  );
}

/**
 * Write a tail marker by atomically replacing its destination file.
 *
 * The parent directory and temporary file are created with private
 * permissions.
 *
 * @param markerPath - Destination marker JSON path.
 * @param marker - Marker state to persist.
 * @returns A promise that resolves after the destination is replaced.
 * @throws If the parent directory cannot be created or the marker cannot be
 *   written or moved into place.
 */
export async function writeMarker(
  markerPath: string,
  marker: TailMarker
): Promise<void> {
  await writePrivateJson(markerPath, marker);
}

async function writePrivateJson(
  destinationPath: string,
  value: unknown
): Promise<void> {
  const markerDir = dirname(destinationPath);
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    markerDir,
    `.${basename(destinationPath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tempPath, destinationPath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// Tail

export interface TailOptions {
  /** Override marker storage directory (default: `<jsonlDir>/.tail-markers/`) */
  readonly markerDir?: string;
  /**
   * Allowed roots for a custom `markerDir`, validated per call. When set
   * (even to an empty array), takes precedence over the
   * `CLAUDE_TAIL_MARKER_ROOTS` env var; when unset, the env var remains the
   * fallback. Ignored unless `markerDir` is provided.
   */
  readonly allowedMarkerRoots?: readonly string[];
  /** If true, do not advance the marker after emitting (read-only preview) */
  readonly dryRun?: boolean;
  /** If true, ignore any existing marker and emit all blocks from byte 0 */
  readonly fromStart?: boolean;
  /** If false, omit tool_result blocks from structured output */
  readonly includeToolResults?: boolean;
}

export interface RawTranscriptTailOptions extends TailOptions {
  /**
   * Exact raw transcript payloads are intentionally unsafe and require an
   * explicit opt-in. The safe default redacts `rawLine` and `payload`.
   */
  readonly rawRedactionMode?: RawTranscriptRedactionMode;
}

export interface RawTranscriptWatchOptions extends RawTranscriptTailOptions {
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

/** Options for tailing every JSONL source belonging to one session. */
export interface RawTranscriptSessionTailOptions extends RawTranscriptTailOptions {
  /** Defer checkpoint persistence until `commitRawTranscriptSessionCheckpoint`. */
  readonly checkpointMode?: 'automatic' | 'manual';
}

/** Options for polling every JSONL source belonging to one session. */
export interface RawTranscriptSessionWatchOptions extends RawTranscriptSessionTailOptions {
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

/** Marker destination controls for committing a manual session checkpoint. */
export interface RawTranscriptSessionCommitOptions {
  readonly markerDir?: string;
  readonly allowedMarkerRoots?: readonly string[];
}

export interface RawTranscriptReadOptions {
  /**
   * Exact raw transcript payloads are intentionally unsafe and require an
   * explicit opt-in. The safe default redacts `rawLine` and `payload`.
   */
  readonly rawRedactionMode?: RawTranscriptRedactionMode;
}

export interface TailResult extends TailProcessingCounts {
  /** New blocks since the last successful tail (chronological) */
  readonly blocks: readonly SessionBlock[];
  /** Byte offset that was reached this call */
  readonly newByteOffset: number;
  /** Byte offset prior to this call (0 if no marker) */
  readonly previousByteOffset: number;
  /** Total file size at read time */
  readonly fileSize: number;
  /** True if file shrank since last marker — full re-scan was performed */
  readonly fileRotated: boolean;
}

interface TailFileCache {
  readonly completeByteOffset: number;
  readonly completeLineCount: number;
  readonly toolNameById: ReadonlyMap<string, string>;
  readonly lastTimestamp?: string;
}

interface TailStateCounts extends TailProcessingCounts {
  readonly completeLineCount: number;
  /**
   * Known-type lines that failed strict typed validation but were preserved
   * as raw records. Already included in `invalidShapeLineCount`; tracked
   * separately so `tailBlocks` does not double-count them when it derives its
   * typed skip count from the records/lines length difference.
   */
  readonly degradedHistoryLineCount: number;
}

interface TailState {
  readonly records: readonly RawTranscriptRecord[];
  readonly lines: readonly RawHistoryLine[];
  readonly toolNameById: ReadonlyMap<string, string>;
  readonly precedingTimestamp?: string;
  readonly nextByteOffset: number;
  readonly counts: TailStateCounts;
}

interface EffectiveTimestampRecord {
  readonly record: RawTranscriptRecord;
  readonly effectiveTimestamp: string;
}

interface RawTranscriptSource {
  readonly sourcePath: string;
  readonly sourceKind: RawTranscriptSourceKind;
  readonly sourceId: string;
}

interface RawTranscriptSessionMarker {
  readonly version: 2;
  readonly sessionId: string;
  readonly mainPathDigest: string;
  readonly revision: number;
  readonly sources: Readonly<Record<string, RawTranscriptSessionSourceMarker>>;
}

interface RawTranscriptSessionSourceMarker extends TailMarker {
  readonly generation: number;
}

const SESSION_MARKER_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const SESSION_MARKER_LOCK_STALE_MS = 30_000;
const SESSION_MARKER_LOCK_RETRY_MS = 25;
const SESSION_MARKER_LOCK_CLOCK_SKEW_MS = 60_000;

const tailFileCache = new Map<string, TailFileCache>();

/**
 * Upper bound on distinct session files tracked in `tailFileCache`. Long-running
 * watch consumers can tail many sessions over their lifetime; without a bound
 * the cache would grow unbounded. Maps preserve insertion order, so once the
 * cap is reached we evict the oldest entry before inserting another key. This
 * is a soft LRU-by-insertion, not a hot-path concern.
 */
const TAIL_FILE_CACHE_MAX_ENTRIES = 1024;

/**
 * Set a cache entry, evicting the oldest entry first when an unseen key would
 * exceed `TAIL_FILE_CACHE_MAX_ENTRIES`. Updating an existing key never evicts
 * because it does not grow the map.
 */
function setTailFileCache(cacheKey: string, value: TailFileCache): void {
  if (
    !tailFileCache.has(cacheKey) &&
    tailFileCache.size >= TAIL_FILE_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = tailFileCache.keys().next().value;
    if (oldestKey !== undefined) {
      tailFileCache.delete(oldestKey);
    }
  }
  tailFileCache.set(cacheKey, value);
}

const REDACTED_RAW_TRANSCRIPT_LINE = '[REDACTED:RAW_TRANSCRIPT_LINE]';
const REDACTED_RAW_TRANSCRIPT_VALUE = '[REDACTED:RAW_TRANSCRIPT_VALUE]';

/**
 * Read a session JSONL and emit only blocks added since the last successful
 * `tailBlocks()` call. Updates the marker on success unless `dryRun` is set.
 *
 * Safe to call repeatedly — stable block IDs make consumer-side upsert
 * idempotent even if marker tracking ever drifts.
 */
export async function tailBlocks(
  jsonlPath: string,
  options: TailOptions = {}
): Promise<TailResult> {
  const result = await tailTranscriptRecordsInternal(jsonlPath, options);
  const blocks: SessionBlock[] = [];
  const lineOptions =
    options.includeToolResults === undefined
      ? undefined
      : { includeToolResults: options.includeToolResults };

  for (const line of result.lines) {
    blocks.push(
      ...decomposeHistoryLine(line, result.toolNameById, lineOptions)
    );
  }
  // Deliberate divergence from extractBlocks (blocks.ts), which keeps physical
  // line order: tail emits as the file grows, so it sorts each
  // emitted batch by timestamp to stay robust against out-of-order appends in
  // live sessions. Under the normal time-ordered append pattern this produces
  // the same ordering as extractBlocks, so parity holds for completed sessions.
  blocks.sort((a, b) => compareStrings(a.timestamp, b.timestamp));

  // Degraded history records sit in `records` but never in `lines`; they are
  // already reported via invalidShapeLineCount, so exclude them here.
  const skippedTypedLineCount =
    result.skippedLineCount +
    (result.records.length -
      result.lines.length -
      result.degradedHistoryLineCount);

  return {
    blocks,
    previousByteOffset: result.previousByteOffset,
    newByteOffset: result.newByteOffset,
    fileSize: result.fileSize,
    fileRotated: result.fileRotated,
    invalidJsonLineCount: result.invalidJsonLineCount,
    invalidShapeLineCount: result.invalidShapeLineCount,
    skippedLineCount: skippedTypedLineCount,
  };
}

/**
 * Read a session JSONL and emit only complete raw transcript records added
 * since the last successful tail call. Unlike `tailBlocks`, this preserves
 * valid object payloads for unknown Claude Code record types and keeps their
 * original fields available in `payload` and `rawLine` for UI consumers that
 * own their own interpretation.
 */
export async function tailRawTranscriptRecords(
  jsonlPath: string,
  options: RawTranscriptTailOptions = {}
): Promise<RawTranscriptTailResult> {
  const result = await tailTranscriptRecordsInternal(jsonlPath, options);
  return {
    records: toPublicRawTranscriptRecords(result.records, options),
    previousByteOffset: result.previousByteOffset,
    newByteOffset: result.newByteOffset,
    fileSize: result.fileSize,
    fileRotated: result.fileRotated,
    invalidJsonLineCount: result.invalidJsonLineCount,
    invalidShapeLineCount: result.invalidShapeLineCount,
    skippedLineCount: result.skippedLineCount,
  };
}

/**
 * Tail the main JSONL and all `<session-id>/subagents/*.jsonl` files as one
 * session. Source discovery runs on every call, offsets advance independently,
 * and untimestamped records inherit the preceding timestamp from their own
 * source for deterministic merge ordering. Returned records are not modified.
 *
 * Marker state is committed atomically after every source has been read. A
 * failed source therefore leaves the prior session checkpoint intact so the
 * next call can replay the complete pass.
 *
 * @param mainJsonlPath - Path to the session's main `<session-id>.jsonl` file.
 * @param options - Marker, replay, redaction, and dry-run controls.
 * @returns Merged records plus aggregate and per-source diagnostics.
 */
export async function tailRawTranscriptSessionRecords(
  mainJsonlPath: string,
  options: RawTranscriptSessionTailOptions = {}
): Promise<RawTranscriptSessionTailResult> {
  const resolvedMainPath = resolve(mainJsonlPath);
  const sessionId = basename(resolvedMainPath, '.jsonl');
  const mainPathDigest = createRawTranscriptSessionPathDigest(resolvedMainPath);
  const markerPath = getRawTranscriptSessionMarkerPath(
    resolvedMainPath,
    options.markerDir,
    options.allowedMarkerRoots
  );
  const existingMarker = await readRawTranscriptSessionMarker(
    markerPath,
    sessionId,
    mainPathDigest
  );
  const sources = await discoverRawTranscriptSources(resolvedMainPath);
  const effectiveTimestampRecords: EffectiveTimestampRecord[] = [];
  const sourceResults: RawTranscriptSourceTailResult[] = [];
  const nextMarkers: Record<string, RawTranscriptSessionSourceMarker> = {};

  for (const source of sources) {
    const sourceKey = getRawTranscriptSourceKey(source);
    const result = await readTranscriptRecordsFromMarker(
      source.sourcePath,
      options.fromStart ? null : (existingMarker?.sources[sourceKey] ?? null)
    );
    const publicRecords = toPublicRawTranscriptRecords(result.records, options);
    let effectiveTimestamp = result.precedingTimestamp ?? '';

    for (const record of publicRecords) {
      if (record.timestamp !== undefined && record.timestamp.length > 0) {
        effectiveTimestamp = record.timestamp;
      }
      effectiveTimestampRecords.push({ record, effectiveTimestamp });
    }
    sourceResults.push({
      sourcePath: source.sourcePath,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      recordCount: publicRecords.length,
      previousByteOffset: result.previousByteOffset,
      newByteOffset: result.newByteOffset,
      fileSize: result.fileSize,
      fileRotated: result.fileRotated,
      degradedHistoryLineCount: result.degradedHistoryLineCount,
      invalidJsonLineCount: result.invalidJsonLineCount,
      invalidShapeLineCount: result.invalidShapeLineCount,
      skippedLineCount: result.skippedLineCount,
    });
    const existingSourceMarker = existingMarker?.sources[sourceKey];
    const forcedRotation =
      options.fromStart === true &&
      existingSourceMarker !== undefined &&
      result.newByteOffset < existingSourceMarker.byteOffset;
    nextMarkers[sourceKey] = {
      byteOffset: result.newByteOffset,
      lastTailAt: new Date().toISOString(),
      fileSize: result.fileSize,
      generation:
        (existingSourceMarker?.generation ?? 0) +
        (result.fileRotated || forcedRotation ? 1 : 0),
    };
  }

  effectiveTimestampRecords.sort(compareEffectiveTimestampRecords);
  const records = effectiveTimestampRecords.map(item => item.record);
  const checkpoint = toRawTranscriptSessionCheckpoint(
    sessionId,
    mainPathDigest,
    existingMarker?.revision ?? 0,
    sourceResults,
    nextMarkers
  );

  if (
    !options.dryRun &&
    options.checkpointMode !== 'manual' &&
    shouldWriteRawTranscriptSessionMarker(existingMarker, sourceResults)
  ) {
    try {
      await mutateRawTranscriptSessionMarker(
        markerPath,
        sessionId,
        mainPathDigest,
        checkpoint
      );
    } catch (error) {
      if (!(error instanceof StaleCheckpointConflict)) {
        throw error;
      }
    }
  }

  return {
    sessionId,
    records,
    sources: sourceResults,
    checkpoint,
    degradedHistoryLineCount: sumSourceCount(
      sourceResults,
      'degradedHistoryLineCount'
    ),
    invalidJsonLineCount: sumSourceCount(sourceResults, 'invalidJsonLineCount'),
    invalidShapeLineCount: sumSourceCount(
      sourceResults,
      'invalidShapeLineCount'
    ),
    skippedLineCount: sumSourceCount(sourceResults, 'skippedLineCount'),
  };
}

/**
 * Commit a checkpoint returned by a manual session tail after its records have
 * been durably consumed. A crash before this call leaves the prior offsets in
 * place, so the batch is replayed on restart.
 *
 * @param mainJsonlPath - Path used to create the session tail result.
 * @param checkpoint - Checkpoint returned with that result.
 * @param options - Marker directory and allow-list controls used for tailing.
 * @returns A promise that resolves after the atomic marker replacement.
 * @throws {@link StaleCheckpointConflict} if the checkpoint revision is stale.
 * @throws If the checkpoint has another path identity, is invalid,
 *   or contains an unsafe offset or generation transition.
 */
export async function commitRawTranscriptSessionCheckpoint(
  mainJsonlPath: string,
  checkpoint: RawTranscriptSessionCheckpoint,
  options: RawTranscriptSessionCommitOptions = {}
): Promise<void> {
  const resolvedMainPath = resolve(mainJsonlPath);
  const sessionId = basename(resolvedMainPath, '.jsonl');
  const mainPathDigest = createRawTranscriptSessionPathDigest(resolvedMainPath);
  if (
    checkpoint.sessionId !== sessionId ||
    checkpoint.mainPathDigest !== mainPathDigest
  ) {
    throw new Error('Session checkpoint does not match the main JSONL path');
  }
  const markerPath = getRawTranscriptSessionMarkerPath(
    resolvedMainPath,
    options.markerDir,
    options.allowedMarkerRoots
  );
  await mutateRawTranscriptSessionMarker(
    markerPath,
    sessionId,
    mainPathDigest,
    checkpoint
  );
}

/**
 * Poll all raw transcript sources for a session, including subagent files that
 * appear after observation begins.
 *
 * The first pass is always yielded. Later passes are yielded when records,
 * diagnostics, rotation, or the discovered source set changes. Aborting the
 * signal ends iteration without an error. `fromStart` applies only to the first
 * pass.
 *
 * @param mainJsonlPath - Path to the session's main `<session-id>.jsonl` file.
 * @param options - Session tail options plus polling and cancellation controls.
 * @returns An async sequence of non-quiet session tail results.
 */
export async function* watchRawTranscriptSessionRecords(
  mainJsonlPath: string,
  options: RawTranscriptSessionWatchOptions = {}
): AsyncGenerator<RawTranscriptSessionTailResult, void, unknown> {
  const { pollMs = 2000, signal, ...initialTailOptions } = options;
  let tailOptions: RawTranscriptSessionTailOptions = initialTailOptions;
  let previousSourceSignature: string | undefined;
  let first = true;

  while (signal?.aborted !== true) {
    const result = await tailRawTranscriptSessionRecords(
      mainJsonlPath,
      tailOptions
    );
    const sourceSignature = result.sources
      .map(source => `${source.sourceKind}:${source.sourceId}`)
      .join('\n');
    if (
      first ||
      result.records.length > 0 ||
      result.sources.some(source => source.fileRotated) ||
      hasTailProcessingCounts(result) ||
      result.degradedHistoryLineCount > 0 ||
      sourceSignature !== previousSourceSignature
    ) {
      yield result;
    }
    first = false;
    previousSourceSignature = sourceSignature;
    if (tailOptions.fromStart === true) {
      const { fromStart: _fromStart, ...remainingOptions } = tailOptions;
      tailOptions = remainingOptions;
    }
    await delay(pollMs, undefined, { signal }).catch(error => {
      if (signal?.aborted === true) return;
      throw error;
    });
  }
}

/**
 * Polling async iterator for raw transcript records. The CLI watch
 * mode still owns the fs.watch implementation; this library API gives Node
 * consumers a compact reusable watcher without duplicating marker handling.
 */
export async function* watchRawTranscriptRecords(
  jsonlPath: string,
  options: RawTranscriptWatchOptions = {}
): AsyncGenerator<RawTranscriptTailResult, void, unknown> {
  const { pollMs = 2000, signal, ...tailOptions } = options;
  let first = true;

  while (signal?.aborted !== true) {
    const result = await tailRawTranscriptRecords(jsonlPath, tailOptions);
    if (
      first ||
      result.records.length > 0 ||
      result.fileRotated ||
      hasTailProcessingCounts(result)
    ) {
      yield result;
    }
    first = false;
    await delay(pollMs, undefined, { signal }).catch(error => {
      if (signal?.aborted === true) return;
      throw error;
    });
  }
}

/**
 * Read a full session as raw transcript records from a Claude project directory, including
 * subagent JSONL files when present. This intentionally bypasses marker
 * advancement so historical reads are side-effect free.
 */
export async function readRawSessionFiles(
  projectDir: string,
  sessionId: string,
  options: RawTranscriptReadOptions = {}
): Promise<RawTranscriptSession> {
  const records: RawTranscriptRecord[] = [];
  const mainPath = join(projectDir, `${sessionId}.jsonl`);
  records.push(
    ...(
      await tailRawTranscriptRecords(mainPath, {
        fromStart: true,
        dryRun: true,
        ...(options.rawRedactionMode !== undefined
          ? { rawRedactionMode: options.rawRedactionMode }
          : {}),
      })
    ).records
  );

  const subagentDir = join(projectDir, sessionId, 'subagents');
  let entries: string[];
  try {
    entries = (await readdir(subagentDir))
      .filter(entry => entry.endsWith('.jsonl'))
      .sort(compareStrings);
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw err;
    entries = [];
  }

  for (const entry of entries) {
    const subagentPath = join(subagentDir, entry);
    records.push(
      ...(
        await tailRawTranscriptRecords(subagentPath, {
          fromStart: true,
          dryRun: true,
          ...(options.rawRedactionMode !== undefined
            ? { rawRedactionMode: options.rawRedactionMode }
            : {}),
        })
      ).records
    );
  }

  records.sort((left, right) => {
    const timestampCompare = compareStrings(
      left.timestamp ?? '',
      right.timestamp ?? ''
    );
    if (timestampCompare !== 0) return timestampCompare;
    return compareStrings(left.id, right.id);
  });
  return { sessionId, records };
}

async function discoverRawTranscriptSources(
  mainJsonlPath: string
): Promise<readonly RawTranscriptSource[]> {
  const sessionId = basename(mainJsonlPath, '.jsonl');
  const sources: RawTranscriptSource[] = [
    {
      sourcePath: mainJsonlPath,
      sourceKind: 'main',
      sourceId: 'main',
    },
  ];
  const subagentDir = join(dirname(mainJsonlPath), sessionId, 'subagents');

  let entries: string[];
  try {
    entries = (await readdir(subagentDir))
      .filter(entry => entry.endsWith('.jsonl'))
      .sort(compareStrings);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return sources;
    throw error;
  }

  for (const entry of entries) {
    sources.push({
      sourcePath: join(subagentDir, entry),
      sourceKind: 'subagent',
      sourceId: basename(entry, '.jsonl'),
    });
  }
  return sources;
}

async function readRawTranscriptSessionMarker(
  markerPath: string,
  sessionId: string,
  mainPathDigest: string
): Promise<RawTranscriptSessionMarker | null> {
  try {
    const raw = await readFile(markerPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const revision = isRecord(parsed) ? parsed['revision'] : undefined;
    if (
      !isRecord(parsed) ||
      parsed['version'] !== 2 ||
      parsed['sessionId'] !== sessionId ||
      parsed['mainPathDigest'] !== mainPathDigest ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !isRecord(parsed['sources'])
    ) {
      return null;
    }

    const sources: Record<string, RawTranscriptSessionSourceMarker> = {};
    for (const [sourceKey, marker] of Object.entries(parsed['sources'])) {
      const generation = isRecord(marker) ? marker['generation'] : undefined;
      if (
        !isTailMarker(marker) ||
        !isRecord(marker) ||
        !Number.isSafeInteger(marker.byteOffset) ||
        marker.byteOffset < 0 ||
        !Number.isSafeInteger(marker.fileSize) ||
        marker.fileSize < marker.byteOffset ||
        typeof generation !== 'number' ||
        !Number.isSafeInteger(generation) ||
        generation < 0
      ) {
        return null;
      }
      sources[sourceKey] = {
        byteOffset: marker.byteOffset,
        fileSize: marker.fileSize,
        lastTailAt: marker.lastTailAt,
        generation,
      };
    }
    return {
      version: 2,
      sessionId,
      mainPathDigest,
      revision,
      sources,
    };
  } catch {
    return null;
  }
}

async function writeRawTranscriptSessionMarker(
  markerPath: string,
  sessionId: string,
  mainPathDigest: string,
  revision: number,
  sources: Readonly<Record<string, RawTranscriptSessionSourceMarker>>
): Promise<void> {
  await writePrivateJson(markerPath, {
    version: 2,
    sessionId,
    mainPathDigest,
    revision,
    sources,
  } satisfies RawTranscriptSessionMarker);
}

export interface RawTranscriptSessionLockHooks {
  /** Test-schedule hooks for observing lock interleavings. */
  readonly onAfterReleaseTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
  readonly onAfterExpiredTokensClassified?: () => void | Promise<void>;
  readonly onAfterExpiredTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
  readonly onAfterCanonicalMkdirBeforeToken?: () => void | Promise<void>;
}

export interface RawTranscriptSessionLockOptions extends RawTranscriptSessionLockHooks {
  readonly now?: () => number;
  readonly acquireTimeoutMs?: number;
  readonly retryMs?: number;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

async function mutateRawTranscriptSessionMarker(
  markerPath: string,
  sessionId: string,
  mainPathDigest: string,
  checkpoint: RawTranscriptSessionCheckpoint,
  hooks?: RawTranscriptSessionLockHooks
): Promise<void> {
  await withRawTranscriptSessionMarkerLock(
    markerPath,
    async () => {
      const existingMarker = await readRawTranscriptSessionMarker(
        markerPath,
        sessionId,
        mainPathDigest
      );
      const nextMarkers = rawTranscriptSessionCheckpointToMarkers(checkpoint);
      const currentRevision = existingMarker?.revision ?? 0;
      if (checkpoint.baseRevision !== currentRevision) {
        throw new StaleCheckpointConflict({
          expectedRevision: checkpoint.baseRevision,
          actualRevision: currentRevision,
        });
      }
      validateRawTranscriptCheckpointProgression(existingMarker, nextMarkers);

      await writeRawTranscriptSessionMarker(
        markerPath,
        sessionId,
        mainPathDigest,
        currentRevision + 1,
        nextMarkers
      );
    },
    hooks
  );
}

export async function withRawTranscriptSessionMarkerLock<T>(
  markerPath: string,
  action: () => Promise<T>,
  options: RawTranscriptSessionLockOptions = {}
): Promise<T> {
  const lockPath = `${markerPath}.lock`;
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const now = options.now ?? Date.now;
  const probeAlive = options.isProcessAlive ?? isProcessAlive;
  const acquireTimeoutMs =
    options.acquireTimeoutMs ?? SESSION_MARKER_LOCK_ACQUIRE_TIMEOUT_MS;
  const retryMs = options.retryMs ?? SESSION_MARKER_LOCK_RETRY_MS;
  const startedAt = Date.now();
  const leaseOptions: LeaseLockOptions = {
    staleMs: SESSION_MARKER_LOCK_STALE_MS,
    now,
    tokenFields: (context: LeaseTokenContext) => ({ createdAt: context.now }),
    tokenSchema: rawTranscriptSessionLockTokenSchema(now),
    canReclaimExpiredToken: (captured: ExpiredLeaseToken) =>
      canReclaimRawTranscriptExpiredToken(captured, now, probeAlive),
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    ...(options.onAfterCanonicalMkdirBeforeToken !== undefined
      ? {
          onAfterCanonicalMkdirBeforeToken:
            options.onAfterCanonicalMkdirBeforeToken,
        }
      : {}),
    ...(options.onAfterExpiredTokensClassified !== undefined
      ? {
          onAfterExpiredTokensClassified:
            options.onAfterExpiredTokensClassified,
        }
      : {}),
    ...(options.onAfterExpiredTokensUnlinkedBeforeRmdir !== undefined
      ? {
          onAfterExpiredTokensUnlinkedBeforeRmdir:
            options.onAfterExpiredTokensUnlinkedBeforeRmdir,
        }
      : {}),
    ...(options.onAfterReleaseTokensUnlinkedBeforeRmdir !== undefined
      ? {
          onAfterReleaseTokensUnlinkedBeforeRmdir:
            options.onAfterReleaseTokensUnlinkedBeforeRmdir,
        }
      : {}),
  };

  while (true) {
    try {
      return await withLeaseLock(lockPath, async () => action(), leaseOptions);
    } catch (error) {
      if (!(error instanceof LeaseLockBusyError)) throw error;
      if (Date.now() - startedAt >= acquireTimeoutMs) {
        throw new Error(
          `Timed out acquiring session marker lock '${lockPath}'`
        );
      }
      await delay(retryMs);
    }
  }
}

function rawTranscriptSessionLockTokenSchema(now: () => number) {
  return leaseTokenSchema
    .extend({
      createdAt: z
        .number()
        .refine(
          value => isValidRawTranscriptLockCreatedAt(value, now()),
          'createdAt failed raw-transcript clock-skew validation'
        ),
    })
    .strict();
}

function canReclaimRawTranscriptExpiredToken(
  captured: ExpiredLeaseToken,
  now: () => number,
  probeAlive: (pid: number) => boolean
): boolean {
  const { token } = captured;
  if (!('pid' in token)) return false;
  if (
    'createdAt' in token &&
    !isValidRawTranscriptLockCreatedAt(token.createdAt, now())
  ) {
    return false;
  }
  return !probeAlive(token.pid);
}

function isValidRawTranscriptLockCreatedAt(
  createdAt: number,
  now: number
): boolean {
  return (
    Number.isSafeInteger(createdAt) &&
    createdAt > 0 &&
    createdAt <= now + SESSION_MARKER_LOCK_CLOCK_SKEW_MS
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(hasErrorCode(error, 'ESRCH') || hasErrorCode(error, 'EINVAL'));
  }
}

function toRawTranscriptSessionCheckpoint(
  sessionId: string,
  mainPathDigest: string,
  baseRevision: number,
  sources: readonly RawTranscriptSourceTailResult[],
  markers: Readonly<Record<string, RawTranscriptSessionSourceMarker>>
): RawTranscriptSessionCheckpoint {
  return {
    sessionId,
    mainPathDigest,
    baseRevision,
    sources: sources.map(source => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      generation:
        markers[`${source.sourceKind}:${source.sourceId}`]?.generation ?? 0,
      byteOffset: source.newByteOffset,
      fileSize: source.fileSize,
    })),
  };
}

function rawTranscriptSessionCheckpointToMarkers(
  checkpoint: RawTranscriptSessionCheckpoint
): Record<string, RawTranscriptSessionSourceMarker> {
  if (
    !checkpoint.sources.some(
      source => source.sourceKind === 'main' && source.sourceId === 'main'
    )
  ) {
    throw new Error('Raw transcript session checkpoint is missing main source');
  }
  if (
    checkpoint.mainPathDigest.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.mainPathDigest) ||
    !Number.isSafeInteger(checkpoint.baseRevision) ||
    checkpoint.baseRevision < 0
  ) {
    throw new Error('Invalid raw transcript session checkpoint identity');
  }
  const markers: Record<string, RawTranscriptSessionSourceMarker> = {};
  const lastTailAt = new Date().toISOString();

  for (const source of checkpoint.sources) {
    if (
      (source.sourceKind !== 'main' && source.sourceKind !== 'subagent') ||
      source.sourceId.length === 0 ||
      !Number.isSafeInteger(source.generation) ||
      source.generation < 0 ||
      !Number.isSafeInteger(source.byteOffset) ||
      source.byteOffset < 0 ||
      !Number.isSafeInteger(source.fileSize) ||
      source.fileSize < source.byteOffset
    ) {
      throw new Error('Invalid raw transcript session checkpoint');
    }
    const sourceKey = `${source.sourceKind}:${source.sourceId}`;
    if (markers[sourceKey] !== undefined) {
      throw new Error(
        'Raw transcript session checkpoint has duplicate sources'
      );
    }
    markers[sourceKey] = {
      byteOffset: source.byteOffset,
      fileSize: source.fileSize,
      lastTailAt,
      generation: source.generation,
    };
  }
  return markers;
}

function validateRawTranscriptCheckpointProgression(
  existingMarker: RawTranscriptSessionMarker | null,
  nextMarkers: Readonly<Record<string, RawTranscriptSessionSourceMarker>>
): void {
  for (const [sourceKey, nextMarker] of Object.entries(nextMarkers)) {
    const existingSource = existingMarker?.sources[sourceKey];
    if (existingSource === undefined) {
      if (nextMarker.generation !== 0) {
        throw new Error('New transcript source must start at generation zero');
      }
      continue;
    }

    if (nextMarker.generation === existingSource.generation) {
      if (nextMarker.byteOffset < existingSource.byteOffset) {
        throw new Error(
          'Session checkpoint would move source offsets backwards'
        );
      }
      continue;
    }

    if (nextMarker.generation !== existingSource.generation + 1) {
      throw new Error('Session checkpoint has an invalid source generation');
    }
  }
}

function getRawTranscriptSourceKey(source: RawTranscriptSource): string {
  return `${source.sourceKind}:${source.sourceId}`;
}

function compareEffectiveTimestampRecords(
  left: EffectiveTimestampRecord,
  right: EffectiveTimestampRecord
): number {
  const timestampCompare = compareStrings(
    left.effectiveTimestamp,
    right.effectiveTimestamp
  );
  if (timestampCompare !== 0) return timestampCompare;

  if (left.record.sourceKind !== right.record.sourceKind) {
    return left.record.sourceKind === 'main' ? -1 : 1;
  }
  const sourceCompare = compareStrings(
    left.record.sourceId,
    right.record.sourceId
  );
  if (sourceCompare !== 0) return sourceCompare;
  if (left.record.byteStart !== right.record.byteStart) {
    return left.record.byteStart < right.record.byteStart ? -1 : 1;
  }
  if (left.record.byteEnd !== right.record.byteEnd) {
    return left.record.byteEnd < right.record.byteEnd ? -1 : 1;
  }
  return compareStrings(left.record.id, right.record.id);
}

type RawTranscriptSourceCountKey =
  | 'degradedHistoryLineCount'
  | 'invalidJsonLineCount'
  | 'invalidShapeLineCount'
  | 'skippedLineCount';

function sumSourceCount(
  sources: readonly RawTranscriptSourceTailResult[],
  key: RawTranscriptSourceCountKey
): number {
  return sources.reduce((sum, source) => sum + source[key], 0);
}

function shouldWriteRawTranscriptSessionMarker(
  existingMarker: RawTranscriptSessionMarker | null,
  sources: readonly RawTranscriptSourceTailResult[]
): boolean {
  if (existingMarker === null) {
    return sources.some(source => source.newByteOffset > 0);
  }

  const sourceKeys = new Set(
    sources.map(source =>
      getRawTranscriptSourceKey({
        sourcePath: source.sourcePath,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
      })
    )
  );
  const existingKeys = Object.keys(existingMarker.sources);
  if (
    sourceKeys.size !== existingKeys.length ||
    existingKeys.some(sourceKey => !sourceKeys.has(sourceKey))
  ) {
    return true;
  }

  return sources.some(source => {
    const sourceKey = `${source.sourceKind}:${source.sourceId}`;
    return (
      existingMarker.sources[sourceKey]?.byteOffset !== source.newByteOffset
    );
  });
}

async function tailTranscriptRecordsInternal(
  jsonlPath: string,
  options: TailOptions = {}
): Promise<
  RawTranscriptTailResult & {
    toolNameById: ReadonlyMap<string, string>;
    lines: readonly RawHistoryLine[];
    degradedHistoryLineCount: number;
    precedingTimestamp?: string;
  }
> {
  const markerPath = getMarkerPath(
    jsonlPath,
    options.markerDir,
    options.allowedMarkerRoots
  );
  const existing = options.fromStart ? null : await readMarker(markerPath);
  const result = await readTranscriptRecordsFromMarker(jsonlPath, existing);

  if (!options.dryRun && result.previousByteOffset !== result.fileSize) {
    await writeMarker(markerPath, {
      byteOffset: result.newByteOffset,
      lastTailAt: new Date().toISOString(),
      fileSize: result.fileSize,
    });
  }

  return result;
}

async function readTranscriptRecordsFromMarker(
  jsonlPath: string,
  existing: TailMarker | null
): Promise<
  RawTranscriptTailResult & {
    toolNameById: ReadonlyMap<string, string>;
    lines: readonly RawHistoryLine[];
    degradedHistoryLineCount: number;
    precedingTimestamp?: string;
  }
> {
  const cacheKey = resolve(jsonlPath);
  const stats = await stat(jsonlPath);
  const fileSize = stats.size;

  // File rotated/truncated since last tail — full re-scan from start
  const fileRotated = existing !== null && fileSize < existing.byteOffset;
  const previousByteOffset = fileRotated ? 0 : (existing?.byteOffset ?? 0);

  // No new bytes — nothing to do
  if (previousByteOffset === fileSize) {
    const cached = tailFileCache.get(cacheKey);
    return {
      records: [],
      lines: [],
      newByteOffset: fileSize,
      previousByteOffset,
      fileSize,
      fileRotated,
      toolNameById: cached?.toolNameById ?? new Map(),
      ...(cached?.lastTimestamp !== undefined
        ? { precedingTimestamp: cached.lastTimestamp }
        : {}),
      invalidJsonLineCount: 0,
      invalidShapeLineCount: 0,
      skippedLineCount: 0,
      degradedHistoryLineCount: 0,
    };
  }

  const cached = fileRotated ? undefined : tailFileCache.get(cacheKey);
  const tailState =
    previousByteOffset > 0 && cached?.completeByteOffset === previousByteOffset
      ? await readIncrementalTailState(
          cacheKey,
          jsonlPath,
          previousByteOffset,
          fileSize,
          cached
        )
      : await readFullTailState(
          cacheKey,
          jsonlPath,
          previousByteOffset,
          fileSize
        );

  const nextByteOffset = tailState.nextByteOffset;

  return {
    records: tailState.records,
    lines: tailState.lines,
    newByteOffset: nextByteOffset,
    previousByteOffset,
    fileSize,
    fileRotated,
    toolNameById: tailState.toolNameById,
    ...(tailState.precedingTimestamp !== undefined
      ? { precedingTimestamp: tailState.precedingTimestamp }
      : {}),
    invalidJsonLineCount: tailState.counts.invalidJsonLineCount,
    invalidShapeLineCount: tailState.counts.invalidShapeLineCount,
    skippedLineCount: tailState.counts.skippedLineCount,
    degradedHistoryLineCount: tailState.counts.degradedHistoryLineCount,
  };
}

// Internals

/**
 * Walk the file content tracking byte offsets and return parsed lines whose
 * starting offset is at or after `minOffset`. Skips a partial trailing line
 * (no terminating newline) for safety against mid-write reads.
 */
function recordsStartingAtOrAfter(
  jsonlPath: string,
  content: Buffer,
  minOffset: number
): {
  records: RawTranscriptRecord[];
  lines: RawHistoryLine[];
  lastCompleteByteOffset: number;
  counts: TailStateCounts;
} {
  const records: RawTranscriptRecord[] = [];
  const lines: RawHistoryLine[] = [];
  const counts = {
    completeLineCount: 0,
    degradedHistoryLineCount: 0,
    invalidJsonLineCount: 0,
    invalidShapeLineCount: 0,
    skippedLineCount: 0,
  };
  let offset = 0;
  let lineStart = 0;
  let lastCompleteByteOffset = minOffset;
  let count = 0;
  const source = getTranscriptSource(jsonlPath);

  while (offset < content.byteLength) {
    const nextNewline = content.indexOf(0x0a, offset);
    if (nextNewline === -1) {
      // Trailing partial line — skip (don't emit incomplete records)
      break;
    }
    const lineNumber = count + 1;
    if (lineStart >= minOffset) {
      const raw = content
        .subarray(lineStart, nextNewline)
        .toString('utf8')
        .trim();
      if (raw) {
        const parsedLine = parseTranscriptLine({
          jsonlPath,
          source,
          lineNumber,
          byteStart: lineStart,
          byteEnd: nextNewline + 1,
          rawLine: raw,
        });

        switch (parsedLine.kind) {
          case 'typed_history':
            records.push(parsedLine.record);
            lines.push(parsedLine.line);
            break;
          case 'raw_record':
            records.push(parsedLine.record);
            break;
          case 'degraded_history':
            records.push(parsedLine.record);
            counts.invalidShapeLineCount += 1;
            counts.degradedHistoryLineCount += 1;
            break;
          case 'invalid_json':
            counts.invalidJsonLineCount += 1;
            break;
          case 'invalid_shape':
            counts.invalidShapeLineCount += 1;
            break;
          case 'skipped':
            counts.skippedLineCount += 1;
            break;
          default:
            assertNever(parsedLine);
        }
      }
    }
    lastCompleteByteOffset = nextNewline + 1;
    lineStart = nextNewline + 1;
    offset = lineStart;
    count++;
  }
  counts.completeLineCount = count;
  return { records, lines, lastCompleteByteOffset, counts };
}

async function readFullTailState(
  cacheKey: string,
  jsonlPath: string,
  previousByteOffset: number,
  snapshotFileSize: number
): Promise<TailState> {
  const fullContent = await readRange(jsonlPath, 0, snapshotFileSize);
  const allComplete = recordsStartingAtOrAfter(jsonlPath, fullContent, 0);
  const toolNameById = buildToolNameMap(allComplete.lines);
  const sliced = recordsStartingAtOrAfter(
    jsonlPath,
    fullContent,
    previousByteOffset
  );
  const precedingTimestamp = findLastRecordTimestamp(
    allComplete.records.filter(record => record.byteEnd <= previousByteOffset)
  );
  const lastTimestamp = findLastRecordTimestamp(allComplete.records);

  setTailFileCache(cacheKey, {
    completeByteOffset: sliced.lastCompleteByteOffset,
    completeLineCount: allComplete.counts.completeLineCount,
    toolNameById,
    ...(lastTimestamp !== undefined ? { lastTimestamp } : {}),
  });

  return {
    records: sliced.records,
    lines: sliced.lines,
    toolNameById,
    ...(precedingTimestamp !== undefined ? { precedingTimestamp } : {}),
    nextByteOffset: sliced.lastCompleteByteOffset,
    counts: sliced.counts,
  };
}

async function readIncrementalTailState(
  cacheKey: string,
  jsonlPath: string,
  previousByteOffset: number,
  fileSize: number,
  cached: TailFileCache
): Promise<TailState> {
  const appendedContent = await readRange(
    jsonlPath,
    previousByteOffset,
    fileSize
  );
  const sliced = recordsStartingAtOrAfter(jsonlPath, appendedContent, 0);
  const toolNameById = new Map(cached.toolNameById);
  const appendedToolNameById = buildToolNameMap(sliced.lines);
  const precedingTimestamp = cached.lastTimestamp;
  const lastTimestamp = findLastRecordTimestamp(
    sliced.records,
    cached.lastTimestamp
  );

  for (const [toolUseId, toolName] of appendedToolNameById) {
    toolNameById.set(toolUseId, toolName);
  }

  const nextByteOffset = previousByteOffset + sliced.lastCompleteByteOffset;
  setTailFileCache(cacheKey, {
    completeByteOffset: nextByteOffset,
    completeLineCount:
      cached.completeLineCount + sliced.counts.completeLineCount,
    toolNameById,
    ...(lastTimestamp !== undefined ? { lastTimestamp } : {}),
  });

  return {
    records: sliced.records.map(record => ({
      ...record,
      lineNumber: cached.completeLineCount + record.lineNumber,
      byteStart: previousByteOffset + record.byteStart,
      byteEnd: previousByteOffset + record.byteEnd,
      id: createRawTranscriptRecordId(
        compactRecordIdArgs({
          sessionId: record.sessionId,
          sourceId: record.sourceId,
          uuid: record.uuid,
          byteStart: previousByteOffset + record.byteStart,
          byteEnd: previousByteOffset + record.byteEnd,
          rawLine: record.rawLine,
        })
      ),
    })),
    lines: sliced.lines,
    toolNameById,
    ...(precedingTimestamp !== undefined ? { precedingTimestamp } : {}),
    nextByteOffset,
    counts: sliced.counts,
  };
}

function findLastRecordTimestamp(
  records: readonly RawTranscriptRecord[],
  initialTimestamp?: string
): string | undefined {
  let lastTimestamp = initialTimestamp;
  for (const record of records) {
    if (record.timestamp !== undefined && record.timestamp.length > 0) {
      lastTimestamp = record.timestamp;
    }
  }
  return lastTimestamp;
}

async function readRange(
  jsonlPath: string,
  startOffset: number,
  endOffset: number
): Promise<Buffer> {
  const length = endOffset - startOffset;
  if (length <= 0) return Buffer.alloc(0);

  const file = await open(jsonlPath, 'r');
  const buffer = Buffer.alloc(length);
  try {
    const { bytesRead } = await file.read(buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

type ParsedTranscriptLine =
  | { kind: 'typed_history'; line: RawHistoryLine; record: RawTranscriptRecord }
  | { kind: 'raw_record'; record: RawTranscriptRecord }
  | { kind: 'degraded_history'; record: RawTranscriptRecord }
  | { kind: 'invalid_json' }
  | { kind: 'invalid_shape' }
  | { kind: 'skipped' };

function parseTranscriptLine(args: {
  jsonlPath: string;
  source: ReturnType<typeof getTranscriptSource>;
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  rawLine: string;
}): ParsedTranscriptLine {
  let parsed: unknown;

  try {
    parsed = JSON.parse(args.rawLine);
  } catch {
    return { kind: 'invalid_json' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'skipped' };
  }

  const rawResult = safeValidateRawTranscriptPayloadMetadata(parsed);
  if (!rawResult.success) {
    return { kind: 'invalid_shape' };
  }

  const record = buildRawTranscriptRecord({
    jsonlPath: args.jsonlPath,
    source: args.source,
    lineNumber: args.lineNumber,
    byteStart: args.byteStart,
    byteEnd: args.byteEnd,
    rawLine: args.rawLine,
    payload: rawResult.data,
  });

  if (!isKnownRawHistoryLineType(rawResult.data.type)) {
    return { kind: 'raw_record', record };
  }

  const typedCandidate = withDefaultSessionId(
    rawResult.data,
    args.source.fallbackSessionId
  );
  const typedResult = safeValidateRawHistoryLine(typedCandidate);
  if (!typedResult.success) {
    // Known-type line whose payload drifted from the strict typed schema
    // (newer Claude Code releases add fields and content shapes faster than
    // the schema tracks them). Typed consumers still see it counted under
    // invalidShapeLineCount, but raw consumers keep the full record.
    return { kind: 'degraded_history', record };
  }

  return { kind: 'typed_history', line: typedResult.data, record };
}

function isKnownRawHistoryLineType(
  value: RawTranscriptPayloadMetadataSchema['type']
): value is RawHistoryLine['type'] {
  return (
    value === 'user' ||
    value === 'assistant' ||
    value === 'system' ||
    value === 'result' ||
    value === 'progress' ||
    value === 'file-history-snapshot'
  );
}

/**
 * Backfill a missing `sessionId` on an already-validated transcript payload.
 *
 * Sibling of `withDefaultSessionId` in parser.ts. They are intentionally NOT
 * merged: this one takes a typed, validated payload and guards on
 * `sessionId !== undefined`, whereas the parser variant takes raw `unknown`
 * and guards via `'sessionId' in parsed` before the typed validation pass.
 * Their backfill behavior is equivalent and pinned by
 * tests/processing-core-hardening.test.ts so they cannot silently drift.
 */
function withDefaultSessionId(
  payload: RawTranscriptPayloadMetadataSchema,
  defaultSessionId: string
): RawTranscriptPayloadMetadataSchema {
  if (payload.sessionId !== undefined) {
    return payload;
  }

  return {
    ...payload,
    sessionId: defaultSessionId,
  };
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === code
  );
}

function getTranscriptSource(jsonlPath: string): {
  sourceKind: 'main' | 'subagent';
  sourceId: string;
  fallbackSessionId: string;
} {
  const stem = basename(jsonlPath, '.jsonl');
  const parent = basename(dirname(jsonlPath));
  if (parent === 'subagents') {
    return {
      sourceKind: 'subagent',
      sourceId: stem,
      fallbackSessionId: basename(dirname(dirname(jsonlPath))),
    };
  }
  return {
    sourceKind: 'main',
    sourceId: 'main',
    fallbackSessionId: stem,
  };
}

function buildRawTranscriptRecord(args: {
  jsonlPath: string;
  source: ReturnType<typeof getTranscriptSource>;
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  rawLine: string;
  payload: unknown;
}): RawTranscriptRecord {
  const payload = isRecord(args.payload) ? args.payload : {};
  const sessionId =
    typeof payload['sessionId'] === 'string'
      ? payload['sessionId']
      : args.source.fallbackSessionId;
  const uuid =
    typeof payload['uuid'] === 'string' ? payload['uuid'] : undefined;
  const parentUuid =
    typeof payload['parentUuid'] === 'string' || payload['parentUuid'] === null
      ? payload['parentUuid']
      : undefined;
  const timestamp =
    typeof payload['timestamp'] === 'string' ? payload['timestamp'] : undefined;
  const type =
    typeof payload['type'] === 'string' ? payload['type'] : undefined;

  return {
    id: createRawTranscriptRecordId(
      compactRecordIdArgs({
        sessionId,
        sourceId: args.source.sourceId,
        uuid,
        byteStart: args.byteStart,
        byteEnd: args.byteEnd,
        rawLine: args.rawLine,
      })
    ),
    sessionId,
    sourcePath: args.jsonlPath,
    sourceKind: args.source.sourceKind,
    sourceId: args.source.sourceId,
    lineNumber: args.lineNumber,
    byteStart: args.byteStart,
    byteEnd: args.byteEnd,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(uuid !== undefined ? { uuid } : {}),
    ...(parentUuid !== undefined ? { parentUuid } : {}),
    ...(type !== undefined ? { type } : {}),
    rawLine: args.rawLine,
    payload: args.payload,
  };
}

function createRawTranscriptRecordId(args: {
  sessionId: string;
  sourceId: string;
  uuid?: string;
  byteStart: number;
  byteEnd: number;
  rawLine: string;
}): string {
  if (args.uuid !== undefined && args.uuid.length > 0) {
    return `${args.sessionId}:${args.sourceId}:${args.uuid}`;
  }
  const hash = createHash('sha256').update(args.rawLine).digest('hex');
  return `${args.sessionId}:${args.sourceId}:${String(args.byteStart)}:${String(args.byteEnd)}:${hash}`;
}

function compactRecordIdArgs(args: {
  sessionId: string;
  sourceId: string;
  uuid: string | undefined;
  byteStart: number;
  byteEnd: number;
  rawLine: string;
}): {
  sessionId: string;
  sourceId: string;
  uuid?: string;
  byteStart: number;
  byteEnd: number;
  rawLine: string;
} {
  return {
    sessionId: args.sessionId,
    sourceId: args.sourceId,
    ...(args.uuid !== undefined ? { uuid: args.uuid } : {}),
    byteStart: args.byteStart,
    byteEnd: args.byteEnd,
    rawLine: args.rawLine,
  };
}

function toPublicRawTranscriptRecords(
  records: readonly RawTranscriptRecord[],
  options: RawTranscriptTailOptions | RawTranscriptReadOptions
): readonly RawTranscriptRecord[] {
  if (options.rawRedactionMode === 'unsafe-unredacted') {
    return records;
  }

  return records.map(record => ({
    ...record,
    rawLine: REDACTED_RAW_TRANSCRIPT_LINE,
    payload: redactRawTranscriptPayload(record.payload),
  }));
}

function redactRawTranscriptPayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    return REDACTED_RAW_TRANSCRIPT_VALUE;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => redactRawTranscriptPayload(item));
  }

  if (isRecord(payload)) {
    const redacted = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        redactRawTranscriptPayload(value),
      ])
    );
    return redacted;
  }

  return payload;
}

function sanitizeMarkerBase(raw: string): string {
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    return 'session';
  }
  return sanitized;
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
      'Custom markerDir requires allowedMarkerRoots (or CLAUDE_TAIL_MARKER_ROOTS) to include an allowed root'
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
  const raw = process.env['CLAUDE_TAIL_MARKER_ROOTS'];
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

function assertNever(value: never): never {
  throw new Error(`Unhandled parsed transcript line: ${JSON.stringify(value)}`);
}

function hasTailProcessingCounts(counts: TailProcessingCounts): boolean {
  return (
    counts.invalidJsonLineCount > 0 ||
    counts.invalidShapeLineCount > 0 ||
    counts.skippedLineCount > 0
  );
}
