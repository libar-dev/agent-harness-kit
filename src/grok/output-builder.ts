/**
 * Builders for hook output JSON written on stdout by Grok hook handlers. Each
 * helper returns a wire-shaped output object without performing I/O.
 *
 * Output authority is the upstream runner contract
 * (docs/upstream/grok/runner-mod.rs): `pre_tool_use` is the only tool gate and
 * parses stdout as GateHookJson (`{decision: "allow" | "deny", reason?}`);
 * `stop`, `subagent_stop`, and `subagent_end` are stop gates and parse stdout
 * as StopHookJson (all fields optional, freely combinable). Every other event
 * is an observe gate whose stdout is ignored, so decisions emitted there have
 * no effect.
 */

import type { z } from 'zod';
import type {
  grokGateOutputSchema,
  grokStopOutputSchema,
} from './validation.js';

/** Grok `pre_tool_use` gate hook output written on stdout. */
export type GrokGateOutput = z.infer<typeof grokGateOutputSchema>;

/** Grok stop-family gate hook output written on stdout. */
export type GrokStopOutput = z.infer<typeof grokStopOutputSchema>;

/** True when a value is a string with non-whitespace content. */
function nonblank(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

export const GrokHookOutputBuilder = {
  /**
   * Build a `pre_tool_use` allow decision.
   *
   * Honored on exit code 0 (and every exit code except 2): upstream gives
   * exit code 2 precedence over a JSON allow, so pair with a clean exit.
   * Ignored on observe-gate events.
   */
  gateAllow: (): GrokGateOutput => ({ decision: 'allow' }),

  /**
   * Build a `pre_tool_use` deny decision with an optional reason.
   *
   * A JSON deny is honored on any exit code. An omitted or blank reason is
   * not serialized; upstream then substitutes the first stderr line, falling
   * back to `denied by hook '<name>'` when stderr is empty.
   */
  gateDeny: (reason?: string): GrokGateOutput => ({
    decision: 'deny',
    ...(nonblank(reason) && { reason }),
  }),

  /**
   * Build a stop-gate block decision with an optional reason.
   *
   * Upstream requires a reason for `decision: "block"`; an omitted or blank
   * reason is not serialized, and upstream substitutes
   * `Blocked by stop hook '<name>'`. Ignored on observe-gate events.
   */
  stopBlock: (reason?: string): GrokStopOutput => ({
    decision: 'block',
    ...(nonblank(reason) && { reason }),
  }),

  /**
   * Build a stop-gate approve decision (an explicit no-op upstream: the
   * stop proceeds and no other signal is sent).
   */
  stopApprove: (): GrokStopOutput => ({ decision: 'approve' }),

  /**
   * Build a force-stop (`continue: false`) with an optional user-visible
   * reason.
   *
   * A force-stop overrides block decisions from other stop hooks. Unlike
   * `reason` and `additionalContext`, upstream applies no nonblank filter to
   * `stopReason`, so a provided value is serialized verbatim.
   */
  stopForce: (stopReason?: string): GrokStopOutput => ({
    continue: false,
    ...(stopReason !== undefined && { stopReason }),
  }),

  /**
   * Build stop-gate context injection.
   *
   * Upstream honors only nonblank `additionalContext` and silently drops
   * blank values; a blank argument is therefore omitted here, returning an
   * empty output that parses to the same empty outcome upstream.
   */
  stopContext: (additionalContext: string): GrokStopOutput =>
    nonblank(additionalContext)
      ? { hookSpecificOutput: { additionalContext } }
      : {},

  /**
   * Build a universal success output.
   *
   * Returns an empty output: the Grok wire contract has no success-message
   * field (neither GateHookJson nor StopHookJson carries one, and the runner
   * ignores unknown JSON fields), so `_message` is accepted for signature
   * parity with the Claude HookOutputBuilder and deliberately not serialized.
   * Write human-facing diagnostics to stderr. Empty JSON leaves the decision
   * to the exit code on tool gates, parses to an empty outcome on stop
   * gates, and is ignored on observe-gate events.
   */
  success: (_message?: string): GrokStopOutput => ({}),

  /**
   * Build a universal error output that force-stops with a user-visible
   * reason.
   *
   * `continue: false` plus `stopReason` is the only user-visible error
   * channel in the Grok wire contract; it takes effect on stop-family gates.
   * On `pre_tool_use` gates these fields are ignored by GateHookJson
   * parsing, so pair with {@link GrokHookOutputBuilder.gateDeny} or exit
   * code 2 to block a tool. Hook process failures themselves fail open
   * upstream: exit 1 logs stderr and lets the agent continue.
   */
  error: (reason: string): GrokStopOutput => ({
    continue: false,
    stopReason: reason,
  }),
};
