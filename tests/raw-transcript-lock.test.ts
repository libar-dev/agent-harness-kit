import { randomUUID } from 'node:crypto';
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

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  withRawTranscriptSessionMarkerLock,
  type RawTranscriptSessionLockOptions,
} from '../src/processing/tail.js';

const roots: string[] = [];
const DEAD_PID = 2_147_483_647;
const STALE_MS = 30_000;
const CLOCK_SKEW_MS = 60_000;
const TOKEN_NAME = /^owner\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i;
const FAST_ACQUIRE: RawTranscriptSessionLockOptions = {
  acquireTimeoutMs: 40,
  retryMs: 5,
};

async function fixture(label: string): Promise<{
  readonly root: string;
  readonly markerPath: string;
  readonly lockPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `raw-transcript-lock-${label}-`));
  roots.push(root);
  const markerPath = join(root, 'session.marker');
  return { root, markerPath, lockPath: `${markerPath}.lock` };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function makeStale(path: string): Promise<void> {
  const past = new Date(Date.now() - STALE_MS - 5_000);
  await utimes(path, past, past);
}

async function plantToken(
  lockPath: string,
  config: {
    readonly stale: boolean;
    readonly pid: number;
    readonly createdAt?: number;
    readonly contents?: string | Record<string, unknown>;
  }
): Promise<string> {
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  const ownerId = randomUUID();
  const leaseId = randomUUID();
  const path = join(lockPath, `owner.${ownerId}.${leaseId}`);
  const body =
    config.contents ??
    ({
      version: 2,
      ownerId,
      leaseId,
      pid: config.pid,
      createdAt: config.createdAt ?? Date.now() - STALE_MS - 5_000,
    } satisfies Record<string, unknown>);
  await writeFile(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    { mode: 0o600 }
  );
  if (config.stale) await makeStale(path);
  return path;
}

function asTokenRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected token object');
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

async function readSoleToken(
  lockPath: string
): Promise<{ readonly name: string; readonly token: Record<string, unknown> }> {
  const entries = await readdir(lockPath);
  expect(entries).toHaveLength(1);
  const [name] = entries;
  if (name === undefined) {
    throw new Error('expected a single token file');
  }
  expect(name).toMatch(TOKEN_NAME);
  return {
    name,
    token: asTokenRecord(
      JSON.parse(await readFile(join(lockPath, name), 'utf8'))
    ),
  };
}

afterEach(async () => {
  const pending = roots.splice(0, roots.length);
  await Promise.all(
    pending.map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('raw transcript session lock adapter', () => {
  it('creates one owner token and removes the lock directory on release', async () => {
    const { markerPath, lockPath } = await fixture('happy');
    const frozenNow = 1_700_000_123_456;

    await withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        expect((await stat(lockPath)).isDirectory()).toBe(true);
        const { token } = await readSoleToken(lockPath);
        expect(token).toMatchObject({
          version: 2,
          pid: process.pid,
          createdAt: frozenNow,
        });
        expect(typeof token['ownerId']).toBe('string');
        expect(typeof token['leaseId']).toBe('string');
      },
      { now: () => frozenNow }
    );

    await expectMissing(lockPath);
  });

  it('times out a second acquirer while a fresh owner is held', async () => {
    const { markerPath, lockPath } = await fixture('fresh-contention');
    const held = deferred();
    const started = deferred();
    let firstActionRan = false;
    let secondActionRan = false;

    const first = withRawTranscriptSessionMarkerLock(markerPath, async () => {
      firstActionRan = true;
      started.resolve();
      await held.promise;
    });
    await started.promise;
    const heldListing = await readdir(lockPath);
    expect(heldListing).toHaveLength(1);

    const second = withRawTranscriptSessionMarkerLock(
      markerPath,
      async () => {
        secondActionRan = true;
      },
      FAST_ACQUIRE
    );
    await expect(second).rejects.toThrow(
      `Timed out acquiring session marker lock '${lockPath}'`
    );
    expect(secondActionRan).toBe(false);
    expect(await readdir(lockPath)).toEqual(heldListing);

    held.resolve();
    await first;
    expect(firstActionRan).toBe(true);
    await expectMissing(lockPath);
  });

  it('reclaims a stale lock when the pid-liveness gate says the owner is dead', async () => {
    const { markerPath, lockPath } = await fixture('stale-dead');
    await plantToken(lockPath, { stale: true, pid: DEAD_PID });
    let actionRan = false;

    await withRawTranscriptSessionMarkerLock(markerPath, async () => {
      actionRan = true;
      const { token } = await readSoleToken(lockPath);
      expect(token['pid']).toBe(process.pid);
    });

    expect(actionRan).toBe(true);
    await expectMissing(lockPath);
  });

  it('does not reclaim a stale-mtime token whose createdAt is still fresh', async () => {
    const { markerPath, lockPath } = await fixture(
      'stale-mtime-fresh-created-at'
    );
    const planted = await plantToken(lockPath, {
      stale: true,
      pid: DEAD_PID,
      createdAt: Date.now(),
    });
    const before = await readFile(planted, 'utf8');
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
    expect(await readFile(planted, 'utf8')).toBe(before);
  });

  it('does not reclaim a stale lock whose pid is still alive', async () => {
    const { markerPath, lockPath } = await fixture('stale-alive');
    const planted = await plantToken(lockPath, {
      stale: true,
      pid: process.pid,
    });
    const before = await readFile(planted, 'utf8');
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
    expect(await readFile(planted, 'utf8')).toBe(before);
  });

  it('treats EPERM from the pid probe as alive and refuses reclaim', async () => {
    const { markerPath, lockPath } = await fixture('stale-eperm');
    const planted = await plantToken(lockPath, { stale: true, pid: DEAD_PID });
    const before = await readFile(planted, 'utf8');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error(
        'Operation not permitted'
      ) as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
    expect(await readFile(planted, 'utf8')).toBe(before);
  });

  it('fails closed on corrupt owner token data', async () => {
    const { markerPath, lockPath } = await fixture('corrupt');
    await plantToken(lockPath, {
      stale: true,
      pid: DEAD_PID,
      contents: '{not-json',
    });
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });

  it('fails closed when owner data is missing from a fresh lock directory', async () => {
    const { markerPath, lockPath } = await fixture('missing');
    await mkdir(lockPath, { mode: 0o700 });
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    expect(await readdir(lockPath)).toEqual([]);
  });

  it('fails closed when createdAt is beyond the clock-skew window', async () => {
    const { markerPath, lockPath } = await fixture('clock-skew');
    await plantToken(lockPath, {
      stale: true,
      pid: DEAD_PID,
      createdAt: Date.now() + CLOCK_SKEW_MS + 5_000,
    });
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
  });

  it('surfaces the adapter acquire-timeout error against a planted fresh token', async () => {
    const { markerPath, lockPath } = await fixture('timeout');
    await plantToken(lockPath, { stale: false, pid: process.pid });
    let actionRan = false;

    await expect(
      withRawTranscriptSessionMarkerLock(
        markerPath,
        async () => {
          actionRan = true;
        },
        FAST_ACQUIRE
      )
    ).rejects.toThrow(`Timed out acquiring session marker lock '${lockPath}'`);

    expect(actionRan).toBe(false);
  });
});
