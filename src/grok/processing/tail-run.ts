import { join, resolve } from 'node:path';

import {
  readJsonlDelta,
  type JsonlCursor,
  type JsonlScanStatus,
} from '../../internal/jsonl-cursor.js';
import { reduceGrokRecords } from './blocks.js';
import {
  commitGrokSessionCheckpoint,
  createGrokSessionPathDigest,
  getGrokSessionMarkerPath,
  grokCheckpointSources,
  readGrokSessionMarker,
  shouldCommitGrokMarker,
} from './tail-marker.js';
import {
  compareGrokTailRecords,
  grokOriginKey,
  grokSourceKinds,
} from './tail-order.js';
import { parseGrokSources } from './tail-parse.js';
import {
  applyGrokFromStartGeneration,
  grokSourceResult,
  hasPriorGrokBytes,
} from './tail-result.js';
import {
  GROK_SOURCE_FILENAMES,
  type GrokCheckpointStatus,
  type GrokSessionCheckpoint,
  type GrokSessionTailOptions,
  type GrokSessionTailResult,
  type GrokSourceReset,
  type GrokTailRecord,
  type GrokTailSourceKind,
} from './tail-types.js';

/**
 * Tail updates.jsonl and events.jsonl as one revisioned session stream.
 *
 * @param sessionDir - Directory containing persisted Grok session files.
 * @param options - Cursor, marker, reduction, and line-size controls.
 * @returns Ordered records, normalized changes, diagnostics, and checkpoint.
 */
export async function tailGrokSession(
  sessionDir: string,
  options: GrokSessionTailOptions = {}
): Promise<GrokSessionTailResult> {
  const resolvedSessionDir = resolve(sessionDir);
  const sessionPathDigest = createGrokSessionPathDigest(resolvedSessionDir);
  const markerPath = getGrokSessionMarkerPath(resolvedSessionDir, options);
  const marker = await readGrokSessionMarker(markerPath, sessionPathDigest);
  const cursorOptions = grokCursorOptions(options);
  const supplied = options.checkpoint;
  if (
    supplied !== undefined &&
    supplied.sessionPathDigest !== sessionPathDigest
  ) {
    throw new Error('Grok session checkpoint does not match the session path');
  }
  const suppliedCursors =
    supplied === undefined ? null : grokCheckpointSources(supplied);
  const markerCursors = {
    updates: suppliedCursors?.updates ?? marker?.sources.updates ?? null,
    events: suppliedCursors?.events ?? marker?.sources.events ?? null,
  } satisfies Record<GrokTailSourceKind, JsonlCursor | null>;
  const previousCursors = {
    updates: options.fromStart ? null : markerCursors.updates,
    events: options.fromStart ? null : markerCursors.events,
  } satisfies Record<GrokTailSourceKind, JsonlCursor | null>;
  const updatePath = join(resolvedSessionDir, GROK_SOURCE_FILENAMES.updates);
  const eventPath = join(resolvedSessionDir, GROK_SOURCE_FILENAMES.events);
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
    updates: applyGrokFromStartGeneration(
      updateDelta,
      markerCursors.updates,
      options.fromStart
    ),
    events: applyGrokFromStartGeneration(
      eventDelta,
      markerCursors.events,
      options.fromStart
    ),
  } as const;
  const parsedDelta = parseGrokSources(deltas);
  const orderedRecords = [...parsedDelta.records].sort(compareGrokTailRecords);
  const deltaOrigins = new Set(
    orderedRecords.map(record => grokOriginKey(record.record.origin))
  );
  const priorStateRecords =
    options.fromStart === true ? [] : (supplied?.state?.records ?? []);
  const retained = priorStateRecords.filter(
    record => !deltas[record.sourceKind].reset
  );
  let stateRecords: readonly GrokTailRecord[] = [
    ...retained,
    ...orderedRecords,
  ].sort(compareGrokTailRecords);
  let reductionRecords = stateRecords.map(record => record.record);
  if (
    orderedRecords.length > 0 &&
    hasPriorGrokBytes(previousCursors) &&
    supplied?.state === undefined
  ) {
    const [allUpdates, allEvents] = await Promise.all([
      readJsonlDelta(updatePath, null, cursorOptions),
      readJsonlDelta(eventPath, null, cursorOptions),
    ]);
    if (allUpdates.fileSize === null) {
      throw new Error(`Missing required Grok updates source '${updatePath}'`);
    }
    if (
      allUpdates.scanStatus.status === 'complete' &&
      (allEvents.fileSize === null ||
        allEvents.scanStatus.status === 'complete')
    ) {
      const full = parseGrokSources(
        { updates: allUpdates, events: allEvents },
        {
          updates: updateDelta.cursor?.generation ?? 0,
          events: eventDelta.cursor?.generation ?? 0,
        }
      );
      stateRecords = [...full.records].sort(compareGrokTailRecords);
      reductionRecords = stateRecords.map(record => record.record);
    }
  }
  const reduction = reduceGrokRecords(reductionRecords);
  const changes = reduction.changes.filter(change =>
    deltaOrigins.has(
      grokOriginKey(
        change.type === 'upsert' ? change.block.origin : change.origin
      )
    )
  );
  const activities =
    options.includeActivities === false
      ? []
      : reduction.activities.filter(activity =>
          deltaOrigins.has(grokOriginKey(activity.origin))
        );
  const checkpoint: GrokSessionCheckpoint = {
    sessionPathDigest,
    baseRevision: marker?.revision ?? 0,
    sources: grokSourceKinds().map(sourceKind => ({
      sourceKind,
      cursor: deltas[sourceKind].cursor,
    })),
    state: { records: stateRecords },
  };
  const sources = grokSourceKinds().map(sourceKind =>
    grokSourceResult(
      sourceKind,
      join(resolvedSessionDir, GROK_SOURCE_FILENAMES[sourceKind]),
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
  const checkpointStatus = await persistCheckpoint(
    resolvedSessionDir,
    marker,
    checkpoint,
    options
  );
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
    scanStatus: combineGrokScanStatus(
      deltas.updates.scanStatus,
      deltas.events.scanStatus
    ),
  };
}

function combineGrokScanStatus(
  updates: JsonlScanStatus,
  events: JsonlScanStatus
): JsonlScanStatus {
  if (updates.status === 'limited') return updates;
  if (events.status === 'limited') return events;
  return { status: 'complete' };
}

function grokCursorOptions(options: GrokSessionTailOptions):
  | {
      readonly maxLineBytes?: number;
      readonly maxScanBytes?: number;
      readonly maxScanLines?: number;
    }
  | undefined {
  if (
    options.maxLineBytes === undefined &&
    options.maxScanBytes === undefined &&
    options.maxScanLines === undefined
  ) {
    return undefined;
  }
  return {
    ...(options.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: options.maxLineBytes }),
    ...(options.maxScanBytes === undefined
      ? {}
      : { maxScanBytes: options.maxScanBytes }),
    ...(options.maxScanLines === undefined
      ? {}
      : { maxScanLines: options.maxScanLines }),
  };
}

async function persistCheckpoint(
  sessionDir: string,
  marker: Awaited<ReturnType<typeof readGrokSessionMarker>>,
  checkpoint: GrokSessionCheckpoint,
  options: GrokSessionTailOptions
): Promise<GrokCheckpointStatus> {
  if (options.checkpointMode === 'manual') return { status: 'manual' };
  if (!shouldCommitGrokMarker(marker, checkpoint))
    return { status: 'unchanged' };
  try {
    await commitGrokSessionCheckpoint(sessionDir, checkpoint, options);
    return { status: 'committed' };
  } catch (error: unknown) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
