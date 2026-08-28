import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readStdin, resetConfigCache } from '../src/utils/index.js';

const ONE_MIB = 1024 * 1024;
const TWO_MIB = 2 * ONE_MIB;
const PIPE_CHUNK_BYTES = 64 * 1024;

interface MockReadableStdin {
  data: string;
  hang: boolean;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

interface MockWritableStream {
  output: string;
  write(data: string): boolean;
}

interface MockProcess {
  stdin: MockReadableStdin;
  stdout: MockWritableStream;
  stderr: MockWritableStream;
  exit: ReturnType<typeof vi.fn>;
  env: Record<string, string | undefined>;
}

vi.mock('node:process', () => {
  const mockStdin: MockReadableStdin = {
    data: '',
    hang: false,
    async *[Symbol.asyncIterator]() {
      const buffer = Buffer.from(mockStdin.data, 'utf-8');
      for (
        let offset = 0;
        offset < buffer.byteLength;
        offset += PIPE_CHUNK_BYTES
      ) {
        yield buffer.subarray(offset, offset + PIPE_CHUNK_BYTES);
      }
      if (mockStdin.hang) {
        await new Promise<never>(() => {});
      }
    },
  };

  const mockStdout: MockWritableStream = {
    output: '',
    write(data: string) {
      mockStdout.output += data;
      return true;
    },
  };

  const mockStderr: MockWritableStream = {
    output: '',
    write(data: string) {
      mockStderr.output += data;
      return true;
    },
  };

  return {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    exit: vi.fn(),
    env: {},
  };
});

async function getMockProcess(): Promise<MockProcess> {
  const proc: unknown = await import('node:process');
  if (!isMockProcess(proc)) {
    throw new Error('Expected mocked node:process');
  }
  return proc;
}

function isMockProcess(value: unknown): value is MockProcess {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stdin' in value) || !('stdout' in value) || !('stderr' in value)) {
    return false;
  }
  if (!('exit' in value) || !('env' in value)) return false;
  return true;
}

describe('Claude readStdin cap and timeout', () => {
  beforeEach(async () => {
    const proc = await getMockProcess();
    proc.stdin.data = '';
    proc.stdin.hang = false;
    proc.stdout.output = '';
    proc.stderr.output = '';
    proc.exit.mockClear();
    resetConfigCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains only the first 1 MiB of a 2 MiB stdin', async () => {
    const proc = await getMockProcess();
    proc.stdin.data = 'x'.repeat(TWO_MIB);

    const text = await readStdin();

    expect(Buffer.byteLength(text, 'utf-8')).toBe(ONE_MIB);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('preserves the 30s stdin timeout exactly', async () => {
    vi.useFakeTimers();
    const proc = await getMockProcess();
    proc.stdin.hang = true;

    const pending = readStdin();
    void pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(proc.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(proc.stderr.output).toContain('Timeout waiting for stdin input');
  });
});
