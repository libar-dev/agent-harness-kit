import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

interface HookCliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BaseHookPayload {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
}

function createBaseHookPayload(): BaseHookPayload {
  return {
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: process.cwd(),
  };
}

function runLifecycleHook(
  script: string,
  input: Record<string, unknown>
): Promise<HookCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${script} to exit`));
    }, 5000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', code => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.stdin.end(JSON.stringify(input));
  });
}

describe('setup handler smoke test', () => {
  it('exits 0 and keeps stdout empty for valid input', async () => {
    const result = await runLifecycleHook('src/lifecycle/setup.ts', {
      ...createBaseHookPayload(),
      hook_event_name: 'Setup',
      trigger: 'init',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Setup hook triggered (init)');
  });

  it('exits non-zero when trigger is missing', async () => {
    const result = await runLifecycleHook('src/lifecycle/setup.ts', {
      ...createBaseHookPayload(),
      hook_event_name: 'Setup',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Failed to parse hook input JSON');
  });
});

describe('message-display handler smoke test', () => {
  it('exits 0 and echoes the display delta for valid input', async () => {
    const result = await runLifecycleHook('src/lifecycle/message-display.ts', {
      ...createBaseHookPayload(),
      hook_event_name: 'MessageDisplay',
      turn_id: '11111111-1111-4111-8111-111111111111',
      message_id: '22222222-2222-4222-8222-222222222222',
      index: 0,
      final: false,
      delta: 'Streaming chunk',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `{\n  "hookSpecificOutput": {\n    "hookEventName": "MessageDisplay",\n    "displayContent": "Streaming chunk"\n  }\n}`
    );
    expect(result.stderr).toBe('');
  });

  it('exits non-zero when message-display UUID input is invalid', async () => {
    const result = await runLifecycleHook('src/lifecycle/message-display.ts', {
      ...createBaseHookPayload(),
      hook_event_name: 'MessageDisplay',
      turn_id: 'not-a-uuid',
      message_id: '22222222-2222-4222-8222-222222222222',
      index: 0,
      final: true,
      delta: 'Streaming chunk',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Failed to parse hook input JSON');
  });
});
