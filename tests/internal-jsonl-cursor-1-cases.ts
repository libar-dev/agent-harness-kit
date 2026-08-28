import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetSnapshotRace } from './internal-jsonl-cursor-utils.js';

import { readJsonlDelta } from '../src/internal/jsonl-cursor.js';

const mib = 1024 * 1024;

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
    expect(result.lines).toEqual([]);
    expect(result.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
    expect(result.cursor?.offset).toBe(oversizedLength + 1);
    expect(result.cursor?.pending).toBeNull();

    const second = await readJsonlDelta(path, result.cursor);
    expect(second.lines).toEqual([
      {
        value: 'normal',
        lineNumber: 2,
        byteStart: oversizedLength + 1,
        byteEnd: oversizedLength + 8,
      },
    ]);
    expect(second.scanStatus).toEqual({ status: 'complete' });
    expect(second.cursor?.offset).toBe(oversizedLength + 8);
  });
});
