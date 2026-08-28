import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertMarkerDirStillAllowed,
  createMarkerPathDigest,
  hasErrorCode,
  isWithinPath,
  isWithinPathResolved,
  resolveAllowedMarkerDir,
  sanitizeMarkerBase,
  writePrivateJson,
} from '../src/internal/marker-store.js';
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

async function makeContainmentFixture(): Promise<{
  readonly allowed: string;
  readonly outside: string;
  readonly emptyRootsMessage: string;
}> {
  const root = await makeTempRoot('marker-store-symlink-');
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  return {
    allowed,
    outside,
    emptyRootsMessage:
      'Custom markerDir requires allowedMarkerRoots to include an allowed root',
  };
}

describe('internal marker-store', () => {
  it('rejects a marker directory outside allowed roots', () => {
    const tmp = resolve('/tmp/marker-store-gate-fixture');
    expect(() =>
      resolveAllowedMarkerDir(join(tmp, 'rejected'), {
        allowedMarkerRoots: [join(tmp, 'allowed')],
        emptyRootsMessage:
          'Custom markerDir requires allowedMarkerRoots to include an allowed root',
      })
    ).toThrow(/outside allowed marker roots/);
  });

  it('falls back to a parameterized env allow-list when roots are omitted', async () => {
    const root = await makeTempRoot('marker-store-env-');
    const allowed = join(root, 'allowed');
    const markerDir = join(allowed, 'markers');
    await mkdir(markerDir, { recursive: true });
    const envVar = 'TEST_INTERNAL_MARKER_ROOTS';
    const previous = process.env[envVar];
    process.env[envVar] = allowed;
    try {
      expect(
        resolveAllowedMarkerDir(markerDir, {
          rootsEnvVar: envVar,
          emptyRootsMessage:
            'Custom markerDir requires allowedMarkerRoots (or TEST_INTERNAL_MARKER_ROOTS) to include an allowed root',
        })
      ).toBe(resolve(markerDir));
    } finally {
      if (previous === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previous;
      }
    }
  });

  it('keeps digest stable across relative and absolute path forms', () => {
    const absolute = resolve('sessions/demo.jsonl');
    const relative = join('.', 'sessions', 'demo.jsonl');
    expect(createMarkerPathDigest(relative)).toBe(
      createMarkerPathDigest(absolute)
    );
    expect(createMarkerPathDigest(absolute)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sanitizes marker basename tokens', () => {
    expect(sanitizeMarkerBase('ok-name.jsonl')).toBe('ok-name.jsonl');
    expect(sanitizeMarkerBase('../weird name!!')).toBe('..-weird-name');
    expect(sanitizeMarkerBase('.')).toBe('session');
    expect(sanitizeMarkerBase('..')).toBe('session');
    expect(sanitizeMarkerBase('')).toBe('session');
  });

  it('detects path containment and errno codes', () => {
    expect(isWithinPath('/tmp/a/b', '/tmp/a')).toBe(true);
    expect(isWithinPath('/tmp/a', '/tmp/a')).toBe(true);
    expect(isWithinPath('/tmp/ab', '/tmp/a')).toBe(false);
    expect(hasErrorCode({ code: 'EEXIST' }, 'EEXIST')).toBe(true);
    expect(hasErrorCode({ code: 'ENOENT' }, 'EEXIST')).toBe(false);
    expect(hasErrorCode('nope', 'EEXIST')).toBe(false);
  });

  it('writePrivateJson uses O_EXCL temp create, fsync, rename, and 0o600 mode', async () => {
    const root = await makeTempRoot('marker-store-write-');
    const path = join(root, 'nested', 'marker.json');
    await writePrivateJson(path, { markerVersion: 1, ok: true });

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ markerVersion: 1, ok: true });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const leftover = await readdir(join(root, 'nested'));
    expect(leftover.filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it('writePrivateJson cleans temp litter when the destination cannot be replaced', async () => {
    const root = await makeTempRoot('marker-store-litter-');
    const path = join(root, 'marker.json');
    await mkdir(path, { recursive: true });

    await expect(writePrivateJson(path, { ok: true })).rejects.toThrow();
    const leftover = await readdir(root);
    expect(leftover.filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it('rejects a markerDir symlink whose target is outside all allowed roots', async () => {
    const { allowed, outside, emptyRootsMessage } =
      await makeContainmentFixture();
    const markerDir = join(allowed, 'markers');
    await symlink(outside, markerDir);
    const resolvedDir = resolve(markerDir);

    expect(() =>
      resolveAllowedMarkerDir(markerDir, {
        allowedMarkerRoots: [allowed],
        emptyRootsMessage,
      })
    ).toThrow(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
    expect(isWithinPathResolved(markerDir, allowed)).toBe(false);
  });

  it('rejects a symlink inside allowed roots that points outward', async () => {
    const { allowed, outside, emptyRootsMessage } =
      await makeContainmentFixture();
    const escape = join(allowed, 'escape');
    await symlink(outside, escape);
    const markerDir = join(escape, 'markers');
    const resolvedDir = resolve(markerDir);

    expect(() =>
      resolveAllowedMarkerDir(markerDir, {
        allowedMarkerRoots: [allowed],
        emptyRootsMessage,
      })
    ).toThrow(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
    expect(isWithinPathResolved(markerDir, allowed)).toBe(false);
  });

  it('allows a realpath-resolved directory that stays inside allowed roots', async () => {
    const { allowed, emptyRootsMessage } = await makeContainmentFixture();
    const realDir = join(allowed, 'real');
    const linkDir = join(allowed, 'via-link');
    const notYet = join(allowed, 'not-yet', 'markers');
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    expect(
      resolveAllowedMarkerDir(realDir, {
        allowedMarkerRoots: [allowed],
        emptyRootsMessage,
      })
    ).toBe(resolve(realDir));
    expect(
      resolveAllowedMarkerDir(linkDir, {
        allowedMarkerRoots: [allowed],
        emptyRootsMessage,
      })
    ).toBe(resolve(linkDir));
    expect(
      resolveAllowedMarkerDir(notYet, {
        allowedMarkerRoots: [allowed],
        emptyRootsMessage,
      })
    ).toBe(resolve(notYet));
    expect(isWithinPathResolved(realDir, allowed)).toBe(true);
    expect(isWithinPathResolved(linkDir, allowed)).toBe(true);
    expect(isWithinPathResolved(notYet, allowed)).toBe(true);
  });

  it('assertMarkerDirStillAllowed rejects a dir swapped for an outward symlink', async () => {
    const { allowed, outside, emptyRootsMessage } =
      await makeContainmentFixture();
    const markerDir = join(allowed, 'markers');
    await mkdir(markerDir, { recursive: true });
    const options = {
      allowedMarkerRoots: [allowed],
      emptyRootsMessage,
    } as const;
    const resolvedDir = resolve(markerDir);

    expect(resolveAllowedMarkerDir(markerDir, options)).toBe(resolvedDir);
    expect(() => assertMarkerDirStillAllowed(markerDir, options)).not.toThrow();

    await rm(markerDir, { recursive: true });
    await symlink(outside, markerDir);

    expect(() => assertMarkerDirStillAllowed(markerDir, options)).toThrow(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
    await expect(
      writePrivateJson(join(markerDir, 'marker.json'), { ok: true }, options)
    ).rejects.toThrow(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
  });
});

describe('internal marker-lock', () => {
  it('removes a stale lock and lets the next holder proceed', async () => {
    const root = await makeTempRoot('marker-lock-stale-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const staleSeconds = DEFAULT_STALE_MARKER_LOCK_MS / 1000 + 5;
    const past = new Date(Date.now() - staleSeconds * 1000);
    await utimes(lockPath, past, past);

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

  it('rejects a fresh competing lock with the adapter label', async () => {
    const root = await makeTempRoot('marker-lock-fresh-');
    const markerPath = join(root, 'session.marker.json');
    const lockPath = `${markerPath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });

    await expect(
      withMarkerLock(markerPath, async () => 'never', {
        lockedLabel: 'Grok session marker',
      })
    ).rejects.toThrow(`Grok session marker is locked: '${markerPath}'`);
  });
});
