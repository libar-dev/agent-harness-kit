import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import {
  lstat,
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

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  LeaseLockBusyError,
  acquireLeaseLock,
  acquireLeaseLockSync,
  leaseTokenSchema,
  type LeaseLockOptions,
} from '../src/internal/lease-lock.js';

const roots: string[] = [];
const staleMs = 1_000;

async function fixture(
  label: string
): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), `lease-lock-${label}-`));
  roots.push(root);
  return { root, lockPath: join(root, 'resource.lock') };
}

function options(overrides: Partial<LeaseLockOptions> = {}): LeaseLockOptions {
  return { staleMs, ...overrides };
}

async function makeStale(path: string): Promise<void> {
  const past = new Date(Date.now() - staleMs - 5_000);
  await utimes(path, past, past);
}

function tokenPath(
  lockPath: string,
  ownerId: string = randomUUID(),
  leaseId: string = randomUUID()
): string {
  return join(lockPath, `owner.${ownerId}.${leaseId}`);
}

async function plantToken(
  lockPath: string,
  config: { stale: boolean; ownerId?: string; leaseId?: string }
): Promise<string> {
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  const ownerId = config.ownerId ?? randomUUID();
  const leaseId = config.leaseId ?? randomUUID();
  const path = tokenPath(lockPath, ownerId, leaseId);
  await writeFile(
    path,
    JSON.stringify({ version: 2, ownerId, leaseId, pid: process.pid }),
    { mode: 0o600 }
  );
  if (config.stale) await makeStale(path);
  return path;
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('lease-lock core', () => {
  it('acquires and releases one exact token and its empty directory', async () => {
    const { lockPath } = await fixture('happy');
    const lease = await acquireLeaseLock(lockPath, options());

    const entries = await readdir(lockPath);
    expect(entries).toEqual([lease.tokenPath.slice(lockPath.length + 1)]);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o700);
    expect((await stat(lease.tokenPath)).mode & 0o777).toBe(0o600);
    await lease.assertHeld();

    await lease.release();
    await expectMissing(lease.tokenPath);
    await expectMissing(lockPath);
  });

  it('uses the synchronous filesystem implementation with awaitable hooks', async () => {
    const { lockPath } = await fixture('sync');
    let mkdirHookFinished = false;
    const lease = await acquireLeaseLockSync(
      lockPath,
      options({
        onAfterCanonicalMkdirBeforeToken: async () => {
          await Promise.resolve();
          mkdirHookFinished = true;
        },
      })
    );

    expect(mkdirHookFinished).toBe(true);
    await lease.assertHeld();
    await lease.release();
    await expectMissing(lockPath);
  });

  it('reports fresh contention without deleting the live token', async () => {
    const { lockPath } = await fixture('contention');
    const livePath = await plantToken(lockPath, { stale: false });
    const liveContents = await readFile(livePath, 'utf8');

    await expect(acquireLeaseLock(lockPath, options())).rejects.toBeInstanceOf(
      LeaseLockBusyError
    );
    expect(await readFile(livePath, 'utf8')).toBe(liveContents);
  });

  it('reclaims one expired token by exact name and becomes owner', async () => {
    const { lockPath } = await fixture('stale');
    const expiredPath = await plantToken(lockPath, { stale: true });

    const lease = await acquireLeaseLock(lockPath, options());
    await expectMissing(expiredPath);
    expect(await readdir(lockPath)).toEqual([
      lease.tokenPath.slice(lockPath.length + 1),
    ]);

    await lease.release();
  });

  it('lets an adapter keep an age-expired token live', async () => {
    const { lockPath } = await fixture('adapter-gate');
    const expiredPath = await plantToken(lockPath, { stale: true });
    let observedPid: number | undefined;

    await expect(
      acquireLeaseLock(
        lockPath,
        options({
          canReclaimExpiredToken: captured => {
            observedPid =
              'pid' in captured.token ? captured.token.pid : undefined;
            return false;
          },
        })
      )
    ).rejects.toBeInstanceOf(LeaseLockBusyError);
    expect(observedPid).toBe(process.pid);
    expect((await stat(expiredPath)).isFile()).toBe(true);
  });

  it('fails closed on an unknown entry without deleting known expired data', async () => {
    const { lockPath } = await fixture('unknown');
    const expiredPath = await plantToken(lockPath, { stale: true });
    const unknownPath = join(lockPath, 'sentinel');
    await writeFile(unknownPath, 'keep\n', { mode: 0o600 });

    await expect(acquireLeaseLock(lockPath, options())).rejects.toBeInstanceOf(
      LeaseLockBusyError
    );
    expect(await readFile(expiredPath, 'utf8')).not.toBe('');
    expect(await readFile(unknownPath, 'utf8')).toBe('keep\n');
  });

  it.each([
    ['marker', { nonce: randomUUID() }],
    [
      'raw transcript',
      { token: randomUUID(), pid: process.pid, createdAt: Date.now() - 10_000 },
    ],
  ])('captures a stale %s owner.json token', async (_label, document) => {
    const { lockPath } = await fixture('legacy-token');
    await mkdir(lockPath, { mode: 0o700 });
    const legacyPath = join(lockPath, 'owner.json');
    await writeFile(legacyPath, JSON.stringify(document), { mode: 0o600 });
    await makeStale(legacyPath);

    const lease = await acquireLeaseLock(lockPath, options());
    await expectMissing(legacyPath);
    await lease.release();
  });

  it('captures a stale legacy non-directory lock without recursive removal', async () => {
    const { lockPath } = await fixture('legacy-file');
    await writeFile(lockPath, 'legacy trust token\n', { mode: 0o600 });
    await makeStale(lockPath);

    const lease = await acquireLeaseLock(lockPath, options());
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    await lease.release();
  });

  it.each([
    ['truncated JSON', '{"version":2'],
    [
      'wrong shape',
      JSON.stringify({
        version: 2,
        ownerId: randomUUID(),
        leaseId: randomUUID(),
      }),
    ],
  ])(
    'treats %s token contents as garbage and preserves them',
    async (_label, raw) => {
      const { lockPath } = await fixture('malformed');
      await mkdir(lockPath, { mode: 0o700 });
      const path = tokenPath(lockPath);
      await writeFile(path, raw, { mode: 0o600 });
      await makeStale(path);

      await expect(
        acquireLeaseLock(lockPath, options())
      ).rejects.toBeInstanceOf(LeaseLockBusyError);
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  );

  it('publishes a renewal before retiring the old token and tracks both paths', async () => {
    const { lockPath } = await fixture('renew');
    const publication: { count: number; oldPath?: string } = { count: 0 };
    const lease = await acquireLeaseLock(
      lockPath,
      options({
        tokenFields: () => {
          publication.count += 1;
          if (publication.count === 2 && publication.oldPath !== undefined) {
            unlinkSync(publication.oldPath);
            mkdirSync(publication.oldPath);
          }
          return {};
        },
      })
    );
    const oldPath = lease.tokenPath;
    publication.oldPath = oldPath;

    const renewalError = await lease.renew().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(errorCode(renewalError)).toMatch(/^(?:EISDIR|EPERM)$/);

    expect(lease.createdTokenPaths).toHaveLength(2);
    expect(lease.tokenPath).not.toBe(oldPath);
    expect((await stat(lease.tokenPath)).size).toBeGreaterThan(0);
    expect((await stat(oldPath)).isDirectory()).toBe(true);
    await rm(oldPath, { recursive: true });
    await lease.release();
  });

  it('rejects a paused acquirer when its empty directory is reclaimed and recreated', async () => {
    const { lockPath } = await fixture('identity');
    const firstPaused = deferred();
    const resumeFirst = deferred();
    let firstHook = true;
    const first = acquireLeaseLock(
      lockPath,
      options({
        onAfterCanonicalMkdirBeforeToken: async () => {
          if (!firstHook) return;
          firstHook = false;
          firstPaused.resolve();
          await resumeFirst.promise;
        },
      })
    );
    await firstPaused.promise;
    await makeStale(lockPath);

    const second = await acquireLeaseLock(lockPath, options());
    const secondContents = await readFile(second.tokenPath, 'utf8');
    resumeFirst.resolve();

    await expect(first).rejects.toBeInstanceOf(LeaseLockBusyError);
    expect(await readFile(second.tokenPath, 'utf8')).toBe(secondContents);
    expect(await readdir(lockPath)).toEqual([
      second.tokenPath.slice(lockPath.length + 1),
    ]);
    await second.release();
  });

  it('rechecks empty-directory identity after classification before removal', async () => {
    const { lockPath } = await fixture('empty-identity');
    await mkdir(lockPath, { mode: 0o700 });
    await makeStale(lockPath);
    const replacementPath = join(lockPath, 'replacement');

    await expect(
      acquireLeaseLock(
        lockPath,
        options({
          onAfterExpiredTokensClassified: async () => {
            await rm(lockPath, { recursive: true });
            await mkdir(lockPath, { mode: 0o700 });
            await writeFile(replacementPath, 'live\n');
          },
        })
      )
    ).rejects.toBeInstanceOf(LeaseLockBusyError);
    expect(await readFile(replacementPath, 'utf8')).toBe('live\n');
  });

  it('removes only an expired sibling while preserving a live owner token', async () => {
    const { lockPath } = await fixture('siblings');
    const live = await acquireLeaseLock(lockPath, options());
    const liveContents = await readFile(live.tokenPath, 'utf8');
    const stalePath = await plantToken(lockPath, { stale: true });

    await expect(acquireLeaseLock(lockPath, options())).rejects.toBeInstanceOf(
      LeaseLockBusyError
    );
    await expectMissing(stalePath);
    expect(await readFile(live.tokenPath, 'utf8')).toBe(liveContents);

    await live.release();
    await expectMissing(lockPath);
  });

  it('validates adapter token fields with the configured schema', async () => {
    const { lockPath } = await fixture('extras');
    const schema = leaseTokenSchema
      .extend({ createdAt: z.number().int() })
      .strict();
    const lease = await acquireLeaseLock(
      lockPath,
      options({
        tokenSchema: schema,
        tokenFields: ({ now }) => ({ createdAt: now }),
        now: () => 123_456,
      })
    );

    expect(JSON.parse(await readFile(lease.tokenPath, 'utf8'))).toMatchObject({
      createdAt: 123_456,
    });
    await lease.release();
  });
});
