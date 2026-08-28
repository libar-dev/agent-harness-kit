import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  withRawTranscriptSessionMarkerLock,
  type RawTranscriptSessionLockOptions,
} from '../src/processing/tail.js';

const tempRoots: string[] = [];
const STALE_MS = 30_000;
const DEAD_PID = 2_147_483_647;
const FAST_ACQUIRE: RawTranscriptSessionLockOptions = {
  acquireTimeoutMs: 0,
  retryMs: 0,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(label: string): Promise<{
  root: string;
  markerPath: string;
  lockPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `raw-transcript-lock-${label}-`));
  tempRoots.push(root);
  const markerPath = join(root, 'session.marker.json');
  return { root, markerPath, lockPath: `${markerPath}.lock` };
}

async function tokenSnapshot(
  lockPath: string
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const name of (await readdir(lockPath)).sort()) {
    snapshot[name] = await readFile(join(lockPath, name), 'utf8');
  }
  expect(Object.keys(snapshot)).toHaveLength(1);
  expect(Object.keys(snapshot)[0]).toMatch(
    /^owner\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i
  );
  return snapshot;
}

async function plantStaleToken(lockPath: string): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 });
  const ownerId = randomUUID();
  const leaseId = randomUUID();
  const tokenPath = join(lockPath, `owner.${ownerId}.${leaseId}`);
  await writeFile(
    tokenPath,
    JSON.stringify({
      version: 2,
      ownerId,
      leaseId,
      pid: DEAD_PID,
      createdAt: Date.now() - STALE_MS - 5_000,
    }),
    { mode: 0o600 }
  );
  const past = new Date(Date.now() - STALE_MS - 5_000);
  await utimes(tokenPath, past, past);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('raw transcript session lock three-party schedules', () => {
  it('T1 keeps fresh owner B canonical while displaced owner A releases', async () => {
    const { markerPath, lockPath } = await fixture('t1-displaced-owner');
    const holdA = deferred();
    const aEntered = deferred();
    const releaseBarrier = deferred();
    const aReleasePaused = deferred();
    const holdB = deferred();
    const bEntered = deferred();

    const ownerA = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        aEntered.resolve();
        await holdA.promise;
      },
      {
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          aReleasePaused.resolve();
          await releaseBarrier.promise;
        },
      }
    );
    await aEntered.promise;

    const ownerB = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        bEntered.resolve();
        await holdB.promise;
      },
      {
        now: () => Date.now() + STALE_MS + 5_000,
        isProcessAlive: () => false,
      }
    );
    await bEntered.promise;
    const ownerBBeforeRelease = await tokenSnapshot(lockPath);

    holdA.resolve();
    await aReleasePaused.promise;
    const ownerDuringRelease = await tokenSnapshot(lockPath);

    releaseBarrier.resolve();
    await ownerA;
    const ownerAfterARelease = await tokenSnapshot(lockPath);
    holdB.resolve();
    await ownerB;

    expect(
      ownerDuringRelease,
      'fresh owner B ownership vanished during displaced owner A release'
    ).toEqual(ownerBBeforeRelease);
    expect(
      ownerAfterARelease,
      'displaced owner A disturbed fresh owner B ownership'
    ).toEqual(ownerBBeforeRelease);
  });

  it('T2 rejects interloper C while displaced owner A release is in flight', async () => {
    const { markerPath } = await fixture('t2-release-interloper');
    const holdA = deferred();
    const aEntered = deferred();
    const releaseBarrier = deferred();
    const aReleasePaused = deferred();
    const holdB = deferred();
    const bEntered = deferred();

    const ownerA = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        aEntered.resolve();
        await holdA.promise;
      },
      {
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          aReleasePaused.resolve();
          await releaseBarrier.promise;
        },
      }
    );
    await aEntered.promise;
    const ownerB = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        bEntered.resolve();
        await holdB.promise;
      },
      {
        now: () => Date.now() + STALE_MS + 5_000,
        isProcessAlive: () => false,
      }
    );
    await bEntered.promise;

    holdA.resolve();
    await aReleasePaused.promise;
    let interloperEntered = false;
    const interloperError = await withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        interloperEntered = true;
      },
      FAST_ACQUIRE
    ).then(
      () => null,
      (error: unknown) => error
    );

    releaseBarrier.resolve();
    await ownerA;
    holdB.resolve();
    await ownerB;

    expect(
      interloperEntered,
      'interloper C entered through the canonical release vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toContain(
      'Timed out acquiring session marker lock'
    );
  });

  it('T3 rejects interloper C while stale owner A reclamation is in flight', async () => {
    const { markerPath, lockPath } = await fixture('t3-reclaim-interloper');
    await plantStaleToken(lockPath);
    const reclaimBarrier = deferred();
    const reclaimerPaused = deferred();

    const reclaimer = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => undefined,
      {
        isProcessAlive: () => false,
        onAfterExpiredTokensUnlinkedBeforeRmdir: async () => {
          reclaimerPaused.resolve();
          await reclaimBarrier.promise;
        },
      }
    );
    await reclaimerPaused.promise;

    let interloperEntered = false;
    const interloperError = await withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        interloperEntered = true;
      },
      FAST_ACQUIRE
    ).then(
      () => null,
      (error: unknown) => error
    );

    reclaimBarrier.resolve();
    await reclaimer;

    expect(
      interloperEntered,
      'interloper C entered through the canonical reclamation vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toContain(
      'Timed out acquiring session marker lock'
    );
  });
});
