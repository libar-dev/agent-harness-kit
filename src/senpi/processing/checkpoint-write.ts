import { resolve } from 'node:path';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';

import { checkpointRevision } from '../../internal/incremental.js';
import { parseJsonlOversizedPending } from '../../internal/jsonl-cursor.js';
import { withMarkerLock } from '../../internal/marker-lock.js';
import { writePrivateJson } from '../../internal/marker-store.js';
import { StaleCheckpointConflict } from '../../processing/stale-checkpoint-conflict.js';
import {
  SENPI_GRAPH_MAX_BYTES,
  SENPI_GRAPH_MAX_ENTRIES,
  SENPI_KEYS_MAX_BYTES,
  SENPI_KEYS_MAX_ENTRIES,
  SENPI_MARKER_MAX_BYTES,
  consistentProjectedRecordCount,
  encodeAcceptedEntries,
  isSafeNonnegativeInteger,
  parseAcceptedEntries,
  parseProjectedRecordCount,
  parseProjectedRecordKeys,
  utf8JsonSize,
  utf8PrettySize,
} from './accepted-graph.js';
import { restoreInternalCheckpoint } from './checkpoint-carrier.js';
import {
  createSenpiSessionPathDigest,
  getSenpiSessionMarkerPath,
} from './checkpoint-path.js';
import { readSenpiSessionMarkerInternal } from './checkpoint-read.js';
import {
  SENPI_MARKER_VERSION,
  type SenpiSessionCheckpoint,
  type SenpiSessionCheckpointCommitOptions,
} from './checkpoint-types.js';

/**
 * Persist a checkpoint by atomically replacing the Senpi marker file.
 *
 * @param sessionPath - Session path that produced the checkpoint.
 * @param checkpoint - Cursor, projection state, and expected revision.
 * @param options - Marker destination and root allow-list.
 * @returns After atomic replacement completes.
 * @throws On stale revision, malformed fields, over-cap state, or write failure.
 */
export async function commitSenpiSessionCheckpointInternal(
  sessionPath: string,
  checkpoint: InternalSenpiSessionCheckpoint,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<void> {
  const resolved = resolve(sessionPath);
  const digest = createSenpiSessionPathDigest(resolved);
  if (checkpoint.sessionPathDigest !== digest) {
    throw new Error('Senpi session checkpoint does not match the session path');
  }
  validateCheckpointFields(checkpoint);
  rejectOverCapState(checkpoint);
  const markerPath = getSenpiSessionMarkerPath(resolved, options);
  await withMarkerLock(
    markerPath,
    async () => {
      const existing = await readSenpiSessionMarkerInternal(resolved, options);
      const revision = existing.kind === 'valid' ? existing.marker.revision : 0;
      if (checkpoint.baseRevision !== revision) {
        throw new StaleCheckpointConflict({
          expectedRevision: checkpoint.baseRevision,
          actualRevision: revision,
        });
      }
      const marker = assembleMarker(digest, checkpoint, revision);
      if (utf8PrettySize(marker) > SENPI_MARKER_MAX_BYTES) {
        throw new Error('Senpi session marker exceeds the 1MiB write bound');
      }
      await writePrivateJson(
        markerPath,
        marker,
        options.markerDir === undefined
          ? undefined
          : {
              allowedMarkerRoots: options.allowedMarkerRoots,
              rootsEnvVar: 'SENPI_TAIL_MARKER_ROOTS',
              emptyRootsMessage:
                'Custom markerDir requires allowedMarkerRoots (or SENPI_TAIL_MARKER_ROOTS) to include an allowed root',
            }
      );
    },
    { lockedLabel: 'Senpi session marker' }
  );
}

/** Commit only the original public checkpoint fields. */
export async function commitSenpiSessionCheckpoint(
  sessionPath: string,
  checkpoint: SenpiSessionCheckpoint,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<void> {
  await commitSenpiSessionCheckpointInternal(
    sessionPath,
    restoreInternalCheckpoint(checkpoint),
    options
  );
}

function validateCheckpointFields(
  checkpoint: InternalSenpiSessionCheckpoint
): void {
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
    (checkpoint.leafId !== null && typeof checkpoint.leafId !== 'string') ||
    parseProjectedRecordKeys(checkpoint.projectedRecordKeys) === undefined ||
    parseJsonlOversizedPending(checkpoint.pending) === undefined
  ) {
    throw new Error('Senpi session checkpoint is malformed');
  }
}

function rejectOverCapState(checkpoint: InternalSenpiSessionCheckpoint): void {
  if (
    checkpoint.acceptedEntries !== undefined &&
    (checkpoint.acceptedEntries.length > SENPI_GRAPH_MAX_ENTRIES ||
      utf8JsonSize(checkpoint.acceptedEntries) > SENPI_GRAPH_MAX_BYTES ||
      parseAcceptedEntries(checkpoint.acceptedEntries).kind === 'absent')
  ) {
    throw new Error(
      'Senpi session checkpoint acceptedEntries are invalid or exceed limits'
    );
  }
  if (
    checkpoint.projectedRecordKeys.length > SENPI_KEYS_MAX_ENTRIES ||
    utf8JsonSize(checkpoint.projectedRecordKeys) > SENPI_KEYS_MAX_BYTES
  ) {
    throw new Error(
      'Senpi session checkpoint projectedRecordKeys exceed limits'
    );
  }
}

function assembleMarker(
  sessionPathDigest: string,
  checkpoint: InternalSenpiSessionCheckpoint,
  revision: number
): InternalSenpiSessionMarker {
  const graph =
    checkpoint.acceptedEntries === undefined
      ? null
      : encodeAcceptedEntries(checkpoint.acceptedEntries);
  const keys = parseProjectedRecordKeys(checkpoint.projectedRecordKeys);
  const overflow = keys?.overflow === true;
  const count = consistentProjectedRecordCount(
    keys?.keys ?? [],
    overflow,
    parseProjectedRecordCount(checkpoint.projectedRecordCount)
  );
  return {
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
    projectedRecordKeys: overflow ? [] : [...checkpoint.projectedRecordKeys],
    markerVersion: SENPI_MARKER_VERSION,
    pending: parseJsonlOversizedPending(checkpoint.pending) ?? null,
    ...(count === undefined ||
    (checkpoint.projectedRecordKeys.length > 0 &&
      count === checkpoint.projectedRecordKeys.length)
      ? {}
      : { projectedRecordCount: count }),
    ...(graph === null ? {} : { acceptedEntries: graph }),
  };
}
