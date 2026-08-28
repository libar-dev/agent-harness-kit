import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isJsonlCursor,
  resetSnapshotRace,
} from './internal-jsonl-cursor-utils.js';

import { readJsonlDelta } from '../src/internal/jsonl-cursor.js';

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

  it('rejects a negative or non-integer maxLineBytes up front', async () => {
    const path = join(fixtureRoot, 'bad-options.jsonl');
    await fsPromises.writeFile(path, 'x\n');

    await expect(
      readJsonlDelta(path, null, { maxLineBytes: -1 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxLineBytes: Number.NaN })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxLineBytes: 0 })
    ).rejects.toThrow(RangeError);
  });

  it('returns limited bytes status when the exact byte cap lands on a line boundary', async () => {
    const path = join(fixtureRoot, 'byte-cap.jsonl');
    await fsPromises.writeFile(path, 'aaaa\nbbbb\ncccc\ndddd\neeee\n');

    const first = await readJsonlDelta(path, null, {
      maxLineBytes: 4,
      maxScanBytes: 20,
      maxScanLines: 100,
    });

    expect(first.lines.map(line => line.value)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
      'dddd',
    ]);
    expect(first.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
    expect(first.scannedBytes).toBe(20);
    expect(first.scannedLines).toBe(4);
    expect(first.cursor?.offset).toBe(20);
    expect(first.cursor?.pending).toBeNull();

    const second = await readJsonlDelta(path, first.cursor, {
      maxLineBytes: 4,
      maxScanBytes: 20,
      maxScanLines: 100,
    });
    expect(second.lines.map(line => line.value)).toEqual(['eeee']);
    expect(second.scanStatus).toEqual({ status: 'complete' });
    expect(second.reset).toBe(false);
  });

  it('returns limited lines status when the exact line cap is reached', async () => {
    const path = join(fixtureRoot, 'line-cap.jsonl');
    await fsPromises.writeFile(path, 'a\nb\nc\nd\n');

    const first = await readJsonlDelta(path, null, {
      maxLineBytes: 8,
      maxScanBytes: 64,
      maxScanLines: 2,
    });

    expect(first.lines.map(line => line.value)).toEqual(['a', 'b']);
    expect(first.scanStatus).toEqual({ status: 'limited', reason: 'lines' });
    expect(first.scannedLines).toBe(2);
    expect(first.cursor?.lineNumber).toBe(3);
    expect(first.cursor?.pending).toBeNull();

    const second = await readJsonlDelta(path, first.cursor, {
      maxLineBytes: 8,
      maxScanBytes: 64,
      maxScanLines: 2,
    });
    expect(second.lines.map(line => line.value)).toEqual(['c', 'd']);
    expect(second.scanStatus).toEqual({ status: 'complete' });
  });

  it('stops at a line boundary when leftover budget cannot start another line', async () => {
    const path = join(fixtureRoot, 'boundary-budget.jsonl');
    await fsPromises.writeFile(path, 'aaaa\nbbbb\ncccc\n');

    const first = await readJsonlDelta(path, null, {
      maxLineBytes: 4,
      maxScanBytes: 12,
      maxScanLines: 100,
    });

    expect(first.lines.map(line => line.value)).toEqual(['aaaa', 'bbbb']);
    expect(first.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
    expect(first.scannedBytes).toBe(10);
    expect(first.cursor?.offset).toBe(10);
    expect(first.cursor?.pending).toBeNull();
  });

  it('discards an oversized line across scans and emits the diagnostic only at the newline', async () => {
    const path = join(fixtureRoot, 'oversized-span.jsonl');
    await fsPromises.writeFile(path, `${'x'.repeat(50)}\nok\n`);

    const limits = {
      maxLineBytes: 8,
      maxScanBytes: 20,
      maxScanLines: 100,
    } as const;

    const first = await readJsonlDelta(path, null, limits);
    expect(first.lines).toEqual([]);
    expect(first.diagnostics).toEqual([]);
    expect(first.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
    expect(first.scannedBytes).toBe(20);
    expect(first.cursor).toMatchObject({
      offset: 20,
      lineNumber: 1,
      pending: { kind: 'discarding_oversized', byteStart: 0 },
    });

    const serialized: unknown = JSON.parse(JSON.stringify(first.cursor));
    if (!isJsonlCursor(serialized)) {
      throw new Error('Serialized pending cursor did not preserve its shape');
    }
    expect(serialized.pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });

    const second = await readJsonlDelta(path, serialized, limits);
    expect(second.lines).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(second.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
    expect(second.cursor?.pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });
    expect(second.cursor?.offset).toBe(40);

    const third = await readJsonlDelta(path, second.cursor, limits);
    expect(third.diagnostics).toEqual([
      { kind: 'oversized', lineNumber: 1, byteStart: 0, byteEnd: 51 },
    ]);
    expect(third.lines.map(line => line.value)).toEqual(['ok']);
    expect(third.lines.some(line => line.value.includes('x'))).toBe(false);
    expect(third.scanStatus).toEqual({ status: 'complete' });
    expect(third.cursor?.pending).toBeNull();
    expect(third.reset).toBe(false);
  });

  it('leaves unterminated valid, malformed, and blank tails uncommitted', async () => {
    const validPath = join(fixtureRoot, 'unterminated-valid.jsonl');
    await fsPromises.writeFile(validPath, 'hello');
    const valid = await readJsonlDelta(validPath, null, {
      maxLineBytes: 16,
      maxScanBytes: 64,
      maxScanLines: 10,
    });
    expect(valid.lines).toEqual([]);
    expect(valid.diagnostics).toEqual([]);
    expect(valid.cursor?.offset).toBe(0);
    expect(valid.cursor?.pending).toBeNull();
    expect(valid.scanStatus).toEqual({ status: 'complete' });

    const malformedPath = join(fixtureRoot, 'unterminated-malformed.jsonl');
    await fsPromises.writeFile(malformedPath, Buffer.from([0xff, 0xfe]));
    const malformed = await readJsonlDelta(malformedPath, null, {
      maxLineBytes: 16,
      maxScanBytes: 64,
      maxScanLines: 10,
    });
    expect(malformed.lines).toEqual([]);
    expect(malformed.cursor?.offset).toBe(0);
    expect(malformed.cursor?.pending).toBeNull();

    const blankPath = join(fixtureRoot, 'unterminated-blank.jsonl');
    await fsPromises.writeFile(blankPath, '   ');
    const blank = await readJsonlDelta(blankPath, null, {
      maxLineBytes: 16,
      maxScanBytes: 64,
      maxScanLines: 10,
    });
    expect(blank.lines).toEqual([]);
    expect(blank.cursor?.offset).toBe(0);
    expect(blank.cursor?.pending).toBeNull();
  });
});
