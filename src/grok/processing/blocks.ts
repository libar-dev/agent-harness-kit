import type { GrokEvent } from './events.js';
import type { GrokUpdateEnvelope } from './updates.js';

/** Provenance of a normalized record read from Grok session storage. */
export interface GrokRecordOrigin {
  readonly harness: 'grok';
  readonly stream: 'conversation' | 'activity';
  readonly sourceId: string;
  readonly nativeType: string;
  readonly generation: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

/** Discriminator of a Grok-owned normalized session block. */
export type GrokSessionBlockType =
  | 'user_text'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'agent_boundary';

/** Fields shared by every Grok-owned session block. */
export interface GrokSessionBlockBase {
  /** Stable key used by upsert and delete changes. */
  readonly id: string;
  readonly type: GrokSessionBlockType;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly promptIndex?: number;
  readonly origin: GrokRecordOrigin;
}

/** User text accumulated from one Grok message stream. */
export interface GrokUserTextBlock extends GrokSessionBlockBase {
  readonly type: 'user_text';
  readonly content: string;
}

/** Assistant text accumulated from one Grok message stream. */
export interface GrokAssistantTextBlock extends GrokSessionBlockBase {
  readonly type: 'assistant_text';
  readonly content: string;
}

/** Assistant reasoning accumulated from one Grok thought stream. */
export interface GrokThinkingBlock extends GrokSessionBlockBase {
  readonly type: 'thinking';
  readonly content: string;
}

/** Current state of a Grok tool call. */
export interface GrokToolUseBlock extends GrokSessionBlockBase {
  readonly type: 'tool_use';
  readonly toolUseId: string;
  readonly title: string;
  readonly kind?: string;
  readonly status?: string;
  readonly input?: unknown;
}

/** Terminal result of a Grok tool call. */
export interface GrokToolResultBlock extends GrokSessionBlockBase {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly status: 'completed' | 'failed';
  readonly output?: unknown;
  readonly isError: boolean;
}

/** Entry or exit of a Grok subagent. */
export interface GrokAgentBoundaryBlock extends GrokSessionBlockBase {
  readonly type: 'agent_boundary';
  readonly subagentId: string;
  readonly childSessionId: string;
  readonly direction: 'enter' | 'exit';
  readonly status?: string;
}

/** Grok-native normalized session block. */
export type GrokSessionBlock =
  | GrokUserTextBlock
  | GrokAssistantTextBlock
  | GrokThinkingBlock
  | GrokToolUseBlock
  | GrokToolResultBlock
  | GrokAgentBoundaryBlock;

/** Idempotent mutation of the normalized Grok block collection. */
export type GrokBlockChange =
  | { readonly type: 'upsert'; readonly block: GrokSessionBlock }
  | {
      readonly type: 'delete';
      readonly id: string;
      readonly origin: GrokRecordOrigin;
    };

/** Current coalesced activity state for one correlated Grok operation. */
export interface GrokActivity {
  readonly id: string;
  readonly category: 'turn' | 'phase' | 'tool' | 'permission' | 'lifecycle';
  readonly correlationId: string;
  readonly state: string;
  readonly timestamp: string | number;
  readonly origin: GrokRecordOrigin;
  readonly payload: unknown;
}

/** Parsed updates.jsonl record with its storage provenance. */
export interface GrokNormalizedUpdateRecord {
  readonly kind: 'update';
  readonly envelope: GrokUpdateEnvelope;
  readonly origin: GrokRecordOrigin;
}

/** Parsed events.jsonl record with its storage provenance. */
export interface GrokNormalizedEventRecord {
  readonly kind: 'event';
  readonly event: GrokEvent;
  readonly origin: GrokRecordOrigin;
}

/** Parsed Grok record accepted by the normalized reducer. */
export type GrokNormalizedRecord =
  | GrokNormalizedUpdateRecord
  | GrokNormalizedEventRecord;

/** Result of reducing an ordered set of parsed Grok records. */
export interface GrokReductionResult {
  readonly changes: readonly GrokBlockChange[];
  readonly activities: readonly GrokActivity[];
}

interface MutableReducerState {
  readonly blocks: Map<string, GrokSessionBlock>;
  readonly changes: GrokBlockChange[];
  readonly upsertIndexes: Map<string, number>;
  readonly activities: Map<string, GrokActivity>;
  readonly activeStreams: Map<string, string>;
  currentPromptIndex: number | undefined;
  currentTurnCorrelation: string | undefined;
}

/**
 * Reduces parsed Grok records into block mutations and coalesced activities.
 *
 * Records are processed in caller-provided order. Repeated upserts to one ID
 * are coalesced until a delete, while rewind deletes remain ordered after the
 * blocks they invalidate.
 *
 * @param records Ordered parsed records from updates.jsonl and events.jsonl.
 * @returns Normalized block changes and current activity states.
 */
export function reduceGrokRecords(
  records: readonly GrokNormalizedRecord[]
): GrokReductionResult {
  const state: MutableReducerState = {
    blocks: new Map(),
    changes: [],
    upsertIndexes: new Map(),
    activities: new Map(),
    activeStreams: new Map(),
    currentPromptIndex: undefined,
    currentTurnCorrelation: undefined,
  };

  for (const record of records) {
    if (record.kind === 'update') reduceUpdate(state, record);
    else reduceEvent(state, record);
  }

  return {
    changes: state.changes,
    activities: [...state.activities.values()],
  };
}

/**
 * Applies a normalized change stream to its final block collection.
 *
 * The returned order follows first insertion order. Re-inserting a deleted ID
 * places it at the end, matching JavaScript Map mutation semantics.
 *
 * @param changes Ordered upsert and delete mutations.
 * @returns Final blocks after every mutation has been applied.
 */
export function foldGrokBlockChanges(
  changes: readonly GrokBlockChange[]
): GrokSessionBlock[] {
  const blocks = new Map<string, GrokSessionBlock>();
  for (const change of changes) {
    if (change.type === 'upsert') blocks.set(change.block.id, change.block);
    else blocks.delete(change.id);
  }
  return [...blocks.values()];
}

function reduceUpdate(
  state: MutableReducerState,
  record: GrokNormalizedUpdateRecord
): void {
  const { envelope } = record;
  const update = envelope.params.update;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      reduceTextChunk(state, record);
      return;
    case 'tool_call':
      clearActiveStreamType(state, 'assistant_text');
      clearActiveStreamType(state, 'thinking');
      upsertToolUse(state, record, update);
      return;
    case 'tool_call_update':
      reduceToolUpdate(state, record, update);
      return;
    case 'subagent_spawned':
      upsertBlock(state, {
        id: `${envelope.params.sessionId}:agent_boundary:${update.subagent_id}:enter`,
        type: 'agent_boundary',
        sessionId: envelope.params.sessionId,
        timestamp: envelope.timestamp,
        ...(state.currentPromptIndex === undefined
          ? {}
          : { promptIndex: state.currentPromptIndex }),
        origin: record.origin,
        subagentId: update.subagent_id,
        childSessionId: update.child_session_id,
        direction: 'enter',
      });
      return;
    case 'subagent_finished':
      upsertBlock(state, {
        id: `${envelope.params.sessionId}:agent_boundary:${update.subagent_id}:exit`,
        type: 'agent_boundary',
        sessionId: envelope.params.sessionId,
        timestamp: envelope.timestamp,
        ...(state.currentPromptIndex === undefined
          ? {}
          : { promptIndex: state.currentPromptIndex }),
        origin: record.origin,
        subagentId: update.subagent_id,
        childSessionId: update.child_session_id,
        direction: 'exit',
        status: update.status,
      });
      return;
    case 'rewind_marker':
      rewindBlocks(state, update.target_prompt_index, record.origin);
      return;
    case 'turn_completed':
      state.activeStreams.clear();
      upsertActivity(state, {
        id: activityId(record.origin.sourceId, 'turn', update.prompt_id),
        category: 'turn',
        correlationId: update.prompt_id,
        state: update.stop_reason,
        timestamp: envelope.timestamp,
        origin: record.origin,
        payload: update,
      });
      return;
    default:
      return;
  }
}

function reduceTextChunk(
  state: MutableReducerState,
  record: GrokNormalizedUpdateRecord
): void {
  const { envelope } = record;
  const update = envelope.params.update;
  if (
    update.sessionUpdate !== 'user_message_chunk' &&
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return;
  }
  if (update.content.type !== 'text') return;

  const type =
    update.sessionUpdate === 'user_message_chunk'
      ? 'user_text'
      : update.sessionUpdate === 'agent_message_chunk'
        ? 'assistant_text'
        : 'thinking';
  const promptIndex = readNumber(update._meta, 'promptIndex');
  if (type === 'user_text' && promptIndex !== undefined) {
    state.currentPromptIndex = promptIndex;
  }
  const blockPromptIndex = promptIndex ?? state.currentPromptIndex;
  const promptId =
    readString(update._meta, 'promptId') ??
    readString(envelope.params._meta, 'promptId');
  const correlation =
    promptId ??
    (blockPromptIndex === undefined
      ? 'unscoped'
      : `prompt-${String(blockPromptIndex)}`);
  const explicitMessageId = update.messageId ?? undefined;
  const streamKey = `${type}:${correlation}`;
  const messageId =
    explicitMessageId ??
    state.activeStreams.get(streamKey) ??
    `${correlation}:stream-${String(record.origin.byteStart)}`;
  if (explicitMessageId === undefined) {
    state.activeStreams.set(streamKey, messageId);
  }

  const id = `${envelope.params.sessionId}:${type}:${messageId}`;
  const existing = state.blocks.get(id);
  const existingContent =
    existing?.type === type &&
    (existing.type === 'user_text' ||
      existing.type === 'assistant_text' ||
      existing.type === 'thinking')
      ? existing.content
      : '';
  const common = {
    id,
    sessionId: envelope.params.sessionId,
    timestamp: envelope.timestamp,
    ...(blockPromptIndex === undefined
      ? {}
      : { promptIndex: blockPromptIndex }),
    origin: record.origin,
    content: existingContent + update.content.text,
  };
  if (type === 'user_text') upsertBlock(state, { ...common, type });
  else if (type === 'assistant_text') upsertBlock(state, { ...common, type });
  else upsertBlock(state, { ...common, type });
}

function upsertToolUse(
  state: MutableReducerState,
  record: GrokNormalizedUpdateRecord,
  update: Extract<
    GrokUpdateEnvelope['params']['update'],
    { sessionUpdate: 'tool_call' }
  >
): void {
  const block: GrokToolUseBlock = {
    id: `${record.envelope.params.sessionId}:tool_use:${update.toolCallId}`,
    type: 'tool_use',
    sessionId: record.envelope.params.sessionId,
    timestamp: record.envelope.timestamp,
    ...(state.currentPromptIndex === undefined
      ? {}
      : { promptIndex: state.currentPromptIndex }),
    origin: record.origin,
    toolUseId: update.toolCallId,
    title: update.title,
    ...(update.kind === undefined ? {} : { kind: update.kind }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(Object.hasOwn(update, 'rawInput') ? { input: update.rawInput } : {}),
  };
  upsertBlock(state, block);
}

function reduceToolUpdate(
  state: MutableReducerState,
  record: GrokNormalizedUpdateRecord,
  update: Extract<
    GrokUpdateEnvelope['params']['update'],
    { sessionUpdate: 'tool_call_update' }
  >
): void {
  const sessionId = record.envelope.params.sessionId;
  const useId = `${sessionId}:tool_use:${update.toolCallId}`;
  const existing = state.blocks.get(useId);
  if (
    existing?.type === 'tool_use' &&
    (update.title !== undefined || Object.hasOwn(update, 'rawInput'))
  ) {
    upsertBlock(state, {
      ...existing,
      timestamp: record.envelope.timestamp,
      origin: record.origin,
      title: update.title ?? existing.title,
      ...(update.kind === undefined ? {} : { kind: update.kind }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(Object.hasOwn(update, 'rawInput') ? { input: update.rawInput } : {}),
    });
  } else if (update.title !== undefined || Object.hasOwn(update, 'rawInput')) {
    upsertBlock(state, {
      id: useId,
      type: 'tool_use',
      sessionId,
      timestamp: record.envelope.timestamp,
      ...(state.currentPromptIndex === undefined
        ? {}
        : { promptIndex: state.currentPromptIndex }),
      origin: record.origin,
      toolUseId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      ...(update.kind === undefined ? {} : { kind: update.kind }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(Object.hasOwn(update, 'rawInput') ? { input: update.rawInput } : {}),
    });
  }

  if (update.status !== 'completed' && update.status !== 'failed') return;
  const result: GrokToolResultBlock = {
    id: `${sessionId}:tool_result:${update.toolCallId}`,
    type: 'tool_result',
    sessionId,
    timestamp: record.envelope.timestamp,
    ...(state.currentPromptIndex === undefined
      ? {}
      : { promptIndex: state.currentPromptIndex }),
    origin: record.origin,
    toolUseId: update.toolCallId,
    status: update.status,
    ...(Object.hasOwn(update, 'rawOutput')
      ? { output: update.rawOutput }
      : update.content === undefined
        ? {}
        : { output: update.content }),
    isError: update.status === 'failed',
  };
  upsertBlock(state, result);
}

function clearActiveStreamType(
  state: MutableReducerState,
  type: 'assistant_text' | 'thinking'
): void {
  for (const key of state.activeStreams.keys()) {
    if (key.startsWith(`${type}:`)) state.activeStreams.delete(key);
  }
}

function rewindBlocks(
  state: MutableReducerState,
  targetPromptIndex: number,
  origin: GrokRecordOrigin
): void {
  state.activeStreams.clear();
  for (const block of [...state.blocks.values()]) {
    if (
      block.promptIndex === undefined ||
      block.promptIndex <= targetPromptIndex
    ) {
      continue;
    }
    state.blocks.delete(block.id);
    state.upsertIndexes.delete(block.id);
    state.changes.push({ type: 'delete', id: block.id, origin });
  }
  state.currentPromptIndex =
    targetPromptIndex === 0 ? undefined : targetPromptIndex - 1;
}

function reduceEvent(
  state: MutableReducerState,
  record: GrokNormalizedEventRecord
): void {
  const { event } = record;
  if (event.type === 'turn_started') {
    state.currentTurnCorrelation = `${event.session_id}:turn:${String(event.turn_number)}`;
  }
  const category = eventCategory(event.type);
  const correlationId = eventCorrelation(state, record, category);
  upsertActivity(state, {
    id: activityId(record.origin.sourceId, category, correlationId),
    category,
    correlationId,
    state: eventState(event),
    timestamp: event.ts,
    origin: record.origin,
    payload: event,
  });
}

function eventCategory(type: GrokEvent['type']): GrokActivity['category'] {
  if (
    type === 'turn_started' ||
    type === 'turn_ended' ||
    type === 'loop_started' ||
    type === 'first_token' ||
    type === 'interjected'
  ) {
    return 'turn';
  }
  if (type === 'phase_changed') return 'phase';
  if (type.startsWith('permission_')) return 'permission';
  if (type.startsWith('tool_') || type.startsWith('mcp_tool_call_')) {
    return 'tool';
  }
  return 'lifecycle';
}

function eventCorrelation(
  state: MutableReducerState,
  record: GrokNormalizedEventRecord,
  category: GrokActivity['category']
): string {
  const event = record.event;
  if (category === 'turn' || category === 'phase') {
    return state.currentTurnCorrelation ?? record.origin.sourceId;
  }
  if (category === 'tool') {
    return (
      readString(event, 'tool_call_id') ??
      readString(event, 'call_id') ??
      readString(event, 'tool_name') ??
      record.origin.sourceId
    );
  }
  if (category === 'permission') {
    return readString(event, 'tool_name') ?? record.origin.sourceId;
  }
  return event.type;
}

function eventState(event: GrokEvent): string {
  return (
    readString(event, 'phase') ??
    readString(event, 'outcome') ??
    readString(event, 'decision') ??
    event.type
  );
}

function activityId(
  sourceId: string,
  category: GrokActivity['category'],
  correlationId: string
): string {
  return `${sourceId}:activity:${category}:${correlationId}`;
}

function upsertBlock(
  state: MutableReducerState,
  block: GrokSessionBlock
): void {
  state.blocks.set(block.id, block);
  const change: GrokBlockChange = { type: 'upsert', block };
  const existingIndex = state.upsertIndexes.get(block.id);
  if (existingIndex === undefined) {
    state.upsertIndexes.set(block.id, state.changes.length);
    state.changes.push(change);
  } else {
    state.changes[existingIndex] = change;
  }
}

function upsertActivity(
  state: MutableReducerState,
  activity: GrokActivity
): void {
  state.activities.set(
    `${activity.category}:${activity.correlationId}`,
    activity
  );
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = Reflect.get(value, key) as unknown;
  return typeof field === 'string' ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = Reflect.get(value, key) as unknown;
  return typeof field === 'number' && Number.isSafeInteger(field)
    ? field
    : undefined;
}
