/** Stale-revision error values consumed by explicit checkpoint writers. */
export {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  isStaleCheckpointConflict,
} from '../../processing/stale-checkpoint-conflict.js';
/** Stable marker identity and destination helpers. */
export {
  createSenpiSessionPathDigest,
  getSenpiSessionMarkerPath,
} from './checkpoint-path.js';
/** Public marker parsing, reading, and invalidation operations. */
export {
  evaluateSenpiCheckpointInvalidation,
  parseSenpiSessionMarker,
  readSenpiSessionMarker,
} from './checkpoint-read.js';
/** Public marker and checkpoint contracts without private continuation fields. */
export {
  SENPI_MARKER_VERSION,
  type SenpiCheckpointInvalidation,
  type SenpiCheckpointInvalidationReason,
  type SenpiCheckpointObservedState,
  type SenpiSessionCheckpoint,
  type SenpiSessionCheckpointCommitOptions,
  type SenpiSessionCheckpointState,
  type SenpiSessionMarker,
  type SenpiSessionMarkerParseResult,
  type SenpiSessionMarkerReadResult,
} from './checkpoint-types.js';
/** Commit only declaration-shaped public checkpoints. */
export { commitSenpiSessionCheckpoint } from './checkpoint-write.js';
