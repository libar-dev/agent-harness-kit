import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  configureReadTracking,
  resetSnapshotRace,
  trackedFileReads,
} from './internal-jsonl-cursor-utils.js';

import {
  parseJsonlOversizedPending,
  readJsonlDelta,
} from '../src/internal/jsonl-cursor.js';

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

  it('invalidates a cursor past EOF, an inode replace, and a digest rewrite', async () => {
    const eofPath = join(fixtureRoot, 'cursor-beyond-eof.jsonl');
    await fsPromises.writeFile(eofPath, 'one\ntwo\nthree\n');
    const eofFirst = await readJsonlDelta(eofPath, null);
    expect(eofFirst.cursor?.offset).toBe(14);
    await fsPromises.truncate(eofPath, 3);
    const eofSecond = await readJsonlDelta(eofPath, eofFirst.cursor);
    expect(eofSecond.reset).toBe(true);
    expect(eofSecond.cursor?.generation).toBe(1);
    expect(eofSecond.cursor?.offset).toBe(0);
    expect(eofSecond.cursor?.pending).toBeNull();

    const replacePath = join(fixtureRoot, 'pending-replace.jsonl');
    await fsPromises.writeFile(replacePath, `${'x'.repeat(50)}\n`);
    const pendingFirst = await readJsonlDelta(replacePath, null, {
      maxLineBytes: 8,
      maxScanBytes: 20,
      maxScanLines: 100,
    });
    expect(pendingFirst.cursor?.pending?.kind).toBe('discarding_oversized');
    const tmp = join(fixtureRoot, 'pending-replace.tmp');
    await fsPromises.writeFile(tmp, 'fresh\n');
    await fsPromises.rename(tmp, replacePath);
    const replaced = await readJsonlDelta(replacePath, pendingFirst.cursor, {
      maxLineBytes: 8,
      maxScanBytes: 20,
      maxScanLines: 100,
    });
    expect(replaced.reset).toBe(true);
    expect(replaced.lines.map(line => line.value)).toEqual(['fresh']);
    expect(replaced.cursor?.pending).toBeNull();

    const digestPath = join(fixtureRoot, 'budget-digest.jsonl');
    await fsPromises.writeFile(digestPath, 'first\n');
    const digestFirst = await readJsonlDelta(digestPath, null);
    await fsPromises.writeFile(digestPath, 'other\n');
    const digestSecond = await readJsonlDelta(digestPath, digestFirst.cursor);
    expect(digestSecond.reset).toBe(true);
    expect(digestSecond.lines.map(line => line.value)).toEqual(['other']);
    expect(digestSecond.cursor?.pending).toBeNull();
  });

  it('bounds every real scan read request by the exact remaining byte budget', async () => {
    const path = join(fixtureRoot, 'real-read-budget.jsonl');
    const maxLineBytes = 64 * 1024;
    const maxScanBytes = maxLineBytes + 1;
    await fsPromises.writeFile(
      path,
      Buffer.alloc(maxScanBytes + 64 * 1024, 0x78)
    );
    configureReadTracking(path, maxScanBytes);

    const result = await readJsonlDelta(path, null, {
      maxLineBytes,
      maxScanBytes,
      maxScanLines: 10,
    });
    const reads = trackedFileReads();
    const scanReads = reads.slice(0, -2);
    let remaining = maxScanBytes;
    for (const read of scanReads) {
      expect(read.requestedBytes).toBeLessThanOrEqual(remaining);
      expect(read.actualBytes).toBeLessThanOrEqual(read.requestedBytes);
      remaining -= read.actualBytes;
    }
    expect(scanReads.map(read => read.requestedBytes)).toEqual([
      maxLineBytes,
      1,
    ]);
    expect(scanReads.reduce((sum, read) => sum + read.actualBytes, 0)).toBe(
      maxScanBytes
    );
    expect(result.scannedBytes).toBe(maxScanBytes);
    expect(result.scanStatus).toEqual({ status: 'limited', reason: 'bytes' });
  });

  it('rejects non-positive scan limits and maxScanBytes below maxLineBytes + 1', async () => {
    const path = join(fixtureRoot, 'bad-scan-options.jsonl');
    await fsPromises.writeFile(path, 'x\n');

    await expect(
      readJsonlDelta(path, null, { maxScanBytes: 0 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanBytes: -1 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanLines: 0 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanBytes: 10, maxLineBytes: 10 })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanBytes: Number.NaN })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanLines: Number.NaN })
    ).rejects.toThrow(RangeError);
    await expect(
      readJsonlDelta(path, null, { maxScanBytes: Number.POSITIVE_INFINITY })
    ).rejects.toThrow(RangeError);
  });

  it('parses omitted and JSON-null pending as null', () => {
    expect(parseJsonlOversizedPending(undefined)).toBeNull();
    expect(parseJsonlOversizedPending(null)).toBeNull();
  });

  it('parses a valid serialized oversized-pending object', () => {
    expect(
      parseJsonlOversizedPending({
        kind: 'discarding_oversized',
        byteStart: 12,
      })
    ).toEqual({ kind: 'discarding_oversized', byteStart: 12 });
  });

  it('rejects invalid serialized oversized-pending shapes', () => {
    expect(
      parseJsonlOversizedPending({ kind: 'other', byteStart: 0 })
    ).toBeUndefined();
    expect(
      parseJsonlOversizedPending({
        kind: 'discarding_oversized',
        byteStart: -1,
      })
    ).toBeUndefined();
    expect(
      parseJsonlOversizedPending({
        kind: 'discarding_oversized',
        byteStart: 1.5,
      })
    ).toBeUndefined();
    expect(parseJsonlOversizedPending('pending')).toBeUndefined();
  });

  it('reports complete when a file ends exactly on the byte cap', async () => {
    const path = join(fixtureRoot, 'exact-file-cap.jsonl');
    await fsPromises.writeFile(path, 'aaaa\nbbbb\ncccc\ndddd\n');

    const result = await readJsonlDelta(path, null, {
      maxLineBytes: 4,
      maxScanBytes: 20,
      maxScanLines: 100,
    });

    expect(result.lines).toHaveLength(4);
    expect(result.scanStatus).toEqual({ status: 'complete' });
    expect(result.scannedBytes).toBe(20);
    expect(result.cursor?.pending).toBeNull();
  });
});
