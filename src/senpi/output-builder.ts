/**
 * Builders for hook output JSON written on stdout by senpi hook handlers.
 * Each helper returns a schema-valid wire object without performing I/O.
 *
 * Output authority is the vendored parser
 * (`docs/upstream/senpi/hooks/output-parser.js`, engine 2026.8.19), not the
 * 6-field `HookOutputWire` in types.d.ts. Parsed fields are those on
 * `senpiHookOutputSchema`. Text fields (`reason`, `additionalContext`,
 * `stopReason`, `systemMessage`) are subject to the parser's `text()` rule:
 * non-strings and blank/whitespace-only strings are dropped (no default
 * reason is substituted). Event-specific gates (systemMessage, updatedInput,
 * updatedToolOutput, decision remapping) are documented on the factories
 * that emit those fields.
 */

import type { SenpiHookOutput } from './hook-wire.js';

/**
 * True when a value is a string with non-whitespace content.
 *
 * Matches the vendored parser `text()` helper: non-strings (including
 * `null`/`undefined`) and blank strings become absent fields.
 *
 * @param value - Candidate text field.
 * @returns True when `value` should be serialized.
 */
function nonblank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Pure factories for senpi hook stdout JSON.
 *
 * Every method returns an object that passes `senpiHookOutputSchema`.
 * Callers write the result to stdout; this module never reads or writes.
 */
export const SenpiHookOutputBuilder = {
  /**
   * Build an `approve` decision.
   *
   * Honored on PreToolUse (`preToolUseDecision` passes `approve` through
   * verbatim). Other events either ignore decisions (SessionStart) or only
   * accept `block` (PostToolUse, UserPromptSubmit, Stop). Pair with a clean
   * exit; exit code 2 is rewritten to `{ decision: "block", reason?: stderr }`
   * and takes precedence over stdout JSON.
   *
   * @returns Schema-valid output `{ decision: "approve" }`.
   */
  approve: (): SenpiHookOutput => ({ decision: 'approve' }),

  /**
   * Build a `block` decision with an optional reason.
   *
   * Honored as `block` on PostToolUse, UserPromptSubmit, and Stop. On
   * PreToolUse the parser remaps `block` to `deny`. An omitted, non-string,
   * or blank reason is not serialized: the parser's `text()` helper drops
   * it, and no default reason string is substituted (exit 2 similarly omits
   * `reason` when stderr is empty).
   *
   * @param reason - Optional user-visible block reason.
   * @returns Schema-valid output with `decision: "block"` and a reason only
   * when `reason` is nonblank.
   */
  block: (reason?: string): SenpiHookOutput => ({
    decision: 'block',
    ...(nonblank(reason) && { reason }),
  }),

  /**
   * Build a `deny` decision with an optional reason.
   *
   * Honored on PreToolUse (`preToolUseDecision` passes `deny` through). On
   * PostToolUse / UserPromptSubmit a non-`block` decision is dropped with an
   * `unsupported_field` warning. An omitted, non-string, or blank reason is
   * not serialized: the parser's `text()` helper drops empty deny reasons
   * and does not fall back to a default message (the same rule as exit-2
   * stderr: empty stderr yields `{ decision: "block" }` with no `reason`).
   *
   * @param reason - Optional user-visible deny reason.
   * @returns Schema-valid output with `decision: "deny"` and a reason only
   * when `reason` is nonblank.
   */
  deny: (reason?: string): SenpiHookOutput => ({
    decision: 'deny',
    ...(nonblank(reason) && { reason }),
  }),

  /**
   * Build an `ask` decision with an optional reason.
   *
   * Honored on PreToolUse (`preToolUseDecision` passes `ask` through).
   * Other events treat non-`block` decisions as unsupported. Blank reasons
   * are omitted per the parser `text()` rule.
   *
   * @param reason - Optional user-visible ask reason.
   * @returns Schema-valid output with `decision: "ask"` and a reason only
   * when `reason` is nonblank.
   */
  ask: (reason?: string): SenpiHookOutput => ({
    decision: 'ask',
    ...(nonblank(reason) && { reason }),
  }),

  /**
   * Build additional context injection.
   *
   * The parser copies `additionalContext` (or the same field nested under
   * `hookSpecificOutput`) on PreToolUse, PostToolUse, UserPromptSubmit,
   * SessionStart, and Stop. Blank values are dropped by `text()`. Compact
   * events ignore this field.
   *
   * @param additionalContext - Context text to inject.
   * @returns `{ additionalContext }` when nonblank; otherwise `{}` (the
   * same empty outcome the parser produces for blank input).
   */
  context: (additionalContext: string): SenpiHookOutput =>
    nonblank(additionalContext) ? { additionalContext } : {},

  /**
   * Build a PreToolUse tool-input replacement.
   *
   * The parser applies `updatedInput` only on PreToolUse and only when the
   * permission decision is `allow` (`permissionDecision === "allow"`);
   * otherwise it emits an `unsupported_field` warning and drops the
   * replacement. Pair with a separate allow/approve decision if the
   * replacement must take effect. `undefined` is omitted (parser
   * `copyUnknown`); every other JSON value, including `null`, is kept.
   *
   * @param input - Replacement tool input payload.
   * @returns `{ updatedInput }` when `input` is not `undefined`; otherwise
   * `{}`.
   */
  updatedInput: (input: unknown): SenpiHookOutput =>
    input === undefined ? {} : { updatedInput: input },

  /**
   * Build a PostToolUse tool-output replacement.
   *
   * The parser copies `updatedToolOutput` only on PostToolUse. Other events
   * ignore it. `undefined` is omitted (parser `copyUnknown`); every other
   * JSON value, including `null`, is kept.
   *
   * @param output - Replacement tool output payload.
   * @returns `{ updatedToolOutput }` when `output` is not `undefined`;
   * otherwise `{}`.
   */
  updatedToolOutput: (output: unknown): SenpiHookOutput =>
    output === undefined ? {} : { updatedToolOutput: output },

  /**
   * Build a force-stop (`continue: false`) with an optional stop reason.
   *
   * The parser always copies `continue` and `stopReason`. On Stop,
   * `continue: false` also sets `decision: "block"`. Blank `stopReason` is
   * omitted per the parser `text()` rule (unlike Grok, senpi does filter
   * this field).
   *
   * @param stopReason - Optional user-visible stop reason.
   * @returns `{ continue: false }` plus `stopReason` when nonblank.
   */
  forceStop: (stopReason?: string): SenpiHookOutput => ({
    continue: false,
    ...(nonblank(stopReason) && { stopReason }),
  }),

  /**
   * Build a `systemMessage` payload.
   *
   * Event-gated: the parser honors `systemMessage` only for
   * PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, and Stop
   * (`SYSTEM_MESSAGE_EVENTS` in the vendored output-parser). On PreCompact
   * and PostCompact the field is dropped with an `unsupported_field`
   * warning. Blank text is omitted per `text()`.
   *
   * @param text - User-visible system message.
   * @returns `{ systemMessage }` when nonblank; otherwise `{}`.
   */
  systemMessage: (text: string): SenpiHookOutput =>
    nonblank(text) ? { systemMessage: text } : {},

  /**
   * Build a universal success output.
   *
   * Returns an empty object: the senpi parsed-output contract has no
   * success-message field, so `message` is accepted for signature parity
   * and deliberately not serialized. Write human-facing diagnostics to
   * stderr or use {@link SenpiHookOutputBuilder.systemMessage}. Empty JSON
   * leaves the decision to the exit code.
   *
   * @param _message - Ignored; not present on the senpi wire.
   * @returns Empty schema-valid output `{}`.
   */
  success: (_message?: string): SenpiHookOutput => ({}),

  /**
   * Build a universal error output that force-stops with a user-visible
   * reason.
   *
   * Emits `continue: false` plus `stopReason` when `reason` is nonblank.
   * On Stop the parser also sets `decision: "block"`. A blank reason still
   * force-stops but omits `stopReason` (parser `text()` rule). Pair with
   * {@link SenpiHookOutputBuilder.block} or {@link SenpiHookOutputBuilder.deny}
   * when a tool-gate decision is required; `continue`/`stopReason` alone
   * do not remap PreToolUse permissions.
   *
   * @param reason - User-visible error reason, copied to `stopReason`.
   * @returns `{ continue: false }` plus `stopReason` when nonblank.
   */
  error: (reason: string): SenpiHookOutput => ({
    continue: false,
    ...(nonblank(reason) && { stopReason: reason }),
  }),
};
