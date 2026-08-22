import { z } from 'zod';

/**
 * The exactly-seven hook events senpi configuration accepts, copied verbatim
 * from the pinned vendored contract (`docs/upstream/senpi/hooks/types.d.ts`,
 * `SUPPORTED_HOOK_EVENTS`, engine 2026.8.19).
 *
 * Configuration keys are matched against these canonical PascalCase names
 * only. Unlike Grok, there are no snake_case or camelCase aliases: any other
 * spelling is rejected as an unknown event.
 */
export const SENPI_HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

/**
 * Event names that exist upstream but are not supported by this kit, copied
 * verbatim from `UNSUPPORTED_KNOWN_HOOK_EVENTS` in the pinned vendored
 * contract. Keys in this list produce an `unsupported_event` diagnostic;
 * every other unrecognized key produces `unknown_event`.
 */
export const SENPI_UNSUPPORTED_HOOK_EVENT_NAMES = [
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Setup',
  'UserPromptExpansion',
  'PostToolUseFailure',
  'PostToolBatch',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'MessageDisplay',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
] as const;

/**
 * Handler types that upstream recognizes but this kit does not run, copied
 * verbatim from `UNSUPPORTED_HANDLER_TYPES` in the pinned vendored contract.
 * A handler carrying one of these types produces an
 * `unsupported_handler_type` diagnostic instead of being executed.
 */
export const SENPI_UNSUPPORTED_HANDLER_TYPES = [
  'prompt',
  'agent',
  'http',
  'mcp_tool',
] as const;

/** One of the seven supported senpi hook events. */
export type SenpiHookEventName = (typeof SENPI_HOOK_EVENT_NAMES)[number];

/** Diagnostic codes, pinned to the vendored `HookDiagnosticCode` union. */
export type SenpiHookDiagnosticCode =
  | 'invalid_root'
  | 'invalid_hooks'
  | 'invalid_event_config'
  | 'invalid_matcher'
  | 'invalid_handler_group'
  | 'invalid_handler_list'
  | 'invalid_handler'
  | 'invalid_command'
  | 'invalid_command_windows'
  | 'invalid_command_target'
  | 'missing_command_target'
  | 'invalid_timeout'
  | 'invalid_status_message'
  | 'unknown_event'
  | 'unsupported_event'
  | 'unsupported_field'
  | 'unsupported_handler_type'
  | 'unsupported_async_handler'
  | 'unsupported_command_variant';

/**
 * Origin metadata carried by diagnostics and executable handlers.
 *
 * Mirrors the vendored `HookSourceMetadata` shape restricted to what a pure,
 * source-free validator can assert: configuration arrived through this
 * function rather than a discovered file, so the scope is `runtime` and the
 * path names this module boundary.
 */
export interface SenpiHookSourceMetadata {
  readonly scope: 'runtime';
  readonly sourcePath: string;
  readonly displayOrder: number;
  readonly discoveredAt: 'pre-session';
}

/**
 * A runnable command handler configuration.
 *
 * Mirrors the vendored `CommandHookConfig`: only `type: "command"` handlers
 * are supported, with optional Windows command override, timeout in seconds,
 * and status message.
 */
export interface SenpiCommandHookConfig {
  readonly type: 'command';
  readonly command: string;
  readonly commandWindows?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
}

/** A validated handler ready for execution. Mirrors `ExecutableHookHandler`. */
export interface SenpiExecutableHookHandler {
  readonly event: SenpiHookEventName;
  readonly matcher?: string;
  readonly groupIndex: number;
  readonly handlerIndex: number;
  readonly config: SenpiCommandHookConfig;
  readonly source: SenpiHookSourceMetadata;
}

/** One structured validation finding. Mirrors `HookDiagnostic`. */
export interface SenpiHookDiagnostic {
  readonly code: SenpiHookDiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: string;
  readonly event?: string;
}

/**
 * Result of validating a hooks configuration. Mirrors the vendored
 * `ParsedHookConfig`: everything that could be salvaged plus typed
 * diagnostics for everything that could not.
 */
export interface SenpiHooksConfig {
  readonly executableHandlers: readonly SenpiExecutableHookHandler[];
  readonly diagnostics: readonly SenpiHookDiagnostic[];
}

const VALIDATOR_SOURCE_PATH = '<senpi-settings-validation>';

const SYNTHETIC_SOURCE: SenpiHookSourceMetadata = {
  scope: 'runtime',
  sourcePath: VALIDATOR_SOURCE_PATH,
  displayOrder: 0,
  discoveredAt: 'pre-session',
};

const UNSUPPORTED_EVENTS: ReadonlySet<string> = new Set(
  SENPI_UNSUPPORTED_HOOK_EVENT_NAMES
);
const UNSUPPORTED_HANDLER_TYPE_SET: ReadonlySet<string> = new Set(
  SENPI_UNSUPPORTED_HANDLER_TYPES
);

/** Handler fields this kit understands; anything else is an ignored extra. */
const KNOWN_HANDLER_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'command',
  'commandWindows',
  'timeout',
  'statusMessage',
]);

/** Matcher-group fields this kit understands; extras are reported and kept. */
const KNOWN_GROUP_FIELDS: ReadonlySet<string> = new Set(['matcher', 'hooks']);

const timeoutSchema = z.number().int().nonnegative();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(parts: readonly (string | number)[]): string {
  return parts
    .map(part => (typeof part === 'number' ? `[${part}]` : part))
    .join('.');
}

function diagnostic(
  code: SenpiHookDiagnosticCode,
  severity: 'error' | 'warning',
  message: string,
  path: string,
  event?: string
): SenpiHookDiagnostic {
  return event === undefined
    ? { code, severity, message, path }
    : { code, severity, message, path, event };
}

interface CommandTargetResult {
  readonly command: string;
  readonly commandWindows?: string;
}

/**
 * Validate the `command` / `commandWindows` targets of one handler.
 *
 * Mirrors the vendored `CommandHookConfig`, where `command` is required and
 * `commandWindows` only overrides it on win32: a handler without a usable
 * `command` has no target on the supported POSIX matrix.
 *
 * Returns the accepted targets, or `undefined` after emitting at least one
 * error diagnostic.
 */
function validateCommandTargets(
  handler: Record<string, unknown>,
  path: string,
  event: string,
  emit: (diagnostic: SenpiHookDiagnostic) => void
): CommandTargetResult | undefined {
  let failed = false;
  let command: string | undefined;
  let commandWindows: string | undefined;

  const rawCommand = handler['command'];
  if (rawCommand === undefined) {
    emit(
      diagnostic(
        'missing_command_target',
        'error',
        "command handler requires a 'command' target",
        path,
        event
      )
    );
    return undefined;
  }
  if (Array.isArray(rawCommand) || isRecord(rawCommand)) {
    emit(
      diagnostic(
        'unsupported_command_variant',
        'error',
        "handler field 'command' must be a plain string; array and object command forms are not supported",
        joinPath([path, 'command']),
        event
      )
    );
    failed = true;
  } else if (typeof rawCommand !== 'string') {
    emit(
      diagnostic(
        'invalid_command',
        'error',
        "handler field 'command' must be a string",
        joinPath([path, 'command']),
        event
      )
    );
    failed = true;
  } else if (rawCommand.trim() === '') {
    emit(
      diagnostic(
        'invalid_command_target',
        'error',
        "handler field 'command' must be a non-empty string",
        joinPath([path, 'command']),
        event
      )
    );
    failed = true;
  } else {
    command = rawCommand;
  }

  const rawCommandWindows = handler['commandWindows'];
  if (rawCommandWindows !== undefined && rawCommandWindows !== null) {
    if (typeof rawCommandWindows !== 'string') {
      emit(
        diagnostic(
          'invalid_command_windows',
          'error',
          "handler field 'commandWindows' must be a string",
          joinPath([path, 'commandWindows']),
          event
        )
      );
      failed = true;
    } else if (rawCommandWindows.trim() === '') {
      emit(
        diagnostic(
          'invalid_command_target',
          'error',
          "handler field 'commandWindows' must be a non-empty string",
          joinPath([path, 'commandWindows']),
          event
        )
      );
      failed = true;
    } else {
      commandWindows = rawCommandWindows;
    }
  }

  if (failed || command === undefined) {
    return undefined;
  }
  return commandWindows === undefined
    ? { command }
    : { command, commandWindows };
}

/**
 * Validate one entry of a group's `hooks` list.
 *
 * Emits diagnostics for every defect found. Returns a runnable handler, or
 * `undefined` when a hard error prevents execution. Ignorable extra fields
 * yield `unsupported_field` warnings without disqualifying the handler.
 */
function validateHandler(
  handler: unknown,
  path: string,
  event: SenpiHookEventName,
  groupIndex: number,
  handlerIndex: number,
  emit: (diagnostic: SenpiHookDiagnostic) => void
): SenpiExecutableHookHandler | undefined {
  if (!isRecord(handler)) {
    emit(
      diagnostic(
        'invalid_handler',
        'error',
        'hook handler must be an object',
        path,
        event
      )
    );
    return undefined;
  }

  const type = handler['type'];
  if (typeof type === 'string' && UNSUPPORTED_HANDLER_TYPE_SET.has(type)) {
    emit(
      diagnostic(
        'unsupported_handler_type',
        'error',
        `handler type '${type}' exists upstream but is not supported by this kit; only 'command' handlers run`,
        path,
        event
      )
    );
    return undefined;
  }
  if (type !== 'command') {
    emit(
      diagnostic(
        'invalid_handler',
        'error',
        "hook handler field 'type' must be the literal 'command'",
        joinPath([path, 'type']),
        event
      )
    );
    return undefined;
  }

  if ('async' in handler && handler['async'] === true) {
    emit(
      diagnostic(
        'unsupported_async_handler',
        'error',
        "async command handlers are not supported; remove the 'async' flag",
        joinPath([path, 'async']),
        event
      )
    );
    return undefined;
  }

  const targets = validateCommandTargets(handler, path, event, emit);
  if (targets === undefined) {
    return undefined;
  }

  let valid = true;
  let timeout: number | undefined;
  let statusMessage: string | undefined;

  const rawTimeout = handler['timeout'];
  if (rawTimeout !== undefined && rawTimeout !== null) {
    const parsedTimeout = timeoutSchema.safeParse(rawTimeout);
    if (!parsedTimeout.success) {
      emit(
        diagnostic(
          'invalid_timeout',
          'error',
          "handler field 'timeout' must be a non-negative integer number of seconds",
          joinPath([path, 'timeout']),
          event
        )
      );
      valid = false;
    } else {
      timeout = parsedTimeout.data;
    }
  }

  const rawStatusMessage = handler['statusMessage'];
  if (rawStatusMessage !== undefined && rawStatusMessage !== null) {
    if (typeof rawStatusMessage !== 'string') {
      emit(
        diagnostic(
          'invalid_status_message',
          'error',
          "handler field 'statusMessage' must be a string",
          joinPath([path, 'statusMessage']),
          event
        )
      );
      valid = false;
    } else {
      statusMessage = rawStatusMessage;
    }
  }

  for (const key of Object.keys(handler)) {
    if (!KNOWN_HANDLER_FIELDS.has(key) && key !== 'async') {
      emit(
        diagnostic(
          'unsupported_field',
          'warning',
          `handler field '${key}' is not supported by this kit and will be ignored`,
          joinPath([path, key]),
          event
        )
      );
    }
  }

  if (!valid) {
    return undefined;
  }

  const config: SenpiCommandHookConfig = {
    type: 'command',
    command: targets.command,
    ...(targets.commandWindows !== undefined
      ? { commandWindows: targets.commandWindows }
      : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(statusMessage !== undefined ? { statusMessage } : {}),
  };

  return {
    event,
    groupIndex,
    handlerIndex,
    config,
    source: SYNTHETIC_SOURCE,
  };
}

/**
 * Validate one matcher group of a supported event.
 *
 * Emits diagnostics for structural defects and returns runnable handlers for
 * everything that survived. A group that is not an object, has no usable
 * `hooks` list, or has a non-string matcher is skipped entirely.
 */
function validateGroup(
  group: unknown,
  path: string,
  event: SenpiHookEventName,
  groupIndex: number,
  emit: (diagnostic: SenpiHookDiagnostic) => void
): SenpiExecutableHookHandler[] {
  if (!isRecord(group)) {
    emit(
      diagnostic(
        'invalid_handler_group',
        'error',
        'event configuration entries must be matcher-group objects',
        path,
        event
      )
    );
    return [];
  }

  let matcher: string | undefined;
  let valid = true;

  const rawMatcher = group['matcher'];
  if (rawMatcher !== undefined && rawMatcher !== null) {
    if (typeof rawMatcher !== 'string') {
      emit(
        diagnostic(
          'invalid_matcher',
          'error',
          "group field 'matcher' must be a string",
          joinPath([path, 'matcher']),
          event
        )
      );
      valid = false;
    } else {
      matcher = rawMatcher;
    }
  }

  const hooksList = group['hooks'];
  if (!Array.isArray(hooksList)) {
    emit(
      diagnostic(
        'invalid_handler_list',
        'error',
        "group field 'hooks' must be an array of handler objects",
        joinPath([path, 'hooks']),
        event
      )
    );
    return [];
  }

  for (const key of Object.keys(group)) {
    if (!KNOWN_GROUP_FIELDS.has(key)) {
      emit(
        diagnostic(
          'unsupported_field',
          'warning',
          `group field '${key}' is not supported by this kit and will be ignored`,
          joinPath([path, key]),
          event
        )
      );
    }
  }

  if (!valid) {
    return [];
  }

  const handlers: SenpiExecutableHookHandler[] = [];
  for (const [handlerIndex, rawHandler] of hooksList.entries()) {
    const handler = validateHandler(
      rawHandler,
      joinPath([path, 'hooks', handlerIndex]),
      event,
      groupIndex,
      handlerIndex,
      emit
    );
    if (handler === undefined) {
      continue;
    }
    handlers.push(matcher === undefined ? handler : { ...handler, matcher });
  }
  return handlers;
}

/**
 * Validates an already-parsed senpi hooks configuration document.
 *
 * This covers every config source the engine loads (`<agentHome>/hooks.json`,
 * `<cwd>/.senpi/hooks.json`, and the `hooks` keys of settings.json): pass the
 * JSON-decoded value of any of them.
 *
 * Validation never throws. Malformed roots, unknown events, unsupported
 * handler types, and bad handler fields all become typed diagnostics from the
 * pinned vendored `HookDiagnosticCode` vocabulary; whatever remains valid is
 * returned as executable handlers keyed to its original position.
 *
 * Event keys are matched against the seven canonical PascalCase names only -
 * unlike Grok, snake_case and camelCase spellings are rejected as
 * `unknown_event`. Keys naming upstream events this kit does not support are
 * rejected as `unsupported_event`.
 *
 * @param json - Parsed JSON value of a hooks document or settings `hooks` key.
 * @returns Executable handlers plus typed diagnostics; never throws.
 */
export function validateSenpiHooksConfig(json: unknown): SenpiHooksConfig {
  const diagnostics: SenpiHookDiagnostic[] = [];
  const emit = (d: SenpiHookDiagnostic): void => {
    diagnostics.push(d);
  };

  if (!isRecord(json)) {
    return {
      executableHandlers: [],
      diagnostics: [
        diagnostic(
          'invalid_root',
          'error',
          'hooks configuration root must be an object',
          '$'
        ),
      ],
    };
  }

  const hooks = json['hooks'];
  if (!isRecord(hooks)) {
    return {
      executableHandlers: [],
      diagnostics: [
        diagnostic(
          'invalid_hooks',
          'error',
          "hooks configuration requires a 'hooks' object keyed by event name",
          '$.hooks'
        ),
      ],
    };
  }

  const executableHandlers: SenpiExecutableHookHandler[] = [];

  for (const [key, value] of Object.entries(hooks)) {
    const event = SENPI_HOOK_EVENT_NAMES.find(name => name === key);
    if (event !== undefined) {
      if (!Array.isArray(value)) {
        emit(
          diagnostic(
            'invalid_event_config',
            'error',
            'event configuration must be an array of matcher groups',
            joinPath(['$', 'hooks', key]),
            event
          )
        );
        continue;
      }
      for (const [groupIndex, group] of value.entries()) {
        executableHandlers.push(
          ...validateGroup(
            group,
            joinPath(['$', 'hooks', key, groupIndex]),
            event,
            groupIndex,
            emit
          )
        );
      }
      continue;
    }
    if (UNSUPPORTED_EVENTS.has(key)) {
      emit(
        diagnostic(
          'unsupported_event',
          'error',
          `event '${key}' exists upstream but is not among the seven events this kit supports`,
          joinPath(['$', 'hooks', key]),
          key
        )
      );
      continue;
    }
    emit(
      diagnostic(
        'unknown_event',
        'error',
        `'${key}' is not a supported senpi hook event; configuration accepts only the canonical PascalCase names (${SENPI_HOOK_EVENT_NAMES.join(', ')})`,
        joinPath(['$', 'hooks', key]),
        key
      )
    );
  }

  return { executableHandlers, diagnostics };
}
