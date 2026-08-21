import { z } from 'zod';

const metadataSchema = z.unknown().optional();
const nullableStringSchema = z.string().nullish();
const unsignedIntegerSchema = z.number().int().nonnegative();

const annotationsSchema = z.looseObject({
  audience: z.array(z.enum(['assistant', 'user'])).optional(),
  lastModified: z.string().optional(),
  priority: z.number().optional(),
  _meta: metadataSchema,
});

const textContentSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
  annotations: annotationsSchema.optional(),
  _meta: metadataSchema,
});

const imageContentSchema = z.looseObject({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string(),
  uri: z.string().nullish(),
  annotations: annotationsSchema.optional(),
  _meta: metadataSchema,
});

const audioContentSchema = z.looseObject({
  type: z.literal('audio'),
  data: z.string(),
  mimeType: z.string(),
  annotations: annotationsSchema.optional(),
  _meta: metadataSchema,
});

const resourceLinkContentSchema = z.looseObject({
  type: z.literal('resource_link'),
  name: z.string(),
  uri: z.string(),
  description: z.string().nullish(),
  mimeType: z.string().nullish(),
  size: z.number().int().nullish(),
  title: z.string().nullish(),
  annotations: annotationsSchema.optional(),
  _meta: metadataSchema,
});

const textResourceSchema = z.looseObject({
  text: z.string(),
  uri: z.string(),
  mimeType: z.string().nullish(),
  _meta: metadataSchema,
});

const blobResourceSchema = z.looseObject({
  blob: z.string(),
  uri: z.string(),
  mimeType: z.string().nullish(),
  _meta: metadataSchema,
});

const embeddedResourceContentSchema = z.looseObject({
  type: z.literal('resource'),
  resource: z.union([textResourceSchema, blobResourceSchema]),
  annotations: annotationsSchema.optional(),
  _meta: metadataSchema,
});

const contentBlockSchema = z.discriminatedUnion('type', [
  textContentSchema,
  imageContentSchema,
  audioContentSchema,
  resourceLinkContentSchema,
  embeddedResourceContentSchema,
]);

const toolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
const toolStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

const toolCallContentSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('content'),
    content: contentBlockSchema,
    _meta: metadataSchema,
  }),
  z.looseObject({
    type: z.literal('diff'),
    path: z.string(),
    oldText: nullableStringSchema,
    newText: z.string(),
    _meta: metadataSchema,
  }),
  z.looseObject({
    type: z.literal('terminal'),
    terminalId: z.string(),
    _meta: metadataSchema,
  }),
]);

const toolLocationSchema = z.looseObject({
  path: z.string(),
  line: unsignedIntegerSchema.nullish(),
  _meta: metadataSchema,
});

const contentChunkFields = {
  content: contentBlockSchema,
  messageId: z.string().nullish(),
  _meta: metadataSchema,
};

const userMessageChunkSchema = z.looseObject({
  sessionUpdate: z.literal('user_message_chunk'),
  ...contentChunkFields,
});
const agentMessageChunkSchema = z.looseObject({
  sessionUpdate: z.literal('agent_message_chunk'),
  ...contentChunkFields,
});
const agentThoughtChunkSchema = z.looseObject({
  sessionUpdate: z.literal('agent_thought_chunk'),
  ...contentChunkFields,
});

const toolCallFields = {
  toolCallId: z.string(),
  title: z.string(),
  kind: toolKindSchema.optional(),
  status: toolStatusSchema.optional(),
  content: z.array(toolCallContentSchema).optional(),
  locations: z.array(toolLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: metadataSchema,
};

const toolCallSchema = z.looseObject({
  sessionUpdate: z.literal('tool_call'),
  ...toolCallFields,
});
const toolCallUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: toolKindSchema.optional(),
  status: toolStatusSchema.optional(),
  content: z.array(toolCallContentSchema).optional(),
  locations: z.array(toolLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: metadataSchema,
});

const planSchema = z.looseObject({
  sessionUpdate: z.literal('plan'),
  entries: z.array(
    z.looseObject({
      content: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      status: z.enum(['pending', 'in_progress', 'completed']),
      _meta: metadataSchema,
    })
  ),
  _meta: metadataSchema,
});

const availableCommandsUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('available_commands_update'),
  availableCommands: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string(),
      input: z.unknown(),
      _meta: metadataSchema,
    })
  ),
  _meta: metadataSchema,
});

const currentModeUpdateSchema = z.looseObject({
  sessionUpdate: z.literal('current_mode_update'),
  currentModeId: z.string(),
  _meta: metadataSchema,
});

/** ACP session/update variants persisted by Grok. */
export const grokAcpSessionUpdateSchema = z.discriminatedUnion(
  'sessionUpdate',
  [
    userMessageChunkSchema,
    agentMessageChunkSchema,
    agentThoughtChunkSchema,
    toolCallSchema,
    toolCallUpdateSchema,
    planSchema,
    availableCommandsUpdateSchema,
    currentModeUpdateSchema,
  ]
);

function tagOnly<const Tag extends string>(tag: Tag) {
  return z.looseObject({ sessionUpdate: z.literal(tag) });
}

const xaiBranches = [
  tagOnly('diff_review'),
  tagOnly('retry_state'),
  z.looseObject({
    sessionUpdate: z.literal('auto_compact_started'),
    tokens_used: unsignedIntegerSchema,
    context_window: unsignedIntegerSchema,
    percentage: unsignedIntegerSchema.max(255),
    reason: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('auto_compact_completed'),
    tokens_before: unsignedIntegerSchema.nullish(),
    tokens_after: unsignedIntegerSchema,
    elapsed_ms: z.number().int().nullish(),
    summary_preview: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('auto_compact_failed'),
    error: z.string(),
  }),
  tagOnly('memory_flush_started'),
  z.looseObject({
    sessionUpdate: z.literal('memory_flush_completed'),
    result: z.string(),
    path: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('memory_dream_completed'),
    result: z.string(),
    path: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('memory_session_saved'),
    path: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('auto_compact_cancelled'),
    reason: z.unknown(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('auto_continue_completed'),
    total_tokens: unsignedIntegerSchema,
  }),
  tagOnly('feedback_request'),
  tagOnly('relay_sync_status'),
  z.looseObject({
    sessionUpdate: z.literal('auto_recovery_started'),
    attempt: unsignedIntegerSchema,
    max_retries: unsignedIntegerSchema,
    error: z.string(),
    delay_ms: unsignedIntegerSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('auto_recovery_exhausted'),
    attempts: unsignedIntegerSchema,
    error: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('hook_annotation'),
    message: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('hook_execution'),
    event_name: z.string(),
    tool_name: nullableStringSchema,
    prompt_id: nullableStringSchema,
    runs: z.array(z.unknown()),
  }),
  z.looseObject({
    sessionUpdate: z.literal('hooks_changed'),
    hooks: z.array(z.unknown()),
    project_trusted: z.boolean(),
    load_errors: z.array(z.string()).optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('plugins_changed'),
    plugins: z.array(z.unknown()),
  }),
  z.looseObject({
    sessionUpdate: z.literal('plugin_updates_installed'),
    updates: z.array(z.tuple([z.string(), z.string(), z.string()])),
  }),
  z.looseObject({
    sessionUpdate: z.literal('session_summary_generated'),
    session_summary: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('session_recap'),
    summary: z.string(),
    auto: z.boolean().optional(),
  }),
  tagOnly('session_recap_unavailable'),
  z.looseObject({
    sessionUpdate: z.literal('last_turn_summary'),
    summary: z.string(),
    prompt_id: nullableStringSchema,
  }),
  tagOnly('compaction_checkpoint'),
  z.looseObject({
    sessionUpdate: z.literal('rewind_marker'),
    target_prompt_index: unsignedIntegerSchema,
    created_at: z.string(),
  }),
  tagOnly('task_completed'),
  z.looseObject({
    sessionUpdate: z.literal('subagent_spawned'),
    subagent_id: z.string(),
    parent_session_id: z.string(),
    parent_prompt_id: nullableStringSchema,
    child_session_id: z.string(),
    subagent_type: z.string(),
    description: z.string(),
    effective_context_source: nullableStringSchema,
    context_normalized: z.boolean().optional(),
    capability_mode: nullableStringSchema,
    persona: nullableStringSchema,
    role: nullableStringSchema,
    model: nullableStringSchema,
    resumed_from: nullableStringSchema,
    workflow_run_id: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('subagent_progress'),
    subagent_id: z.string(),
    parent_session_id: z.string(),
    child_session_id: z.string(),
    duration_ms: unsignedIntegerSchema,
    turn_count: unsignedIntegerSchema,
    tool_call_count: unsignedIntegerSchema,
    tokens_used: unsignedIntegerSchema,
    context_window_tokens: unsignedIntegerSchema,
    context_usage_pct: unsignedIntegerSchema.max(255),
    tools_used: z.array(z.string()),
    error_count: unsignedIntegerSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('subagent_finished'),
    subagent_id: z.string(),
    child_session_id: z.string(),
    status: z.string(),
    error: nullableStringSchema,
    tool_calls: unsignedIntegerSchema,
    turns: unsignedIntegerSchema,
    duration_ms: unsignedIntegerSchema,
    tokens_used: unsignedIntegerSchema.optional(),
    output: nullableStringSchema,
    will_wake: z.boolean().optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('task_backgrounded'),
    tool_call_id: z.string(),
    task_id: z.string(),
    command: z.string(),
    cwd: z.string(),
    output_file: z.string(),
    monitor_description: nullableStringSchema,
    description: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('scheduled_task_created'),
    task_id: z.string(),
    prompt: z.string(),
    human_schedule: z.string(),
    next_fire_at: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('scheduled_task_fired'),
    task_id: z.string(),
    prompt: z.string(),
    human_schedule: z.string(),
    next_fire_at: nullableStringSchema,
    subagent_id: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('scheduled_task_deleted'),
    task_id: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('monitor_event'),
    task_id: z.string(),
    description: z.string(),
    event_text: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('model_auto_switched'),
    previous_model_id: z.string(),
    new_model_id: z.string(),
    reason: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('model_changed'),
    model_id: z.string(),
    reasoning_effort: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('tool_call_delta_chunk'),
    tool_call_id: nullableStringSchema,
    tool_index: unsignedIntegerSchema,
    name: nullableStringSchema,
    arguments_delta: nullableStringSchema,
  }),
  tagOnly('image_compressed'),
  z.looseObject({
    sessionUpdate: z.literal('image_dropped'),
    notes: z.array(z.string()),
  }),
  tagOnly('memory_files'),
  tagOnly('workflow_updated'),
  tagOnly('goal_updated'),
  z.looseObject({
    sessionUpdate: z.literal('pending_interaction'),
    tool_call_id: z.string(),
    kind: z.unknown(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('interaction_resolved'),
    tool_call_id: z.string(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('turn_completed'),
    prompt_id: z.string(),
    stop_reason: z.string(),
    agent_result: nullableStringSchema,
    usage: z.unknown().optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('response_started'),
    message_id: nullableStringSchema,
    model: nullableStringSchema,
    input_tokens: unsignedIntegerSchema.optional(),
    cache_read_input_tokens: unsignedIntegerSchema.optional(),
    cache_creation_input_tokens: unsignedIntegerSchema.optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('reasoning_completed'),
    signature: nullableStringSchema,
  }),
  z.looseObject({
    sessionUpdate: z.literal('response_completed'),
    message_id: nullableStringSchema,
    stop_reason: nullableStringSchema,
    usage: z.unknown().optional(),
    signature: nullableStringSchema,
    stop_sequence: nullableStringSchema,
  }),
] as const;

/**
 * xAI extension session updates pinned by the vendored SessionUpdate enum.
 *
 * Branches whose payload is an upstream nested DTO without a vendored field
 * contract validate only the `sessionUpdate` tag and preserve all other fields
 * through `z.looseObject`. This applies to diff/retry/feedback/relay,
 * compaction-checkpoint, task-completed, image-compressed, memory-files,
 * workflow, and goal payloads.
 */
export const grokXaiSessionUpdateSchema = z.discriminatedUnion(
  'sessionUpdate',
  xaiBranches
);

const acpEnvelopeSchema = z.looseObject({
  timestamp: z.number(),
  method: z.literal('session/update'),
  params: z.looseObject({
    sessionId: z.string(),
    update: grokAcpSessionUpdateSchema,
    _meta: metadataSchema,
  }),
});
const xaiEnvelopeSchema = z.looseObject({
  timestamp: z.number(),
  method: z.literal('_x.ai/session/update'),
  params: z.looseObject({
    sessionId: z.string(),
    update: grokXaiSessionUpdateSchema,
    _meta: metadataSchema,
  }),
});

/** A typed updates.jsonl envelope for ACP or xAI session updates. */
export const grokUpdateEnvelopeSchema = z.discriminatedUnion('method', [
  acpEnvelopeSchema,
  xaiEnvelopeSchema,
]);

const rawEnvelopeSchema = z.looseObject({
  timestamp: z.number(),
  method: z.enum(['session/update', '_x.ai/session/update']),
  params: z.looseObject({
    sessionId: z.string(),
    update: z.unknown(),
    _meta: metadataSchema,
  }),
});

/** A validated, typed updates.jsonl envelope. */
export type GrokUpdateEnvelope = z.infer<typeof grokUpdateEnvelopeSchema>;

/** The result of parsing one updates.jsonl record. */
export type GrokSessionUpdateParseResult =
  | { kind: 'known'; envelope: GrokUpdateEnvelope }
  | { kind: 'unknown'; tag: string; raw: unknown }
  | { kind: 'invalid'; error: string; raw: unknown };

const updateTagSchema = z.looseObject({ sessionUpdate: z.string() });

function peekTag(update: unknown): string | undefined {
  const result = updateTagSchema.safeParse(update);
  return result.success ? result.data.sessionUpdate : undefined;
}

const acpTags: ReadonlySet<string> = new Set(
  grokAcpSessionUpdateSchema.options.map(
    option => option.shape.sessionUpdate.value
  )
);
const xaiTags: ReadonlySet<string> = new Set(
  grokXaiSessionUpdateSchema.options.map(
    option => option.shape.sessionUpdate.value
  )
);

/**
 * Parses one decoded updates.jsonl record without throwing.
 *
 * Unknown tags are preserved verbatim for forward compatibility. A tag that
 * belongs to the selected method but fails its branch schema is invalid rather
 * than being downgraded to unknown. The function is pure and preserves input
 * order because it performs no filtering, sorting, or deduplication.
 *
 * @param raw Decoded JSON value from one updates.jsonl line.
 * @returns A known envelope, preserved unknown record, or validation failure.
 */
export function parseGrokSessionUpdate(
  raw: unknown
): GrokSessionUpdateParseResult {
  const envelopeResult = rawEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    return { kind: 'invalid', error: envelopeResult.error.message, raw };
  }

  const tag = peekTag(envelopeResult.data.params.update);
  if (tag === undefined) {
    return {
      kind: 'invalid',
      error: 'Missing or non-string params.update.sessionUpdate',
      raw,
    };
  }

  const tags =
    envelopeResult.data.method === 'session/update' ? acpTags : xaiTags;
  if (!tags.has(tag)) return { kind: 'unknown', tag, raw };

  const knownResult = grokUpdateEnvelopeSchema.safeParse(raw);
  if (!knownResult.success) {
    return { kind: 'invalid', error: knownResult.error.message, raw };
  }
  return { kind: 'known', envelope: knownResult.data };
}
