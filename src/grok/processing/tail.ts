import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import {
  reduceGrokRecords,
  type GrokActivity,
  type GrokBlockChange,
  type GrokNormalizedRecord,
  type GrokRecordOrigin,
} from './blocks.js';
import { parseGrokEvent } from './events.js';
import {
  readJsonlDelta,
  type JsonlCursor,
  type JsonlDelta,
  type JsonlLine,
} from './jsonl-cursor.js';
import { parseGrokSessionUpdate } from './updates.js';

const MARKER_VERSION = 1;
const STALE_MARKER_LOCK_MS = 30_000;
const SOURCE_FILENAMES = {
  updates: 'updates.jsonl',
  events: 'events.jsonl',
} as const;

/** A persisted Grok session source. */
export type GrokTailSourceKind = keyof typeof SOURCE_FILENAMES;

/** Options shared by Grok session tail and watch operations. */
export interface GrokSessionTailOptions {
  /** Marker directory, defaulting to `<sessionDir>/.tail-markers`. */
  readonly markerDir?: string;
  /** Roots allowed to contain a custom marker directory. */
  readonly allowedMarkerRoots?: readonly string[];
  /** Ignore saved cursors and scan both sources from byte zero. */
  readonly fromStart?: boolean;
  /** Persist on successful tail or defer persistence to an explicit commit. */
  readonly checkpointMode?: 'automatic' | 'manual';
  /** Maximum bytes retained for one JSONL line. */
  readonly maxLineBytes?: number;
  /** Include reduced event activity states, defaulting to true. */
  readonly includeActivities?: boolean;
}

/** Options for watching a Grok session directory. */
export interface GrokSessionWatchOptions extends GrokSessionTailOptions {
  /** Ends observation and closes the underlying filesystem watcher. */
  readonly signal?: AbortSignal;
}

/** Marker controls accepted by manual checkpoint commits. */
export interface GrokSessionCheckpointCommitOptions {
  /** Marker directory, defaulting to `<sessionDir>/.tail-markers`. */
  readonly markerDir?: string;
  /** Roots allowed to contain a custom marker directory. */
  readonly allowedMarkerRoots?: readonly string[];
}

/** Serializable cursor state for one Grok session source. */
export interface GrokSessionSourceCheckpoint {
  readonly sourceKind: GrokTailSourceKind;
  readonly cursor: JsonlCursor | null;
}

/** Revision-bound checkpoint returned by a successful two-source read. */
export interface GrokSessionCheckpoint {
  readonly sessionPathDigest: string;
  readonly baseRevision: number;
  readonly sources: readonly GrokSessionSourceCheckpoint[];
}

/** One parsed, ordered record emitted by a Grok session tail. */
export interface GrokTailRecord {
  readonly sourceKind: GrokTailSourceKind;
  readonly effectiveTimestamp: number;
  readonly nativeType: string;
  readonly generation: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly record: GrokNormalizedRecord;
}

/** A parse or cursor diagnostic tied to one physical source record. */
export interface GrokTailDiagnostic {
  readonly sourceKind: GrokTailSourceKind;
  readonly kind:
    | 'invalid_json'
    | 'invalid_record'
    | 'unknown_record'
    | 'oversized';
  readonly lineNumber: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly message: string;
}

/** State reached for one source during a tail pass. */
export interface GrokSourceTailResult {
  readonly sourceKind: GrokTailSourceKind;
  readonly sourcePath: string;
  readonly status: 'read' | 'missing';
  readonly recordCount: number;
  readonly generation: number;
  readonly previousByteOffset: number;
  readonly newByteOffset: number;
  readonly fileSize: number | null;
  readonly reset: boolean;
}

/** Notification that a source was replaced, truncated, or rewritten. */
export interface GrokSourceReset {
  readonly type: 'source_reset';
  readonly sourceKind: GrokTailSourceKind;
  readonly generation: number;
}

/** Outcome of checkpoint handling after a successful two-source read. */
export type GrokCheckpointStatus =
  | { readonly status: 'committed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'manual' }
  | { readonly status: 'failed'; readonly error: string };

/** Result of one atomic two-source Grok session read. */
export interface GrokSessionTailResult {
  readonly sessionDir: string;
  readonly records: readonly GrokTailRecord[];
  readonly changes: readonly GrokBlockChange[];
  readonly activities: readonly GrokActivity[];
  readonly diagnostics: readonly GrokTailDiagnostic[];
  readonly sources: readonly GrokSourceTailResult[];
  readonly resets: readonly GrokSourceReset[];
  readonly checkpoint: GrokSessionCheckpoint;
  /**
   * Automatic persistence outcome for this pass. A `failed` status leaves the
   * saved marker unchanged, so the next call replays this batch and can commit
   * it after marker storage becomes writable. Manual commits still reject.
   */
  readonly checkpointStatus: GrokCheckpointStatus;
}

interface GrokSessionMarker {
  readonly version: 1;
  readonly sessionPathDigest: string;
  readonly revision: number;
  readonly sources: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>;
}

interface ParsedSource {
  readonly records: readonly GrokTailRecord[];
  readonly diagnostics: readonly GrokTailDiagnostic[];
}

interface ParsedLine {
  readonly record?: GrokTailRecord;
  readonly diagnostic?: GrokTailDiagnostic;
}

class StaleGrokSessionCheckpointError extends Error {}

/**
 * Tail updates.jsonl and events.jsonl as one revisioned session stream.
 *
 * Both size-snapshotted source reads must succeed before the checkpoint can be
 * committed. A missing events.jsonl is represented by a `missing` source; a
 * missing updates.jsonl is an error. Complete malformed records advance their
 * source cursor and are reported as diagnostics. Unknown tags are preserved as
 * native records and also reported as diagnostics.
 *
 * Automatic checkpoint failures do not discard a successfully read batch.
 * They return `checkpointStatus: { status: 'failed', error }`, leave the saved
 * marker unchanged, and cause the next call to replay the batch. Explicit
 * `commitGrokSessionCheckpoint` failures reject.
 *
 * @param sessionDir - Directory containing Grok's persisted session files.
 * @param options - Cursor, marker, reduction, and line-size controls.
 * @returns Ordered records, normalized changes, diagnostics, and checkpoint.
 * @throws If either source read fails.
 */
export async function tailGrokSession(
  sessionDir: string,
  options: GrokSessionTailOptions = {}
): Promise<GrokSessionTailResult> {
  const resolvedSessionDir = resolve(sessionDir);
  const sessionPathDigest = createSessionPathDigest(resolvedSessionDir);
  const markerPath = getGrokSessionMarkerPath(resolvedSessionDir, options);
  const marker = await readGrokSessionMarker(markerPath, sessionPathDigest);
  const cursorOptions =
    options.maxLineBytes === undefined
      ? undefined
      : { maxLineBytes: options.maxLineBytes };

  const markerCursors = {
    updates: marker?.sources.updates ?? null,
    events: marker?.sources.events ?? null,
  } satisfies Record<GrokTailSourceKind, JsonlCursor | null>;
  const previousCursors = {
    updates: options.fromStart ? null : markerCursors.updates,
    events: options.fromStart ? null : markerCursors.events,
  } satisfies Record<GrokTailSourceKind, JsonlCursor | null>;
  const updatePath = join(resolvedSessionDir, SOURCE_FILENAMES.updates);
  const eventPath = join(resolvedSessionDir, SOURCE_FILENAMES.events);

  const updateDelta = await readJsonlDelta(
    updatePath,
    previousCursors.updates,
    cursorOptions
  );
  if (updateDelta.fileSize === null) {
    throw new Error(`Missing required Grok updates source '${updatePath}'`);
  }
  const eventDelta = await readJsonlDelta(
    eventPath,
    previousCursors.events,
    cursorOptions
  );

  const deltas = {
    updates: applyFromStartGeneration(
      updateDelta,
      markerCursors.updates,
      options.fromStart
    ),
    events: applyFromStartGeneration(
      eventDelta,
      markerCursors.events,
      options.fromStart
    ),
  } as const;
  const parsedDelta = parseSources(deltas);
  const orderedRecords = [...parsedDelta.records].sort(compareTailRecords);
  const deltaOrigins = new Set(
    orderedRecords.map(record => originKey(record.record.origin))
  );

  let reductionRecords: readonly GrokNormalizedRecord[] = orderedRecords.map(
    record => record.record
  );
  if (orderedRecords.length > 0 && hasPriorCommittedBytes(previousCursors)) {
    const [allUpdates, allEvents] = await Promise.all([
      readJsonlDelta(updatePath, null, cursorOptions),
      readJsonlDelta(eventPath, null, cursorOptions),
    ]);
    if (allUpdates.fileSize === null) {
      throw new Error(`Missing required Grok updates source '${updatePath}'`);
    }
    const fullParsed = parseSources(
      { updates: allUpdates, events: allEvents },
      {
        updates: updateDelta.cursor?.generation ?? 0,
        events: eventDelta.cursor?.generation ?? 0,
      }
    );
    reductionRecords = [...fullParsed.records]
      .sort(compareTailRecords)
      .map(record => record.record);
  }

  const reduction = reduceGrokRecords(reductionRecords);
  const changes = reduction.changes.filter(change =>
    deltaOrigins.has(
      originKey(change.type === 'upsert' ? change.block.origin : change.origin)
    )
  );
  const activities =
    options.includeActivities === false
      ? []
      : reduction.activities.filter(activity =>
          deltaOrigins.has(originKey(activity.origin))
        );
  const checkpoint: GrokSessionCheckpoint = {
    sessionPathDigest,
    baseRevision: marker?.revision ?? 0,
    sources: sourceKinds().map(sourceKind => ({
      sourceKind,
      cursor: deltas[sourceKind].cursor,
    })),
  };
  const sources = sourceKinds().map(sourceKind =>
    sourceResult(
      sourceKind,
      join(resolvedSessionDir, SOURCE_FILENAMES[sourceKind]),
      previousCursors[sourceKind],
      deltas[sourceKind],
      parsedDelta.records
    )
  );
  const resets: GrokSourceReset[] = sources
    .filter(source => source.reset)
    .map(source => ({
      type: 'source_reset',
      sourceKind: source.sourceKind,
      generation: source.generation,
    }));

  let checkpointStatus: GrokCheckpointStatus;
  if (options.checkpointMode === 'manual') {
    checkpointStatus = { status: 'manual' };
  } else if (!shouldCommitMarker(marker, checkpoint)) {
    checkpointStatus = { status: 'unchanged' };
  } else {
    try {
      await commitGrokSessionCheckpoint(
        resolvedSessionDir,
        checkpoint,
        options
      );
      checkpointStatus = { status: 'committed' };
    } catch (error: unknown) {
      checkpointStatus = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    sessionDir: resolvedSessionDir,
    records: orderedRecords,
    changes,
    activities,
    diagnostics: parsedDelta.diagnostics,
    sources,
    resets,
    checkpoint,
    checkpointStatus,
  };
}

/**
 * Commit a checkpoint after its emitted changes have been durably consumed.
 *
 * The checkpoint is accepted only for the same resolved session path and base
 * revision. Source offsets cannot move backwards without one generation step.
 *
 * @param sessionDir - Session directory used to produce the checkpoint.
 * @param checkpoint - Checkpoint returned by `tailGrokSession`.
 * @param options - Marker destination and root allow-list.
 * @returns After the marker has been atomically replaced.
 * @throws If the checkpoint is stale, malformed, unsafe, or for another path.
 */
export async function commitGrokSessionCheckpoint(
  sessionDir: string,
  checkpoint: GrokSessionCheckpoint,
  options: GrokSessionCheckpointCommitOptions = {}
): Promise<void> {
  const resolvedSessionDir = resolve(sessionDir);
  const sessionPathDigest = createSessionPathDigest(resolvedSessionDir);
  if (checkpoint.sessionPathDigest !== sessionPathDigest) {
    throw new Error('Grok session checkpoint does not match the session path');
  }
  const nextSources = checkpointSources(checkpoint);
  const markerPath = getGrokSessionMarkerPath(resolvedSessionDir, options);
  await withMarkerLock(markerPath, async () => {
    const marker = await readGrokSessionMarker(markerPath, sessionPathDigest);
    const revision = marker?.revision ?? 0;
    if (checkpoint.baseRevision !== revision) {
      throw new StaleGrokSessionCheckpointError(
        'Grok session checkpoint is stale for the current marker'
      );
    }
    validateCheckpointProgression(marker, nextSources);
    await writePrivateJson(markerPath, {
      version: MARKER_VERSION,
      sessionPathDigest,
      revision: revision + 1,
      sources: nextSources,
    } satisfies GrokSessionMarker);
  });
}

/**
 * Watch updates.jsonl and events.jsonl and yield successful non-empty passes.
 *
 * Native filesystem callbacks are coalesced within one event-loop turn. No
 * polling interval is used. The first `next()` yields an initial pass after
 * filesystem observation is active, giving callers a deterministic readiness
 * handshake. Aborting or closing iteration releases the watcher. `fromStart`
 * applies only to the initial pass.
 *
 * @param sessionDir - Directory containing the two Grok JSONL sources.
 * @param options - Tail options plus an optional cancellation signal.
 * @returns An async sequence of changed session batches.
 */
export async function* watchGrokSession(
  sessionDir: string,
  options: GrokSessionWatchOptions = {}
): AsyncGenerator<GrokSessionTailResult, void, unknown> {
  const resolvedSessionDir = resolve(sessionDir);
  const { signal, ...initialTailOptions } = options;
  let tailOptions: GrokSessionTailOptions = initialTailOptions;
  let changed = false;
  let wake: (() => void) | undefined;
  let queued = false;
  let watchError: Error | undefined;

  const watcher = watch(resolvedSessionDir, (_eventType, filename) => {
    const name = filename?.toString();
    if (name !== SOURCE_FILENAMES.updates && name !== SOURCE_FILENAMES.events) {
      return;
    }
    changed = true;
    if (wake === undefined || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const resolveWake = wake;
      wake = undefined;
      resolveWake?.();
    });
  });
  watcher.on('error', error => {
    watchError = error;
    changed = true;
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  });
  const abort = (): void => {
    watcher.close();
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const initialResult = await tailGrokSession(
      resolvedSessionDir,
      tailOptions
    );
    if (tailOptions.fromStart === true) {
      const { fromStart: _fromStart, ...remainingOptions } = tailOptions;
      tailOptions = remainingOptions;
    }
    yield initialResult;

    while (signal?.aborted !== true) {
      if (!changed) {
        await new Promise<void>(resolveWake => {
          wake = resolveWake;
          if (changed || signal?.aborted === true) {
            wake = undefined;
            resolveWake();
          }
        });
      }
      if (isAborted(signal)) return;
      if (watchError !== undefined) throw watchError;
      changed = false;
      const result = await tailGrokSession(resolvedSessionDir, tailOptions);
      if (isObservableResult(result)) yield result;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    watcher.close();
  }
}

function parseSources(
  deltas: Readonly<Record<GrokTailSourceKind, JsonlDelta>>,
  generations?: Readonly<Record<GrokTailSourceKind, number>>
): ParsedSource {
  const records: GrokTailRecord[] = [];
  const diagnostics: GrokTailDiagnostic[] = [];
  for (const sourceKind of sourceKinds()) {
    const delta = deltas[sourceKind];
    const generation =
      generations?.[sourceKind] ?? delta.cursor?.generation ?? 0;
    for (const diagnostic of delta.diagnostics) {
      diagnostics.push({
        sourceKind,
        kind: 'oversized',
        lineNumber: diagnostic.lineNumber,
        byteStart: diagnostic.byteStart,
        byteEnd: diagnostic.byteEnd,
        message: 'JSONL line exceeds maxLineBytes',
      });
    }
    for (const line of delta.lines) {
      const parsed = parseLine(sourceKind, generation, line);
      if (parsed.record !== undefined) records.push(parsed.record);
      if (parsed.diagnostic !== undefined) {
        diagnostics.push(parsed.diagnostic);
      }
    }
  }
  return { records, diagnostics };
}

function parseLine(
  sourceKind: GrokTailSourceKind,
  generation: number,
  line: JsonlLine
): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line.value) as unknown;
  } catch (error: unknown) {
    return {
      diagnostic: lineDiagnostic(
        sourceKind,
        line,
        'invalid_json',
        error instanceof Error ? error.message : String(error)
      ),
    };
  }

  if (sourceKind === 'updates') {
    const parsed = parseGrokSessionUpdate(raw);
    if (parsed.kind === 'unknown') {
      return unknownParsedLine(
        sourceKind,
        generation,
        line,
        parsed.tag,
        parsed.raw
      );
    }
    if (parsed.kind !== 'known') {
      return {
        diagnostic: lineDiagnostic(
          sourceKind,
          line,
          'invalid_record',
          parsed.error
        ),
      };
    }
    const nativeType = parsed.envelope.params.update.sessionUpdate;
    const origin = createOrigin(sourceKind, nativeType, generation, line);
    const record: GrokNormalizedRecord = {
      kind: 'update',
      envelope: parsed.envelope,
      origin,
    };
    return {
      record: {
        sourceKind,
        effectiveTimestamp: updateTimestamp(parsed.envelope),
        nativeType,
        generation,
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        record,
      },
    };
  }

  const parsed = parseGrokEvent(raw);
  if (parsed.kind === 'unknown') {
    return unknownParsedLine(
      sourceKind,
      generation,
      line,
      parsed.tag,
      parsed.raw
    );
  }
  if (parsed.kind !== 'known') {
    return {
      diagnostic: lineDiagnostic(
        sourceKind,
        line,
        'invalid_record',
        parsed.error
      ),
    };
  }
  const nativeType = parsed.event.type;
  const origin = createOrigin(sourceKind, nativeType, generation, line);
  const record: GrokNormalizedRecord = {
    kind: 'event',
    event: parsed.event,
    origin,
  };
  const parsedTimestamp = Date.parse(parsed.event.ts);
  return {
    record: {
      sourceKind,
      effectiveTimestamp: Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : 0,
      nativeType,
      generation,
      byteStart: line.byteStart,
      byteEnd: line.byteEnd,
      record,
    },
  };
}

function unknownParsedLine(
  sourceKind: GrokTailSourceKind,
  generation: number,
  line: JsonlLine,
  tag: string,
  raw: unknown
): ParsedLine {
  const origin = createOrigin(sourceKind, tag, generation, line);
  const record: GrokNormalizedRecord = {
    kind: 'unknown',
    tag,
    raw,
    origin,
  };
  return {
    record: {
      sourceKind,
      effectiveTimestamp: unknownRecordTimestamp(sourceKind, raw),
      nativeType: tag,
      generation,
      byteStart: line.byteStart,
      byteEnd: line.byteEnd,
      record,
    },
    diagnostic: lineDiagnostic(
      sourceKind,
      line,
      'unknown_record',
      sourceKind === 'updates'
        ? `Unknown update '${tag}'`
        : `Unknown event '${tag}'`
    ),
  };
}

function createOrigin(
  sourceKind: GrokTailSourceKind,
  nativeType: string,
  generation: number,
  line: JsonlLine
): GrokRecordOrigin {
  return {
    harness: 'grok',
    stream: sourceKind === 'updates' ? 'conversation' : 'activity',
    sourceId: sourceKind,
    nativeType,
    generation,
    byteStart: line.byteStart,
    byteEnd: line.byteEnd,
  };
}

function lineDiagnostic(
  sourceKind: GrokTailSourceKind,
  line: JsonlLine,
  kind: GrokTailDiagnostic['kind'],
  message: string
): GrokTailDiagnostic {
  return {
    sourceKind,
    kind,
    lineNumber: line.lineNumber,
    byteStart: line.byteStart,
    byteEnd: line.byteEnd,
    message,
  };
}

function unknownRecordTimestamp(
  sourceKind: GrokTailSourceKind,
  raw: unknown
): number {
  if (!isRecord(raw)) return 0;
  if (sourceKind === 'updates') {
    const timestamp = raw['timestamp'];
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return Math.abs(timestamp) < 100_000_000_000
        ? timestamp * 1_000
        : timestamp;
    }
    return 0;
  }
  const timestamp = raw['ts'];
  if (typeof timestamp !== 'string') return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updateTimestamp(
  envelope: Extract<GrokNormalizedRecord, { kind: 'update' }>['envelope']
): number {
  const meta = envelope.params._meta;
  if (typeof meta === 'object' && meta !== null) {
    const value = Reflect.get(meta, 'agentTimestampMs') as unknown;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return Math.abs(envelope.timestamp) < 100_000_000_000
    ? envelope.timestamp * 1_000
    : envelope.timestamp;
}

function compareTailRecords(
  left: GrokTailRecord,
  right: GrokTailRecord
): number {
  if (left.effectiveTimestamp !== right.effectiveTimestamp) {
    return left.effectiveTimestamp < right.effectiveTimestamp ? -1 : 1;
  }
  const sourceDifference =
    sourceRank(left.sourceKind) - sourceRank(right.sourceKind);
  if (sourceDifference !== 0) return sourceDifference;
  if (left.generation !== right.generation) {
    return left.generation < right.generation ? -1 : 1;
  }
  if (left.byteStart !== right.byteStart) {
    return left.byteStart < right.byteStart ? -1 : 1;
  }
  return left.byteEnd - right.byteEnd;
}

function sourceRank(sourceKind: GrokTailSourceKind): number {
  return sourceKind === 'updates' ? 0 : 1;
}

function sourceKinds(): readonly GrokTailSourceKind[] {
  return ['updates', 'events'];
}

function sourceResult(
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

function createSessionPathDigest(sessionDir: string): string {
  return createHash('sha256').update(resolve(sessionDir)).digest('hex');
}

function getGrokSessionMarkerPath(
  sessionDir: string,
  options: GrokSessionCheckpointCommitOptions
): string {
  const markerDir =
    options.markerDir === undefined
      ? resolve(sessionDir, '.tail-markers')
      : resolveAllowedMarkerDir(options.markerDir, options.allowedMarkerRoots);
  const digest = createSessionPathDigest(sessionDir);
  const sessionName = sanitizeMarkerBase(basename(sessionDir));
  return join(
    markerDir,
    `${sessionName}-${digest.slice(0, 16)}.grok-session.json`
  );
}

function resolveAllowedMarkerDir(
  markerDir: string,
  allowedMarkerRoots?: readonly string[]
): string {
  const resolvedDir = resolve(markerDir);
  const roots = (allowedMarkerRoots ?? [])
    .map(root => root.trim())
    .filter(root => root.length > 0)
    .map(root => resolve(root));
  if (roots.length === 0) {
    throw new Error(
      'Custom markerDir requires allowedMarkerRoots to include an allowed root'
    );
  }
  if (!roots.some(root => isWithinPath(resolvedDir, root))) {
    throw new Error(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
  }
  return resolvedDir;
}

function isWithinPath(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

function sanitizeMarkerBase(raw: string): string {
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length === 0 || sanitized === '.' || sanitized === '..'
    ? 'session'
    : sanitized;
}

async function readGrokSessionMarker(
  markerPath: string,
  sessionPathDigest: string
): Promise<GrokSessionMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(parsed) || parsed['version'] !== MARKER_VERSION) return null;
    if (parsed['sessionPathDigest'] !== sessionPathDigest) return null;
    const revision = parsed['revision'];
    const sources = parsed['sources'];
    if (!isSafeNonnegativeInteger(revision) || !isRecord(sources)) return null;
    const updates = parseCursor(sources['updates']);
    const events = parseCursor(sources['events']);
    if (updates === undefined || events === undefined) return null;
    return {
      version: MARKER_VERSION,
      sessionPathDigest,
      revision,
      sources: { updates, events },
    };
  } catch {
    return null;
  }
}

function parseCursor(value: unknown): JsonlCursor | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value['device'] !== 'string' ||
    typeof value['inode'] !== 'string' ||
    !isSafeNonnegativeInteger(value['offset']) ||
    !isSafeNonnegativeInteger(value['lineNumber']) ||
    value['lineNumber'] < 1 ||
    !isSafeNonnegativeInteger(value['generation']) ||
    typeof value['headDigest'] !== 'string' ||
    typeof value['boundaryDigest'] !== 'string'
  ) {
    return undefined;
  }
  return {
    device: value['device'],
    inode: value['inode'],
    offset: value['offset'],
    lineNumber: value['lineNumber'],
    generation: value['generation'],
    headDigest: value['headDigest'],
    boundaryDigest: value['boundaryDigest'],
  };
}

function checkpointSources(
  checkpoint: GrokSessionCheckpoint
): Record<GrokTailSourceKind, JsonlCursor | null> {
  if (!isSafeNonnegativeInteger(checkpoint.baseRevision)) {
    throw new Error('Invalid Grok session checkpoint revision');
  }
  const sources: Partial<Record<GrokTailSourceKind, JsonlCursor | null>> = {};
  for (const source of checkpoint.sources) {
    if (source.sourceKind !== 'updates' && source.sourceKind !== 'events') {
      throw new Error('Invalid Grok session checkpoint source');
    }
    if (Object.hasOwn(sources, source.sourceKind)) {
      throw new Error('Grok session checkpoint has duplicate sources');
    }
    if (source.cursor !== null && parseCursor(source.cursor) === undefined) {
      throw new Error('Invalid Grok session checkpoint cursor');
    }
    sources[source.sourceKind] = source.cursor;
  }
  if (!Object.hasOwn(sources, 'updates') || !Object.hasOwn(sources, 'events')) {
    throw new Error('Grok session checkpoint must contain both sources');
  }
  return { updates: sources.updates ?? null, events: sources.events ?? null };
}

function applyFromStartGeneration(
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

function validateCheckpointProgression(
  marker: GrokSessionMarker | null,
  next: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>
): void {
  for (const sourceKind of sourceKinds()) {
    const previousCursor = marker?.sources[sourceKind] ?? null;
    const nextCursor = next[sourceKind];
    if (previousCursor === null || nextCursor === null) continue;
    if (nextCursor.generation === previousCursor.generation) {
      if (nextCursor.offset < previousCursor.offset) {
        throw new Error(
          'Grok session checkpoint would move a source backwards'
        );
      }
    } else if (nextCursor.generation !== previousCursor.generation + 1) {
      throw new Error(
        'Grok session checkpoint has an invalid generation transition'
      );
    }
  }
}

function shouldCommitMarker(
  marker: GrokSessionMarker | null,
  checkpoint: GrokSessionCheckpoint
): boolean {
  const next = checkpointSources(checkpoint);
  if (marker === null) return next.updates !== null || next.events !== null;
  return sourceKinds().some(
    sourceKind => !cursorsEqual(marker.sources[sourceKind], next[sourceKind])
  );
}

function cursorsEqual(
  left: JsonlCursor | null,
  right: JsonlCursor | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.offset === right.offset &&
    left.lineNumber === right.lineNumber &&
    left.generation === right.generation &&
    left.headDigest === right.headDigest &&
    left.boundaryDigest === right.boundaryDigest
  );
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
      throw new Error(`Grok session marker is locked: '${markerPath}'`);
    }
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (retryError: unknown) {
      if (hasErrorCode(retryError, 'EEXIST')) {
        throw new Error(`Grok session marker is locked: '${markerPath}'`);
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

function hasPriorCommittedBytes(
  cursors: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>
): boolean {
  return sourceKinds().some(
    sourceKind => (cursors[sourceKind]?.offset ?? 0) > 0
  );
}

function originKey(origin: GrokRecordOrigin): string {
  return `${origin.sourceId}:${String(origin.generation)}:${String(origin.byteStart)}:${String(origin.byteEnd)}`;
}

function isObservableResult(result: GrokSessionTailResult): boolean {
  return (
    result.records.length > 0 ||
    result.diagnostics.length > 0 ||
    result.resets.length > 0
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}
