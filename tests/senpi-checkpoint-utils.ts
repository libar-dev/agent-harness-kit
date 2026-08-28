import {
  createSenpiSessionPathDigest,
  type SenpiSessionCheckpoint,
} from '../src/senpi/processing/checkpoint.js';
import {
  SENPI_MARKER_VERSION,
  type InternalSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { internalCheckpoint } from './senpi-internal-state-utils.js';

/** Build the canonical checkpoint fixture for marker tests. */
export function sampleCheckpoint(sessionPath: string): SenpiSessionCheckpoint {
  return {
    sessionPathDigest: createSenpiSessionPathDigest(sessionPath),
    sessionId: 'sess-1',
    device: '16777220',
    inode: '123456',
    generation: 0,
    offset: 20,
    lineNumber: 2,
    headDigest: 'a'.repeat(64),
    boundaryDigest: 'b'.repeat(64),
    baseRevision: 0,
    leafId: 'leaf-1',
    projectedRecordKeys: ['rec:1', 'rec:2'],
  };
}

/** Convert a fixture checkpoint to its expected persisted marker. */
export function expectedMarker(
  checkpoint: SenpiSessionCheckpoint,
  revision: number
): InternalSenpiSessionMarker {
  return {
    sessionPathDigest: checkpoint.sessionPathDigest,
    sessionId: checkpoint.sessionId,
    device: checkpoint.device,
    inode: checkpoint.inode,
    generation: checkpoint.generation,
    offset: checkpoint.offset,
    lineNumber: checkpoint.lineNumber,
    headDigest: checkpoint.headDigest,
    boundaryDigest: checkpoint.boundaryDigest,
    revision,
    leafId: checkpoint.leafId,
    projectedRecordKeys: checkpoint.projectedRecordKeys,
    markerVersion: SENPI_MARKER_VERSION,
    pending: internalCheckpoint(checkpoint).pending ?? null,
  };
}
