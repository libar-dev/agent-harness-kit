import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const snapshotRace = vi.hoisted(() => ({
  targetPath: '',
  appendAfterStat: Buffer.alloc(0),
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: async (path: PathLike, flags: string): Promise<FileHandle> => {
      const handle = await actual.open(path, flags);
      if (String(path) !== snapshotRace.targetPath) return handle;

      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (): Promise<
              Awaited<ReturnType<FileHandle['stat']>>
            > => {
              const snapshot = await target.stat();
              if (snapshotRace.appendAfterStat.byteLength > 0) {
                const appended = snapshotRace.appendAfterStat;
                snapshotRace.appendAfterStat = Buffer.alloc(0);
                await actual.appendFile(path, appended);
              }
              return snapshot;
            };
          }
          if (property === 'read') return target.read.bind(target);
          if (property === 'close') return target.close.bind(target);
          if (property === 'then') return undefined;
          throw new Error(`Unexpected FileHandle property ${String(property)}`);
        },
      });
    },
  };
});

import {
  readJsonlDelta,
  type JsonlCursor,
} from '../src/grok/processing/jsonl-cursor.js';

const mib = 1024 * 1024;

describe('Grok JSONL cursor', () => {
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'grok-jsonl-cursor-')
    );
  });

  afterAll(async () => {
    snapshotRace.targetPath = '';
    snapshotRace.appendAfterStat = Buffer.alloc(0);
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
    await expect(fsPromises.stat(fixtureRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reads appended complete lines once with byte-accurate offsets', async () => {
    const path = join(fixtureRoot, 'append.jsonl');
    const content = 'alpha\nβeta\nthird\n';
    await fsPromises.writeFile(path, content);

    const first = await readJsonlDelta(path, null);

    expect(first.lines).toEqual([
      { value: 'alpha', lineNumber: 1, byteStart: 0, byteEnd: 6 },
      { value: 'βeta', lineNumber: 2, byteStart: 6, byteEnd: 12 },
      { value: 'third', lineNumber: 3, byteStart: 12, byteEnd: 18 },
    ]);
    expect(first.diagnostics).toEqual([]);
    expect(first.cursor).toMatchObject({
      offset: Buffer.byteLength(content),
      lineNumber: 4,
      generation: 0,
    });

    const second = await readJsonlDelta(path, first.cursor);
    expect(second.lines).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it('holds a partial tail and emits it exactly once after completion', async () => {
    const path = join(fixtureRoot, 'partial.jsonl');
    await fsPromises.writeFile(path, 'line1\npar');

    const first = await readJsonlDelta(path, null);
    expect(first.lines.map(line => `${line.value}\n`)).toEqual(['line1\n']);
    expect(first.cursor?.offset).toBe(Buffer.byteLength('line1\n'));

    await fsPromises.appendFile(path, 'tial\n');
    const second = await readJsonlDelta(path, first.cursor);
    expect(second.lines.map(line => `${line.value}\n`)).toEqual(['partial\n']);
    expect(second.lines[0]).toMatchObject({
      lineNumber: 2,
      byteStart: Buffer.byteLength('line1\n'),
      byteEnd: Buffer.byteLength('line1\npartial\n'),
    });

    const third = await readJsonlDelta(path, second.cursor);
    expect(third.lines).toEqual([]);
  });

  it('detects truncate-regrow on the same inode and rescans from byte zero', async () => {
    const path = join(fixtureRoot, 'truncate.jsonl');
    await fsPromises.writeFile(path, 'old-one\nold-two\n');
    const first = await readJsonlDelta(path, null);
    const originalIdentity = await fsPromises.stat(path);

    await fsPromises.truncate(path, 0);
    await fsPromises.writeFile(path, 'fresh\n');
    const replacementIdentity = await fsPromises.stat(path);
    expect(replacementIdentity.ino).toBe(originalIdentity.ino);

    const second = await readJsonlDelta(path, first.cursor);
    expect(second.reset).toBe(true);
    expect(second.cursor?.generation).toBe(1);
    expect(second.lines).toEqual([
      { value: 'fresh', lineNumber: 1, byteStart: 0, byteEnd: 6 },
    ]);
  });

  it('detects inode replacement and rescans from byte zero', async () => {
    const path = join(fixtureRoot, 'replacement.jsonl');
    const replacementPath = join(fixtureRoot, 'replacement.tmp');
    await fsPromises.writeFile(path, 'old\n');
    const first = await readJsonlDelta(path, null);

    await fsPromises.writeFile(replacementPath, 'new-one\nnew-two\n');
    await fsPromises.rename(replacementPath, path);

    const second = await readJsonlDelta(path, first.cursor);
    expect(second.reset).toBe(true);
    expect(second.cursor?.generation).toBe(1);
    expect(second.lines.map(line => line.value)).toEqual([
      'new-one',
      'new-two',
    ]);
    expect(second.lines[0]?.byteStart).toBe(0);
  });

  it('stream-discards an oversized line, diagnoses it, and continues', async () => {
    const path = join(fixtureRoot, 'oversized.jsonl');
    const oversizedLength = 17 * mib + 1;
    const handle = await fsPromises.open(path, 'w');
    try {
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let written = 0;
      while (written < oversizedLength) {
        const length = Math.min(chunk.byteLength, oversizedLength - written);
        await handle.write(chunk, 0, length);
        written += length;
      }
      await handle.write(Buffer.from('\nnormal\n'));
    } finally {
      await handle.close();
    }

    const result = await readJsonlDelta(path, null);

    expect(result.diagnostics).toEqual([
      {
        kind: 'oversized',
        lineNumber: 1,
        byteStart: 0,
        byteEnd: oversizedLength + 1,
      },
    ]);
    expect(result.lines).toEqual([
      {
        value: 'normal',
        lineNumber: 2,
        byteStart: oversizedLength + 1,
        byteEnd: oversizedLength + 8,
      },
    ]);
    expect(result.cursor?.offset).toBe(oversizedLength + 8);
  });

  it('defers bytes appended after the open-file size snapshot', async () => {
    const path = join(fixtureRoot, 'snapshot.jsonl');
    await fsPromises.writeFile(path, 'inside\n');
    snapshotRace.targetPath = path;
    snapshotRace.appendAfterStat = Buffer.from('outside\n');

    const first = await readJsonlDelta(path, null, { maxLineBytes: 3 });
    expect(first.lines).toEqual([]);
    expect(first.diagnostics).toEqual([
      { kind: 'oversized', lineNumber: 1, byteStart: 0, byteEnd: 7 },
    ]);
    expect(first.fileSize).toBe(Buffer.byteLength('inside\n'));

    snapshotRace.targetPath = '';
    const second = await readJsonlDelta(path, first.cursor, {
      maxLineBytes: 16,
    });
    expect(second.lines.map(line => line.value)).toEqual(['outside']);
  });

  it('retains the exact cursor when the file is missing', async () => {
    const path = join(fixtureRoot, 'missing.jsonl');
    const cursor: JsonlCursor = {
      device: '1',
      inode: '2',
      offset: 12,
      lineNumber: 3,
      generation: 4,
      headDigest: 'head',
      boundaryDigest: 'boundary',
    };

    const result = await readJsonlDelta(path, cursor);
    expect(result).toEqual({
      lines: [],
      diagnostics: [],
      cursor,
      fileSize: null,
      reset: false,
    });
    expect(result.cursor).toBe(cursor);
  });

  it('detects same-size stale content through digest validation', async () => {
    const path = join(fixtureRoot, 'digest.jsonl');
    await fsPromises.writeFile(path, 'first\n');
    const first = await readJsonlDelta(path, null);

    await fsPromises.writeFile(path, 'other\n');
    const second = await readJsonlDelta(path, first.cursor);

    expect(second.reset).toBe(true);
    expect(second.cursor?.generation).toBe(1);
    expect(second.lines.map(line => line.value)).toEqual(['other']);
  });

  it('preserves binary garbage lossily and resumes from a serialized cursor', async () => {
    const path = join(fixtureRoot, 'resume.jsonl');
    await fsPromises.writeFile(
      path,
      Buffer.concat([Buffer.from('one\n'), Buffer.from([0xff, 0xfe, 0x0a])])
    );
    const first = await readJsonlDelta(path, null);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[1]?.value).toBe('\uFFFD\uFFFD');

    const resumedCursor: unknown = JSON.parse(JSON.stringify(first.cursor));
    if (!isJsonlCursor(resumedCursor)) {
      throw new Error('Serialized cursor did not preserve its shape');
    }
    await fsPromises.appendFile(path, 'two\n');
    const second = await readJsonlDelta(path, resumedCursor);
    const third = await readJsonlDelta(path, second.cursor);

    expect(second.lines.map(line => line.value)).toEqual(['two']);
    expect(third.lines).toEqual([]);
  });
});

function isJsonlCursor(value: unknown): value is JsonlCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'device' in value &&
    typeof value.device === 'string' &&
    'inode' in value &&
    typeof value.inode === 'string' &&
    'offset' in value &&
    typeof value.offset === 'number' &&
    'lineNumber' in value &&
    typeof value.lineNumber === 'number' &&
    'generation' in value &&
    typeof value.generation === 'number' &&
    'headDigest' in value &&
    typeof value.headDigest === 'string' &&
    'boundaryDigest' in value &&
    typeof value.boundaryDigest === 'string'
  );
}
