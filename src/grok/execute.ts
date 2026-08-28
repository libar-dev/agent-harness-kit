/**
 * Grok hook runner: Grok-native stdin reading, stdout output, and the
 * executeGrokHook entrypoint with Grok exit-code semantics.
 *
 * This module never reads CLAUDE_* configuration. Logging goes to stderr via
 * logError; set GROK_HOOK_DEBUG=true for verbose local debug logging.
 */

import { stdin, stdout, stderr, env, exit } from 'node:process';
import { readBoundedTimedStdin } from '../internal/stdin.js';
import { logError, toError } from '../utils/index.js';
import { validateGrokHookInput } from './validation.js';
import type { GrokHookEventName, GrokHookInput } from './types.js';

const DEFAULT_STDIN_TIMEOUT_MS = 30000;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;

const GROK_STOP_GATE_EVENTS: ReadonlySet<GrokHookEventName> = new Set([
  'stop',
  'subagent_stop',
  'subagent_end',
]);

/**
 * Internal tag for the stdin-timeout rejection. The reader owns timeout
 * termination (one stderr diagnostic, one exit-hook call); the runner
 * recognizes this error and does not log or exit a second time.
 */
class GrokStdinTimeoutError extends Error {
  constructor() {
    super('Timeout waiting for Grok hook stdin input');
    this.name = 'GrokStdinTimeoutError';
  }
}

/**
 * Decision JSON a Grok pre_tool_use gate hook prints on stdout.
 *
 * Upstream honors `deny` regardless of the process exit code and substitutes
 * its own default message when the reason is absent or blank.
 */
export interface GrokGateOutput {
  readonly decision: 'allow' | 'deny';
  readonly reason?: string;
}

/**
 * Outcome JSON a Grok stop-gate hook (stop, subagent_stop, subagent_end)
 * prints on stdout. All fields are optional and one output can combine
 * several signals; upstream ignores a blank reason or additionalContext.
 */
export interface GrokStopHookOutput {
  readonly decision?: 'block' | 'approve';
  readonly reason?: string;
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly hookSpecificOutput?: {
    readonly additionalContext?: string;
  };
}

/** JSON shapes a Grok hook may print on stdout. */
export type GrokHookOutput = GrokGateOutput | GrokStopHookOutput;

/**
 * Injectable seams for the Grok hook runner. Tests pass a canned stdin
 * stream, a recording exit function, and a shortened stdin timeout.
 */
export interface GrokHookRunnerOptions {
  /** Stream to read the hook envelope from. Defaults to process stdin. */
  readonly stdin?: AsyncIterable<Buffer>;
  /**
   * Milliseconds to wait for stdin before logging an error and exiting 1.
   * Defaults to 30 seconds.
   */
  readonly stdinTimeoutMs?: number;
  /** Maximum number of stdin bytes retained before parsing. Defaults to 1 MiB. */
  readonly maxStdinBytes?: number;
  /** Exit hook invoked with the process exit code. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

function isGrokHookDebugEnabled(): boolean {
  return env['GROK_HOOK_DEBUG'] === 'true';
}

function logGrokDebug(message: string, data?: unknown): void {
  if (!isGrokHookDebugEnabled()) {
    return;
  }

  const timestamp = new Date().toISOString();
  let fullMessage = `[${timestamp}] DEBUG: ${message}`;

  if (data !== undefined) {
    fullMessage += '\n' + JSON.stringify(data, null, 2);
  }

  stderr.write(fullMessage + '\n');
}

async function readGrokStdinText(
  options: GrokHookRunnerOptions
): Promise<string> {
  const source = options.stdin ?? (stdin as AsyncIterable<Buffer>);
  const exitFn = options.exit ?? exit;
  const maxBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES;
  const boundedSource = (async function* (): AsyncGenerator<Buffer> {
    let remaining = maxBytes;
    for await (const chunk of source) {
      if (remaining <= 0) {
        break;
      }
      yield chunk.subarray(0, remaining);
      remaining -= chunk.byteLength;
    }
  })();

  return readBoundedTimedStdin({
    stdin: boundedSource,
    maxBytes,
    timeoutMs: options.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS,
    stderr,
    exit: exitFn,
    timeoutMessage: 'Timeout waiting for Grok hook stdin input',
    createTimeoutError: () => new GrokStdinTimeoutError(),
  });
}

/**
 * Read and validate a Grok hook envelope from stdin.
 *
 * @param options - Injectable stdin stream, timeout, and exit hook.
 * @returns The validated event-specific Grok hook input.
 * @throws {Error} When stdin holds malformed JSON or fails envelope validation.
 * On stdin timeout the reader logs the timeout and invokes the exit hook with
 * 1; with an injected exit hook the timeout error then propagates unwrapped.
 */
export async function readGrokStdinJson(
  options: GrokHookRunnerOptions = {}
): Promise<GrokHookInput> {
  try {
    const input = await readGrokStdinText(options);
    const parsed: unknown = JSON.parse(input);
    const validated = validateGrokHookInput(parsed);

    logGrokDebug('Received Grok hook input:', validated);

    return validated;
  } catch (error) {
    if (error instanceof GrokStdinTimeoutError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : 'Unknown parsing error';
    throw new Error(`Failed to parse Grok hook input JSON: ${message}`);
  }
}

/**
 * Write a typed Grok hook output to stdout as pretty-printed JSON.
 *
 * @param output - Gate or stop-gate output in the Grok wire shape.
 */
export function outputGrokJson(output: GrokHookOutput): void {
  const jsonString = JSON.stringify(output, null, 2);

  logGrokDebug('Sending Grok hook output:', output);

  stdout.write(jsonString);
}

/**
 * Run a Grok hook handler with stdin parsing, logging, and Grok exit codes.
 *
 * Exit codes follow the Grok hook contract:
 * - 0: success. Decision JSON the handler printed stands; upstream honors a
 *   `deny` (pre_tool_use) or `block` (stop gates) decision regardless of the
 *   exit code, so a handler that prints a decision and returns normally still
 *   blocks the action.
 * - 2: blocking error from a gate handler. The runner prints
 *   `{decision: 'deny', reason}` for pre_tool_use and
 *   `{decision: 'block', reason}` for stop-gate events (stop, subagent_stop,
 *   subagent_end) with the handler error message as the reason.
 * - 1: non-blocking failure. Grok fails open on hook failures: exit 1 does
 *   NOT block the tool call or the stop; the agent continues as if the hook
 *   had not run. Malformed stdin JSON, envelope validation failures, and
 *   handler errors on observe events take this path. A stdin timeout is
 *   logged and exited (1) by the reader itself, so the runner emits exactly
 *   one diagnostic and one exit-hook call on that path.
 *
 * Observe events (every event except pre_tool_use and the stop gates) ignore
 * stdout decisions upstream, so a handler failure there only logs to stderr
 * and exits 1.
 *
 * @param handler - Hook handler invoked with the validated event input.
 * @param options - Injectable stdin stream, timeout, and exit hook.
 * @returns Resolves after the exit hook has been invoked.
 */
export function executeGrokHook<T extends GrokHookInput = GrokHookInput>(
  handler: (input: T) => Promise<void> | void,
  options?: GrokHookRunnerOptions
): Promise<void>;
export async function executeGrokHook(
  handler: (input: GrokHookInput) => Promise<void> | void,
  options: GrokHookRunnerOptions = {}
): Promise<void> {
  const exitFn = options.exit ?? exit;

  let input: GrokHookInput;
  try {
    input = await readGrokStdinJson(options);
  } catch (error) {
    if (error instanceof GrokStdinTimeoutError) {
      return;
    }
    logError('Grok hook execution failed', toError(error));
    exitFn(1);
    return;
  }

  let handlerError: Error | undefined;
  try {
    await handler(input);
  } catch (error) {
    handlerError = toError(error);
  }

  if (handlerError === undefined) {
    exitFn(0);
    return;
  }

  if (input.hookEventName === 'pre_tool_use') {
    outputGrokJson({ decision: 'deny', reason: handlerError.message });
    exitFn(2);
    return;
  }

  if (GROK_STOP_GATE_EVENTS.has(input.hookEventName)) {
    outputGrokJson({ decision: 'block', reason: handlerError.message });
    exitFn(2);
    return;
  }

  logError('Grok hook execution failed', handlerError);
  exitFn(1);
}
