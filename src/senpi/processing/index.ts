/**
 * Public processing APIs for persisted Senpi sessions.
 *
 * Observe-only surface: session types, parse, discovery/listing, tree
 * projection, tail, watch, checkpoint commit, and native block reduce/fold.
 * This is the stable `/senpi/processing` subpath. JSONL cursor internals
 * and checkpoint marker schema, filenames, and invalidation predicates
 * stay unexported. Do not import this surface from the kit root barrel.
 */

export type {
  SenpiAgentMessage,
  SenpiAssistantMessage,
  SenpiBashExecutionMessage,
  SenpiBranchSummaryEntry,
  SenpiBranchSummaryMessage,
  SenpiCompactionEntry,
  SenpiCompactionSummaryMessage,
  SenpiCustomEntry,
  SenpiCustomMessage,
  SenpiCustomMessageEntry,
  SenpiEntryTag,
  SenpiImageContent,
  SenpiLabelEntry,
  SenpiMessageEntry,
  SenpiModelChangeEntry,
  SenpiSessionEntry,
  SenpiSessionHeader,
  SenpiSessionInfoEntry,
  SenpiTextContent,
  SenpiThinkingContent,
  SenpiThinkingLevelChangeEntry,
  SenpiToolCall,
  SenpiToolResultMessage,
  SenpiUsage,
  SenpiUserMessage,
} from '../types.js';

export { parseSenpiEntry } from './parse.js';
export type { SenpiEntryParseResult, SenpiUnknownEntry } from './parse.js';

export {
  encodeSenpiCwdDirname,
  findSenpiSessionDirs,
  getSenpiSessionsRoot,
} from './discovery.js';

export { listAllSenpiSessions, listSenpiSessions } from './listing.js';
export type {
  InvalidSenpiSession,
  SenpiListingOptions,
  SenpiSessionInfo,
  SenpiSessionListing,
  ValidSenpiSession,
} from './listing.js';

export {
  computeProjectionMutation,
  projectSenpiBranch,
  resolveSenpiLeaf,
} from './projection.js';
export type {
  SenpiEntryProjectionRecord,
  SenpiLeafResolution,
  SenpiOffPathDisposition,
  SenpiOffPathRecord,
  SenpiProjectionInput,
  SenpiProjectionMutation,
  SenpiProjectionOptions,
  SenpiProjectionRecord,
  SenpiProjectionResult,
  SenpiProjectionWarning,
  SenpiProjectionWarningCode,
  SenpiRetainedProjectionRecord,
  SenpiTreeEntry,
  SenpiTreeIndex,
} from './projection.js';

export { tailSenpiSession } from './tail.js';
export type {
  SenpiSessionSpliceMutation,
  SenpiSessionTailOptions,
  SenpiSessionTailResult,
  SenpiTailDiagnostic,
  SenpiTailDiagnosticCode,
  SenpiTailLeaf,
} from './tail.js';

export { watchSenpiSession } from './watch.js';
export type {
  SenpiSessionWatchEvent,
  SenpiSessionWatchOptions,
  SenpiWatchClock,
  SenpiWatchCycle,
} from './watch.js';

export { commitSenpiSessionCheckpoint } from './checkpoint.js';
export type {
  SenpiSessionCheckpoint,
  SenpiSessionCheckpointCommitOptions,
  SenpiSessionCheckpointState,
} from './checkpoint.js';

export { foldSenpiBlockChanges, reduceSenpiProjection } from './blocks.js';
export type {
  SenpiBlockBranchStatus,
  SenpiBlockChange,
  SenpiBlockContent,
  SenpiBlockOrigin,
  SenpiBlockReduction,
  SenpiBlockReductionState,
  SenpiBlockRole,
  SenpiMessageBlock,
  SenpiMetadataBlock,
  SenpiSessionBlock,
  SenpiSessionBlockBase,
} from './blocks.js';
