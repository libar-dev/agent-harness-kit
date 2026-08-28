import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertMarkerDirStillAllowed,
  isWithinPathResolved,
  resolveAllowedMarkerDir,
  writePrivateJson,
} from '../src/internal/marker-store.js';

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
  const root = await makeTempRoot('marker-store-containment-');
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

describe('marker-store symlink-resolving containment', () => {
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
