import { resolve } from 'node:path';

import { byteCursorChanged } from '../../internal/incremental.js';
import { readJsonlDelta } from '../../internal/jsonl-cursor.js';
import { seedAcceptedGraph } from './accepted-graph.js';
import { restoreInternalCheckpoint } from './checkpoint-carrier.js';
import { createSenpiSessionPathDigest } from './checkpoint-path.js';
import { readSenpiSessionMarkerInternal } from './checkpoint-read.js';
import { checkpointCursor, parseLines } from './tail-parse.js';
import { projectAndCommit } from './tail-project.js';
import { unchangedResult } from './tail-result.js';
import { canUseGraphAppend, cursorOptions } from './tail-resume.js';
import {
  assertCheckpointPath,
  tailCheckpointOptions as checkpointOptions,
  initialTailBaseline,
  markerOnlyRebuildDecision,
  normalizeFromStartDelta,
  projectRequest,
  rebuildTail as rebuild,
  resolveTailLimits as resolveLimits,
  resumeCarriedRebuild,
  type SenpiInternalSessionTailOptions,
} from './tail-run-support.js';
import type { SenpiSessionTailResult } from './tail-types.js';

/**
 * Tail a Senpi session into its persisted root-to-leaf projection.
 *
 * Pure append may continue from a complete bounded graph. Other marker-only
 * paths rebuild exactly from byte zero for at most four bounded scans, then
 * return a no-write continuation checkpoint.
 *
 * @param file - Senpi session JSONL file.
 * @param options - Cursor, marker, projection, and scan-budget controls.
 * @returns Projection records, one optional splice, and continuation state.
 */
export async function tailSenpiSessionInternal(
  file: string,
  options: SenpiInternalSessionTailOptions = {}
): Promise<SenpiSessionTailResult> {
  const sessionPath = resolve(file);
  const markerOptions = checkpointOptions(options);
  const markerRead = await readSenpiSessionMarkerInternal(
    sessionPath,
    markerOptions
  );
  const marker = markerRead.kind === 'valid' ? markerRead.marker : null;
  const provided =
    options.checkpoint === undefined
      ? undefined
      : restoreInternalCheckpoint(options.checkpoint);
  const supplied = options.fromStart === true ? undefined : provided;
  const sessionPathDigest = createSenpiSessionPathDigest(sessionPath);
  assertCheckpointPath(supplied, sessionPathDigest);
  const limits = resolveLimits(options);
  const rebuildProgress = supplied?.state?.rebuild;
  const priorCursor =
    options.fromStart === true
      ? null
      : rebuildProgress !== undefined
        ? rebuildProgress.cursor
        : checkpointCursor(supplied ?? marker);
  const baseline = initialTailBaseline(
    options.fromStart === true,
    supplied,
    marker,
    markerRead.kind === 'invalid' && supplied === undefined
      ? markerRead.error
      : null
  );
  let invalidationMessage = baseline.message;
  const resetBaseline = baseline.reset;
  const includeOffPath = options.includeOffPath === true;
  const priorState = supplied?.state;

  const resumedRebuild = resumeCarriedRebuild({
    sessionPath,
    options,
    markerOptions,
    digest: sessionPathDigest,
    marker,
    supplied,
    cursor: priorCursor,
    limits,
    includeOffPath,
    message: invalidationMessage,
    resetBaseline,
  });
  if (resumedRebuild !== null) return resumedRebuild;
  const markerDecision = await markerOnlyRebuildDecision(
    sessionPath,
    resetBaseline,
    priorState !== undefined,
    marker,
    priorCursor
  );
  if (markerDecision === 'rebuild') {
    return rebuild(
      sessionPath,
      options,
      markerOptions,
      sessionPathDigest,
      marker,
      supplied,
      limits,
      includeOffPath,
      invalidationMessage
    );
  }
  if (markerDecision === 'stale') {
    invalidationMessage = 'source identity or committed content changed';
  }

  let delta = normalizeFromStartDelta(
    await readJsonlDelta(sessionPath, priorCursor, cursorOptions(limits)),
    options.fromStart === true,
    provided
  );
  if (delta.fileSize === null || delta.cursor === null) {
    throw new Error(`Missing required Senpi session source '${sessionPath}'`);
  }
  if (delta.reset && invalidationMessage === null) {
    invalidationMessage = 'source identity or committed content changed';
  }
  const reset = resetBaseline || delta.reset;
  if (
    !reset &&
    !byteCursorChanged(priorCursor, delta.cursor) &&
    delta.lines.length === 0 &&
    delta.diagnostics.length === 0 &&
    priorState?.includeOffPath === includeOffPath &&
    rebuildProgress === undefined
  ) {
    if (supplied === undefined) {
      throw new Error('Incremental Senpi state requires a supplied checkpoint');
    }
    return unchangedResult(
      supplied,
      priorState,
      delta.cursor,
      delta.fileSize,
      supplied.revision ?? marker?.revision ?? 0
    );
  }

  const parsedDelta = parseLines(
    delta.lines,
    delta.diagnostics,
    reset ? null : (supplied?.sessionId ?? marker?.sessionId ?? null)
  );
  const graph = marker?.acceptedEntries;
  const graphAppend =
    !reset &&
    priorState === undefined &&
    graph !== undefined &&
    canUseGraphAppend({
      graph,
      leafId: marker?.leafId ?? null,
      delta: parsedDelta.inputs,
      fileSize: delta.fileSize,
      maxScanBytes: limits.maxScanBytes,
    });
  if (!reset && priorState === undefined && !graphAppend) {
    if (delta.fileSize <= limits.maxScanBytes) {
      const full = await readJsonlDelta(
        sessionPath,
        null,
        cursorOptions(limits)
      );
      if (full.fileSize === null || full.cursor === null) {
        throw new Error(
          `Missing required Senpi session source '${sessionPath}'`
        );
      }
      if (
        full.scanStatus.status === 'complete' &&
        full.cursor.offset >= delta.cursor.offset
      ) {
        delta = {
          ...full,
          cursor: {
            ...full.cursor,
            generation: priorCursor?.generation ?? full.cursor.generation,
          },
        };
        return projectAndCommit(
          projectRequest(
            sessionPath,
            options,
            markerOptions,
            sessionPathDigest,
            marker,
            supplied,
            delta,
            parseLines(
              full.lines,
              full.diagnostics,
              supplied?.sessionId ?? marker?.sessionId ?? null
            ),
            includeOffPath,
            reset,
            invalidationMessage,
            priorCursor,
            [],
            marker?.projectedRecordKeys ?? supplied?.projectedRecordKeys ?? [],
            marker?.projectedRecordCount,
            limits
          )
        );
      }
    }
    return rebuild(
      sessionPath,
      options,
      markerOptions,
      sessionPathDigest,
      marker,
      supplied,
      limits,
      includeOffPath,
      invalidationMessage
    );
  }

  const seeds =
    graphAppend && graph !== undefined ? seedAcceptedGraph(graph) : [];
  const seedless = priorState === undefined && seeds.length === 0;
  const parsed = {
    ...parsedDelta,
    inputs:
      reset || seedless
        ? parsedDelta.inputs
        : [...(priorState?.inputs ?? seeds), ...parsedDelta.inputs],
    diagnostics:
      reset || seedless
        ? [...parsedDelta.diagnostics]
        : [...(priorState?.parseDiagnostics ?? []), ...parsedDelta.diagnostics],
    sessionId:
      parsedDelta.sessionId ?? supplied?.sessionId ?? marker?.sessionId ?? null,
  };
  return projectAndCommit(
    projectRequest(
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
      seeds,
      reset
        ? []
        : (priorState?.records.map(record => record.key) ??
            marker?.projectedRecordKeys ??
            supplied?.projectedRecordKeys ??
            []),
      reset ? undefined : marker?.projectedRecordCount,
      limits
    )
  );
}
