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
} from '../src/internal/jsonl-cursor.js';

const mib = 1024 * 1024;
const scanChunkBytes = 64 * 1024;

describe('internal JSONL cursor', () => {
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'internal-jsonl-cursor-')
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
    const content = 'alpha\n\u03b2eta\nthird\n';
    await fsPromises.writeFile(path, content);

    const first = await readJsonlDelta(path, null);

    expect(first.lines).toEqual([
      { value: 'alpha', lineNumber: 1, byteStart: 0, byteEnd: 6 },
      { value: '\u03b2eta', lineNumber: 2, byteStart: 6, byteEnd: 12 },
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

  it('detects a same-size rewrite through head/boundary digest mismatch', async () => {
    // Same byte size means neither identity nor offset checks can fire;
    // only the dual digests distinguish stale content from an append.
    const path = join(fixtureRoot, 'digest.jsonl');
    await fsPromises.writeFile(path, 'first\n');
    const first = await readJsonlDelta(path, null);
    expect(first.cursor?.headDigest).not.toBe('');
    expect(first.cursor?.boundaryDigest).not.toBe('');

    await fsPromises.writeFile(path, 'other\n');
    const statBefore = await fsPromises.stat(path);
    expect(statBefore.size).toBe(Buffer.byteLength('first\n'));

    const second = await readJsonlDelta(path, first.cursor);

    expect(second.reset).toBe(true);
    expect(second.cursor?.generation).toBe(1);
    expect(second.cursor?.offset).toBe(Buffer.byteLength('other\n'));
    expect(second.lines).toEqual([
      { value: 'other', lineNumber: 1, byteStart: 0, byteEnd: 6 },
    ]);

    // A clean append against the refreshed cursor must NOT reset again.
    await fsPromises.appendFile(path, 'more\n');
    const third = await readJsonlDelta(path, second.cursor);
    expect(third.reset).toBe(false);
    expect(third.lines.map(line => line.value)).toEqual(['more']);
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

  it('keeps CR characters intact and never treats a lone CR as a terminator', async () => {
    const path = join(fixtureRoot, 'crlf.jsonl');
    await fsPromises.writeFile(path, 'alpha\r\nbeta\r\nlone\rcr\n');

    const result = await readJsonlDelta(path, null);

    expect(result.lines).toEqual([
      { value: 'alpha\r', lineNumber: 1, byteStart: 0, byteEnd: 7 },
      {
        value: 'beta\r',
        lineNumber: 2,
        byteStart: 7,
        byteEnd: 13,
      },
      {
        value: 'lone\rcr',
        lineNumber: 3,
        byteStart: 13,
        byteEnd: 21,
      },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.cursor?.offset).toBe(21);

    const next = await readJsonlDelta(path, result.cursor);
    expect(next.lines).toEqual([]);
    expect(next.reset).toBe(false);
  });

  it('decodes a multibyte character split across the internal read-chunk boundary', async () => {
    // The scanner reads in fixed 64 KiB chunks. Place a 4-byte UTF-8
    // character so its first three bytes land in chunk one and its final
    // byte lands in chunk two; per-line decode must still be exact.
    const path = join(fixtureRoot, 'multibyte-boundary.jsonl');
    const leadBytes = scanChunkBytes - 3;
    const emoji = '\u{1F600}';
    const content = Buffer.concat([
      Buffer.alloc(leadBytes, 0x61),
      Buffer.from(emoji, 'utf8'),
      Buffer.from('\nafter\n'),
    ]);
    await fsPromises.writeFile(path, content);

    const result = await readJsonlDelta(path, null);

    expect(result.lines).toHaveLength(2);
    const expectedValue = `${'a'.repeat(leadBytes)}${emoji}`;
    expect(result.lines[0]?.value).toBe(expectedValue);
    expect(result.lines[0]?.byteStart).toBe(0);
    expect(result.lines[0]?.byteEnd).toBe(
      leadBytes + Buffer.byteLength(emoji, 'utf8') + 1
    );
    expect(result.lines[1]?.value).toBe('after');
  });

  it('commits deterministic lines over hostile bytes: NULs, invalid UTF-8, embedded newlines in garbage', async () => {
    const path = join(fixtureRoot, 'hostile.jsonl');
    await fsPromises.writeFile(
      path,
      Buffer.concat([
        Buffer.from('a\x00b\n', 'utf8'),
        Buffer.from([0xff, 0x00, 0xfe, 0x0a]),
        Buffer.from('\n', 'utf8'),
        Buffer.from('tail\n', 'utf8'),
      ])
    );

    const result = await readJsonlDelta(path, null);

    expect(result.lines.map(line => line.value)).toEqual([
      'a\x00b',
      '\uFFFD\x00\uFFFD',
      '',
      'tail',
    ]);
    expect(result.lines[0]).toMatchObject({ lineNumber: 1 });
    expect(result.lines[1]).toMatchObject({ lineNumber: 2 });
    expect(result.lines[2]).toMatchObject({ lineNumber: 3, byteStart: 8 });
    expect(result.lines[3]).toMatchObject({ lineNumber: 4 });
    expect(result.cursor?.offset).toBe(14);

    const next = await readJsonlDelta(path, result.cursor);
    expect(next.lines).toEqual([]);
    expect(next.reset).toBe(false);
  });

  it('rejects a negative or non-integer maxLineBytes up front', async () => {
    const path = join(fixtureRoot, 'bad-options.jsonl');
    await fsPromises.writeFile(path, 'x\n');

    await expect(
      readJsonlDelta(path, null, { maxLineBytes: -1 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxLineBytes: Number.NaN })
    ).rejects.toThrow(RangeError);
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
