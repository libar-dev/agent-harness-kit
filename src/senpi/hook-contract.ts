import type { SenpiHookEventName } from './settings.js';

/**
 * One wire-level field of a HookInputWire branch, copied verbatim from the
 * pinned vendored contract (`docs/upstream/senpi/hooks/types.d.ts`, engine
 * 2026.8.19).
 *
 * `type` carries the exact TypeScript annotation text from the vendored
 * declaration (for example `'string'`, `'boolean'`, `'unknown'`, or the
 * quoted literal `'"SessionStart"'`); `required` is false exactly when the
 * vendored declaration marks the property optional (`?`).
 */
export interface SenpiHookWireField {
  /** Verbatim property name from the vendored branch. */
  readonly name: string;
  /** True when the vendored property is not optional. */
  readonly required: boolean;
  /** Verbatim TypeScript annotation text from the vendored property. */
  readonly type: string;
}

/**
 * Per-event required-field manifests for the seven senpi hook input events,
 * copied VERBATIM (names, optionality, and annotation text, in declaration
 * order) from the `HookInputWire` discriminated union in the pinned vendored
 * artifact `docs/upstream/senpi/hooks/types.d.ts`.
 *
 * Drift-pinned: tests/senpi-upstream-drift.test.ts re-extracts the union
 * mechanically from the vendored file and fails this module if they ever
 * diverge. Known upstream asymmetries are preserved exactly:
 *
 * - `SessionStart` requires camelCase `sessionId`; snake_case `session_id`
 *   exists only as an optional alias.
 * - `permission_mode` appears ONLY on `UserPromptSubmit`.
 * - `PreCompact` has NO `accepted` field (only `PostCompact` does).
 * - `PostToolUse` has NO `transcript_path` field.
 *
 * The discriminator `event` itself is not repeated per field: it IS the map
 * key. Todo 16 implements the wire schemas strictly against this manifest.
 */
export const HOOK_INPUT_BRANCHES = {
  SessionStart: [
    { name: 'sessionId', required: true, type: 'string' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'hook_event_name', required: false, type: '"SessionStart"' },
    { name: 'reason', required: false, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'transcript_path', required: false, type: 'string' },
  ],
  UserPromptSubmit: [
    { name: 'prompt', required: true, type: 'string' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'permission_mode', required: false, type: 'string' },
    { name: 'transcript_path', required: false, type: 'string' },
  ],
  PreToolUse: [
    { name: 'toolName', required: true, type: 'string' },
    { name: 'toolInput', required: true, type: 'unknown' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'hook_event_name', required: false, type: '"PreToolUse"' },
    { name: 'tool_name', required: false, type: 'string' },
    { name: 'tool_input', required: false, type: 'unknown' },
    { name: 'tool_use_id', required: false, type: 'string' },
  ],
  PostToolUse: [
    { name: 'toolName', required: true, type: 'string' },
    { name: 'toolInput', required: true, type: 'unknown' },
    { name: 'toolOutput', required: true, type: 'unknown' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'hook_event_name', required: false, type: '"PostToolUse"' },
    { name: 'tool_name', required: false, type: 'string' },
    { name: 'tool_input', required: false, type: 'unknown' },
    { name: 'tool_response', required: false, type: 'unknown' },
    { name: 'tool_use_id', required: false, type: 'string' },
  ],
  PreCompact: [
    { name: 'reason', required: true, type: 'string' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'custom_instructions', required: false, type: 'string' },
    { name: 'hook_event_name', required: false, type: '"PreCompact"' },
    { name: 'request_id', required: false, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'transcript_path', required: false, type: 'string' },
    { name: 'will_retry', required: false, type: 'boolean' },
  ],
  PostCompact: [
    { name: 'reason', required: true, type: 'string' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'accepted', required: false, type: 'boolean' },
    { name: 'hook_event_name', required: false, type: '"PostCompact"' },
    { name: 'request_id', required: false, type: 'string' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'transcript_path', required: false, type: 'string' },
    { name: 'will_retry', required: false, type: 'boolean' },
  ],
  Stop: [
    { name: 'stopReason', required: false, type: 'string' },
    { name: 'cwd', required: true, type: 'string' },
    { name: 'hook_event_name', required: false, type: '"Stop"' },
    { name: 'session_id', required: false, type: 'string' },
    { name: 'transcript_path', required: false, type: 'string' },
  ],
} as const satisfies Readonly<
  Record<SenpiHookEventName, readonly SenpiHookWireField[]>
>;

/**
 * Decision vocabulary for parsed hook output, copied verbatim from the
 * pinned vendored artifacts: `"approve" | "block" | "deny" | "ask"` from
 * `docs/upstream/senpi/hooks/types.d.ts` (`HookOutputWire.decision`) plus
 * `"allow"`, which the vendored output parser accepts beyond the .d.ts
 * union. Drift-pinned to those vendored files; consumed by todo 16's wire
 * schema.
 */
export const HOOK_DECISIONS = [
  'approve',
  'block',
  'deny',
  'ask',
  'allow',
] as const;
