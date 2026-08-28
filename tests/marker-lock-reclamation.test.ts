import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_STALE_MARKER_LOCK_MS,
  withMarkerLock,
} from '../src/internal/marker-lock.js';

const tempRoots: string[] = [];

afterEach(async () => {
  const roots = tempRoots.splice(0, tempRoots.length);
  await Promise.all(
    roots.map(async root => {
      await rm(root, { recursive: true, force: true });
    })
  );
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function plantLockDir(
  lockPath: string,
  options: { nonce?: string | null; stale?: boolean }
): Promise<void> {
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  if (options.nonce !== null && options.nonce !== undefined) {
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ nonce: options.nonce }),
      { encoding: 'utf8', mode: 0o600 }
    );
  }
  if (options.stale) {
    const staleSeconds = DEFAULT_STALE_MARKER_LOCK_MS / 1000 + 5;
    const past = new Date(Date.now() - staleSeconds * 1000);
    await utimes(lockPath, past, past);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseOwnerDocument(raw: string): { nonce: string } {
  const parsed: unknown = JSON.parse(raw);
  const nonce = isRecord(parsed) ? parsed['nonce'] : undefined;
  if (typeof nonce !== 'string') {
    throw new Error('owner.json is not { nonce: string }');
  }
  return { nonce };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tokenDirectorySnapshot(
  lockPath: string
): Promise<Record<string, string>> {
  const names = (await readdir(lockPath)).sort();
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^owner\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i);
  const snapshot: Record<string, string> = {};
  for (const name of names) {
    snapshot[name] = await readFile(join(lockPath, name), 'utf8');
  }
  return snapshot;
}

describe('internal marker-lock identity reclamation', () => {
  it('removes a stale lock whose identity and nonce still match', async () => {
    const root = await makeTempRoot('marker-lock-nonce-stale-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await plantLockDir(lockPath, { nonce: randomUUID(), stale: true });

    const value = await withMarkerLock(
      markerPath,
      async () => {
        await writeFile(markerPath, '{"ok":true}\n', { mode: 0o600 });
        return 'held';
      },
      { lockedLabel: 'Senpi session marker' }
    );

    expect(value).toBe('held');
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
      ok: true,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a lock dir replaced between identity capture and unlink', async () => {
    const root = await makeTempRoot('marker-lock-replaced-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    const originalNonce = randomUUID();
    await plantLockDir(lockPath, { nonce: originalNonce, stale: true });
    const original = await stat(lockPath);

    const replacementNonce = randomUUID();
    await expect(
      withMarkerLock(markerPath, async () => 'never', {
        lockedLabel: 'Senpi session marker',
        onBeforeStaleUnlink: async captured => {
          expect(captured.dev).toBe(original.dev);
          expect(captured.ino).toBe(original.ino);
          expect(captured.nonce).toBe(originalNonce);
          await rm(lockPath, { recursive: true, force: true });
          await mkdir(lockPath, { mode: 0o700 });
          await writeFile(
            join(lockPath, 'owner.json'),
            JSON.stringify({ nonce: replacementNonce }),
            { encoding: 'utf8', mode: 0o600 }
          );
          await writeFile(join(lockPath, 'sentinel'), 'replacement\n', {
            mode: 0o600,
          });
          const staleSeconds = DEFAULT_STALE_MARKER_LOCK_MS / 1000 + 5;
          const past = new Date(Date.now() - staleSeconds * 1000);
          await utimes(lockPath, past, past);
        },
      })
    ).rejects.toThrow(`Senpi session marker is locked: '${markerPath}'`);

    expect(await readFile(join(lockPath, 'sentinel'), 'utf8')).toBe(
      'replacement\n'
    );
    expect(
      parseOwnerDocument(await readFile(join(lockPath, 'owner.json'), 'utf8'))
    ).toEqual({
      nonce: replacementNonce,
    });
    // No assertion that surviving.ino differs from original.ino: ext4 and
    // overlayfs reuse inode numbers after rm+mkdir of the same path, so
    // identity equality is environment-dependent. The protected property is
    // already asserted above — the replacement sentinel and its distinct
    // nonce survived because reclamation refused on the nonce mismatch.
  });

  it('release does not delete a lock dir reclaimed by another owner', async () => {
    const root = await makeTempRoot('marker-lock-release-owner-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    const replacementNonce = randomUUID();

    // Owner A holds the lock; while its critical section runs it goes stale
    // and owner B reclaims. When A releases, its cleanup must leave B's lock
    // intact instead of deleting it and letting a third owner in.
    await withMarkerLock(
      markerPath,
      async () => {
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(
          join(lockPath, 'owner.json'),
          JSON.stringify({ nonce: replacementNonce }),
          { encoding: 'utf8', mode: 0o600 }
        );
        await writeFile(join(lockPath, 'sentinel'), 'owner-b\n', {
          mode: 0o600,
        });
        return 'stale-holder-done';
      },
      { lockedLabel: 'Senpi session marker' }
    );

    expect(await readFile(join(lockPath, 'sentinel'), 'utf8')).toBe(
      'owner-b\n'
    );
    expect(
      parseOwnerDocument(await readFile(join(lockPath, 'owner.json'), 'utf8'))
    ).toEqual({ nonce: replacementNonce });
  });

  it('rejects a fresh competing lock with the adapter label', async () => {
    const root = await makeTempRoot('marker-lock-fresh-nonce-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await plantLockDir(lockPath, { nonce: randomUUID(), stale: false });

    await expect(
      withMarkerLock(markerPath, async () => 'never', {
        lockedLabel: 'Grok session marker',
      })
    ).rejects.toThrow(`Grok session marker is locked: '${markerPath}'`);

    const freshOwner = parseOwnerDocument(
      await readFile(join(lockPath, 'owner.json'), 'utf8')
    );
    expect(freshOwner.nonce.length).toBeGreaterThan(0);
  });

  it('lets exactly one of two concurrent reclaimers win mkdir', async () => {
    const root = await makeTempRoot('marker-lock-concurrent-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await plantLockDir(lockPath, { nonce: randomUUID(), stale: true });

    let releaseHold!: () => void;
    const hold = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    let notifyEntered!: () => void;
    const sawEnter = new Promise<void>(resolve => {
      notifyEntered = resolve;
    });
    let entered = 0;
    let reclaimersReady = 0;
    let releaseReclaimers!: () => void;
    const bothReclaimersReady = new Promise<void>(resolve => {
      releaseReclaimers = resolve;
    });

    const run = (): Promise<string> =>
      withMarkerLock(
        markerPath,
        async () => {
          entered += 1;
          notifyEntered();
          if (entered === 2) releaseHold();
          await hold;
          return 'held';
        },
        {
          lockedLabel: 'Senpi session marker',
          onBeforeStaleClaim: async () => {
            reclaimersReady += 1;
            const reclaimerNumber = reclaimersReady;
            if (reclaimerNumber === 2) releaseReclaimers();
            await bothReclaimersReady;
            if (reclaimerNumber === 2) await sawEnter;
          },
        }
      );

    const first = run();
    const second = run();
    const lockedMessage = `Senpi session marker is locked: '${markerPath}'`;
    type Settled =
      | { status: 'fulfilled'; value: string }
      | { status: 'rejected'; error: unknown };
    const asSettled = (promise: Promise<string>): Promise<Settled> =>
      promise.then(
        value => ({ status: 'fulfilled', value }),
        (error: unknown) => ({ status: 'rejected', error })
      );
    const firstSettled = asSettled(first);
    const secondSettled = asSettled(second);

    const progress = await Promise.race([
      sawEnter.then(() => 'entered' as const),
      Promise.all([firstSettled, secondSettled]).then(
        () => 'both-done' as const
      ),
    ]);
    expect(progress).toBe('entered');
    expect(entered).toBe(1);

    const loser = await Promise.race([firstSettled, secondSettled]);
    expect(loser.status).toBe('rejected');
    if (loser.status !== 'rejected') {
      throw new Error('expected the loser to reject');
    }
    expect(errorMessage(loser.error)).toBe(lockedMessage);

    releaseHold();
    const settled = await Promise.all([firstSettled, secondSettled]);
    const fulfilled = settled.filter(
      (result): result is { status: 'fulfilled'; value: string } =>
        result.status === 'fulfilled'
    );
    const rejected = settled.filter(
      (result): result is { status: 'rejected'; error: unknown } =>
        result.status === 'rejected'
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toBe('held');
    expect(rejected).toHaveLength(1);
    expect(errorMessage(rejected[0]?.error)).toBe(lockedMessage);
    expect(entered).toBe(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a stale lock whose malformed owner is treated as legacy', async () => {
    const root = await makeTempRoot('marker-lock-malformed-owner-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await plantLockDir(lockPath, { nonce: null, stale: false });
    await writeFile(join(lockPath, 'owner.json'), '{not-json\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const staleSeconds = DEFAULT_STALE_MARKER_LOCK_MS / 1000 + 5;
    const past = new Date(Date.now() - staleSeconds * 1000);
    await utimes(lockPath, past, past);

    const value = await withMarkerLock(markerPath, async () => 'held', {
      lockedLabel: 'Senpi session marker',
    });

    expect(value).toBe('held');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still reclaims a stale legacy lock that has no owner.json', async () => {
    const root = await makeTempRoot('marker-lock-legacy-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await plantLockDir(lockPath, { nonce: null, stale: true });

    const value = await withMarkerLock(markerPath, async () => 'held', {
      lockedLabel: 'Senpi session marker',
    });

    expect(value).toBe('held');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T1 keeps fresh owner B canonical while displaced owner A releases', async () => {
    const root = await makeTempRoot('marker-lock-t1-displaced-owner-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;

    let finishA!: () => void;
    const holdA = new Promise<void>(resolve => {
      finishA = resolve;
    });
    let sawA!: () => void;
    const aEntered = new Promise<void>(resolve => {
      sawA = resolve;
    });
    let resumeARelease!: () => void;
    const releaseBarrier = new Promise<void>(resolve => {
      resumeARelease = resolve;
    });
    let sawARelease!: () => void;
    const aReleasePaused = new Promise<void>(resolve => {
      sawARelease = resolve;
    });
    let finishB!: () => void;
    const holdB = new Promise<void>(resolve => {
      finishB = resolve;
    });
    let sawB!: () => void;
    const bEntered = new Promise<void>(resolve => {
      sawB = resolve;
    });

    const ownerA = withMarkerLock(
      markerPath,
      async () => {
        sawA();
        await holdA;
      },
      {
        lockedLabel: 'Senpi session marker',
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          sawARelease();
          await releaseBarrier;
        },
      }
    );
    await aEntered;
    const past = new Date(Date.now() - DEFAULT_STALE_MARKER_LOCK_MS - 5_000);
    await utimes(lockPath, past, past);

    const ownerB = withMarkerLock(
      markerPath,
      async () => {
        sawB();
        await holdB;
      },
      { lockedLabel: 'Senpi session marker' }
    );
    await bEntered;
    const ownerBBeforeRelease = await tokenDirectorySnapshot(lockPath);

    finishA();
    await aReleasePaused;
    const canonicalDuringRelease = await stat(lockPath).then(
      () => true,
      () => false
    );
    const ownerDuringRelease = await tokenDirectorySnapshot(lockPath);

    resumeARelease();
    await ownerA;
    const ownerAfterARelease = await tokenDirectorySnapshot(lockPath);
    finishB();
    await ownerB;

    expect(
      canonicalDuringRelease,
      'canonical marker lock was vacated while fresh owner B was live'
    ).toBe(true);
    expect(
      ownerDuringRelease,
      'fresh owner B ownership vanished during displaced owner A release'
    ).toEqual(ownerBBeforeRelease);
    expect(
      ownerAfterARelease,
      'displaced owner A disturbed fresh owner B ownership'
    ).toEqual(ownerBBeforeRelease);
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T2 rejects interloper C while displaced owner A release is in flight', async () => {
    const root = await makeTempRoot('marker-lock-t2-release-interloper-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    const lockedMessage = `Senpi session marker is locked: '${markerPath}'`;

    let finishA!: () => void;
    const holdA = new Promise<void>(resolve => {
      finishA = resolve;
    });
    let sawA!: () => void;
    const aEntered = new Promise<void>(resolve => {
      sawA = resolve;
    });
    let resumeARelease!: () => void;
    const releaseBarrier = new Promise<void>(resolve => {
      resumeARelease = resolve;
    });
    let sawARelease!: () => void;
    const aReleasePaused = new Promise<void>(resolve => {
      sawARelease = resolve;
    });
    let finishB!: () => void;
    const holdB = new Promise<void>(resolve => {
      finishB = resolve;
    });
    let sawB!: () => void;
    const bEntered = new Promise<void>(resolve => {
      sawB = resolve;
    });

    const ownerA = withMarkerLock(
      markerPath,
      async () => {
        sawA();
        await holdA;
      },
      {
        lockedLabel: 'Senpi session marker',
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          sawARelease();
          await releaseBarrier;
        },
      }
    );
    await aEntered;
    const past = new Date(Date.now() - DEFAULT_STALE_MARKER_LOCK_MS - 5_000);
    await utimes(lockPath, past, past);
    const ownerB = withMarkerLock(
      markerPath,
      async () => {
        sawB();
        await holdB;
      },
      { lockedLabel: 'Senpi session marker' }
    );
    await bEntered;

    finishA();
    await aReleasePaused;
    let interloperEntered = false;
    const interloperError = await withMarkerLock(
      markerPath,
      async () => {
        interloperEntered = true;
      },
      { lockedLabel: 'Senpi session marker' }
    ).then(
      () => null,
      (error: unknown) => error
    );

    resumeARelease();
    await ownerA;
    finishB();
    await ownerB;

    expect(
      interloperEntered,
      'interloper C entered through the canonical release vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toBe(lockedMessage);
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T3 rejects interloper C while stale owner A reclamation is in flight', async () => {
    const root = await makeTempRoot('marker-lock-t3-reclaim-interloper-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    const lockedMessage = `Senpi session marker is locked: '${markerPath}'`;
    await plantLockDir(lockPath, { nonce: randomUUID(), stale: true });

    let resumeReclaimer!: () => void;
    const reclaimBarrier = new Promise<void>(resolve => {
      resumeReclaimer = resolve;
    });
    let sawReclaimGap!: () => void;
    const reclaimerPaused = new Promise<void>(resolve => {
      sawReclaimGap = resolve;
    });
    const reclaimer = withMarkerLock(markerPath, async () => 'reclaimed', {
      lockedLabel: 'Senpi session marker',
      onAfterExpiredTokensUnlinkedBeforeRmdir: async () => {
        sawReclaimGap();
        await reclaimBarrier;
      },
    });
    await reclaimerPaused;

    let interloperEntered = false;
    const interloperError = await withMarkerLock(
      markerPath,
      async () => {
        interloperEntered = true;
      },
      { lockedLabel: 'Senpi session marker' }
    ).then(
      () => null,
      (error: unknown) => error
    );

    resumeReclaimer();
    await reclaimer;

    expect(
      interloperEntered,
      'interloper C entered through the canonical reclamation vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toBe(lockedMessage);
  });
});
