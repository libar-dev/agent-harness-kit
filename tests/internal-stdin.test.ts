import { describe, expect, it } from 'vitest';

import { readBoundedTimedStdin } from '../src/internal/stdin.js';

function stringStdin(text: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf-8');
    },
  };
}

/**
 * Yields one chunk then suspends forever. Proves the byte cap stops
 * consumption and that the timeout path fires without hanging the suite.
 */
function endlessStdin(firstChunk: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(firstChunk, 'utf-8');
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

class TestStdinTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestStdinTimeoutError';
  }
}

describe('readBoundedTimedStdin', () => {
  it('returns an empty string for an empty stdin source', async () => {
    const stderr = createSinkRecorder();
    const exits: number[] = [];

    const text = await readBoundedTimedStdin({
      stdin: stringStdin(''),
      maxBytes: 1024,
      timeoutMs: 1000,
      stderr,
      exit: (code: number) => {
        exits.push(code);
      },
      timeoutMessage: 'Timeout waiting for test stdin input',
      createTimeoutError: () =>
        new TestStdinTimeoutError('Timeout waiting for test stdin input'),
    });

    expect(text).toBe('');
    expect(stderr.text).toBe('');
    expect(exits).toEqual([]);
  });

  it('stops consuming once the byte cap is reached and keeps the retained prefix', async () => {
    const stderr = createSinkRecorder();
    const exits: number[] = [];
    // First chunk is exactly the cap; a second chunk would hang if consumed.
    const first = 'abcdefgh'; // 8 bytes
    const source: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(first, 'utf-8');
        yield Buffer.from('SHOULD_NOT_BE_READ', 'utf-8');
        await new Promise<never>(() => {});
      },
    };

    const text = await readBoundedTimedStdin({
      stdin: source,
      maxBytes: 8,
      timeoutMs: 1000,
      stderr,
      exit: (code: number) => {
        exits.push(code);
      },
      timeoutMessage: 'Timeout waiting for test stdin input',
      createTimeoutError: () =>
        new TestStdinTimeoutError('Timeout waiting for test stdin input'),
    });

    expect(text).toBe(first);
    expect(Buffer.byteLength(text, 'utf-8')).toBe(8);
    expect(stderr.text).toBe('');
    expect(exits).toEqual([]);
  });

  it('retains only the byte cap when a single chunk exceeds the cap', async () => {
    const stderr = createSinkRecorder();
    const exits: number[] = [];
    const cap = 1024 * 1024;
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const source: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        yield oversized;
      },
    };

    const text = await readBoundedTimedStdin({
      stdin: source,
      maxBytes: cap,
      timeoutMs: 1000,
      stderr,
      exit: (code: number) => {
        exits.push(code);
      },
      timeoutMessage: 'Timeout waiting for test stdin input',
      createTimeoutError: () =>
        new TestStdinTimeoutError('Timeout waiting for test stdin input'),
    });

    expect(Buffer.byteLength(text, 'utf-8')).toBe(cap);
    expect(stderr.text).toBe('');
    expect(exits).toEqual([]);
  });

  it('retains only the remaining budget when an oversized chunk arrives after partial data', async () => {
    const stderr = createSinkRecorder();
    const exits: number[] = [];
    const cap = 1024 * 1024;
    const first = Buffer.alloc(512 * 1024, 0x62);
    const second = Buffer.alloc(2 * 1024 * 1024, 0x63);
    const source: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        yield first;
        yield second;
        yield Buffer.alloc(1024, 0x64);
      },
    };

    const text = await readBoundedTimedStdin({
      stdin: source,
      maxBytes: cap,
      timeoutMs: 1000,
      stderr,
      exit: (code: number) => {
        exits.push(code);
      },
      timeoutMessage: 'Timeout waiting for test stdin input',
      createTimeoutError: () =>
        new TestStdinTimeoutError('Timeout waiting for test stdin input'),
    });

    expect(Buffer.byteLength(text, 'utf-8')).toBe(cap);
    expect(stderr.text).toBe('');
    expect(exits).toEqual([]);
  });

  it('logs, exits 1, and rejects when stdin never completes before the timeout', async () => {
    const stderr = createSinkRecorder();
    const exits: number[] = [];

    await expect(
      readBoundedTimedStdin({
        stdin: endlessStdin('{"partial":'),
        maxBytes: 1024 * 1024,
        timeoutMs: 10,
        stderr,
        exit: (code: number) => {
          exits.push(code);
        },
        timeoutMessage: 'Timeout waiting for test stdin input',
        createTimeoutError: () =>
          new TestStdinTimeoutError('Timeout waiting for test stdin input'),
      })
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof TestStdinTimeoutError &&
        error.message === 'Timeout waiting for test stdin input'
      );
    });

    expect(exits).toEqual([1]);
    expect(stderr.text).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T.*Z\] ERROR: Timeout waiting for test stdin input\n$/
    );
  });
});
