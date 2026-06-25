/**
 * Tail mode — incremental `SessionBlock` emission for live consumers.
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
 *   4. Marker is automatically advanced to the new file size so the next
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
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { buildToolNameMap } from './denoiser.js';
import { decomposeHistoryLine } from './block-decomposition.js';
import { compareStrings } from './ordering.js';
import {
  safeValidateRawHistoryLine,
  safeValidateRawTranscriptPayloadMetadata,
} from '../validation/validators.js';
import type { RawTranscriptPayloadMetadataSchema } from '../validation/schemas.js';
import { isRecord } from '../utils/index.js';
import type {
  RawHistoryLine,
  RawTranscriptRecord,
  RawTranscriptRedactionMode,
  RawTranscriptSession,
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
 */
export function getMarkerPath(jsonlPath: string, markerDir?: string): string {
  const dir =
    markerDir === undefined
      ? resolve(dirname(jsonlPath), '.tail-markers')
      : resolveAllowedMarkerDir(markerDir);
  const base = sanitizeMarkerBase(basename(jsonlPath, '.jsonl'));
  return join(dir, `${base}.json`);
}

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

export async function writeMarker(
  markerPath: string,
  marker: TailMarker
): Promise<void> {
  const markerDir = dirname(markerPath);
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    markerDir,
    `.${basename(markerPath)}.${String(process.pid)}.${String(Date.now())}.tmp`
  );
  try {
    await writeFile(tempPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
    await rename(tempPath, markerPath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// Tail

export interface TailOptions {
  /** Override marker storage directory (default: `<jsonlDir>/.tail-markers/`) */
  readonly markerDir?: string;
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
}

interface TailStateCounts extends TailProcessingCounts {
  readonly completeLineCount: number;
}

interface TailState {
  readonly records: readonly RawTranscriptRecord[];
  readonly lines: readonly RawHistoryLine[];
  readonly toolNameById: ReadonlyMap<string, string>;
  readonly nextByteOffset: number;
  readonly counts: TailStateCounts;
}

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
  // line order: tail emits incrementally as the file grows, so it sorts each
  // emitted batch by timestamp to stay robust against out-of-order appends in
  // live sessions. Under the normal time-ordered append pattern this produces
  // the same ordering as extractBlocks, so parity holds for completed sessions.
  blocks.sort((a, b) => compareStrings(a.timestamp, b.timestamp));

  const skippedTypedLineCount =
    result.skippedLineCount + (result.records.length - result.lines.length);

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

async function tailTranscriptRecordsInternal(
  jsonlPath: string,
  options: TailOptions = {}
): Promise<
  RawTranscriptTailResult & {
    toolNameById: ReadonlyMap<string, string>;
    lines: readonly RawHistoryLine[];
  }
> {
  const cacheKey = resolve(jsonlPath);
  const stats = await stat(jsonlPath);
  const fileSize = stats.size;

  const markerPath = getMarkerPath(jsonlPath, options.markerDir);
  const existing = options.fromStart ? null : await readMarker(markerPath);

  // File rotated/truncated since last tail — full re-scan from start
  const fileRotated = existing !== null && fileSize < existing.byteOffset;
  const previousByteOffset = fileRotated ? 0 : (existing?.byteOffset ?? 0);

  // No new bytes — nothing to do
  if (previousByteOffset === fileSize) {
    return {
      records: [],
      lines: [],
      newByteOffset: fileSize,
      previousByteOffset,
      fileSize,
      fileRotated,
      toolNameById: tailFileCache.get(cacheKey)?.toolNameById ?? new Map(),
      invalidJsonLineCount: 0,
      invalidShapeLineCount: 0,
      skippedLineCount: 0,
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
      : await readFullTailState(cacheKey, jsonlPath, previousByteOffset);

  const nextByteOffset = tailState.nextByteOffset;

  if (!options.dryRun) {
    await writeMarker(markerPath, {
      byteOffset: nextByteOffset,
      lastTailAt: new Date().toISOString(),
      fileSize,
    });
  }

  return {
    records: tailState.records,
    lines: tailState.lines,
    newByteOffset: nextByteOffset,
    previousByteOffset,
    fileSize,
    fileRotated,
    toolNameById: tailState.toolNameById,
    invalidJsonLineCount: tailState.counts.invalidJsonLineCount,
    invalidShapeLineCount: tailState.counts.invalidShapeLineCount,
    skippedLineCount: tailState.counts.skippedLineCount,
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
  previousByteOffset: number
): Promise<TailState> {
  const fullContent = await readFile(jsonlPath);
  const allComplete = recordsStartingAtOrAfter(jsonlPath, fullContent, 0);
  const toolNameById = buildToolNameMap(allComplete.lines);
  const sliced = recordsStartingAtOrAfter(
    jsonlPath,
    fullContent,
    previousByteOffset
  );

  setTailFileCache(cacheKey, {
    completeByteOffset: sliced.lastCompleteByteOffset,
    completeLineCount: allComplete.counts.completeLineCount,
    toolNameById,
  });

  return {
    records: sliced.records,
    lines: sliced.lines,
    toolNameById,
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

  for (const [toolUseId, toolName] of appendedToolNameById) {
    toolNameById.set(toolUseId, toolName);
  }

  const nextByteOffset = previousByteOffset + sliced.lastCompleteByteOffset;
  setTailFileCache(cacheKey, {
    completeByteOffset: nextByteOffset,
    completeLineCount:
      cached.completeLineCount + sliced.counts.completeLineCount,
    toolNameById,
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
    nextByteOffset,
    counts: sliced.counts,
  };
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
    return { kind: 'invalid_shape' };
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

function resolveAllowedMarkerDir(markerDir: string): string {
  const resolvedDir = resolve(markerDir);
  const roots = parseAllowedMarkerRoots();
  if (roots.length === 0) {
    throw new Error(
      'Custom markerDir requires CLAUDE_TAIL_MARKER_ROOTS to include an allowed root'
    );
  }
  if (!roots.some(root => isWithinPath(resolvedDir, root))) {
    throw new Error(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
  }
  return resolvedDir;
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
  return child === parent || child.startsWith(`${parent}${sep}`);
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
