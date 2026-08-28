/** Stale-revision error values shared by explicit checkpoint consumers. */
export {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  isStaleCheckpointConflict,
} from '../../processing/stale-checkpoint-conflict.js';
/** Commit a revision-bound checkpoint after consumer durability. */
export { commitGrokSessionCheckpoint } from './tail-marker.js';
/** Read and reduce one bounded two-source Grok tail pass. */
export { tailGrokSession } from './tail-run.js';
/** Public checkpoint, record, diagnostic, source, and option contracts. */
export {
  type GrokCheckpointStatus,
  type GrokSessionCheckpoint,
  type GrokSessionCheckpointCommitOptions,
  type GrokSessionCheckpointState,
  type GrokSessionSourceCheckpoint,
  type GrokSessionTailOptions,
  type GrokSessionTailResult,
  type GrokSessionWatchOptions,
  type GrokWatchClock,
  type GrokSourceReset,
  type GrokSourceTailResult,
  type GrokTailDiagnostic,
  type GrokTailRecord,
  type GrokTailSourceKind,
} from './tail-types.js';
/** Watch Grok sources while retaining the latest bounded checkpoint. */
export { watchGrokSession } from './tail-watch.js';
