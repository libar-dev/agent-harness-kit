/** Scenario table A. */
import type { Scenario } from './senpi-upstream-output-scenarios-types.js';
export function buildOutputScenariosA(): Scenario[] {
  return [
    {
      id: 'exit2-stderr',
      event: 'Stop',
      exitCode: 2,
      stderr: ' blocked ',
      expectOutput: { decision: 'block', reason: 'blocked' },
    },
    {
      id: 'exit2-blank-stderr',
      event: 'Stop',
      exitCode: 2,
      stderr: '   ',
      expectOutput: { decision: 'block' },
    },
    { id: 'empty-stdout', event: 'Stop', expectOutput: {} },
    {
      id: 'invalid-json',
      event: 'Stop',
      body: 'not-json{',
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'error',
          code: 'invalid_root',
          event: 'Stop',
          message: 'Hook stdout must be valid JSON.',
          path: 'stdout',
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
      id: 'non-object-json',
      event: 'Stop',
      body: '[]',
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'error',
          code: 'invalid_root',
          event: 'Stop',
          message: 'Hook stdout JSON must be an object.',
          path: 'stdout',
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
      id: 'specific-invalid',
      event: 'PostToolUse',
      body: { reason: 'x', hookSpecificOutput: 'bad' },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'error',
          code: 'invalid_event_config',
          event: 'PostToolUse',
          message: 'Hook hookSpecificOutput field must be an object.',
          path: 'stdout.hookSpecificOutput',
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
      id: 'specific-mismatched',
      event: 'PostToolUse',
      body: { reason: 'x', hookSpecificOutput: { hookEventName: 'Stop' } },
      expectOutput: {},
      expectDiagnostics: [
        {
          severity: 'error',
          code: 'invalid_event_config',
          event: 'PostToolUse',
          message: 'Hook output event Stop does not match PostToolUse.',
          path: 'stdout.hookSpecificOutput.hookEventName',
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
      id: 'specific-match',
      event: 'PostToolUse',
      body: {
        reason: 'r',
        hookSpecificOutput: { hookEventName: 'PostToolUse' },
      },
      expectOutput: { reason: 'r' },
    },
    {
      id: 'specific-undefined-eventName',
      event: 'PostToolUse',
      body: { reason: 'r', hookSpecificOutput: {} },
      expectOutput: { reason: 'r' },
    },
    {
      id: 'continue-suppress-bool',
      event: 'PostToolUse',
      body: { continue: true, suppressOutput: true },
      expectOutput: { continue: true, suppressOutput: true },
    },
    {
      id: 'continue-suppress-nonbool',
      event: 'PostToolUse',
      body: { continue: 'yes', suppressOutput: 'yes' },
      expectOutput: {},
    },
    {
      id: 'stopReason-ok',
      event: 'Stop',
      body: { stopReason: ' done ' },
      expectOutput: { stopReason: 'done' },
    },
    {
      id: 'stopReason-num',
      event: 'Stop',
      body: { stopReason: 9 },
      expectOutput: {},
    },
    {
      id: 'stop-continue-false',
      event: 'Stop',
      body: { continue: false },
      expectOutput: { continue: false, decision: 'block' },
    },
    {
      id: 'reason-blank',
      event: 'PostToolUse',
      body: { reason: '   ' },
      expectOutput: {},
    },
    {
      id: 'reason-trim',
      event: 'PostToolUse',
      body: { reason: '  hi  ' },
      expectOutput: { reason: 'hi' },
    },
    {
      id: 'reason-number',
      event: 'PostToolUse',
      body: { reason: 1 },
      expectOutput: {},
    },
    {
      id: 'uto-null',
      event: 'PostToolUse',
      body: { updatedToolOutput: null },
      expectOutput: { updatedToolOutput: null },
    },
    {
      id: 'uto-false',
      event: 'PostToolUse',
      body: { updatedToolOutput: false },
      expectOutput: { updatedToolOutput: false },
    },
    {
      id: 'uto-zero',
      event: 'PostToolUse',
      body: { updatedToolOutput: 0 },
      expectOutput: { updatedToolOutput: 0 },
    },
    {
      id: 'uto-array',
      event: 'PostToolUse',
      body: { updatedToolOutput: [1] },
      expectOutput: { updatedToolOutput: [1] },
    },
    {
      id: 'uto-string',
      event: 'PostToolUse',
      body: { updatedToolOutput: 's' },
      expectOutput: { updatedToolOutput: 's' },
    },
  ];
}
