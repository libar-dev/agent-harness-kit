import { describe, expect, it } from 'vitest';

import {
  postToolUseOutputSchema,
  sessionStartOutputSchema,
} from '../src/validation/index.js';
import {
  messageDisplayOutputSchema,
  setupOutputSchema,
} from '../src/validation/schemas.js';
import { HookOutputBuilder } from '../src/utils/output-builder.js';

describe('HookOutputBuilder parity helpers', () => {
  it('setupContext returns valid SetupOutput', () => {
    const output = HookOutputBuilder.setupContext('x');

    expect(output.hookSpecificOutput?.hookEventName).toBe('Setup');
    expect(output.hookSpecificOutput?.additionalContext).toBe('x');
    expect(setupOutputSchema.safeParse(output).success).toBe(true);
  });

  it('messageDisplayContent returns valid MessageDisplayOutput', () => {
    const output = HookOutputBuilder.messageDisplayContent('y');

    expect(output.hookSpecificOutput?.hookEventName).toBe('MessageDisplay');
    expect(output.hookSpecificOutput?.displayContent).toBe('y');
    expect(messageDisplayOutputSchema.safeParse(output).success).toBe(true);
  });

  it('sessionStartContext returns valid SessionStartOutput with new fields', () => {
    const output = HookOutputBuilder.sessionStartContext({
      sessionTitle: 't',
      watchPaths: ['/a'],
      reloadSkills: true,
      initialUserMessage: 'hi',
    });

    expect(output.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput?.sessionTitle).toBe('t');
    expect(output.hookSpecificOutput?.watchPaths).toEqual(['/a']);
    expect(output.hookSpecificOutput?.reloadSkills).toBe(true);
    expect(output.hookSpecificOutput?.initialUserMessage).toBe('hi');
    expect(sessionStartOutputSchema.safeParse(output).success).toBe(true);
  });

  it('feedback includes updatedToolOutput when provided', () => {
    const output = HookOutputBuilder.feedback('r', 'ctx', undefined, {
      replaced: true,
    });

    expect(output.reason).toBe('r');
    expect(output.hookSpecificOutput?.additionalContext).toBe('ctx');
    expect(output.hookSpecificOutput?.updatedToolOutput).toEqual({
      replaced: true,
    });
    expect(postToolUseOutputSchema.safeParse(output).success).toBe(true);
  });

  it('feedback still works without updatedToolOutput', () => {
    const output = HookOutputBuilder.feedback('r', 'ctx');

    expect(output.reason).toBe('r');
    expect(output.hookSpecificOutput?.additionalContext).toBe('ctx');
    expect(output.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
    expect(postToolUseOutputSchema.safeParse(output).success).toBe(true);
  });
});
