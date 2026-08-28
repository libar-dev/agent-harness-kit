import { resolve } from 'node:path';
import type {
  InternalSenpiSessionMarkerParseResult,
  InternalSenpiSessionMarkerReadResult,
} from './checkpoint-internal-types.js';

import { readUtf8FileBounded } from '../../internal/bounded-file-read.js';
import { parseJsonlOversizedPending } from '../../internal/jsonl-cursor.js';
import {
  SENPI_MARKER_MAX_BYTES,
  consistentProjectedRecordCount,
  graphLeafMember,
  isSafeNonnegativeInteger,
  parseAcceptedEntries,
  parseProjectedRecordCount,
  parseProjectedRecordKeys,
} from './accepted-graph.js';
import { publicMarker } from './checkpoint-carrier.js';
import {
  createSenpiSessionPathDigest,
  getSenpiSessionMarkerPath,
} from './checkpoint-path.js';
import {
  SENPI_MARKER_VERSION,
  type SenpiCheckpointInvalidation,
  type SenpiCheckpointObservedState,
  type SenpiSessionCheckpointCommitOptions,
  type SenpiSessionMarkerParseResult,
  type SenpiSessionMarkerReadResult,
} from './checkpoint-types.js';

/**
 * Parse an unknown value as a Senpi session marker.
 *
 * @param value - Decoded JSON or any other candidate.
 * @returns A valid marker or an invalid result; never throws.
 */
export function parseSenpiSessionMarkerInternal(
  value: unknown
): InternalSenpiSessionMarkerParseResult {
  if (!isRecord(value)) {
    return { kind: 'invalid', error: 'marker is not an object' };
  }
  if (value['markerVersion'] !== SENPI_MARKER_VERSION) {
    return { kind: 'invalid', error: 'unsupported markerVersion' };
  }
  const projected = parseProjectedRecordKeys(value['projectedRecordKeys']);
  const pending = parseJsonlOversizedPending(value['pending']);
  if (
    !validCoreFields(value) ||
    projected === undefined ||
    pending === undefined
  ) {
    return { kind: 'invalid', error: 'marker fields are malformed' };
  }
  const graph = parseAcceptedEntries(value['acceptedEntries']);
  const trustedGraph =
    graph.kind === 'present' && graphLeafMember(graph, value['leafId'])
      ? graph
      : { kind: 'absent' as const };
  const rawCount = parseProjectedRecordCount(value['projectedRecordCount']);
  const projectedRecordCount =
    rawCount === undefined && !projected.overflow
      ? undefined
      : consistentProjectedRecordCount(
          projected.keys,
          projected.overflow,
          rawCount
        );
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
      projectedRecordKeys: projected.keys,
      markerVersion: SENPI_MARKER_VERSION,
      pending,
      ...(projectedRecordCount === undefined ? {} : { projectedRecordCount }),
      ...(trustedGraph.kind === 'present'
        ? { acceptedEntries: trustedGraph.entries }
        : {}),
    },
  };
}

/** Parse a marker while erasing private continuation fields from its type. */
export function parseSenpiSessionMarker(
  value: unknown
): SenpiSessionMarkerParseResult {
  const parsed = parseSenpiSessionMarkerInternal(value);
  return parsed.kind === 'invalid'
    ? parsed
    : { kind: 'valid', marker: publicMarker(parsed.marker) };
}

/**
 * Decide whether a persisted marker must be discarded.
 *
 * @param marker - Persisted marker or malformed stand-in.
 * @param observed - Current identity, size, digests, and boundary status.
 * @returns Whether the marker is unusable and the first matching reason.
 */
export function evaluateSenpiCheckpointInvalidation(
  marker: unknown,
  observed: SenpiCheckpointObservedState
): SenpiCheckpointInvalidation {
  const parsed = parseSenpiSessionMarkerInternal(marker);
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
  if (!observed.offsetAtLineBoundary && current.pending === null) {
    return { invalidate: true, reason: 'offset_not_at_line_boundary' };
  }
  return { invalidate: false, reason: null };
}

/**
 * Read one marker with a strict 1 MiB bound.
 *
 * @param sessionPath - Session path whose marker should be loaded.
 * @param options - Marker destination controls.
 * @returns Missing, valid, or invalid marker state.
 */
export async function readSenpiSessionMarkerInternal(
  sessionPath: string,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<InternalSenpiSessionMarkerReadResult> {
  const resolved = resolve(sessionPath);
  const raw = await readUtf8FileBounded(
    getSenpiSessionMarkerPath(resolved, options),
    SENPI_MARKER_MAX_BYTES
  );
  if (raw.kind === 'missing') return { kind: 'missing' };
  if (raw.kind === 'oversize') {
    return { kind: 'invalid', error: 'marker file exceeds 1MiB read bound' };
  }
  if (raw.kind === 'unreadable') {
    return { kind: 'invalid', error: 'marker file is unreadable' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.text) as unknown;
  } catch {
    return { kind: 'invalid', error: 'marker JSON is malformed' };
  }
  const parsed = parseSenpiSessionMarkerInternal(decoded);
  if (parsed.kind === 'invalid') return parsed;
  if (
    parsed.marker.sessionPathDigest !== createSenpiSessionPathDigest(resolved)
  ) {
    return { kind: 'invalid', error: 'sessionPathDigest does not match path' };
  }
  return parsed;
}

/** Read a marker while erasing private continuation fields from its type. */
export async function readSenpiSessionMarker(
  sessionPath: string,
  options: SenpiSessionCheckpointCommitOptions = {}
): Promise<SenpiSessionMarkerReadResult> {
  const read = await readSenpiSessionMarkerInternal(sessionPath, options);
  return read.kind === 'valid'
    ? { kind: 'valid', marker: publicMarker(read.marker) }
    : read;
}

function validCoreFields(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  sessionPathDigest: string;
  sessionId: string;
  device: string;
  inode: string;
  generation: number;
  offset: number;
  lineNumber: number;
  headDigest: string;
  boundaryDigest: string;
  revision: number;
  leafId: string | null;
} {
  return (
    typeof value['sessionPathDigest'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['device'] === 'string' &&
    typeof value['inode'] === 'string' &&
    isSafeNonnegativeInteger(value['generation']) &&
    isSafeNonnegativeInteger(value['offset']) &&
    isSafeNonnegativeInteger(value['lineNumber']) &&
    value['lineNumber'] >= 1 &&
    typeof value['headDigest'] === 'string' &&
    typeof value['boundaryDigest'] === 'string' &&
    isSafeNonnegativeInteger(value['revision']) &&
    (value['leafId'] === null || typeof value['leafId'] === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
