import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
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
});
