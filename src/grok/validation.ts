import { z } from 'zod';
import { GrokHookEventName, type GrokHookInput } from './types.js';

const commonEnvelopeFields = {
  sessionId: z.string(),
  cwd: z.string(),
  workspaceRoot: z.string(),
  timestamp: z.string(),
  transcriptPath: z.string().optional(),
  clientIdentifier: z.string().optional(),
  promptId: z.string().optional(),
  permissionMode: z.string().optional(),
};

const requiredUnknownSchema = z.unknown().refine(value => value !== undefined, {
  message: 'Required',
});

const unsignedIntegerSchema = z.number().int().nonnegative();

/** Schema for a background task included with a Stop event. */
export const grokStopBackgroundTaskSchema = z.looseObject({
  id: z.string(),
  type: z.enum(['shell', 'monitor', 'subagent']),
  status: z.string(),
  description: z.string().optional(),
  command: z.string().optional(),
  agentType: z.string().optional(),
});

/** Schema for a session-scoped scheduled wakeup included with a Stop event. */
export const grokStopSessionCronSchema = z.looseObject({
  id: z.string(),
  schedule: z.string(),
  recurring: z.boolean(),
  prompt: z.string(),
});

/** Schema for Grok session_start hook input. */
export const grokSessionStartInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[0]),
  source: z.string(),
  modelId: z.string().optional(),
  agentType: z.string().optional(),
});

/** Schema for Grok user_prompt_submit hook input. */
export const grokUserPromptSubmitInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[1]),
  prompt: z.string().optional(),
});

/** Schema for Grok pre_tool_use hook input. */
export const grokPreToolUseInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[2]),
  toolName: z.string(),
  toolUseId: z.string(),
  toolInput: requiredUnknownSchema,
  toolInputTruncated: z.boolean(),
  subagentType: z.string().optional(),
});

/** Schema for Grok post_tool_use hook input. */
export const grokPostToolUseInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[3]),
  toolName: z.string(),
  toolUseId: z.string(),
  toolInput: requiredUnknownSchema,
  toolResult: requiredUnknownSchema,
  toolInputTruncated: z.boolean(),
  toolResultTruncated: z.boolean(),
  durationMs: unsignedIntegerSchema.optional(),
  isBackgrounded: z.boolean(),
  subagentType: z.string().optional(),
});

/** Schema for Grok post_tool_use_failure hook input. */
export const grokPostToolUseFailureInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[4]),
  toolName: z.string(),
  toolUseId: z.string(),
  toolInput: requiredUnknownSchema,
  toolInputTruncated: z.boolean(),
  error: z.string(),
  subagentType: z.string().optional(),
});

/** Schema for Grok permission_denied hook input. */
export const grokPermissionDeniedInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[5]),
  toolName: z.string(),
  toolUseId: z.string(),
  toolInput: requiredUnknownSchema,
  toolInputTruncated: z.boolean(),
});

/** Schema for Grok stop hook input. */
export const grokStopInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[6]),
  reason: z.string(),
  stopHookActive: z.boolean(),
  lastAssistantMessage: z.string().optional(),
  backgroundTasks: z.array(grokStopBackgroundTaskSchema).optional(),
  sessionCrons: z.array(grokStopSessionCronSchema).optional(),
});

/** Schema for error kinds emitted by Grok stop_failure hooks. */
export const grokStopFailureKindSchema = z.enum([
  'rate_limit',
  'authentication_failed',
  'invalid_request',
  'server_error',
  'max_output_tokens',
  'unknown',
]);

/** Schema for Grok stop_failure hook input. */
export const grokStopFailureInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[7]),
  error: grokStopFailureKindSchema,
  errorDetails: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
});

/** Schema for Grok notification hook input. */
export const grokNotificationInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[8]),
  notificationType: z.string(),
  message: z.string().optional(),
  title: z.string().optional(),
  level: z.string().optional(),
});

/** Schema for Grok subagent_start hook input. */
export const grokSubagentStartInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[9]),
  subagentId: z.string(),
  subagentType: z.string(),
  description: z.string().optional(),
});

const subagentStopPayloadFields = {
  phase: z.enum(['gate', 'observe']),
  subagentId: z.string(),
  subagentType: z.string(),
  stopHookActive: z.boolean().optional(),
  lastAssistantMessage: z.string().optional(),
};

/** Schema for Grok subagent_stop hook input. */
export const grokSubagentStopInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[10]),
  ...subagentStopPayloadFields,
});

/** Schema for the Grok subagent_end compatibility hook input. */
export const grokSubagentEndInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[11]),
  ...subagentStopPayloadFields,
});

/** Schema for Grok pre_compact hook input. */
export const grokPreCompactInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[12]),
  source: z.string(),
});

/** Schema for Grok post_compact hook input. */
export const grokPostCompactInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[13]),
  source: z.string(),
});

/** Schema for Grok session_end hook input. */
export const grokSessionEndInputSchema = z.looseObject({
  ...commonEnvelopeFields,
  hookEventName: z.literal(GrokHookEventName[14]),
  reason: z.string(),
  turnCount: unsignedIntegerSchema.optional(),
  toolCallCount: unsignedIntegerSchema.optional(),
});

/** Schema for every Grok hook envelope accepted on stdin. */
export const grokHookInputSchema = z.discriminatedUnion('hookEventName', [
  grokSessionStartInputSchema,
  grokUserPromptSubmitInputSchema,
  grokPreToolUseInputSchema,
  grokPostToolUseInputSchema,
  grokPostToolUseFailureInputSchema,
  grokPermissionDeniedInputSchema,
  grokStopInputSchema,
  grokStopFailureInputSchema,
  grokNotificationInputSchema,
  grokSubagentStartInputSchema,
  grokSubagentStopInputSchema,
  grokSubagentEndInputSchema,
  grokPreCompactInputSchema,
  grokPostCompactInputSchema,
  grokSessionEndInputSchema,
]);

/**
 * Validates an unknown value as a Grok hook input envelope.
 *
 * @param input - Value read from a Grok hook's stdin.
 * @returns The validated event-specific hook input.
 * @throws {z.ZodError} When the envelope or payload does not match the wire contract.
 */
export function validateGrokHookInput(input: unknown): GrokHookInput {
  return grokHookInputSchema.parse(input);
}

/**
 * Schema for Grok `pre_tool_use` gate hook output parsed from stdout JSON.
 * Mirrors the upstream GateHookJson struct: `decision` is required, `reason`
 * is optional, and unknown fields are ignored. An unknown decision value is a
 * hard error upstream, so the enum is exhaustive. A blank `reason` validates
 * here but is filtered upstream in favor of the first stderr line or a
 * default `denied by hook '<name>'` message.
 */
export const grokGateOutputSchema = z.looseObject({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
});

/** Schema for the stop-gate hookSpecificOutput payload. */
export const grokStopHookSpecificOutputSchema = z.looseObject({
  additionalContext: z.string().optional(),
});

/**
 * Schema for Grok stop-family (`stop`, `subagent_stop`, `subagent_end`) gate
 * hook output parsed from stdout JSON. Mirrors the upstream StopHookJson
 * struct: every field is optional and one output may combine a block
 * decision, a `continue: false` force-stop, and context injection. Unknown
 * decision values are a hard error upstream. Blank `reason` and
 * `additionalContext` values validate here but are filtered upstream;
 * `stopReason` is kept verbatim.
 */
export const grokStopOutputSchema = z.looseObject({
  decision: z.enum(['block', 'approve']).optional(),
  reason: z.string().optional(),
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  hookSpecificOutput: grokStopHookSpecificOutputSchema.optional(),
});
