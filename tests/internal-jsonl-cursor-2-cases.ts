import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  configureSnapshotRace,
  isJsonlCursor,
  resetSnapshotRace,
} from './internal-jsonl-cursor-utils.js';

import {
  readJsonlDelta,
  type JsonlCursor,
} from '../src/internal/jsonl-cursor.js';

const scanChunkBytes = 64 * 1024;

describe('internal JSONL cursor', () => {
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(
      join(tmpdir(), 'internal-jsonl-cursor-')
    );
  });

  afterAll(async () => {
    resetSnapshotRace();
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
    await expect(fsPromises.stat(fixtureRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('defers bytes appended after the open-file size snapshot', async () => {
    const path = join(fixtureRoot, 'snapshot.jsonl');
    await fsPromises.writeFile(path, 'inside\n');
    configureSnapshotRace(path, Buffer.from('outside\n'));

    const first = await readJsonlDelta(path, null, { maxLineBytes: 3 });
    expect(first.lines).toEqual([]);
    expect(first.diagnostics).toEqual([
      { kind: 'oversized', lineNumber: 1, byteStart: 0, byteEnd: 7 },
    ]);
    expect(first.fileSize).toBe(Buffer.byteLength('inside\n'));

    resetSnapshotRace();
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
      scanStatus: { status: 'complete' },
      scannedBytes: 0,
      scannedLines: 0,
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
});
