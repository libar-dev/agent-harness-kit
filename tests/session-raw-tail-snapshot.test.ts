import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const statRace = vi.hoisted(() => ({
  targetPath: '',
  appendAfterStat: '',
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    stat: async (path: PathLike) => {
      const snapshot = await actual.stat(path);
      if (
        String(path) === statRace.targetPath &&
        statRace.appendAfterStat.length > 0
      ) {
        const appended = statRace.appendAfterStat;
        statRace.appendAfterStat = '';
        await actual.appendFile(path, appended);
      }
      return snapshot;
    },
  };
});

import { tailRawTranscriptSessionRecords } from '../src/processing/index.js';

function recordLine(sessionId: string, uuid: string): string {
  return `${JSON.stringify({
    type: 'queue-operation',
    sessionId,
    uuid,
    value: uuid,
  })}\n`;
}

describe('session raw tail stat snapshots', () => {
  let tmp: string | undefined;

  afterEach(async () => {
    statRace.targetPath = '';
    statRace.appendAfterStat = '';
    if (tmp !== undefined) {
      await fsPromises.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it('defers bytes appended after stat and retains partial-line handling', async () => {
    tmp = await fsPromises.mkdtemp(join(tmpdir(), 'session-tail-snapshot-'));
    const sessionId = 'snapshot-session';
    const mainPath = join(tmp, `${sessionId}.jsonl`);
    const markerDir = join(tmp, 'markers');
    const initial = recordLine(sessionId, 'initial');
    const appended = recordLine(sessionId, 'outside-snapshot');
    const completedLater = recordLine(sessionId, 'completed-later');
    const splitAt = Math.floor(completedLater.length / 2);
    const partialPrefix = completedLater.slice(0, splitAt);
    const partialSuffix = completedLater.slice(splitAt);
    await fsPromises.writeFile(mainPath, initial);
    statRace.targetPath = mainPath;
    statRace.appendAfterStat = appended + partialPrefix;

    const options = {
      markerDir,
      allowedMarkerRoots: [tmp],
      rawRedactionMode: 'unsafe-unredacted' as const,
    };
    const first = await tailRawTranscriptSessionRecords(mainPath, options);

    expect(first.records.map(record => record.uuid)).toEqual(['initial']);
    expect(first.sources[0]).toMatchObject({
      fileSize: Buffer.byteLength(initial),
      newByteOffset: Buffer.byteLength(initial),
    });
    expect(first.checkpoint.sources[0]).toMatchObject({
      fileSize: Buffer.byteLength(initial),
      byteOffset: Buffer.byteLength(initial),
    });

    const second = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(second.records.map(record => record.uuid)).toEqual([
      'outside-snapshot',
    ]);
    expect(second.sources[0]).toMatchObject({
      fileSize: Buffer.byteLength(initial + appended + partialPrefix),
      newByteOffset: Buffer.byteLength(initial + appended),
    });

    await fsPromises.appendFile(mainPath, partialSuffix);
    const third = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(third.records.map(record => record.uuid)).toEqual([
      'completed-later',
    ]);
    expect(third.sources[0]?.newByteOffset).toBe(
      Buffer.byteLength(initial + appended + completedLater)
    );
  });
});
