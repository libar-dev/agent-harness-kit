/** Public processing APIs for persisted Grok sessions. */

export { byteCursorsEqual } from '../../internal/incremental.js';

export {
  encodeGrokCwdDirname,
  findGrokSessionDirs,
  getGrokHome,
  grokSummarySchema,
  listGrokSessions,
} from './discovery.js';
export type {
  GrokSession,
  GrokSummary,
  InvalidGrokSession,
  ValidGrokSession,
} from './discovery.js';

export { grokUpdateEnvelopeSchema, parseGrokSessionUpdate } from './updates.js';
export type {
  GrokSessionUpdateParseResult,
  GrokUpdateEnvelope,
} from './updates.js';

export { grokEventSchema, parseGrokEvent } from './events.js';
export type { GrokEvent, GrokEventParseResult } from './events.js';

export {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  commitGrokSessionCheckpoint,
  isStaleCheckpointConflict,
  tailGrokSession,
  watchGrokSession,
} from './tail.js';
export type {
  GrokCheckpointStatus,
  GrokSessionCheckpoint,
  GrokSessionCheckpointCommitOptions,
  GrokSessionCheckpointState,
  GrokSessionSourceCheckpoint,
  GrokSessionTailOptions,
  GrokSessionTailResult,
  GrokSessionWatchOptions,
  GrokWatchClock,
  GrokSourceReset,
  GrokSourceTailResult,
  GrokTailDiagnostic,
  GrokTailRecord,
  GrokTailSourceKind,
} from './tail.js';

export { foldGrokBlockChanges, reduceGrokRecords } from './blocks.js';
export type {
  GrokActivity,
  GrokAgentBoundaryBlock,
  GrokAssistantTextBlock,
  GrokBlockChange,
  GrokNormalizedEventRecord,
  GrokNormalizedRecord,
  GrokNormalizedUnknownRecord,
  GrokNormalizedUpdateRecord,
  GrokRecordOrigin,
  GrokReductionResult,
  GrokSessionBlock,
  GrokSessionBlockBase,
  GrokSessionBlockType,
  GrokThinkingBlock,
  GrokToolResultBlock,
  GrokToolUseBlock,
  GrokUserTextBlock,
} from './blocks.js';

export type {
  JsonlCursor,
  JsonlScanStatus,
} from '../../internal/jsonl-cursor.js';
