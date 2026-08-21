import { z } from 'zod';

const unsignedIntegerSchema = z.number().int().nonnegative();
const timestampSchema = z.string();
const phaseSchema = z.enum([
  'waiting_for_model',
  'streaming_text',
  'streaming_reasoning',
  'tool_execution',
  'permission_prompt',
]);
const toolOutcomeSchema = z.enum([
  'success',
  'error',
  'permission_rejected',
  'permission_cancelled',
  'followup',
  'hook_denied',
  'invalid_tool',
  'cancelled',
]);
const permissionDecisionSchema = z.enum([
  'allow',
  'deny',
  'cancelled',
  'followup',
]);
const redirectKindSchema = z.enum([
  'interjection',
  'cancel_then_send',
  'queued_after_cancel',
]);
const mcpErrorCategorySchema = z.enum([
  'spawn_failed',
  'timeout',
  'handshake_failed',
  'auth_required',
  'client_error',
]);

function eventBranch<
  const Tag extends string,
  const Fields extends Record<string, z.ZodType>,
>(tag: Tag, fields: Fields) {
  return z.looseObject({
    type: z.literal(tag),
    ts: timestampSchema,
    ...fields,
  });
}

const eventBranches = [
  eventBranch('turn_started', {
    session_id: z.string(),
    turn_number: unsignedIntegerSchema,
    model_id: z.string(),
    yolo_mode: z.boolean(),
    conversation_message_count: unsignedIntegerSchema,
    session_relationship: z.enum(['primary', 'subagent']),
    schema_version: z.literal('1.0'),
    redirect_kind: redirectKindSchema.optional(),
  }),
  eventBranch('phase_changed', { phase: phaseSchema }),
  eventBranch('first_token', {}),
  eventBranch('loop_started', { loop_index: unsignedIntegerSchema }),
  eventBranch('tool_started', { tool_name: z.string() }),
  eventBranch('tool_completed', {
    tool_name: z.string(),
    duration_ms: unsignedIntegerSchema,
    outcome: toolOutcomeSchema,
    tool_call_id: z.string().optional(),
    source: z.literal('workspace').optional(),
  }),
  eventBranch('permission_requested', { tool_name: z.string() }),
  eventBranch('permission_resolved', {
    tool_name: z.string(),
    decision: permissionDecisionSchema,
    wait_ms: unsignedIntegerSchema,
  }),
  eventBranch('turn_ended', {
    outcome: z.enum(['completed', 'cancelled', 'error']),
    cancellation_category: z
      .enum([
        'hook_denied',
        'permission_rejected',
        'permission_cancelled',
        'mid_turn_abort',
      ])
      .optional(),
    cancellation_context: z.unknown().optional(),
  }),
  eventBranch('interjected', {
    source: z.enum(['direct', 'queue']),
    image_count: unsignedIntegerSchema,
    redirect_kind: z.literal('interjection'),
  }),
  eventBranch('yolo_toggled', { enabled: z.boolean() }),
  eventBranch('goal_auto_paused', {
    reason: z.enum([
      'user',
      'back_off',
      'no_progress',
      'verification',
      'infra',
    ]),
  }),
  eventBranch('todo_gate_fired', {
    fires: unsignedIntegerSchema,
    pending: unsignedIntegerSchema,
    in_progress: unsignedIntegerSchema,
    reason: z.string(),
  }),
  eventBranch('todo_gate_exhausted', { pending: unsignedIntegerSchema }),
  eventBranch('laziness_classifier_fired', {
    model_id: z.string(),
    category: z.string(),
    confidence: z.number(),
  }),
  eventBranch('laziness_nudge_fired', {
    model_id: z.string(),
    category: z.string(),
    nudges_remaining: unsignedIntegerSchema,
  }),
  eventBranch('laziness_classifier_aborted', { reason: z.string() }),
  eventBranch('goal_classifier_fired', {
    attempt: unsignedIntegerSchema,
    max_runs: unsignedIntegerSchema,
    model_id: z.string(),
  }),
  eventBranch('goal_classifier_verdict', {
    verdict: z.enum(['achieved', 'not_achieved']),
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_fail_open', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_fail_closed', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_cap_reached', {
    attempt: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_mid_turn_deferred', {
    pending_depth: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_dropped_after_cap', {
    attempts_seen: unsignedIntegerSchema,
  }),
  eventBranch('goal_classifier_pending_queue_cleared', {
    dropped: unsignedIntegerSchema,
  }),
  eventBranch('goal_planner_fired', {
    attempt: unsignedIntegerSchema,
    max_runs: unsignedIntegerSchema,
    model_id: z.string(),
  }),
  eventBranch('goal_planner_completed', {
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_planner_fail_closed', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_strategist_fired', {
    attempt: unsignedIntegerSchema,
    consecutive_failures: unsignedIntegerSchema,
    every: unsignedIntegerSchema,
    model_id: z.string(),
  }),
  eventBranch('goal_strategist_completed', {
    attempt: unsignedIntegerSchema,
    consecutive_failures: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_strategist_failed', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
    consecutive_failures: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_strategist_contract_restore_failed', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
  }),
  eventBranch('goal_summarizer_fired', {
    attempt: unsignedIntegerSchema,
    model_id: z.string(),
  }),
  eventBranch('goal_summarizer_completed', {
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_summarizer_fail_open', {
    reason: z.string(),
    attempt: unsignedIntegerSchema,
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_role_model_resolved', {
    role: z.string(),
    skeptic_idx: unsignedIntegerSchema.optional(),
    model_id: z.string(),
    agent_type: z.string(),
    source: z.string(),
  }),
  eventBranch('goal_role_model_fail_open', {
    role: z.string(),
    skeptic_idx: unsignedIntegerSchema.optional(),
    reason: z.string(),
  }),
  eventBranch('goal_verifier_skeptic_verdict', {
    attempt: unsignedIntegerSchema,
    skeptic_idx: unsignedIntegerSchema,
    refuted: z.boolean(),
    confidence: z.string(),
    latency_ms: unsignedIntegerSchema,
  }),
  eventBranch('goal_verifier_aggregate_verdict', {
    attempt: unsignedIntegerSchema,
    refuted_count: unsignedIntegerSchema,
    total: unsignedIntegerSchema,
    achieved: z.boolean(),
  }),
  eventBranch('goal_premature_stop_detected', { pattern: z.string() }),
  eventBranch('mcp_config_resolved', {
    servers: z.array(
      z.looseObject({
        name: z.string(),
        transport: z.string(),
        source: z.string(),
      })
    ),
    disabled: z.array(z.string()),
  }),
  eventBranch('mcp_managed_config_result', {
    server_count: unsignedIntegerSchema,
    error: z.string().optional(),
  }),
  eventBranch('mcp_oauth_discovery_timeout', {
    server_name: z.string(),
    url: z.string(),
  }),
  eventBranch('mcp_server_starting', {
    server_name: z.string(),
    transport: z.string(),
    target: z.string(),
    timeout_sec: unsignedIntegerSchema,
  }),
  eventBranch('mcp_server_connected', {
    server_name: z.string(),
    transport: z.string(),
    tool_count: unsignedIntegerSchema,
    duration_ms: unsignedIntegerSchema,
    tools: z.array(z.string()),
  }),
  eventBranch('mcp_server_failed', {
    server_name: z.string(),
    transport: z.string().optional(),
    target: z.string().optional(),
    error_type: mcpErrorCategorySchema,
    error_message: z.string(),
    duration_ms: unsignedIntegerSchema.optional(),
    timeout_sec: unsignedIntegerSchema.optional(),
  }),
  eventBranch('mcp_tool_registration_failed', {
    server_name: z.string(),
    tool_name: z.string(),
    error: z.string(),
  }),
  eventBranch('mcp_init_completed', {
    total_servers: unsignedIntegerSchema,
    succeeded: unsignedIntegerSchema,
    failed: unsignedIntegerSchema,
    auth_required: unsignedIntegerSchema,
    total_tools: unsignedIntegerSchema,
    duration_ms: unsignedIntegerSchema,
    is_reinit: z.boolean(),
    failed_servers: z.array(z.string()).optional(),
  }),
  eventBranch('mcp_init_cancelled', { reason: z.string() }),
  eventBranch('mcp_tool_call_started', {
    server_name: z.string(),
    tool_name: z.string(),
    call_id: z.string(),
    timeout_sec: unsignedIntegerSchema,
  }),
  eventBranch('mcp_tool_call_completed', {
    server_name: z.string(),
    tool_name: z.string(),
    call_id: z.string(),
    duration_ms: unsignedIntegerSchema,
    success: z.boolean(),
    is_timeout: z.boolean(),
    error: z.string().optional(),
    reconnect_attempted: z.boolean(),
    auth_retry_attempted: z.boolean(),
  }),
  eventBranch('mcp_transport_error', {
    server_name: z.string(),
    tool_name: z.string(),
    error: z.string(),
  }),
  eventBranch('mcp_transport_decode_error', {
    server_name: z.string(),
    error: z.string(),
    sample: z.string(),
  }),
  eventBranch('mcp_transport_reconnect', {
    server_name: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  eventBranch('mcp_auth_retry', {
    server_name: z.string(),
    trigger: z.string(),
    success: z.boolean(),
  }),
  eventBranch('mcp_health_check', {
    server_name: z.string(),
    healthy: z.boolean(),
    client_state: z.string().optional(),
  }),
  eventBranch('mcp_server_toggled', {
    server_name: z.string(),
    enabled: z.boolean(),
  }),
] as const;

/** Every event type persisted by the pinned Grok Event enum. */
export const grokEventTypes = eventBranches.map(
  branch => branch.shape.type.value
) as readonly string[];

/** Schema for one writer-completed events.jsonl record. */
export const grokEventSchema = z.discriminatedUnion('type', eventBranches);

/** A validated events.jsonl record. */
export type GrokEvent = z.infer<typeof grokEventSchema>;

/** The result of parsing one events.jsonl record. */
export type GrokEventParseResult =
  | { kind: 'known'; event: GrokEvent }
  | { kind: 'unknown'; tag: string; raw: unknown }
  | { kind: 'invalid'; error: string; raw: unknown };

const eventTagSchema = z.looseObject({ type: z.string() });
const eventTypeSet: ReadonlySet<string> = new Set(grokEventTypes);

/**
 * Parses one decoded events.jsonl record without throwing.
 *
 * Unknown tags are preserved verbatim for forward compatibility. Known tags
 * that fail their branch schema are invalid rather than being downgraded.
 * High-volume records are returned without filtering or coalescing.
 *
 * @param raw Decoded JSON value from one events.jsonl line.
 * @returns A known event, preserved unknown record, or validation failure.
 */
export function parseGrokEvent(raw: unknown): GrokEventParseResult {
  const tagResult = eventTagSchema.safeParse(raw);
  if (!tagResult.success) {
    return { kind: 'invalid', error: tagResult.error.message, raw };
  }

  const tag = tagResult.data.type;
  if (!eventTypeSet.has(tag)) return { kind: 'unknown', tag, raw };

  const eventResult = grokEventSchema.safeParse(raw);
  if (!eventResult.success) {
    return { kind: 'invalid', error: eventResult.error.message, raw };
  }
  return { kind: 'known', event: eventResult.data };
}
