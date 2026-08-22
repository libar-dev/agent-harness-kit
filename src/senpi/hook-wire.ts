import { z } from 'zod';

import { HOOK_DECISIONS } from './hook-contract.js';
import { type SenpiHookEventName } from './settings.js';

/**
 * Snake_case -> camelCase alias table for hook input envelopes, normalized
 * ONCE at this boundary. Every primary field is a verbatim member of the
 * `HookInputWire` union in the pinned vendored contract
 * (`docs/upstream/senpi/hooks/types.d.ts`, engine 2026.8.19); every alias is
 * the corresponding optional snake_case member the same union declares.
 * Alias values only fill a missing primary - an explicitly present primary
 * always wins.
 */
const SENPI_HOOK_ALIAS_FIELDS = {
  hook_event_name: 'event',
  session_id: 'sessionId',
  tool_name: 'toolName',
  tool_input: 'toolInput',
  tool_response: 'toolOutput',
} as const satisfies Readonly<Record<string, string>>;

/**
 * Copies snake_case alias fields into their missing camelCase primaries on a
 * shallow clone of the input envelope (the caller's object is never
 * mutated). Unknown extra fields pass through untouched; looseObject keeps
 * them on the parsed result.
 */
function normalizeSenpiHookAliases(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const record: Record<string, unknown> = {};
  Object.assign(record, raw);
  for (const [alias, primary] of Object.entries(SENPI_HOOK_ALIAS_FIELDS)) {
    if (record[primary] !== undefined) {
      continue;
    }
    const aliasValue = record[alias];
    if (aliasValue === undefined) {
      continue;
    }
    record[primary] = aliasValue;
  }
  return record;
}

/** A required `unknown` field: accepts any value except `undefined`. */
const senpiRequiredUnknownSchema = z
  .unknown()
  .refine(value => value !== undefined, { message: 'Required' });

/**
 * Schema for senpi SessionStart hook input, copied VERBATIM from the
 * `SessionStart` branch of the vendored `HookInputWire` union
 * (`docs/upstream/senpi/hooks/types.d.ts`). Preserves the known upstream
 * asymmetry: camelCase `sessionId` is REQUIRED here while `session_id`
 * exists only as an optional alias (normalized to `sessionId` by
 * senpiHookInputSchema).
 */
export const senpiSessionStartInputSchema = z.looseObject({
  event: z.literal('SessionStart'),
  sessionId: z.string(),
  cwd: z.string(),
  hook_event_name: z.literal('SessionStart').optional(),
  reason: z.string().optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
});

/**
 * Schema for senpi UserPromptSubmit hook input, copied VERBATIM from the
 * `UserPromptSubmit` branch of the vendored `HookInputWire` union. This is
 * the ONLY branch carrying `permission_mode`.
 */
export const senpiUserPromptSubmitInputSchema = z.looseObject({
  event: z.literal('UserPromptSubmit'),
  prompt: z.string(),
  cwd: z.string(),
  session_id: z.string().optional(),
  permission_mode: z.string().optional(),
  transcript_path: z.string().optional(),
});

/**
 * Schema for senpi PreToolUse hook input, copied VERBATIM from the
 * `PreToolUse` branch of the vendored `HookInputWire` union. `toolInput` is
 * required and may be any JSON value including `null`; `tool_input` exists
 * only as an optional alias.
 */
export const senpiPreToolUseInputSchema = z.looseObject({
  event: z.literal('PreToolUse'),
  toolName: z.string(),
  toolInput: senpiRequiredUnknownSchema,
  cwd: z.string(),
  session_id: z.string().optional(),
  hook_event_name: z.literal('PreToolUse').optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

/**
 * Schema for senpi PostToolUse hook input, copied VERBATIM from the
 * `PostToolUse` branch of the vendored `HookInputWire` union. `toolOutput`
 * is required; the vendored branch has NO `transcript_path` field, and
 * `tool_response` exists only as an optional alias normalized to
 * `toolOutput`.
 */
export const senpiPostToolUseInputSchema = z.looseObject({
  event: z.literal('PostToolUse'),
  toolName: z.string(),
  toolInput: senpiRequiredUnknownSchema,
  toolOutput: senpiRequiredUnknownSchema,
  cwd: z.string(),
  session_id: z.string().optional(),
  hook_event_name: z.literal('PostToolUse').optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

/**
 * Schema for senpi PreCompact hook input, copied VERBATIM from the
 * `PreCompact` branch of the vendored `HookInputWire` union. Unlike
 * `PostCompact`, this branch has NO `accepted` field.
 */
export const senpiPreCompactInputSchema = z.looseObject({
  event: z.literal('PreCompact'),
  reason: z.string(),
  cwd: z.string(),
  custom_instructions: z.string().optional(),
  hook_event_name: z.literal('PreCompact').optional(),
  request_id: z.string().optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  will_retry: z.boolean().optional(),
});

/**
 * Schema for senpi PostCompact hook input, copied VERBATIM from the
 * `PostCompact` branch of the vendored `HookInputWire` union. The optional
 * `accepted` boolean appears ONLY on this branch.
 */
export const senpiPostCompactInputSchema = z.looseObject({
  event: z.literal('PostCompact'),
  reason: z.string(),
  cwd: z.string(),
  accepted: z.boolean().optional(),
  hook_event_name: z.literal('PostCompact').optional(),
  request_id: z.string().optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  will_retry: z.boolean().optional(),
});

/**
 * Schema for senpi Stop hook input, copied VERBATIM from the `Stop` branch
 * of the vendored `HookInputWire` union. Only `cwd` is required;
 * `stopReason` is optional.
 */
export const senpiStopInputSchema = z.looseObject({
  event: z.literal('Stop'),
  stopReason: z.string().optional(),
  cwd: z.string(),
  hook_event_name: z.literal('Stop').optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
});

/** A `z.looseObject` branch of the hook input union, shape-introspectable. */
interface SenpiHookInputBranchSchema {
  readonly shape: Readonly<Record<string, z.ZodType>>;
}

/**
 * Per-event input branch schemas keyed by canonical event name, in the
 * declaration order of the vendored `HookInputWire` union. Field sets are
 * drift-pinned against HOOK_INPUT_BRANCHES (src/senpi/hook-contract.ts).
 */
export const SENPI_HOOK_INPUT_BRANCH_SCHEMAS = {
  SessionStart: senpiSessionStartInputSchema,
  UserPromptSubmit: senpiUserPromptSubmitInputSchema,
  PreToolUse: senpiPreToolUseInputSchema,
  PostToolUse: senpiPostToolUseInputSchema,
  PreCompact: senpiPreCompactInputSchema,
  PostCompact: senpiPostCompactInputSchema,
  Stop: senpiStopInputSchema,
} as const satisfies Record<SenpiHookEventName, SenpiHookInputBranchSchema>;

/**
 * Schema for EVERY senpi hook input envelope accepted on stdin: a 7-event
 * discriminated union whose branches are copied VERBATIM from the vendored
 * `HookInputWire` union (`docs/upstream/senpi/hooks/types.d.ts`) and
 * validated strictly against the HOOK_INPUT_BRANCHES manifest
 * (src/senpi/hook-contract.ts). Snake_case aliases
 * (hook_event_name, session_id, tool_name, tool_input, tool_response) are
 * normalized once at this boundary into their camelCase primaries; unknown
 * extra fields pass through via looseObject.
 */
export const senpiHookInputSchema = z.preprocess(
  normalizeSenpiHookAliases,
  z.discriminatedUnion('event', [
    senpiSessionStartInputSchema,
    senpiUserPromptSubmitInputSchema,
    senpiPreToolUseInputSchema,
    senpiPostToolUseInputSchema,
    senpiPreCompactInputSchema,
    senpiPostCompactInputSchema,
    senpiStopInputSchema,
  ])
);

/** Discriminated union of all seven validated senpi hook inputs. */
export type SenpiHookInput = z.infer<typeof senpiHookInputSchema>;

/**
 * Events whose parsed hook output may carry `systemMessage`, copied
 * verbatim from the SYSTEM_MESSAGE_EVENTS set in the pinned vendored
 * implementation `docs/upstream/senpi/hooks/output-parser.js` (NOT from
 * types.d.ts): PreCompact and PostCompact are gate-out events and the
 * parser drops their `systemMessage` with an `unsupported_field` warning
 * diagnostic.
 */
export const SENPI_HOOK_SYSTEM_MESSAGE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
] as const satisfies readonly SenpiHookEventName[];

/**
 * Whether the vendored output parser honors `systemMessage` for the given
 * event, per SYSTEM_MESSAGE_EVENTS in docs/upstream/senpi/hooks/
 * output-parser.js. Gate-out events (PreCompact, PostCompact) return false.
 *
 * @param event - Canonical senpi hook event name.
 * @returns True when `systemMessage` survives parsing for that event.
 */
export function senpiEventSupportsSystemMessage(
  event: SenpiHookEventName
): boolean {
  return (SENPI_HOOK_SYSTEM_MESSAGE_EVENTS as readonly string[]).includes(
    event
  );
}

/**
 * Schema for senpi hook output parsed from stdout JSON, sourced from the
 * vendored IMPLEMENTATION `docs/upstream/senpi/hooks/output-parser.js`
 * (ParsedHookOutput["output"]) rather than the 6-field HookOutputWire in
 * types.d.ts:
 *
 * - `decision` accepts `"allow"` beyond the .d.ts approve/block/deny/ask
 *   union (HOOK_DECISIONS, src/senpi/hook-contract.ts), because the parser's
 *   preToolUseDecision maps it through verbatim.
 * - Universal parser-level fields `continue`, `stopReason`,
 *   `suppressOutput`, and `systemMessage` are present; whether
 *   `systemMessage` SURVIVES for a given event is gated by
 *   SENPI_HOOK_SYSTEM_MESSAGE_EVENTS / senpiEventSupportsSystemMessage.
 * - `hookSpecificOutput` is consumed per the vendored parser (its inner
 *   fields feed decision/reason/additionalContext/updatedInput/
 *   updatedToolOutput) and never copied into the output object itself, so it
 *   passes through here only as an unknown extra.
 *
 * Unknown extra fields pass through via looseObject.
 */
export const senpiHookOutputSchema = z.looseObject({
  decision: z.enum(HOOK_DECISIONS).optional(),
  reason: z.string().optional(),
  additionalContext: z.string().optional(),
  updatedInput: z.unknown().optional(),
  updatedToolOutput: z.unknown().optional(),
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
});

/** Validated shape of one senpi hook's stdout JSON output. */
export type SenpiHookOutput = z.infer<typeof senpiHookOutputSchema>;

/**
 * Validates an unknown value as a senpi hook input envelope.
 *
 * @param input - Value read from a senpi hook command's stdin.
 * @returns The validated, alias-normalized event-specific hook input.
 * @throws {z.ZodError} When the envelope does not match the vendored
 * `HookInputWire` contract for any of the seven supported events.
 */
export function validateSenpiHookInput(input: unknown): SenpiHookInput {
  return senpiHookInputSchema.parse(input);
}
