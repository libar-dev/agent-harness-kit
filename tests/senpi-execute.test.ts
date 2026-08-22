import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  executeSenpiHook,
  outputSenpiJson,
  readSenpiStdinJson,
  type SenpiCommandRunResult,
  type SenpiHookRunnerTarget,
} from '../src/senpi/execute.js';
import type { SenpiCommandHookConfig } from '../src/senpi/settings.js';
import type { SenpiHookInput } from '../src/senpi/hook-wire.js';

/** Loads one of the hand-authored per-event fixture envelopes. */
function fixtureEnvelope(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`./fixtures/senpi/hook-inputs/${name}.json`, import.meta.url)
    ),
    'utf-8'
  );
}

function stringStdin(text: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf-8');
    },
  };
}

/**
 * A stdin source that never ends: yields one chunk, then suspends forever.
 * Used to prove the byte cap stops consumption and the timeout fires.
 */
function endlessStdin(): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"event":"Stop"', 'utf-8');
      await new Promise<never>(() => {});
    },
  };
}

interface SinkRecorder {
  text: string;
  write(chunk: string): void;
}

function createSinkRecorder(): SinkRecorder {
  const recorder = {
    text: '',
    write(chunk: string): void {
      recorder.text += chunk;
    },
  };
  return recorder;
}

interface ExitRecorder {
  readonly calls: number[];
  exit(code: number): void;
}

function createExitRecorder(): ExitRecorder {
  const recorder = { calls: [] as number[] };
  return {
    calls: recorder.calls,
    exit(code: number): void {
      recorder.calls.push(code);
    },
  };
}

function createTarget(
  event: SenpiHookRunnerTarget['event'],
  config?: Partial<SenpiCommandHookConfig>
): SenpiHookRunnerTarget {
  return {
    event,
    config: { type: 'command', command: 'echo hi', ...config },
  };
}

function cannedRun(
  overrides: Partial<SenpiCommandRunResult>
): SenpiCommandRunResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

/**
 * Full injected-seam harness around executeSenpiHook: recorded exit hook,
 * recording stdout/stderr sinks, and a runCommand seam that returns the
 * given canned result while recording every call.
 */
function createHarness(result: SenpiCommandRunResult) {
  const exits: number[] = [];
  const stdout = createSinkRecorder();
  const stderr = createSinkRecorder();
  const runCommands: Array<{
    command: string;
    input: SenpiHookInput;
    target: SenpiHookRunnerTarget;
  }> = [];

  async function run(
    target: SenpiHookRunnerTarget,
    stdinText: string
  ): Promise<void> {
    await executeSenpiHook(target, {
      stdin: stringStdin(stdinText),
      stdout,
      stderr,
      exit: code => exits.push(code),
      platform: 'linux',
      runCommand: async (command, input, target) => {
        runCommands.push({ command, input, target });
        return result;
      },
    });
  }

  return { exits, stdout, stderr, runCommands, run };
}

describe('readSenpiStdinJson', () => {
  it('returns the validated pre-tool-use fixture envelope with aliases normalized', async () => {
    const input = await readSenpiStdinJson({
      stdin: stringStdin(fixtureEnvelope('pre-tool-use')),
    });

    expect(input.event).toBe('PreToolUse');
    if (input.event === 'PreToolUse') {
      expect(input.toolName).toBe('read_file');
      expect(input.toolInput).toEqual({ path: '/project/src/example.ts' });
      expect(input.session_id).toBe('sess-pre-tool-use-0003');
    }
  });

  it('rejects malformed JSON with a parse-failure message', async () => {
    await expect(
      readSenpiStdinJson({ stdin: stringStdin('not json{') })
    ).rejects.toThrow('Failed to parse Senpi hook input JSON');
  });

  it('rejects an envelope failing wire validation', async () => {
    await expect(
      readSenpiStdinJson({
        stdin: stringStdin('{"event":"PreToolUse","cwd":"/project"}'),
      })
    ).rejects.toThrow('Failed to parse Senpi hook input JSON');
  });

  it('truncates oversized stdin at the byte cap without hanging', async () => {
    // The endless stream would never finish on its own; the cap must stop
    // consumption immediately and the retained prefix fails JSON parsing.
    await expect(
      readSenpiStdinJson({ stdin: endlessStdin(), maxStdinBytes: 8 })
    ).rejects.toThrow('Failed to parse Senpi hook input JSON');
  });

  it('logs a timeout and invokes the exit hook with 1 when stdin never arrives', async () => {
    const exits = createExitRecorder();

    await expect(
      readSenpiStdinJson({
        stdin: endlessStdin(),
        exit: exits.exit,
        stdinTimeoutMs: 10,
        maxStdinBytes: 1024 * 1024,
      })
    ).rejects.toThrow(/Timeout waiting for Senpi hook stdin input/);

    expect(exits.calls).toEqual([1]);
  });
});

describe('outputSenpiJson', () => {
  it('writes pretty-printed JSON plus a trailing newline to the injected sink', () => {
    const sink = createSinkRecorder();

    outputSenpiJson({ decision: 'block', reason: 'nope' }, sink);

    expect(sink.text).toBe(
      `${JSON.stringify({ decision: 'block', reason: 'nope' }, null, 2)}\n`
    );
  });
});

describe('executeSenpiHook', () => {
  it('passes valid child JSON through and exits 0', async () => {
    const harness = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          continue: true,
          stopReason: 'done',
          suppressOutput: false,
          systemMessage: 'hello',
        }),
      })
    );

    await harness.run(
      createTarget('PreToolUse'),
      fixtureEnvelope('pre-tool-use')
    );

    expect(harness.runCommands).toHaveLength(1);
    expect(JSON.parse(harness.stdout.text)).toEqual({
      continue: true,
      stopReason: 'done',
      suppressOutput: false,
      systemMessage: 'hello',
    });
    expect(harness.exits).toEqual([0]);
    expect(harness.stderr.text).toBe('');
  });

  it('maps child exit code 2 to a block decision carrying trimmed stderr', async () => {
    const harness = createHarness(
      cannedRun({
        stdout: 'ignored on this path',
        stderr: '  boom \n ',
        exitCode: 2,
      })
    );

    await harness.run(
      createTarget('PostToolUse'),
      fixtureEnvelope('post-tool-use')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({
      decision: 'block',
      reason: 'boom',
    });
    expect(harness.exits).toEqual([0]);
  });

  it('omits reason when child exit code 2 carries blank stderr', async () => {
    const harness = createHarness(cannedRun({ stderr: '   \n', exitCode: 2 }));

    await harness.run(
      createTarget('PostToolUse'),
      fixtureEnvelope('post-tool-use')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({ decision: 'block' });
    expect(harness.exits).toEqual([0]);
  });

  it('treats malformed child stdout as a diagnostic no-op exiting 0', async () => {
    const harness = createHarness(cannedRun({ stdout: 'not json{' }));

    await harness.run(
      createTarget('PreToolUse'),
      fixtureEnvelope('pre-tool-use')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({});
    expect(harness.exits).toEqual([0]);
    expect(harness.stderr.text).toContain('invalid_root');
  });

  it('treats non-object child stdout as a no-op exiting 0', async () => {
    const harness = createHarness(cannedRun({ stdout: '[1,2,3]' }));

    await harness.run(
      createTarget('PreToolUse'),
      fixtureEnvelope('pre-tool-use')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({});
    expect(harness.exits).toEqual([0]);
    expect(harness.stderr.text).toContain('invalid_root');
  });

  it('drops decisions on SessionStart but keeps its systemMessage', async () => {
    const harness = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          decision: 'block',
          reason: 'should not survive',
          systemMessage: 'session started',
        }),
      })
    );

    await harness.run(
      createTarget('SessionStart'),
      fixtureEnvelope('session-start')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({
      systemMessage: 'session started',
    });
    expect(harness.exits).toEqual([0]);
    expect(harness.stderr.text).toContain(
      'SessionStart does not support decisions.'
    );
  });

  it('drops both decision and systemMessage on gate-out PreCompact', async () => {
    const harness = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          decision: 'block',
          systemMessage: 'not for compact events',
          stopReason: 'kept',
        }),
      })
    );

    await harness.run(
      createTarget('PreCompact'),
      fixtureEnvelope('pre-compact')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({ stopReason: 'kept' });
    expect(harness.exits).toEqual([0]);
    expect(harness.stderr.text).toContain(
      'Hook systemMessage is not supported for this event.'
    );
  });

  it('derives block from continue:false on Stop', async () => {
    const harness = createHarness(
      cannedRun({ stdout: JSON.stringify({ continue: false }) })
    );

    await harness.run(createTarget('Stop'), fixtureEnvelope('stop'));

    expect(JSON.parse(harness.stdout.text)).toEqual({
      continue: false,
      decision: 'block',
    });
    expect(harness.exits).toEqual([0]);
  });

  it('applies PreToolUse updatedInput only when permissionDecision is allow', async () => {
    const allow = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'safe',
            updatedInput: { path: '/project/src/other.ts' },
          },
        }),
      })
    );
    await allow.run(
      createTarget('PreToolUse'),
      fixtureEnvelope('pre-tool-use')
    );
    expect(JSON.parse(allow.stdout.text)).toEqual({
      decision: 'allow',
      reason: 'safe',
      updatedInput: { path: '/project/src/other.ts' },
    });
    expect(allow.exits).toEqual([0]);

    const deny = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            updatedInput: { path: '/project/src/other.ts' },
          },
        }),
      })
    );
    await deny.run(createTarget('PreToolUse'), fixtureEnvelope('pre-tool-use'));
    expect(JSON.parse(deny.stdout.text)).toEqual({ decision: 'deny' });
    expect(deny.stderr.text).toContain('permissionDecision is allow');
    expect(deny.exits).toEqual([0]);
  });

  it('keeps universal fields but skips specifics on hookEventName mismatch', async () => {
    const harness = createHarness(
      cannedRun({
        stdout: JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'from another event',
          },
        }),
      })
    );

    await harness.run(
      createTarget('PreToolUse'),
      fixtureEnvelope('pre-tool-use')
    );

    expect(JSON.parse(harness.stdout.text)).toEqual({ continue: true });
    expect(harness.stderr.text).toContain(
      'Hook output event PostToolUse does not match PreToolUse.'
    );
    expect(harness.exits).toEqual([0]);
  });

  it('exits 1 with a stderr log for an envelope failing validation', async () => {
    const harness = createHarness(cannedRun({}));

    await harness.run(createTarget('PreToolUse'), '{"event":"PreToolUse"}');

    expect(harness.runCommands).toHaveLength(0);
    expect(harness.stdout.text).toBe('');
    expect(harness.exits).toEqual([1]);
    expect(harness.stderr.text).toContain(
      'Failed to parse Senpi hook input JSON'
    );
  });

  it('exits 1 when the injected runCommand seam throws', async () => {
    const exits = createExitRecorder();
    const stderrSink = createSinkRecorder();

    await executeSenpiHook(createTarget('PreToolUse'), {
      stdin: stringStdin(fixtureEnvelope('pre-tool-use')),
      stderr: stderrSink,
      exit: exits.exit,
      platform: 'linux',
      runCommand: async () => {
        throw new Error('spawn gone');
      },
    });

    expect(exits.calls).toEqual([1]);
    expect(stderrSink.text).toContain('spawn gone');
  });

  it('selects commandWindows on injected win32 and command elsewhere', async () => {
    const target = createTarget('PreToolUse', {
      command: 'posix-command',
      commandWindows: 'windows-command',
    });

    const winRuns: string[] = [];
    await executeSenpiHook(target, {
      stdin: stringStdin(fixtureEnvelope('pre-tool-use')),
      exit: () => {},
      platform: 'win32',
      runCommand: async command => {
        winRuns.push(command);
        return cannedRun({});
      },
    });
    expect(winRuns).toEqual(['windows-command']);

    const posixRuns: string[] = [];
    await executeSenpiHook(target, {
      stdin: stringStdin(fixtureEnvelope('pre-tool-use')),
      exit: () => {},
      platform: 'linux',
      runCommand: async command => {
        posixRuns.push(command);
        return cannedRun({});
      },
    });
    expect(posixRuns).toEqual(['posix-command']);

    // win32 without a commandWindows override falls back to command.
    const fallbackRuns: string[] = [];
    await executeSenpiHook(
      createTarget('PreToolUse', { command: 'only-command' }),
      {
        stdin: stringStdin(fixtureEnvelope('pre-tool-use')),
        exit: () => {},
        platform: 'win32',
        runCommand: async command => {
          fallbackRuns.push(command);
          return cannedRun({});
        },
      }
    );
    expect(fallbackRuns).toEqual(['only-command']);
  });
});
