import { describe, expect, it } from 'vitest';

import {
  messageDisplayOutputSchema,
  postToolUseFailureOutputSchema,
  postToolUseOutputSchema,
  sessionStartOutputSchema,
  setupOutputSchema,
  stopOutputSchema,
  subagentStopOutputSchema,
  userPromptSubmitOutputSchema,
} from '../src/validation/index.js';
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

  it('sessionStartContext returns valid SessionStartOutput with metadata fields', () => {
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

  it('sessionStartContext preserves context and explicit reloadSkills false', () => {
    const output = HookOutputBuilder.sessionStartContext({
      context: 'Loaded project state',
      reloadSkills: false,
    });

    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'Loaded project state',
      reloadSkills: false,
    });
    expect(sessionStartOutputSchema.safeParse(output).success).toBe(true);
  });

  it('taskBlock can target TaskCreated output explicitly', () => {
    const output = HookOutputBuilder.taskBlock(
      'Task needs more detail',
      'TaskCreated'
    );

    expect(output.continue).toBe(false);
    expect(output.stopReason).toBe('Task needs more detail');
    expect(output.hookSpecificOutput.hookEventName).toBe('TaskCreated');
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

  it('feedback accepts string updatedMCPToolOutput', () => {
    const output = HookOutputBuilder.feedback('r', 'ctx', 'ready');

    expect(output.hookSpecificOutput?.updatedMCPToolOutput).toBe('ready');
    expect(postToolUseOutputSchema.safeParse(output).success).toBe(true);
  });

  it('feedback preserves falsy updatedMCPToolOutput values', () => {
    const cases = [false, 0, '', null];

    for (const updatedMCPToolOutput of cases) {
      const output = HookOutputBuilder.feedback(
        'r',
        'ctx',
        updatedMCPToolOutput
      );

      expect(output.hookSpecificOutput?.updatedMCPToolOutput).toBe(
        updatedMCPToolOutput
      );
      expect(postToolUseOutputSchema.safeParse(output).success).toBe(true);
    }
  });

  it('feedback passes through fourth positional updatedToolOutput unchanged', () => {
    const updatedToolOutput = {
      replaced: true,
      nested: { value: 'ok' },
    };
    const output = HookOutputBuilder.feedback(
      'r',
      'ctx',
      undefined,
      updatedToolOutput
    );

    expect(output.hookSpecificOutput?.updatedToolOutput).toBe(
      updatedToolOutput
    );
    expect(postToolUseOutputSchema.safeParse(output).success).toBe(true);
  });

  it('stop and subagent stop helpers emit event-safe discriminants', () => {
    const stopBlock = HookOutputBuilder.stopBlock('keep going');
    const stopContext = HookOutputBuilder.stopContext('run tests');
    const subagentBlock = HookOutputBuilder.subagentStopBlock('keep going');
    const subagentContext =
      HookOutputBuilder.subagentStopAdditionalContext('investigate more');
    const deprecatedAlias =
      HookOutputBuilder.subagentStopContext('compat block');

    expect(stopOutputSchema.safeParse(stopBlock).success).toBe(true);
    expect(stopOutputSchema.safeParse(stopContext).success).toBe(true);
    expect(subagentStopOutputSchema.safeParse(subagentBlock).success).toBe(
      true
    );
    expect(subagentStopOutputSchema.safeParse(subagentContext).success).toBe(
      true
    );
    expect(deprecatedAlias).toEqual({
      decision: 'block',
      reason: 'compat block',
    });
  });

  it('stop builders with empty strings still validate against schemas', () => {
    const stopBlock = HookOutputBuilder.stopBlock('');
    const stopContext = HookOutputBuilder.stopContext('');
    const subagentBlock = HookOutputBuilder.subagentStopBlock('');
    const subagentContext = HookOutputBuilder.subagentStopAdditionalContext('');

    expect(stopOutputSchema.safeParse(stopBlock).success).toBe(true);
    expect(stopOutputSchema.safeParse(stopContext).success).toBe(true);
    expect(subagentStopOutputSchema.safeParse(subagentBlock).success).toBe(
      true
    );
    expect(subagentStopOutputSchema.safeParse(subagentContext).success).toBe(
      true
    );
  });

  it('blockPrompt accepts suppressOriginalPrompt and validates', () => {
    const output = HookOutputBuilder.blockPrompt('Not allowed', {
      suppressOriginalPrompt: true,
    });

    expect(output).toEqual({
      decision: 'block',
      reason: 'Not allowed',
      suppressOriginalPrompt: true,
    });
    expect(userPromptSubmitOutputSchema.safeParse(output).success).toBe(true);
  });

  it('failureFeedback builds PostToolUseFailure output', () => {
    const output = HookOutputBuilder.failureFeedback(
      'retry later',
      'use absolute path'
    );

    expect(output.decision).toBe('block');
    expect(output.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    expect(postToolUseFailureOutputSchema.safeParse(output).success).toBe(true);
  });

  it('permissionRequestSetMode accepts manual mode alias', () => {
    const output = HookOutputBuilder.permissionRequestSetMode(
      'manual',
      'localSettings'
    );
    const decision = output.hookSpecificOutput?.decision;
    expect(decision?.behavior).toBe('allow');
    if (decision?.behavior === 'allow') {
      expect(decision.updatedPermissions).toEqual([
        {
          type: 'setMode',
          mode: 'manual',
          destination: 'localSettings',
        },
      ]);
    }
  });

  it('stopFailureLog is a no-op compatibility shim', () => {
    expect(HookOutputBuilder.stopFailureLog('ignored')).toEqual({});
  });
});
