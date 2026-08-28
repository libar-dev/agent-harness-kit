import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import {
  mkdtemp,
  writeFile,
  rm,
  stat,
  appendFile,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  try {
    const result = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', script, ...args],
      {
        env: { ...process.env, ...env },
      }
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const execError = getExecError(err);
    return {
      code: execError.code ?? 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
    };
  }
}

function getExecError(err: unknown): {
  code?: number;
  stdout?: string;
  stderr?: string;
} {
  if (!isRecord(err)) return {};
  return {
    ...(typeof err['code'] === 'number' ? { code: err['code'] } : {}),
    ...(typeof err['stdout'] === 'string' ? { stdout: err['stdout'] } : {}),
    ...(typeof err['stderr'] === 'string' ? { stderr: err['stderr'] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Event-driven wait for child-process output. Subscribes to stream data
 * events and resolves on the first buffer match - no polling sleeps.
 * Hang budget uses AbortSignal.timeout (wall-clock ceiling only).
 */
async function waitForOutput(
  reader: () => string,
  pattern: RegExp,
  subscribe: (listener: () => void) => () => void,
  timeoutMs = 5000
): Promise<string> {
  const existing = reader();
  if (pattern.test(existing)) return existing;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const hang = AbortSignal.timeout(timeoutMs);

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      hang.removeEventListener('abort', onHang);
      action();
    };

    const onHang = (): void => {
      finish(() => {
        reject(new Error(`Timed out waiting for ${String(pattern)}`));
      });
    };

    const onData = (): void => {
      const output = reader();
      if (pattern.test(output)) {
        finish(() => {
          resolve(output);
        });
      }
    };

    hang.addEventListener('abort', onHang, { once: true });
    const unsubscribe = subscribe(onData);
    // Catch data that arrived between the initial check and subscribe.
    onData();
  });
}

function makeUserTextLine(uuid: string, text: string, ts: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

describe('CLI argument validation', () => {
  let tmp: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cli-test-'));
    jsonlPath = join(tmp, 'session.jsonl');
    await writeFile(
      jsonlPath,
      makeUserTextLine('u-1', 'hello', '2026-02-16T20:00:00.000Z')
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects non-numeric tail debounce values', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--watch',
      '--debounce-ms',
      'abc',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      '--debounce-ms must be a non-negative integer'
    );
  });

  it('accepts zero tail debounce values', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--debounce-ms',
      '0',
      '--dry-run',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('"blockCount":1');
  });

  it('emits tail blocks on stdout before the stderr summary', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--dry-run',
    ]);
    const fileSize = (await stat(jsonlPath)).size;

    const firstStdoutLine = result.stdout.trim().split('\n')[0];
    expect(result.code).toBe(0);
    expect(firstStdoutLine).toBeDefined();
    expect(JSON.parse(firstStdoutLine ?? '{}')).toMatchObject({
      id: 'u-1:0',
      type: 'user_text',
      content: 'hello',
    });
    expect(result.stderr.trim()).toBe(
      JSON.stringify({
        blockCount: 1,
        previousByteOffset: 0,
        newByteOffset: fileSize,
        fileSize,
        fileRotated: false,
        markerAdvanced: false,
      })
    );
  });

  it('emits raw transcript records when requested', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--dry-run',
      '--format',
      'raw-records',
      '--unsafe-raw-unredacted',
    ]);

    const firstStdoutLine = result.stdout.trim().split('\n')[0];
    expect(result.code).toBe(0);
    expect(JSON.parse(firstStdoutLine ?? '{}')).toMatchObject({
      id: 's1:main:u-1',
      sourceKind: 'main',
      sourceId: 'main',
      type: 'user',
      uuid: 'u-1',
      payload: {
        message: { role: 'user', content: 'hello' },
      },
    });
    const fileSize = (await stat(jsonlPath)).size;
    expect(JSON.parse(result.stderr.trim())).toEqual({
      recordCount: 1,
      previousByteOffset: 0,
      newByteOffset: fileSize,
      fileSize,
      fileRotated: false,
      markerAdvanced: false,
      unsafeRawUnredacted: true,
      warning:
        'UNSAFE raw-records mode exposes exact transcript payloads and rawLine bytes.',
    });
    expect(result.stderr).not.toContain('"blockCount"');
  });

  it('keeps verbose progress separate from the JSON summary', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--verbose',
      '--format',
      'raw-records',
      '--unsafe-raw-unredacted',
    ]);
    const stderrLines = result.stderr.trim().split('\n');
    const summaryLine = stderrLines.at(-1);

    expect(result.code).toBe(0);
    expect(stderrLines[0]).toBe(
      'tail: WARNING unsafe raw-records mode exposes exact transcript payloads and rawLine bytes'
    );
    expect(stderrLines[1]).toMatch(/^tail: 1 new records \(offset 0 → \d+\)$/);
    expect(JSON.parse(summaryLine ?? '{}')).toMatchObject({
      recordCount: 1,
      markerAdvanced: true,
      unsafeRawUnredacted: true,
    });
  });

  it('rejects raw-records mode without the explicit unsafe opt-in flag', async () => {
    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--dry-run',
      '--format',
      'raw-records',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      '--format raw-records requires --unsafe-raw-unredacted'
    );
  });

  it('rejects non-numeric export days values', async () => {
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--days',
      'abc',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--days must be a non-negative integer');
  });

  it('rejects non-numeric export limit values', async () => {
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--limit',
      'abc',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--limit must be a non-negative integer');
  });

  it('rejects unknown filename styles', async () => {
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--filename-style',
      'invalid',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      '--filename-style must be one of: date, webui'
    );
  });

  it('rejects unknown export formats', async () => {
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--format',
      'invalid',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      '--format must be one of: markdown, md, jsonl, json, both'
    );
  });

  it('suppresses tool_result blocks in tail JSONL when --no-tool-results is set', async () => {
    const toolSession =
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'Read',
              input: { file_path: '/repo/.env' },
            },
          ],
        },
        sessionId: 's1',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-1',
      })}\n` +
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'API_KEY=secret',
            },
          ],
        },
        sessionId: 's1',
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'u-2',
      })}\n`;
    await writeFile(jsonlPath, toolSession);

    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--dry-run',
      '--no-tool-results',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"type":"tool_use"');
    expect(result.stdout).not.toContain('"type":"tool_result"');
  });

  it('redacts tool_result blocks in tail JSONL by default', async () => {
    const toolSession =
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-redact',
              name: 'Read',
              input: { file_path: '/repo/.env' },
            },
          ],
        },
        sessionId: 's1',
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-1',
      })}\n` +
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-redact',
              content: 'api_key=super-secret\nAuthorization: Bearer top-secret',
            },
          ],
        },
        sessionId: 's1',
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'u-2',
      })}\n`;
    await writeFile(jsonlPath, toolSession);

    const result = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--dry-run',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('api_key=[REDACTED:API_KEY]');
    expect(result.stdout).toContain('Authorization: [REDACTED:AUTHORIZATION]');
    expect(result.stdout).not.toContain('super-secret');
    expect(result.stdout).not.toContain('top-secret');
  });

  it('suppresses tool_result blocks in exported JSONL when --no-tool-results is set', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await writeFile(
      join(tmp, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-export',
              name: 'Read',
              input: { file_path: '/repo/.env' },
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-1',
      })}\n${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-export',
              content: 'API_KEY=secret',
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'u-1',
      })}\n`
    );

    const outDir = join(tmp, 'out');
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--out',
      outDir,
      '--format',
      'jsonl',
      '--no-tool-results',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.jsonl');
    const exportedPath = join(outDir, '2026-02-16_2000_11111111.jsonl');
    const exportedStats = await stat(exportedPath);
    expect(exportedStats.isFile()).toBe(true);
    const exportedContent = await readFile(exportedPath, 'utf8');
    expect(exportedContent).toContain('"type":"tool_use"');
    expect(exportedContent).not.toContain('"type":"tool_result"');
  });

  it('redacts tool_result blocks in exported JSONL by default', async () => {
    const sessionId = '44444444-4444-4444-4444-444444444444';
    await writeFile(
      join(tmp, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-export-redact',
              name: 'Read',
              input: { file_path: '/repo/.env' },
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-1',
      })}\n${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-export-redact',
              content:
                'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv\nhttps://user:pass@example.com/repo',
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'u-1',
      })}\n`
    );

    const outDir = join(tmp, 'out-redact');
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--out',
      outDir,
      '--format',
      'jsonl',
    ]);

    expect(result.code).toBe(0);
    const exportedPath = join(outDir, '2026-02-16_2000_44444444.jsonl');
    const exportedContent = await readFile(exportedPath, 'utf8');
    expect(exportedContent).toContain('[REDACTED:OPENAI_API_KEY]');
    expect(exportedContent).toContain('[REDACTED:URL_CREDENTIALS]');
    expect(exportedContent).not.toContain(
      'sk-1234567890abcdefghijklmnopqrstuv'
    );
    expect(exportedContent).not.toContain('user:pass@example.com');
  });

  it('keeps markdown exports free of raw tool_result content by default', async () => {
    const sessionId = '22222222-2222-2222-2222-222222222222';
    await writeFile(
      join(tmp, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-export-md',
              name: 'Read',
              input: { file_path: '/repo/.env' },
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:00.000Z',
        uuid: 'a-1',
      })}\n${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-export-md',
              content: 'API_KEY=secret',
            },
          ],
        },
        sessionId,
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'u-1',
      })}\n`
    );

    const outDir = join(tmp, 'out-md');
    const result = await runCli('src/cli/export-sessions.ts', [
      '--project-dir',
      tmp,
      '--out',
      outDir,
      '--format',
      'markdown',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.md');
    const exportedPath = join(outDir, '2026-02-16_2000_22222222.md');
    const exportedContent = await readFile(exportedPath, 'utf8');
    expect(exportedContent).toContain('### Tool: Read(/repo/.env)');
    expect(exportedContent).not.toContain('### Read Result');
    expect(exportedContent).not.toContain('API_KEY=secret');
  });

  it('prints tail-session help and exits successfully', async () => {
    const result = await runCli('src/cli/tail-session.ts', ['--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).toContain('claude-session-tail <session-jsonl-path>');
  });

  it('prints export-sessions help and exits successfully', async () => {
    const result = await runCli('src/cli/export-sessions.ts', ['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('claude-session-export [project-path]');
  });

  const watchSignals = ['SIGINT', 'SIGTERM'] as const;

  it.each(watchSignals)(
    'shuts down watch mode cleanly on %s after emitting appended blocks',
    async signal => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli/tail-session.ts',
          jsonlPath,
          '--watch',
          '--dry-run',
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
      const subscribeStdout = (listener: () => void): (() => void) => {
        child.stdout.on('data', listener);
        return () => {
          child.stdout.off('data', listener);
        };
      };

      try {
        await waitForOutput(() => stdout, /"id":"u-1:0"/, subscribeStdout);

        await appendFile(
          jsonlPath,
          makeUserTextLine('u-2', 'follow-up', '2026-02-16T20:00:01.000Z')
        );

        await waitForOutput(() => stdout, /"id":"u-2:0"/, subscribeStdout);

        child.kill(signal);
        const exitResult: unknown[] = await once(child, 'exit');
        const code = exitResult[0];
        const exitSignal = exitResult[1];

        expect(exitSignal).toBeNull();
        expect(code).toBe(0);
        expect(stdout).toContain('"id":"u-1:0"');
        expect(stdout).toContain('"id":"u-2:0"');
        expect(stderr).toContain('"markerAdvanced":false');
      } finally {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }
    }
  );

  it.each(watchSignals)(
    'installs watch shutdown handlers before the first pass on %s',
    async signal => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli/tail-session.ts',
          jsonlPath,
          '--watch',
          '--dry-run',
          '--verbose',
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
      const subscribeStderr = (listener: () => void): (() => void) => {
        child.stderr.on('data', listener);
        return () => {
          child.stderr.off('data', listener);
        };
      };

      try {
        await waitForOutput(() => stderr, /tail: watching /, subscribeStderr);

        child.kill(signal);
        const exitResult: unknown[] = await once(child, 'exit');
        const code = exitResult[0];
        const exitSignal = exitResult[1];

        expect(exitSignal).toBeNull();
        expect(code).toBe(0);
        expect(stderr).not.toContain('Error during shutdown');
      } finally {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }
    }
  );
});
