/**
 * Senpi hook command runner: bounded stdin reading, stdout output, and the
 * executeSenpiHook entrypoint with senpi exit semantics.
 *
 * SEMANTIC AUTHORITY: the pinned vendored engine implementation
 * `docs/upstream/senpi/hooks/output-parser.js` (engine 2026.8.19) - the
 * SYSTEM_MESSAGE_EVENTS gating, the exit-code-2 rule, the "allow" permission
 * decision handling, and the hookSpecificOutput behavior are transcribed
 * from that file exactly. The command/platform selection mirrors the
 * vendored `selectCommandForPlatform` (`docs/upstream/senpi/hooks/
 * command-runner.d.ts`).
 *
 * CONSUMER-VISIBLE EXIT CONTRACT of executeSenpiHook:
 * - 0: the handler command ran. Its parsed output JSON is written to stdout;
 *   a blocking outcome rides in that JSON (`decision: "block"` / `"deny"`).
 *   A malformed or non-object child stdout produces an `invalid_root`
 *   diagnostic on stderr and an empty `{}` output - still exit 0.
 *   A child exit code of 2 produces `{decision: "block", reason:
 *   <trimmed-child-stderr>}` - still exit 0.
 * - 1: failure before the child could be judged: stdin timeout, malformed
 *   or schema-invalid stdin envelope, or a spawn/run error. Logged to
 *   stderr; nothing is written to stdout.
 *
 * This module never reads CLAUDE_* configuration env vars, never imports
 * from the grok or Claude adapter modules, and never touches hook trust
 * state.
 */

import { spawn } from 'node:child_process';
import {
  exit,
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from 'node:process';

import {
  senpiEventSupportsSystemMessage,
  validateSenpiHookInput,
  type SenpiHookInput,
} from './hook-wire.js';
import type {
  SenpiCommandHookConfig,
  SenpiHookDiagnostic,
  SenpiHookDiagnosticCode,
  SenpiHookEventName,
} from './settings.js';

/** Milliseconds to wait for the hook envelope on stdin. Mirrors grok's 30s cap. */
const DEFAULT_STDIN_TIMEOUT_MS = 30000;

/**
 * Byte cap for the stdin envelope read. Hook envelopes are small JSON
 * documents; anything at or beyond this cap stops the read immediately so a
 * hostile or buggy upstream can never make the runner hang or balloon
 * memory.
 */
const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;

/**
 * Per-stream byte cap for captured child stdout/stderr. Mirrors the vendored
 * `DEFAULT_STDOUT_LIMIT_BYTES` / `DEFAULT_STDERR_LIMIT_BYTES` (64 KiB each)
 * in `docs/upstream/senpi/hooks/output-bounds.js`.
 */
const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Default child-process timeout in seconds. Mirrors the vendored
 * `DEFAULT_HOOK_TIMEOUT_SECONDS` in `docs/upstream/senpi/hooks/safety.d.ts`.
 */
const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

/**
 * Internal tag for the stdin-timeout rejection. The reader owns timeout
 * termination (one stderr log, one exit-hook call); the runner recognizes
 * this error and does not log or exit a second time.
 */
class SenpiStdinTimeoutError extends Error {
  constructor() {
    super('Timeout waiting for Senpi hook stdin input');
    this.name = 'SenpiStdinTimeoutError';
  }
}

/**
 * Minimal writable sink for runner output. `process.stdout`,
 * `process.stderr`, and test recorders all satisfy this structurally.
 */
export interface SenpiTextSink {
  /** Writes one chunk of text. May return anything (or nothing). */
  readonly write: (text: string) => unknown;
}

/**
 * The parts of a validated executable handler the runner needs: the event
 * being dispatched and the command config to run. A full
 * `SenpiExecutableHookHandler` satisfies this structurally.
 */
export interface SenpiHookRunnerTarget {
  /** Canonical senpi hook event this handler is registered for. */
  readonly event: SenpiHookEventName;
  /** Command configuration; `commandWindows` overrides on win32. */
  readonly config: SenpiCommandHookConfig;
}

/** Captured result of one handler-command execution. */
export interface SenpiCommandRunResult {
  /** Raw stdout of the child process (possibly truncated at the byte cap). */
  readonly stdout: string;
  /** Raw stderr of the child process (possibly truncated at the byte cap). */
  readonly stderr: string;
  /**
   * Child exit code. A signal-terminated child (including timeout kill) has
   * a null exit code, mapped to 1 here.
   */
  readonly exitCode: number;
}

/**
 * Injectable command execution seam. The default implementation spawns the
 * selected command through a shell; tests inject canned results instead of
 * real processes.
 */
export type SenpiCommandRunner = (
  command: string,
  input: SenpiHookInput,
  target: SenpiHookRunnerTarget
) => Promise<SenpiCommandRunResult>;

/** Injectable seams shared by the stdin reader and the full runner. */
export interface SenpiStdinReadOptions {
  /** Stream to read the hook envelope from. Defaults to process stdin. */
  readonly stdin?: AsyncIterable<Buffer>;
  /** Exit hook invoked with the process exit code. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
  /** Sink receiving error logs (timeout). Defaults to process stderr. */
  readonly stderr?: SenpiTextSink;
  /**
   * Milliseconds to wait for stdin before logging an error and exiting 1.
   * Defaults to 30000 (mirroring grok's cap semantics).
   */
  readonly stdinTimeoutMs?: number;
  /**
   * Byte cap for the envelope read. Defaults to 1 MiB. See
   * {@link readSenpiStdinJson} for the truncation policy.
   */
  readonly maxStdinBytes?: number;
}

/** Injectable seams for the full senpi hook runner. */
export interface SenpiHookRunnerOptions extends SenpiStdinReadOptions {
  /** Sink receiving the final output JSON. Defaults to process stdout. */
  readonly stdout?: SenpiTextSink;
  /** Sink receiving diagnostics and error logs. Defaults to process stderr. */
  readonly stderr?: SenpiTextSink;
  /**
   * Injected platform used to select `commandWindows` over `command`.
   * Defaults to `process.platform`; tests pass 'win32' explicitly.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Injectable command execution seam. When provided, the runner never
   * spawns a real process; it awaits this function with the platform-selected
   * command string.
   */
  readonly runCommand?: SenpiCommandRunner;
}

/**
 * Select the command string for the given platform.
 *
 * On win32, `commandWindows` is used when present; every other platform -
 * including the supported POSIX matrix - runs `command`. Mirrors the
 * vendored `selectCommandForPlatform` behavior restricted to command hooks.
 *
 * @param target - Event plus command configuration of the handler.
 * @param platform - Platform selecting between the two command variants.
 * @returns The command string to execute.
 */
function selectSenpiCommand(
  target: SenpiHookRunnerTarget,
  platform: NodeJS.Platform
): string {
  if (platform === 'win32' && target.config.commandWindows !== undefined) {
    return target.config.commandWindows;
  }
  return target.config.command;
}

/**
 * Read and validate a senpi hook envelope from stdin.
 *
 * Bounded-read policy: the read terminates after {@link SenpiStdinReadOptions.stdinTimeoutMs}
 * milliseconds (timeout path logs one error and invokes the exit hook with 1),
 * and once {@link SenpiStdinReadOptions.maxStdinBytes} bytes have accumulated
 * the reader STOPS CONSUMING input - any remaining bytes are discarded
 * unread, so an oversized stream can never hang the runner. The retained
 * prefix is decoded as UTF-8 (a multi-byte character split at the boundary
 * decodes to replacement characters); truncated text then fails JSON parsing
 * below, which surfaces as the ordinary validation-failure exit 1.
 *
 * @param options - Injectable stdin stream, timeout, byte cap, and exit hook.
 * @returns The validated, alias-normalized event-specific hook input.
 * @throws {Error} When stdin holds malformed JSON or fails envelope
 * validation (message prefixed `Failed to parse Senpi hook input JSON`).
 * On stdin timeout the reader logs the timeout and invokes the exit hook
 * with 1; with an injected exit hook the timeout error then propagates
 * unwrapped.
 */
export async function readSenpiStdinJson(
  options: SenpiStdinReadOptions = {}
): Promise<SenpiHookInput> {
  try {
    const input = await readSenpiStdinText(options);
    const parsed: unknown = JSON.parse(input);
    return validateSenpiHookInput(parsed);
  } catch (error) {
    if (error instanceof SenpiStdinTimeoutError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : 'Unknown parsing error';
    throw new Error(`Failed to parse Senpi hook input JSON: ${message}`);
  }
}

async function readSenpiStdinText(
  options: SenpiStdinReadOptions
): Promise<string> {
  const source = options.stdin ?? (processStdin as AsyncIterable<Buffer>);
  const exitFn = options.exit ?? exit;
  const maxBytes = options.maxStdinBytes ?? DEFAULT_STDIN_MAX_BYTES;
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  let rejectOnTimeout: ((error: Error) => void) | undefined;
  const stderrSink = options.stderr ?? processStderr;
  const timeout = setTimeout(() => {
    stderrSink.write(
      `[${new Date().toISOString()}] ERROR: Timeout waiting for Senpi hook stdin input\n`
    );
    exitFn(1);
    rejectOnTimeout?.(new SenpiStdinTimeoutError());
  }, options.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS);

  try {
    await Promise.race([
      (async () => {
        // Truncation policy: stop consuming as soon as the byte cap is
        // reached. Whatever the source still holds is abandoned unread.
        for await (const chunk of source) {
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
          if (totalBytes >= maxBytes) {
            break;
          }
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        rejectOnTimeout = reject;
      }),
    ]);

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write a parsed senpi hook output to stdout as pretty-printed JSON.
 *
 * @param output - Parsed hook output fields (see
 * `docs/upstream/senpi/hooks/output-parser.js`, `ParsedHookOutput["output"]`).
 * @param sink - Injectable output sink; defaults to process stdout.
 */
export function outputSenpiJson(
  output: Readonly<Record<string, unknown>>,
  sink: SenpiTextSink = processStdout
): void {
  sink.write(`${JSON.stringify(output, null, 2)}\n`);
}

interface ParseState {
  readonly event: SenpiHookEventName;
  readonly output: Record<string, unknown>;
  readonly diagnostics: SenpiHookDiagnostic[];
}

/**
 * Outcome of inspecting `hookSpecificOutput`: the record itself, `undefined`
 * when absent, or a sentinel when the field is invalid or names another
 * event (universals already collected survive those sentinels, exactly like
 * the vendored parser's early `parsedOutput(state)` returns).
 */
type SpecificResult =
  | Record<string, unknown>
  | undefined
  | 'invalid'
  | 'mismatched';

/**
 * Parse one handler-command result into consumer-visible output fields,
 * transcribed line-for-line from the vendored
 * `docs/upstream/senpi/hooks/output-parser.js`:
 *
 * - Exit code 2 short-circuits to `{decision: "block"}` with the trimmed
 *   stderr as `reason` (omitted when blank); stdout is ignored.
 * - Otherwise stdout must be a JSON object; anything else yields only the
 *   `invalid_root` diagnostic and an empty output (no-op).
 * - Universal fields `continue` / `stopReason` / `suppressOutput` /
 *   `systemMessage` are copied, with `systemMessage` gated to the vendored
 *   five-event SYSTEM_MESSAGE_EVENTS set (PreCompact and PostCompact drop
 *   it with an `unsupported_field` warning). `continue: false` on Stop
 *   implies `decision: "block"`.
 * - `hookSpecificOutput` feeds per-event decision/reason/context/input
 *   handling; a non-object or mismatched `hookEventName` discards only the
 *   specific-derived fields while keeping the universals.
 *
 * @param event - Canonical event the handler ran for.
 * @param exitCode - Exit code of the handler command.
 * @param stdoutText - Raw stdout of the handler command.
 * @param stderrText - Raw stderr of the handler command.
 * @param diagnostics - Array the parser appends typed findings to.
 * @returns The consumer-visible output fields (possibly empty).
 */
function parseSenpiHookOutputFields(
  event: SenpiHookEventName,
  exitCode: number,
  stdoutText: string,
  stderrText: string,
  diagnostics: SenpiHookDiagnostic[]
): Record<string, unknown> {
  const trimmedStderr = textOf(stderrText);
  if (exitCode === 2) {
    return trimmedStderr === undefined
      ? { decision: 'block' }
      : { decision: 'block', reason: trimmedStderr };
  }

  const state: ParseState = { event, output: {}, diagnostics };
  const stdout = stdoutText.trim();
  if (stdout.length === 0) {
    return state.output;
  }

  let parsed: Record<string, unknown> | undefined;
  try {
    const candidate: unknown = JSON.parse(stdout);
    if (isRecord(candidate)) {
      parsed = candidate;
    } else {
      addDiagnostic(
        state,
        'invalid_root',
        'stdout',
        'Hook stdout JSON must be an object.'
      );
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    addDiagnostic(
      state,
      'invalid_root',
      'stdout',
      'Hook stdout must be valid JSON.'
    );
  }
  if (parsed === undefined) {
    return state.output;
  }

  parseUniversal(parsed, state);
  const specific = parseSpecific(parsed['hookSpecificOutput'], state);
  if (specific === 'mismatched' || specific === 'invalid') {
    return state.output;
  }
  parseEvent(parsed, specific, state);
  return state.output;
}

function parseUniversal(
  parsed: Record<string, unknown>,
  state: ParseState
): void {
  const continueValue = parsed['continue'];
  if (typeof continueValue === 'boolean') {
    state.output['continue'] = continueValue;
    if (state.event === 'Stop' && continueValue === false) {
      state.output['decision'] = 'block';
    }
  }
  copyText(parsed['stopReason'], 'stopReason', state);
  const suppressOutput = parsed['suppressOutput'];
  if (typeof suppressOutput === 'boolean') {
    state.output['suppressOutput'] = suppressOutput;
  }
  const systemMessage = parsed['systemMessage'];
  if (systemMessage === undefined) {
    return;
  }
  if (senpiEventSupportsSystemMessage(state.event)) {
    copyText(systemMessage, 'systemMessage', state);
    return;
  }
  addDiagnostic(
    state,
    'unsupported_field',
    'stdout.systemMessage',
    'Hook systemMessage is not supported for this event.',
    'warning'
  );
}

function parseSpecific(value: unknown, state: ParseState): SpecificResult {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    addDiagnostic(
      state,
      'invalid_event_config',
      'stdout.hookSpecificOutput',
      'Hook hookSpecificOutput field must be an object.'
    );
    return 'invalid';
  }
  const eventName = value['hookEventName'];
  if (eventName === undefined || eventName === state.event) {
    return value;
  }
  addDiagnostic(
    state,
    'invalid_event_config',
    'stdout.hookSpecificOutput.hookEventName',
    `Hook output event ${String(eventName)} does not match ${state.event}.`
  );
  return 'mismatched';
}

function parseEvent(
  parsed: Record<string, unknown>,
  specific: SpecificResult,
  state: ParseState
): void {
  switch (state.event) {
    case 'PreToolUse':
      parsePreToolUse(parsed, specific, state);
      return;
    case 'PostToolUse':
      blockOnlyDecision(parsed['decision'], 'PostToolUse', state);
      copyText(parsed['reason'], 'reason', state);
      copyText(
        fieldFrom(specific, 'additionalContext') ?? parsed['additionalContext'],
        'additionalContext',
        state
      );
      copyUnknown(
        fieldFrom(specific, 'updatedToolOutput') ?? parsed['updatedToolOutput'],
        'updatedToolOutput',
        state
      );
      return;
    case 'UserPromptSubmit':
      blockOnlyDecision(parsed['decision'], 'UserPromptSubmit', state);
      copyText(parsed['reason'], 'reason', state);
      copyText(
        fieldFrom(specific, 'additionalContext') ?? parsed['additionalContext'],
        'additionalContext',
        state
      );
      rejectPromptReplacement(specific, state);
      return;
    case 'Stop':
      {
        const decision = parsed['decision'];
        if (decision === 'block') {
          state.output['decision'] = 'block';
        } else if (decision !== undefined && decision !== 'continue') {
          addDiagnostic(
            state,
            'unsupported_field',
            'stdout.decision',
            'Stop only supports decision block or continue.',
            'warning'
          );
        }
        copyText(parsed['reason'], 'reason', state);
        copyText(
          fieldFrom(specific, 'additionalContext') ??
            parsed['additionalContext'],
          'additionalContext',
          state
        );
      }
      return;
    case 'SessionStart':
      copyText(
        fieldFrom(specific, 'additionalContext') ?? parsed['additionalContext'],
        'additionalContext',
        state
      );
      if (parsed['decision'] !== undefined) {
        addDiagnostic(
          state,
          'unsupported_field',
          'stdout.decision',
          'SessionStart does not support decisions.',
          'warning'
        );
      }
      return;
    case 'PreCompact':
    case 'PostCompact':
      return;
  }
}

function parsePreToolUse(
  parsed: Record<string, unknown>,
  specific: SpecificResult,
  state: ParseState
): void {
  const rawDecision =
    fieldFrom(specific, 'permissionDecision') ?? parsed['decision'];
  const decision = preToolUseDecision(rawDecision);
  if (decision !== undefined) {
    state.output['decision'] = decision;
  }
  copyText(
    fieldFrom(specific, 'permissionDecisionReason') ?? parsed['reason'],
    'reason',
    state
  );
  copyText(
    fieldFrom(specific, 'additionalContext') ?? parsed['additionalContext'],
    'additionalContext',
    state
  );
  const updatedInput =
    fieldFrom(specific, 'updatedInput') ?? parsed['updatedInput'];
  if (updatedInput === undefined) {
    return;
  }
  if (fieldFrom(specific, 'permissionDecision') === 'allow') {
    state.output['updatedInput'] = updatedInput;
    return;
  }
  addDiagnostic(
    state,
    'unsupported_field',
    'stdout.hookSpecificOutput.updatedInput',
    'PreToolUse updatedInput is only applied when permissionDecision is allow.',
    'warning'
  );
}

function blockOnlyDecision(
  value: unknown,
  event: SenpiHookEventName,
  state: ParseState
): void {
  if (value === 'block') {
    state.output['decision'] = 'block';
  } else if (value !== undefined) {
    addDiagnostic(
      state,
      'unsupported_field',
      'stdout.decision',
      `${event} only supports decision block.`,
      'warning'
    );
  }
}

function rejectPromptReplacement(
  specific: SpecificResult,
  state: ParseState
): void {
  for (const field of ['prompt', 'updatedPrompt', 'replacementPrompt']) {
    if (
      specific !== undefined &&
      typeof specific !== 'string' &&
      Object.hasOwn(specific, field)
    ) {
      addDiagnostic(
        state,
        'unsupported_field',
        `stdout.hookSpecificOutput.${field}`,
        'UserPromptSubmit prompt replacement is not supported.',
        'warning'
      );
    }
  }
}

/**
 * Map a PreToolUse decision to its consumer-visible form, verbatim from the
 * vendored `preToolUseDecision`: `allow` passes through beyond the .d.ts
 * union, `deny`/`block` both collapse to `deny`, everything else is absent.
 */
function preToolUseDecision(
  value: unknown
): 'allow' | 'approve' | 'ask' | 'deny' | undefined {
  if (value === 'allow' || value === 'approve' || value === 'ask') {
    return value;
  }
  if (value === 'deny' || value === 'block') {
    return 'deny';
  }
  return undefined;
}

/** Reads one named field off a present hookSpecificOutput record. */
function fieldFrom(specific: SpecificResult, field: string): unknown {
  if (specific === undefined || typeof specific === 'string') {
    return undefined;
  }
  return specific[field];
}

function copyText(value: unknown, field: string, state: ParseState): void {
  const normalized = textOf(value);
  if (normalized !== undefined) {
    state.output[field] = normalized;
  }
}

function copyUnknown(value: unknown, field: string, state: ParseState): void {
  if (value !== undefined) {
    state.output[field] = value;
  }
}

function addDiagnostic(
  state: ParseState,
  code: SenpiHookDiagnosticCode,
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error'
): void {
  state.diagnostics.push({
    code,
    severity,
    message,
    path,
    event: state.event,
  });
}

/** Best-effort message of an unknown thrown value for stderr logs. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Non-array, non-null object check, verbatim from the vendored parser. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default command execution seam: spawns the selected command through a
 * shell, pipes the validated envelope into its stdin, and captures up to
 * 64 KiB per stream (vendored output-bounds parity; bytes past the cap are
 * discarded). The child is SIGTERM-killed after the handler `timeout`
 * seconds (vendored default 600s). A signal-terminated child resolves with
 * exit code 1.
 */
function defaultRunCommand(
  command: string,
  input: SenpiHookInput,
  target: SenpiHookRunnerTarget
): Promise<SenpiCommandRunResult> {
  return new Promise<SenpiCommandRunResult>((resolve, reject) => {
    const child = spawn(command, { shell: true });
    const limit = DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    const timer = setTimeout(
      () => {
        child.kill('SIGTERM');
      },
      (target.config.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= limit) {
        return;
      }
      outChunks.push(chunk.subarray(0, limit - outBytes));
      outBytes += chunk.byteLength;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= limit) {
        return;
      }
      errChunks.push(chunk.subarray(0, limit - errBytes));
      errBytes += chunk.byteLength;
    });
    // EPIPE on the child's stdin when it exits early is harmless here.
    child.stdin?.on('error', () => {});
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Run one senpi command hook end to end: read and validate the envelope
 * from stdin, spawn (or invoke via the injected seam) the platform-selected
 * handler command, judge its result per the vendored
 * `docs/upstream/senpi/hooks/output-parser.js`, write the resulting JSON to
 * stdout, and exit.
 *
 * Consumer-visible exit contract:
 * - 0: the command ran; its parsed output JSON was written to stdout
 *   (blocking outcomes ride inside that JSON; see
 *   {@link parseSenpiHookOutputFields} for the exact field semantics,
 *   including the exit-code-2 block rule and malformed-stdout no-op).
 * - 1: stdin timeout, malformed or schema-invalid envelope, or a failed
 *   command spawn - logged to stderr, nothing on stdout.
 *
 * Diagnostics produced by output parsing (for example `invalid_root`,
 * `unsupported_field`) are written to stderr as `[senpi-hook]` lines and do
 * NOT change the exit code.
 *
 * Never reads CLAUDE_* env vars, never imports grok/claude modules, never
 * touches hook trust state.
 *
 * @param handler - Event plus command config of the handler to run; on
 * win32 the injected-or-default platform selects `commandWindows` when
 * present (POSIX is the tested path).
 * @param options - Injectable stdin/stdout/stderr/exit/platform seams plus
 * the `runCommand` seam that replaces real process spawning in tests.
 * @returns Resolves after the exit hook has been invoked.
 */
export async function executeSenpiHook(
  handler: SenpiHookRunnerTarget,
  options: SenpiHookRunnerOptions = {}
): Promise<void> {
  const exitFn = options.exit ?? exit;
  const stderrSink = options.stderr ?? processStderr;

  let input: SenpiHookInput;
  try {
    input = await readSenpiStdinJson(options);
  } catch (error) {
    if (error instanceof SenpiStdinTimeoutError) {
      return;
    }
    stderrSink.write(
      `[${new Date().toISOString()}] ERROR: Failed to parse Senpi hook input JSON\n${toErrorMessage(error)}\n`
    );
    exitFn(1);
    return;
  }

  const command = selectSenpiCommand(
    handler,
    options.platform ?? process.platform
  );
  let run: SenpiCommandRunResult;
  try {
    run =
      options.runCommand !== undefined
        ? await options.runCommand(command, input, handler)
        : await defaultRunCommand(command, input, handler);
  } catch (error) {
    stderrSink.write(
      `[${new Date().toISOString()}] ERROR: Senpi hook command failed to run\n${toErrorMessage(error)}\n`
    );
    exitFn(1);
    return;
  }

  const diagnostics: SenpiHookDiagnostic[] = [];
  const output = parseSenpiHookOutputFields(
    input.event,
    run.exitCode,
    run.stdout,
    run.stderr,
    diagnostics
  );
  for (const diagnostic of diagnostics) {
    stderrSink.write(
      `[senpi-hook] ${diagnostic.severity} ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}\n`
    );
  }
  outputSenpiJson(output, options.stdout ?? processStdout);
  exitFn(0);
}
