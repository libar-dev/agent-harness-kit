import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  validateGrokHooksConfig,
  validateGrokHooksToml,
} from '../src/grok/settings.js';

const commandGroup = (command = 'bin/check.sh') => ({
  matcher: 'run_terminal_command',
  hooks: [{ type: 'command', command, timeout: 12, env: { MODE: 'strict' } }],
});

const eventAliases = [
  ['SessionStart', 'SessionStart'],
  ['session_start', 'SessionStart'],
  ['sessionStart', 'SessionStart'],
  ['UserPromptSubmit', 'UserPromptSubmit'],
  ['user_prompt_submit', 'UserPromptSubmit'],
  ['beforeSubmitPrompt', 'UserPromptSubmit'],
  ['PreToolUse', 'PreToolUse'],
  ['pre_tool_use', 'PreToolUse'],
  ['preToolUse', 'PreToolUse'],
  ['beforeShellExecution', 'PreToolUse'],
  ['beforeMCPExecution', 'PreToolUse'],
  ['beforeReadFile', 'PreToolUse'],
  ['PostToolUse', 'PostToolUse'],
  ['post_tool_use', 'PostToolUse'],
  ['postToolUse', 'PostToolUse'],
  ['afterShellExecution', 'PostToolUse'],
  ['afterMCPExecution', 'PostToolUse'],
  ['afterFileEdit', 'PostToolUse'],
  ['afterAgentResponse', 'PostToolUse'],
  ['afterAgentThought', 'PostToolUse'],
  ['PostToolUseFailure', 'PostToolUseFailure'],
  ['post_tool_use_failure', 'PostToolUseFailure'],
  ['postToolUseFailure', 'PostToolUseFailure'],
  ['PermissionDenied', 'PermissionDenied'],
  ['permission_denied', 'PermissionDenied'],
  ['permissionDenied', 'PermissionDenied'],
  ['Stop', 'Stop'],
  ['stop', 'Stop'],
  ['StopFailure', 'StopFailure'],
  ['stop_failure', 'StopFailure'],
  ['stopFailure', 'StopFailure'],
  ['Notification', 'Notification'],
  ['notification', 'Notification'],
  ['SubagentStart', 'SubagentStart'],
  ['subagent_start', 'SubagentStart'],
  ['subagentStart', 'SubagentStart'],
  ['SubagentStop', 'SubagentStop'],
  ['subagent_stop', 'SubagentStop'],
  ['subagentStop', 'SubagentStop'],
  ['SubagentEnd', 'SubagentEnd'],
  ['subagent_end', 'SubagentEnd'],
  ['subagentEnd', 'SubagentEnd'],
  ['PreCompact', 'PreCompact'],
  ['pre_compact', 'PreCompact'],
  ['preCompact', 'PreCompact'],
  ['PostCompact', 'PostCompact'],
  ['post_compact', 'PostCompact'],
  ['postCompact', 'PostCompact'],
  ['SessionEnd', 'SessionEnd'],
  ['session_end', 'SessionEnd'],
  ['sessionEnd', 'SessionEnd'],
] as const;

describe('Grok settings validation', () => {
  it('validates a real-world-shaped JSON config and normalizes aliases', () => {
    const config = validateGrokHooksConfig({
      hooks: {
        beforeSubmitPrompt: [commandGroup('bin/prompt.sh')],
        beforeShellExecution: [commandGroup('bin/pre-tool.sh')],
        afterFileEdit: [
          {
            matcher: 'edit_file',
            hooks: [
              {
                type: 'http',
                url: 'https://hooks.example.test/edit',
                env: null,
              },
            ],
          },
        ],
        sessionEnd: [commandGroup('bin/session-end.sh')],
      },
    });

    expect(Object.keys(config.hooks)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'SessionEnd',
    ]);
    expect(config.hooks.PostToolUse?.[0]?.hooks[0]).toEqual({
      type: 'http',
      url: 'https://hooks.example.test/edit',
      env: null,
    });
  });

  it.each(eventAliases)('normalizes %s to %s', (alias, canonical) => {
    const config = validateGrokHooksConfig({
      hooks: { [alias]: [commandGroup()] },
    });

    expect(config.hooks).toEqual({ [canonical]: [commandGroup()] });
  });

  it('merges groups whose keys normalize to the same event', () => {
    const config = validateGrokHooksConfig({
      hooks: {
        PreToolUse: [commandGroup('bin/one.sh')],
        beforeReadFile: [commandGroup('bin/two.sh')],
      },
    });

    expect(config.hooks.PreToolUse).toHaveLength(2);
  });

  it.each([
    ['command handler without command', { type: 'command' }],
    ['http handler without url', { type: 'http' }],
    ['unsupported mcp_tool handler', { type: 'mcp_tool', server: 'tools' }],
  ])('rejects a whole JSON file for a %s', (_label, handler) => {
    expect(() =>
      validateGrokHooksConfig({
        hooks: {
          PreToolUse: [{ hooks: [handler] }],
          PostToolUse: [commandGroup('bin/otherwise-valid.sh')],
        },
      })
    ).toThrow(ZodError);
  });

  it.each([
    ['command handler without command', { type: 'command' }],
    ['http handler without url', { type: 'http' }],
    ['unsupported mcp_tool handler', { type: 'mcp_tool', server: 'tools' }],
  ])('skips a malformed TOML event for a %s', (_label, handler) => {
    const result = validateGrokHooksToml({
      hooks: {
        PreToolUse: [{ hooks: [handler] }],
        PostToolUse: [commandGroup('bin/kept.sh')],
      },
    });

    expect(result.skipped).toEqual(['PreToolUse']);
    expect(result.config.hooks).toEqual({
      PostToolUse: [commandGroup('bin/kept.sh')],
    });
  });

  it('silently skips unknown event keys in JSON', () => {
    const config = validateGrokHooksConfig({
      hooks: {
        ImaginaryEvent: [commandGroup('bin/ignored.sh')],
        Stop: [commandGroup('bin/kept.sh')],
      },
    });

    expect(config.hooks).toEqual({ Stop: [commandGroup('bin/kept.sh')] });
  });

  it('reports unknown event keys as skipped in TOML', () => {
    const result = validateGrokHooksToml({
      hooks: {
        ImaginaryEvent: [commandGroup('bin/ignored.sh')],
        Stop: [commandGroup('bin/kept.sh')],
      },
    });

    expect(result.skipped).toEqual(['ImaginaryEvent']);
    expect(result.config.hooks).toEqual({
      Stop: [commandGroup('bin/kept.sh')],
    });
  });

  it.each([null, [], 'hooks', 1])(
    'rejects non-object JSON input: %j',
    input => {
      expect(() => validateGrokHooksConfig(input)).toThrow(ZodError);
    }
  );

  it.each([null, [], 'hooks', 1])(
    'rejects non-object TOML input: %j',
    input => {
      expect(() => validateGrokHooksToml(input)).toThrow(ZodError);
    }
  );
});
