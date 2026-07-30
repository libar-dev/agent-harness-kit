import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HookEndpointFile,
  buildHookUrl,
  isCwdUnderRoots,
  isProcessAlive,
  readHookEndpointFile,
} from '../src/endpoint-discovery/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true }))
  );
});

describe('hook endpoint discovery', () => {
  it('round-trips a valid discovery file and builds an event URL', async () => {
    const dir = await createTempDir();
    const filePath = join(dir, 'endpoint.json');
    const endpoint = {
      version: 1 as const,
      pid: process.pid,
      port: 5710,
      token: '0123456789abcdef0123456789abcdef',
      url: 'http://127.0.0.1:5710',
      startedAt: '2026-07-12T12:00:00.000Z',
      projectRoots: ['/repo/project'],
    };
    await writeFile(filePath, JSON.stringify(endpoint));

    await expect(readHookEndpointFile(filePath)).resolves.toEqual(endpoint);
    expect(buildHookUrl(endpoint, 'PreToolUse')).toBe(
      `http://127.0.0.1:5710/hooks/${endpoint.token}/PreToolUse`
    );
  });

  it.each([
    { version: 2 },
    { version: 1, pid: 0 },
    { version: 1, pid: 1, port: 0 },
    { version: 1, pid: 1, port: 5710, token: 'wrong' },
  ])('rejects malformed discovery data %#', async partial => {
    const dir = await createTempDir();
    const filePath = join(dir, 'endpoint.json');
    await writeFile(
      filePath,
      JSON.stringify({
        token: '0123456789abcdef0123456789abcdef',
        startedAt: '2026-07-12T12:00:00.000Z',
        projectRoots: ['/repo'],
        ...partial,
      })
    );

    await expect(readHookEndpointFile(filePath)).resolves.toBeNull();
  });

  it('rejects invalid JSON and missing files without throwing', async () => {
    const dir = await createTempDir();
    const invalidPath = join(dir, 'invalid.json');
    await writeFile(invalidPath, '{');
    await expect(readHookEndpointFile(invalidPath)).resolves.toBeNull();
    await expect(
      readHookEndpointFile(join(dir, 'missing.json'))
    ).resolves.toBeNull();
  });

  it('checks exact, nested, sibling-prefix, and Windows paths', () => {
    expect(isCwdUnderRoots('/a/foo', ['/a/foo'])).toBe(true);
    expect(isCwdUnderRoots('/a/foo/nested', ['/a/foo'])).toBe(true);
    expect(isCwdUnderRoots('/a/foobar', ['/a/foo'])).toBe(false);
    expect(
      isCwdUnderRoots('C:\\Repo\\Project\\src', ['c:\\repo\\project'])
    ).toBe(true);
    expect(isCwdUnderRoots('C:\\Repo\\ProjectTwo', ['c:\\repo\\project'])).toBe(
      false
    );
  });

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('exposes the schema for consumers that validate before writing', () => {
    expect(
      HookEndpointFile.safeParse({
        version: 1,
        pid: process.pid,
        port: 5710,
        token: '0123456789abcdef0123456789abcdef',
        startedAt: 'now',
        projectRoots: [],
      }).success
    ).toBe(true);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hook-endpoint-'));
  tempDirs.push(dir);
  return dir;
}
