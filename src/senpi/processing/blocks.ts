import type {
  SenpiAgentMessage,
  SenpiImageContent,
  SenpiSessionEntry,
  SenpiSessionHeader,
  SenpiTextContent,
  SenpiThinkingContent,
  SenpiToolCall,
  SenpiUsage,
} from '../types.js';
import {
  computeProjectionMutation,
  type SenpiEntryProjectionRecord,
  type SenpiProjectionRecord,
  type SenpiProjectionResult,
  type SenpiRetainedProjectionRecord,
  type SenpiTreeEntry,
} from './projection.js';

/** Content blocks carried by a senpi message block, in native wire shape. */
export type SenpiBlockContent =
  | SenpiTextContent
  | SenpiImageContent
  | SenpiThinkingContent
  | SenpiToolCall;

/** Role of a session block: the native agent-message role or `metadata`. */
export type SenpiBlockRole = SenpiAgentMessage['role'] | 'metadata';

/** Provenance of a block: a physical tree entry or a compaction retained tail. */
export type SenpiBlockOrigin = 'entry' | 'retained_tail';

/**
 * Branch status of a block relative to the projected leaf path. Blocks
 * produced by {@link reduceSenpiProjection} are always `active`; off-branch
 * and summarized statuses exist for consumers mapping
 * `SenpiProjectionResult.offPath` themselves.
 */
export type SenpiBlockBranchStatus = 'active' | 'off_branch' | 'summarized';

/** Fields shared by every senpi-native session block. */
export interface SenpiSessionBlockBase {
  /** Stable identity used by upsert and delete changes. */
  readonly id: string;
  readonly type: 'message' | 'metadata';
  readonly role: SenpiBlockRole;
  /** Id of the physical entry this block was derived from. */
  readonly entryId: string;
  readonly parentId: string | null;
  readonly origin: SenpiBlockOrigin;
  readonly branch: SenpiBlockBranchStatus;
  /** Native entry tag this block was derived from (e.g. `message`, `custom`). */
  readonly entryType: string;
  /** Entry-level ISO timestamp; absent for retained-tail materializations. */
  readonly entryTimestamp: string | undefined;
  /** Message-level Unix-ms timestamp; absent on metadata blocks. */
  readonly messageTimestamp: number | undefined;
  /** Token/cost usage when the native payload carries one. */
  readonly usage: SenpiUsage | undefined;
  /** Error flag from toolResult messages or assistant error messages. */
  readonly isError: boolean | undefined;
  /**
   * Native `customType` passthrough for `custom` and `custom_message`
   * metadata blocks; identifies the owning extension without interpretation.
   */
  readonly customType: string | undefined;
}

/** A block derived from one content block of an agent message. */
export interface SenpiMessageBlock extends SenpiSessionBlockBase {
  readonly type: 'message';
  readonly role: SenpiAgentMessage['role'];
  /**
   * Native content blocks of the source message. When one message splits
   * into multiple blocks, each block carries exactly one content element.
   */
  readonly content: readonly SenpiBlockContent[];
}

/**
 * A block derived from a non-message or extension entry. Unknown and custom
 * payloads are preserved verbatim in `payload`; the kit never interprets
 * them (planning-brief risk 2: neutral density handling).
 */
export interface SenpiMetadataBlock extends SenpiSessionBlockBase {
  readonly type: 'metadata';
  readonly role: 'metadata';
  /**
   * Native payload preserved as-is: `custom.data`, the tag-specific fields
   * of known metadata entries, or the whole unknown entry verbatim.
   */
  readonly payload: unknown;
}

/** Senpi-native normalized session block. */
export type SenpiSessionBlock = SenpiMessageBlock | SenpiMetadataBlock;

/** One ordered mutation of the senpi block collection. */
export type SenpiBlockChange =
  | { readonly type: 'upsert'; readonly block: SenpiSessionBlock }
  | { readonly type: 'delete'; readonly id: string };

/**
 * Incremental reduction state mapping stable projection record keys to the
 * block ids they produced, so suffix-splice deletes can remove exactly the
 * blocks their removed records created.
 */
export interface SenpiBlockReductionState {
  readonly blocks: ReadonlyMap<string, SenpiSessionBlock>;
  /** Active projection record keys in order; drives the next LCP splice. */
  readonly recordKeys: readonly string[];
  readonly blockIdsByRecordKey: ReadonlyMap<string, readonly string[]>;
}

/** Result of one incremental reduction step over a projection result. */
export interface SenpiBlockReduction {
  readonly changes: readonly SenpiBlockChange[];
  readonly state: SenpiBlockReductionState;
}

/** Empty starting state for {@link reduceSenpiProjection}. Frozen. */
export const EMPTY_SENPI_BLOCK_REDUCTION_STATE: SenpiBlockReductionState =
  Object.freeze({
    blocks: new Map<string, SenpiSessionBlock>(),
    recordKeys: Object.freeze([]),
    blockIdsByRecordKey: new Map<string, readonly string[]>(),
  });

/** Known non-header entry shapes accepted by the session v3 schema. */
type SenpiKnownNonHeaderEntry = Exclude<SenpiSessionEntry, SenpiSessionHeader>;

const KNOWN_NON_HEADER_TAGS: ReadonlySet<string> = new Set([
  'message',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
]);

function isMessageEntry(
  entry: SenpiTreeEntry
): entry is Extract<SenpiKnownNonHeaderEntry, { type: 'message' }> {
  return entry.type === 'message' && typeof entry.message === 'object';
}

function isKnownNonHeaderEntry(
  entry: SenpiTreeEntry
): entry is SenpiKnownNonHeaderEntry {
  return KNOWN_NON_HEADER_TAGS.has(entry.type);
}

interface BlockKeyFields {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly origin: SenpiBlockOrigin;
  readonly entryTimestamp: string | undefined;
}

/**
 * Normalizes one agent message into its native content-block array.
 *
 * Roles whose persisted body is not block-shaped (bashExecution,
 * branchSummary, compactionSummary, plain-string user/custom bodies) are
 * represented as a single `text` content block; no other rewriting occurs.
 *
 * @param message Native agent message from a message entry or retained tail.
 * @returns The message's content blocks in wire shape.
 */
function messageContent(message: SenpiAgentMessage): SenpiBlockContent[] {
  switch (message.role) {
    case 'user':
    case 'custom':
      return typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : [...message.content];
    case 'assistant':
    case 'toolResult':
      return [...message.content];
    case 'bashExecution':
      return [{ type: 'text', text: message.output }];
    case 'branchSummary':
    case 'compactionSummary':
      return [{ type: 'text', text: message.summary }];
  }
}

function messageUsage(message: SenpiAgentMessage): SenpiUsage | undefined {
  if (message.role === 'assistant') return message.usage;
  if (message.role === 'toolResult') return message.usage ?? undefined;
  return undefined;
}

function messageIsError(message: SenpiAgentMessage): boolean | undefined {
  if (message.role === 'toolResult') return message.isError;
  if (message.role === 'assistant' && message.errorMessage !== undefined) {
    return true;
  }
  return undefined;
}

function messageBlocks(
  message: SenpiAgentMessage,
  key: BlockKeyFields,
  idPrefix: string
): SenpiMessageBlock[] {
  const content = messageContent(message);
  const split = content.length > 1;
  const common = {
    type: 'message' as const,
    role: message.role,
    entryId: key.entryId,
    parentId: key.parentId,
    origin: key.origin,
    branch: 'active' as const,
    entryType: 'message',
    entryTimestamp: key.entryTimestamp,
    messageTimestamp: message.timestamp,
    usage: messageUsage(message),
    isError: messageIsError(message),
    customType: undefined,
  };
  if (!split) {
    return [{ ...common, id: idPrefix, content }];
  }
  return content.map((block, index) => ({
    ...common,
    id: `${idPrefix}:${String(index)}`,
    content: [block],
  }));
}

function metadataPayload(entry: SenpiKnownNonHeaderEntry): unknown {
  switch (entry.type) {
    case 'model_change':
      return { provider: entry.provider, modelId: entry.modelId };
    case 'thinking_level_change':
      return { thinkingLevel: entry.thinkingLevel };
    case 'compaction':
      return { summary: entry.summary, tokensBefore: entry.tokensBefore };
    case 'branch_summary':
      return { fromId: entry.fromId, summary: entry.summary };
    case 'custom':
      return entry.data;
    case 'custom_message':
      return {
        content: entry.content,
        display: entry.display,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      };
    case 'label':
      return { targetId: entry.targetId, label: entry.label };
    case 'session_info':
      return { name: entry.name };
    case 'message':
      return undefined;
  }
}

function metadataUsage(
  entry: SenpiKnownNonHeaderEntry
): SenpiUsage | undefined {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return entry.usage ?? undefined;
  }
  return undefined;
}

function metadataCustomType(
  entry: SenpiKnownNonHeaderEntry
): string | undefined {
  if (entry.type === 'custom' || entry.type === 'custom_message') {
    return entry.customType;
  }
  return undefined;
}

function entryMetadataBlock(
  entry: SenpiTreeEntry,
  key: BlockKeyFields
): SenpiMetadataBlock {
  const shared = {
    type: 'metadata' as const,
    role: 'metadata' as const,
    entryId: key.entryId,
    parentId: key.parentId,
    origin: key.origin,
    branch: 'active' as const,
    entryTimestamp: key.entryTimestamp,
    messageTimestamp: undefined,
    isError: undefined,
  };
  if (!isKnownNonHeaderEntry(entry)) {
    // Unknown tags stay neutral metadata: the whole entry (extras included)
    // is preserved verbatim and never interpreted.
    return {
      ...shared,
      id: entry.id,
      entryType: entry.type,
      usage: undefined,
      customType: undefined,
      payload: entry,
    };
  }
  return {
    ...shared,
    id: entry.id,
    entryType: entry.type,
    usage: entry.type === 'message' ? undefined : metadataUsage(entry),
    customType: metadataCustomType(entry),
    payload: entry.type === 'message' ? undefined : metadataPayload(entry),
  };
}

function entryBlocks(record: SenpiEntryProjectionRecord): SenpiSessionBlock[] {
  const key: BlockKeyFields = {
    entryId: record.entryId,
    parentId: record.parentId,
    origin: 'entry',
    entryTimestamp: record.entry.timestamp,
  };
  if (isMessageEntry(record.entry)) {
    return messageBlocks(record.entry.message, key, record.entryId);
  }
  return [entryMetadataBlock(record.entry, key)];
}

function retainedBlocks(
  record: SenpiRetainedProjectionRecord
): SenpiSessionBlock[] {
  const key: BlockKeyFields = {
    entryId: record.entryId,
    parentId: record.parentId,
    origin: 'retained_tail',
    entryTimestamp: undefined,
  };
  return messageBlocks(
    record.message,
    key,
    `${record.entryId}:retained:${String(record.retainedIndex)}`
  );
}

function recordBlocks(record: SenpiProjectionRecord): SenpiSessionBlock[] {
  return record.origin === 'retained_tail'
    ? retainedBlocks(record)
    : entryBlocks(record);
}

interface MutableReductionState {
  readonly blocks: Map<string, SenpiSessionBlock>;
  readonly changes: SenpiBlockChange[];
  readonly upsertIndexes: Map<string, number>;
  readonly blockIdsByRecordKey: Map<string, readonly string[]>;
}

function applyUpsert(
  state: MutableReductionState,
  block: SenpiSessionBlock
): void {
  state.blocks.set(block.id, block);
  const change: SenpiBlockChange = { type: 'upsert', block };
  const existingIndex = state.upsertIndexes.get(block.id);
  if (existingIndex === undefined) {
    state.upsertIndexes.set(block.id, state.changes.length);
    state.changes.push(change);
  } else {
    state.changes[existingIndex] = change;
  }
}

/**
 * Reduces one projection result against the previous reduction state into
 * upsert/delete changes driven by the sole suffix splice between the two
 * active key sequences ({@link computeProjectionMutation} shape).
 *
 * Semantics:
 * - Deletes are emitted before upserts so a record key that moves position
 *   within one splice is deleted and then re-created, never deleted after
 *   its re-creation.
 * - Each removed record key deletes exactly the block ids its own earlier
 *   upsert created (`removedRecordKeys` resolved through
 *   `blockIdsByRecordKey`), so spliced-out records leave no orphan blocks.
 * - Repeated upserts of one id within one step coalesce in place, keeping
 *   the emitted change log free of redundant re-emissions.
 * - An `empty` or structurally `invalid` projection clears every block: the
 *   projection is the sole authority and stale linear history must not
 *   survive a corrupt tree.
 *
 * @param previous State returned by an earlier call, or
 *   {@link EMPTY_SENPI_BLOCK_REDUCTION_STATE}.
 * @param current Projection result for the same session.
 * @returns Ordered changes plus the successor state.
 */
export function reduceSenpiProjection(
  previous: SenpiBlockReductionState,
  current: SenpiProjectionResult
): SenpiBlockReduction {
  const mutation = computeProjectionMutation(
    previous.recordKeys,
    current.records
  );
  const state: MutableReductionState = {
    blocks: new Map(previous.blocks),
    changes: [],
    upsertIndexes: new Map<string, number>(),
    blockIdsByRecordKey: new Map(previous.blockIdsByRecordKey),
  };

  if (mutation !== null) {
    for (const removedKey of mutation.removedRecordKeys) {
      const ids = state.blockIdsByRecordKey.get(removedKey) ?? [];
      for (const id of ids) {
        if (!state.blocks.has(id)) continue;
        state.blocks.delete(id);
        state.changes.push({ type: 'delete', id });
      }
      state.blockIdsByRecordKey.delete(removedKey);
    }
    for (const record of mutation.records) {
      const blocks = recordBlocks(record);
      for (const block of blocks) applyUpsert(state, block);
      state.blockIdsByRecordKey.set(
        record.key,
        blocks.map(block => block.id)
      );
    }
  }

  return {
    changes: state.changes,
    state: {
      blocks: state.blocks,
      recordKeys: current.records.map(record => record.key),
      blockIdsByRecordKey: state.blockIdsByRecordKey,
    },
  };
}

/**
 * Folds an ordered upsert/delete change stream into its final block list.
 *
 * Idempotence contract: applying the same change stream twice yields the
 * same result as applying it once - `fold(x)` equals `fold([...x, ...x])`,
 * and folding the upserts reconstructed from an already-folded block list
 * reproduces that list unchanged. Deletes of absent ids are no-ops; output
 * order follows first insertion, with re-inserted ids moving to the end.
 *
 * O(n) in the number of changes: each change applies once via Map
 * set/delete, with no per-entry retained allocations beyond the block
 * itself (planning-brief risk 2: dense extension traffic stays linear).
 *
 * @param changes Ordered upsert and delete mutations.
 * @returns Final blocks after every mutation has been applied.
 */
export function foldSenpiBlockChanges(
  changes: readonly SenpiBlockChange[]
): SenpiSessionBlock[] {
  const blocks = new Map<string, SenpiSessionBlock>();
  for (const change of changes) {
    if (change.type === 'upsert') blocks.set(change.block.id, change.block);
    else blocks.delete(change.id);
  }
  return [...blocks.values()];
}
