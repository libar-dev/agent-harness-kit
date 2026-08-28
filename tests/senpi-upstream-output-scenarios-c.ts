/** Scenario table C. */
import type { Scenario } from './senpi-upstream-output-scenarios-types.js';
export function buildOutputScenariosC(): Scenario[] {
  return [
    {
      id: 'PreToolUse-reason-nested',
      event: 'PreToolUse',
      body: {
        reason: 'top',
        hookSpecificOutput: { permissionDecisionReason: 'nested' },
      },
      expectOutput: { reason: 'nested' },
    },
    {
      id: 'PreToolUse-context-nested',
      event: 'PreToolUse',
      body: {
        additionalContext: 'top',
        hookSpecificOutput: { additionalContext: 'nested' },
      },
      expectOutput: { additionalContext: 'nested' },
    },
    {
      id: 'PreToolUse-updatedInput-allow',
      event: 'PreToolUse',
      body: {
        hookSpecificOutput: {
          permissionDecision: 'allow',
          updatedInput: { a: 1 },
        },
      },
      expectOutput: { decision: 'allow', updatedInput: { a: 1 } },
    },
    {
      id: 'PreToolUse-updatedInput-denied',
      event: 'PreToolUse',
      body: {
        decision: 'deny',
        hookSpecificOutput: { updatedInput: { a: 1 } },
      },
      expectOutput: { decision: 'deny' },
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'PreToolUse',
          message:
            'PreToolUse updatedInput is only applied when permissionDecision is allow.',
          path: 'stdout.hookSpecificOutput.updatedInput',
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
      id: 'PreToolUse-updatedInput-undefined',
      event: 'PreToolUse',
      body: { decision: 'allow' },
      expectOutput: { decision: 'allow' },
    },
    { id: 'PreCompact-empty', event: 'PreCompact', body: {}, expectOutput: {} },
    {
      id: 'PostCompact-empty',
      event: 'PostCompact',
      body: {},
      expectOutput: {},
    },
    {
      id: 'systemMessage-PreToolUse-in',
      event: 'PreToolUse',
      body: { systemMessage: ' m ' },
      expectOutput: { systemMessage: 'm' },
    },
    {
      id: 'systemMessage-PostToolUse-in',
      event: 'PostToolUse',
      body: { systemMessage: ' m ' },
      expectOutput: { systemMessage: 'm' },
    },
    {
      id: 'systemMessage-UserPromptSubmit-in',
      event: 'UserPromptSubmit',
      body: { systemMessage: ' m ' },
      expectOutput: { systemMessage: 'm' },
    },
    {
      id: 'systemMessage-SessionStart-in',
      event: 'SessionStart',
      body: { systemMessage: ' m ' },
      expectOutput: { systemMessage: 'm' },
    },
    {
      id: 'systemMessage-PreCompact-out',
      event: 'PreCompact',
      body: { systemMessage: 'm' },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'PreCompact',
          message: 'Hook systemMessage is not supported for this event.',
          path: 'stdout.systemMessage',
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
      id: 'systemMessage-PostCompact-out',
      event: 'PostCompact',
      body: { systemMessage: 'm' },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'warning',
          code: 'unsupported_field',
          event: 'PostCompact',
          message: 'Hook systemMessage is not supported for this event.',
          path: 'stdout.systemMessage',
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
      id: 'systemMessage-Stop-in',
      event: 'Stop',
      body: { systemMessage: ' m ' },
      expectOutput: { systemMessage: 'm' },
    },
    {
      id: 'event-empty-PreToolUse',
      event: 'PreToolUse',
      body: {},
      expectOutput: {},
    },
    {
      id: 'event-empty-PostToolUse',
      event: 'PostToolUse',
      body: {},
      expectOutput: {},
    },
    {
      id: 'event-empty-UserPromptSubmit',
      event: 'UserPromptSubmit',
      body: {},
      expectOutput: {},
    },
    {
      id: 'event-empty-SessionStart',
      event: 'SessionStart',
      body: {},
      expectOutput: {},
    },
    {
      id: 'event-empty-PreCompact',
      event: 'PreCompact',
      body: {},
      expectOutput: {},
    },
    {
      id: 'event-empty-PostCompact',
      event: 'PostCompact',
      body: {},
      expectOutput: {},
    },
    { id: 'event-empty-Stop', event: 'Stop', body: {}, expectOutput: {} },
    // Hits synthetic switch no-match / default direction in parseEvent.
    {
      id: 'event-unknown-nomatch',
      event: 'UnknownEventForBranchCoverage',
      body: { reason: 'x' },
      expectOutput: {},
    },
    // updatedInput from root while specific is absent → opt-miss on permissionDecision.
    {
      id: 'PreToolUse-updatedInput-root-no-specific',
      event: 'PreToolUse',
      body: { decision: 'allow', updatedInput: { a: 1 } },
      expectOutput: { decision: 'allow' },
      expectDiagnostics: [
        {
          code: 'unsupported_field',
          severity: 'warning',
          message:
            'PreToolUse updatedInput is only applied when permissionDecision is allow.',
          path: 'stdout.hookSpecificOutput.updatedInput',
          event: 'PreToolUse',
          source: {
            scope: 'runtime',
            sourcePath: 'drift',
            displayOrder: 0,
            discoveredAt: 'pre-session',
          },
        },
      ],
    },
  ];
}
