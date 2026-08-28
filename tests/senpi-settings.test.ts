import { describe, expect, it } from 'vitest';

import {
  SENPI_HOOK_EVENT_NAMES,
  SENPI_UNSUPPORTED_HANDLER_TYPES,
  validateSenpiHooksConfig,
} from '../src/senpi/settings.js';

/** A minimal valid command handler. */
function commandHandler(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type: 'command', command: 'echo hi', ...extra };
}

/** A hooks document with exactly one group and one handler under `event`. */
function singleHandlerDoc(
  event: string,
  handler: unknown
): Record<string, unknown> {
  return { hooks: { [event]: [{ matcher: 'Bash', hooks: [handler] }] } };
}

const fullValidConfig = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'echo pre',
            timeout: 10,
            statusMessage: 'validating bash',
          },
        ],
      },
    ],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }],
    UserPromptSubmit: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: 'echo prompt',
            commandWindows: 'echo prompt-win',
          },
        ],
      },
    ],
    SessionStart: [{ hooks: [commandHandler()] }],
    PreCompact: [{ hooks: [commandHandler()] }],
    PostCompact: [{ hooks: [commandHandler()] }],
    Stop: [{ hooks: [commandHandler()] }],
  },
};

interface MalformedCase {
  readonly code: string;
  readonly input: unknown;
}

/**
 * Exactly one dedicated malformed input per pinned HookDiagnosticCode.
 * Codes are copied verbatim from the vendored contract
 * docs/upstream/senpi/hooks/types.d.ts (engine 2026.8.19).
 */
const malformedCases: readonly MalformedCase[] = [
  { code: 'invalid_root', input: 42 },
  {
    code: 'invalid_hooks',
    input: { hooks: 'not-an-object' },
  },
  {
    code: 'invalid_event_config',
    input: { hooks: { Stop: { notAnArray: true } } },
  },
  {
    code: 'invalid_matcher',
    input: { hooks: { Stop: [{ matcher: 42, hooks: [commandHandler()] }] } },
  },
  {
    code: 'invalid_handler_group',
    input: { hooks: { Stop: ['not-a-group'] } },
  },
  {
    code: 'invalid_handler_list',
    input: { hooks: { Stop: [{ matcher: 'Bash', hooks: 'not-a-list' }] } },
  },
  {
    code: 'invalid_handler',
    input: { hooks: { Stop: [{ hooks: [42] }] } },
  },
  {
    code: 'invalid_command',
    input: singleHandlerDoc('Stop', { type: 'command', command: 42 }),
  },
  {
    code: 'invalid_command_windows',
    input: singleHandlerDoc('Stop', {
      type: 'command',
      command: 'echo ok',
      commandWindows: 7,
    }),
  },
  {
    code: 'invalid_command_target',
    input: singleHandlerDoc('Stop', { type: 'command', command: '   ' }),
  },
  {
    code: 'missing_command_target',
    input: singleHandlerDoc('Stop', { type: 'command' }),
  },
  {
    code: 'invalid_timeout',
    input: singleHandlerDoc('Stop', commandHandler({ timeout: -5 })),
  },
  {
    code: 'invalid_status_message',
    input: singleHandlerDoc('Stop', commandHandler({ statusMessage: 9 })),
  },
  {
    code: 'unknown_event',
    input: { hooks: { pre_tool_use: [{ hooks: [commandHandler()] }] } },
  },
  {
    code: 'unsupported_event',
    input: { hooks: { SessionEnd: [{ hooks: [commandHandler()] }] } },
  },
  {
    code: 'unsupported_field',
    input: singleHandlerDoc('Stop', commandHandler({ env: { FOO: 'bar' } })),
  },
  {
    code: 'unsupported_handler_type',
    input: singleHandlerDoc('Stop', { type: 'http', url: 'https://x.test' }),
  },
  {
    code: 'unsupported_async_handler',
    input: singleHandlerDoc('Stop', commandHandler({ async: true })),
  },
  {
    code: 'unsupported_command_variant',
    input: singleHandlerDoc('Stop', {
      type: 'command',
      command: ['echo', 'argv-form'],
    }),
  },
];

describe('validateSenpiHooksConfig', () => {
  it('parses a full valid 7-event config into executable handlers', () => {
    const result = validateSenpiHooksConfig(fullValidConfig);

    expect(result.diagnostics).toEqual([]);
    expect(result.executableHandlers).toHaveLength(7);
    expect([...result.executableHandlers].map(h => h.event)).toEqual([
      ...SENPI_HOOK_EVENT_NAMES,
    ]);

    const preToolUse = result.executableHandlers.find(
      handler => handler.event === 'PreToolUse'
    );
    expect(preToolUse).toBeDefined();
    expect(preToolUse?.matcher).toBe('Bash');
    expect(preToolUse?.groupIndex).toBe(0);
    expect(preToolUse?.handlerIndex).toBe(0);
    expect(preToolUse?.config).toEqual({
      type: 'command',
      command: 'echo pre',
      timeout: 10,
      statusMessage: 'validating bash',
    });

    const userPromptSubmit = result.executableHandlers.find(
      handler => handler.event === 'UserPromptSubmit'
    );
    expect(userPromptSubmit?.matcher).toBe('*');
    expect(userPromptSubmit?.config.commandWindows).toBe('echo prompt-win');

    const sourcelessFieldsAllMatch = result.executableHandlers.every(
      handler =>
        handler.source.scope === 'runtime' &&
        handler.source.discoveredAt === 'pre-session'
    );
    expect(sourcelessFieldsAllMatch).toBe(true);
  });

  it.each(malformedCases)(
    '$code has a dedicated malformed input',
    ({ code, input }) => {
      const result = validateSenpiHooksConfig(input);
      const codes = result.diagnostics.map(d => d.code);

      // Never throws; always returns both result fields.
      expect(Array.isArray(result.executableHandlers)).toBe(true);
      expect(codes).toContain(code);
    }
  );

  it('emits unsupported_field as a warning without disqualifying the handler', () => {
    const result = validateSenpiHooksConfig(
      singleHandlerDoc('Stop', commandHandler({ env: { FOO: 'bar' } }))
    );
    const fieldDiag = result.diagnostics.find(
      d => d.code === 'unsupported_field'
    );
    expect(fieldDiag?.severity).toBe('warning');
    expect(fieldDiag?.path).toContain('env');
    expect(result.executableHandlers).toHaveLength(1);
  });

  it('rejects snake_case event spellings as unknown_event', () => {
    const snake = validateSenpiHooksConfig({
      hooks: { pre_tool_use: [{ hooks: [commandHandler()] }] },
    });
    expect(snake.executableHandlers).toEqual([]);
    expect(snake.diagnostics.map(d => d.code)).toEqual(['unknown_event']);
    expect(snake.diagnostics[0]?.event).toBe('pre_tool_use');

    const camel = validateSenpiHooksConfig({
      hooks: { preToolUse: [{ hooks: [commandHandler()] }] },
    });
    expect(camel.executableHandlers).toEqual([]);
    expect(camel.diagnostics.map(d => d.code)).toEqual(['unknown_event']);
  });

  it('accepts only the seven canonical event names as keys', () => {
    const wrongCase = validateSenpiHooksConfig({
      hooks: { pretooluse: [{ hooks: [commandHandler()] }] },
    });
    expect(wrongCase.diagnostics.map(d => d.code)).toEqual(['unknown_event']);

    for (const event of SENPI_HOOK_EVENT_NAMES) {
      const ok = validateSenpiHooksConfig({
        hooks: { [event]: [{ hooks: [commandHandler()] }] },
      });
      expect(ok.diagnostics).toEqual([]);
      expect(ok.executableHandlers).toHaveLength(1);
    }
  });

  it('returns an unsupported_handler_type diagnostic for an http handler instead of throwing', () => {
    let result: ReturnType<typeof validateSenpiHooksConfig> | undefined;
    expect(() => {
      result = validateSenpiHooksConfig({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: 'http', url: 'https://observer.test/hook' }] },
          ],
        },
      });
    }).not.toThrow();

    expect(result?.executableHandlers).toEqual([]);
    const codes = result?.diagnostics.map(d => d.code) ?? [];
    expect(codes).toContain('unsupported_handler_type');
    const diag = result?.diagnostics.find(
      d => d.code === 'unsupported_handler_type'
    );
    expect(diag?.severity).toBe('error');
    expect(diag?.event).toBe('PostToolUse');
  });

  it.each([
    ['null', null],
    ['number', 42],
    ['array', []],
    ['string', 'nope'],
  ])('never throws on %s root', (_name, input) => {
    const result = validateSenpiHooksConfig(input);
    expect(result.executableHandlers).toEqual([]);
    expect(result.diagnostics.map(d => d.code)).toEqual(['invalid_root']);
  });

  it('isolates failures per handler instead of rejecting the whole config', () => {
    const result = validateSenpiHooksConfig({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'http', url: 'https://x.test' }, commandHandler()],
          },
        ],
      },
    });
    expect(result.executableHandlers).toHaveLength(1);
    expect(result.executableHandlers[0]?.handlerIndex).toBe(1);
    expect(result.diagnostics.map(d => d.code)).toEqual([
      'unsupported_handler_type',
    ]);
  });

  it('covers every vendored unsupported handler type constant', () => {
    for (const type of SENPI_UNSUPPORTED_HANDLER_TYPES) {
      const result = validateSenpiHooksConfig(
        singleHandlerDoc('Stop', { type, target: 'whatever' })
      );
      expect(result.diagnostics.map(d => d.code)).toContain(
        'unsupported_handler_type'
      );
      expect(result.executableHandlers).toEqual([]);
    }
  });
});
