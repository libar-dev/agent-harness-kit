/** Scenario table B. */
import type { Scenario } from './senpi-upstream-output-scenarios-types.js';
export function buildOutputScenariosB(): Scenario[] {
  return [
    { id: 'uto-omit', event: 'PostToolUse', body: {}, expectOutput: {} },
    {
      id: 'PostToolUse-block',
      event: 'PostToolUse',
      body: { decision: 'block' },
      expectOutput: { decision: 'block' },
    },
    {
      id: 'PostToolUse-allow-ignored',
      event: 'PostToolUse',
      body: { decision: 'allow' },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'PostToolUse',
          message: 'PostToolUse only supports decision block.',
          path: 'stdout.decision',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'PostToolUse-context-nested',
      event: 'PostToolUse',
      body: {
        additionalContext: 'top',
        hookSpecificOutput: { additionalContext: 'nested' },
      },
      expectOutput: { additionalContext: 'nested' },
    },
    {
      id: 'PostToolUse-uto-nested',
      event: 'PostToolUse',
      body: {
        updatedToolOutput: 'top',
        hookSpecificOutput: { updatedToolOutput: { n: 1 } },
      },
      expectOutput: { updatedToolOutput: { n: 1 } },
    },
    {
      id: 'UserPromptSubmit-block-reason',
      event: 'UserPromptSubmit',
      body: { decision: 'block', reason: 'upr' },
      expectOutput: { decision: 'block', reason: 'upr' },
    },
    {
      id: 'UserPromptSubmit-prompt-reject',
      event: 'UserPromptSubmit',
      body: { hookSpecificOutput: { prompt: 'p' } },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'UserPromptSubmit',
          message: 'UserPromptSubmit prompt replacement is not supported.',
          path: 'stdout.hookSpecificOutput.prompt',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'UserPromptSubmit-updatedPrompt-reject',
      event: 'UserPromptSubmit',
      body: { hookSpecificOutput: { updatedPrompt: 'p' } },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'UserPromptSubmit',
          message: 'UserPromptSubmit prompt replacement is not supported.',
          path: 'stdout.hookSpecificOutput.updatedPrompt',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'UserPromptSubmit-replacementPrompt-reject',
      event: 'UserPromptSubmit',
      body: { hookSpecificOutput: { replacementPrompt: 'p' } },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'UserPromptSubmit',
          message: 'UserPromptSubmit prompt replacement is not supported.',
          path: 'stdout.hookSpecificOutput.replacementPrompt',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'UserPromptSubmit-context-nested',
      event: 'UserPromptSubmit',
      body: {
        additionalContext: 'top',
        hookSpecificOutput: { additionalContext: 'nested' },
      },
      expectOutput: { additionalContext: 'nested' },
    },
    {
      id: 'Stop-block',
      event: 'Stop',
      body: { decision: 'block', reason: 'sr' },
      expectOutput: { decision: 'block', reason: 'sr' },
    },
    {
      id: 'Stop-continue',
      event: 'Stop',
      body: { decision: 'continue' },
      expectOutput: {},
    },
    {
      id: 'Stop-other',
      event: 'Stop',
      body: { decision: 'allow' },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'Stop',
          message: 'Stop only supports decision block or continue.',
          path: 'stdout.decision',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'Stop-context-nested',
      event: 'Stop',
      body: {
        additionalContext: 'top',
        hookSpecificOutput: { additionalContext: 'nested' },
      },
      expectOutput: { additionalContext: 'nested' },
    },
    {
      id: 'SessionStart-decision-ignored',
      event: 'SessionStart',
      body: { decision: 'block', additionalContext: 's' },
      expectOutput: { additionalContext: 's' },
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'SessionStart',
          message: 'SessionStart does not support decisions.',
          path: 'stdout.decision',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
    {
      id: 'SessionStart-context-nested',
      event: 'SessionStart',
      body: {
        additionalContext: 'top',
        hookSpecificOutput: { additionalContext: 'nested' },
      },
      expectOutput: { additionalContext: 'nested' },
    },
    {
      id: 'PreToolUse-deny',
      event: 'PreToolUse',
      body: { decision: 'deny' },
      expectOutput: { decision: 'deny' },
    },
    {
      id: 'PreToolUse-block-maps-deny',
      event: 'PreToolUse',
      body: { decision: 'block' },
      expectOutput: { decision: 'deny' },
    },
    {
      id: 'PreToolUse-allow',
      event: 'PreToolUse',
      body: { decision: 'allow' },
      expectOutput: { decision: 'allow' },
    },
    {
      id: 'PreToolUse-approve',
      event: 'PreToolUse',
      body: { decision: 'approve' },
      expectOutput: { decision: 'approve' },
    },
    {
      id: 'PreToolUse-ask',
      event: 'PreToolUse',
      body: { decision: 'ask' },
      expectOutput: { decision: 'ask' },
    },
    {
      id: 'PreToolUse-unknown-decision',
      event: 'PreToolUse',
      body: { decision: 'maybe' },
      expectOutput: {},
    },
  ];
}
