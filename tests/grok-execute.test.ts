import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeGrokHook,
  outputGrokJson,
  readGrokStdinJson,
} from '../src/grok/execute.js';
import type {
  GrokHookInput,
  GrokNotificationInput,
  GrokPreToolUseInput,
  GrokStopInput,
} from '../src/grok/types.js';
import {
  createGrokExitRecorder,
  createGrokHookEnvelope,
  createGrokStderrMock,
  createGrokStdinMock,
  createGrokStdoutMock,
  createNeverEndingGrokStdinMock,
} from './grok-test-utils.js';

function createPreToolUseEnvelope(command: string = 'pnpm test') {
  return createGrokHookEnvelope('pre_tool_use', {
    toolName: 'run_terminal_command',
    toolUseId: 'tool-001',
    toolInput: { command },
    toolInputTruncated: false,
  });
}

function createNotificationEnvelope() {
  return createGrokHookEnvelope('notification', {
    notificationType: 'warning',
    message: 'A background task is still running',
  });
}

describe('readGrokStdinJson', () => {
  it('returns the validated envelope for a valid pre_tool_use payload', async () => {
    const input = await readGrokStdinJson({
      stdin: createGrokStdinMock(createPreToolUseEnvelope()),
    });

    expect(input.hookEventName).toBe('pre_tool_use');
    if (input.hookEventName === 'pre_tool_use') {
      expect(input.toolName).toBe('run_terminal_command');
      expect(input.toolInput).toEqual({ command: 'pnpm test' });
    }
  });

  it('rejects malformed JSON', async () => {
    await expect(
      readGrokStdinJson({ stdin: createGrokStdinMock('not json{') })
    ).rejects.toThrow('Failed to parse Grok hook input JSON');
  });

  it('rejects a truncated JSON envelope', async () => {
    await expect(
      readGrokStdinJson({
        stdin: createGrokStdinMock('{"hookEventName":"pre_tool_use"'),
      })
    ).rejects.toThrow('Failed to parse Grok hook input JSON');
  });

  it('rejects an unknown hook event name', async () => {
    await expect(
      readGrokStdinJson({
        stdin: createGrokStdinMock(createGrokHookEnvelope('future_event', {})),
      })
    ).rejects.toThrow('Failed to parse Grok hook input JSON');
  });
});

describe('outputGrokJson', () => {
  const stdoutMock = createGrokStdoutMock();

  beforeEach(() => {
    stdoutMock.mockStdout();
  });

  afterEach(() => {
    stdoutMock.restoreStdout();
  });

  it('writes pretty-printed JSON to stdout', () => {
    outputGrokJson({ decision: 'deny', reason: 'nope' });

    expect(stdoutMock.getOutput()).toBe(
      JSON.stringify({ decision: 'deny', reason: 'nope' }, null, 2)
    );
  });
});

describe('executeGrokHook', () => {
  const stdoutMock = createGrokStdoutMock();
  const stderrMock = createGrokStderrMock();
  let exitRecorder: ReturnType<typeof createGrokExitRecorder>;

  beforeEach(() => {
    stdoutMock.mockStdout();
    stderrMock.mockStderr();
    exitRecorder = createGrokExitRecorder();
  });

  afterEach(() => {
    stdoutMock.restoreStdout();
    stderrMock.restoreStderr();
  });

  it('runs the handler and exits 0 for a valid pre_tool_use envelope', async () => {
    let received: GrokPreToolUseInput | undefined;
    const handler = (input: GrokPreToolUseInput): void => {
      received = input;
      outputGrokJson({ decision: 'allow' });
    };

    await executeGrokHook<GrokPreToolUseInput>(handler, {
      stdin: createGrokStdinMock(createPreToolUseEnvelope()),
      exit: exitRecorder.exit,
    });

    expect(received?.hookEventName).toBe('pre_tool_use');
    expect(received?.toolInput).toEqual({ command: 'pnpm test' });
    expect(stdoutMock.getOutputAsJson()).toEqual({ decision: 'allow' });
    expect(exitRecorder.calls).toEqual([0]);
  });

  it('exits 1 with a stderr log for malformed JSON stdin', async () => {
    const handler = vi.fn();

    await executeGrokHook(handler, {
      stdin: createGrokStdinMock('not json{'),
      exit: exitRecorder.exit,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(stdoutMock.getOutput()).toBe('');
    expect(exitRecorder.calls).toEqual([1]);
    expect(stderrMock.getOutput()).toContain(
      'Failed to parse Grok hook input JSON'
    );
  });

  it('exits 1 with a stderr log for an envelope failing validation', async () => {
    const handler = vi.fn();
    const missingFlag = createGrokHookEnvelope('pre_tool_use', {
      toolName: 'run_terminal_command',
      toolUseId: 'tool-001',
      toolInput: { command: 'pnpm test' },
    });

    await executeGrokHook(handler, {
      stdin: createGrokStdinMock(missingFlag),
      exit: exitRecorder.exit,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(exitRecorder.calls).toEqual([1]);
    expect(stderrMock.getOutput()).toContain(
      'Failed to parse Grok hook input JSON'
    );
  });

  it('exits 1 for an unknown hook event envelope', async () => {
    const handler = vi.fn();

    await executeGrokHook(handler, {
      stdin: createGrokStdinMock(createGrokHookEnvelope('future_event', {})),
      exit: exitRecorder.exit,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(exitRecorder.calls).toEqual([1]);
    expect(stderrMock.getOutput()).toContain(
      'Failed to parse Grok hook input JSON'
    );
  });

  it('exits 1 for a PascalCase hook event name', async () => {
    const handler = vi.fn();

    await executeGrokHook(handler, {
      stdin: createGrokStdinMock(createGrokHookEnvelope('PreToolUse', {})),
      exit: exitRecorder.exit,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(exitRecorder.calls).toEqual([1]);
    expect(stderrMock.getOutput()).toContain(
      'Failed to parse Grok hook input JSON'
    );
  });

  it('prints a deny decision and exits 2 when a pre_tool_use handler throws', async () => {
    const handler = (): void => {
      throw new Error('dangerous command');
    };

    await executeGrokHook<GrokPreToolUseInput>(handler, {
      stdin: createGrokStdinMock(createPreToolUseEnvelope()),
      exit: exitRecorder.exit,
    });

    expect(stdoutMock.getOutputAsJson()).toEqual({
      decision: 'deny',
      reason: 'dangerous command',
    });
    expect(exitRecorder.calls).toEqual([2]);
  });

  it('prints a deny decision and exits 2 when a pre_tool_use handler rejects', async () => {
    const handler = async (): Promise<void> => {
      throw new Error('async denial');
    };

    await executeGrokHook<GrokPreToolUseInput>(handler, {
      stdin: createGrokStdinMock(createPreToolUseEnvelope()),
      exit: exitRecorder.exit,
    });

    expect(stdoutMock.getOutputAsJson()).toEqual({
      decision: 'deny',
      reason: 'async denial',
    });
    expect(exitRecorder.calls).toEqual([2]);
  });

  const stopGateEnvelopes = [
    createGrokHookEnvelope('stop', {
      reason: 'end_turn',
      stopHookActive: false,
    }),
    createGrokHookEnvelope('subagent_stop', {
      phase: 'gate',
      subagentId: 'agent-1',
      subagentType: 'reviewer',
    }),
    createGrokHookEnvelope('subagent_end', {
      phase: 'gate',
      subagentId: 'agent-1',
      subagentType: 'reviewer',
    }),
  ];

  it.each(stopGateEnvelopes)(
    'prints a block decision and exits 2 when a $hookEventName handler throws',
    async envelope => {
      const handler = (): void => {
        throw new Error('unfinished work');
      };

      await executeGrokHook<GrokStopInput>(handler, {
        stdin: createGrokStdinMock(envelope),
        exit: exitRecorder.exit,
      });

      expect(stdoutMock.getOutputAsJson()).toEqual({
        decision: 'block',
        reason: 'unfinished work',
      });
      expect(exitRecorder.calls).toEqual([2]);
    }
  );

  it('exits 1 without a stdout decision when an observe-event handler throws', async () => {
    const handler = (): void => {
      throw new Error('observer boom');
    };

    await executeGrokHook<GrokNotificationInput>(handler, {
      stdin: createGrokStdinMock(createNotificationEnvelope()),
      exit: exitRecorder.exit,
    });

    expect(stdoutMock.getOutput()).toBe('');
    expect(exitRecorder.calls).toEqual([1]);
    expect(stderrMock.getOutput()).toContain('Grok hook execution failed');
    expect(stderrMock.getOutput()).toContain('observer boom');
  });

  it('exits 0 when an observe-event handler succeeds', async () => {
    const handler = vi.fn();

    await executeGrokHook<GrokHookInput>(handler, {
      stdin: createGrokStdinMock(createNotificationEnvelope()),
      exit: exitRecorder.exit,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(exitRecorder.calls).toEqual([0]);
  });

  it('accepts a toolInput string larger than the upstream 128 KiB truncation cap', async () => {
    const oversizedCommand = 'x'.repeat(129 * 1024);
    let received: GrokPreToolUseInput | undefined;
    const handler = (input: GrokPreToolUseInput): void => {
      received = input;
    };

    await executeGrokHook<GrokPreToolUseInput>(handler, {
      stdin: createGrokStdinMock(createPreToolUseEnvelope(oversizedCommand)),
      exit: exitRecorder.exit,
    });

    expect(exitRecorder.calls).toEqual([0]);
    expect(received?.toolInput).toEqual({ command: oversizedCommand });
  });

  it('exits 1 with one stderr diagnostic when stdin never closes within the timeout', async () => {
    const handler = vi.fn();

    await executeGrokHook(handler, {
      stdin: createNeverEndingGrokStdinMock(),
      stdinTimeoutMs: 20,
      exit: exitRecorder.exit,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(exitRecorder.calls).toEqual([1]);
    const stderrOutput = stderrMock.getOutput();
    const timeoutDiagnostics = stderrOutput
      .split('\n')
      .filter(line =>
        line.includes('Timeout waiting for Grok hook stdin input')
      );
    expect(timeoutDiagnostics).toHaveLength(1);
    expect(stderrOutput).not.toContain('Grok hook execution failed');
  });
});
