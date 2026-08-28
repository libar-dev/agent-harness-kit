import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { blake3 } from '@noble/hashes/blake3.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal must use the actual module type
type FsPromisesModule = typeof import('node:fs/promises');
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

interface FsReadRecord {
  readonly requested: number[];
  actual: number;
}

const fsReadTracker = vi.hoisted(() => ({
  recordsByPath: new Map<string, FsReadRecord>(),
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<FsPromisesModule>();
  return {
    ...actual,
    open: async (path: string, flags: string) => {
      const handle = await actual.open(path, flags);
      const targetPath = path;
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== 'read') {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- preserve unrelated FileHandle members
            return Reflect.get(target, property, receiver);
          }
          return (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number
          ) => {
            const record = fsReadTracker.recordsByPath.get(targetPath) ?? {
              requested: [],
              actual: 0,
            };
            record.requested.push(length);
            fsReadTracker.recordsByPath.set(targetPath, record);
            // The proxy delegates the real FileHandle result unchanged.
            return originalRead(buffer, offset, length, position).then(
              result => {
                record.actual += result.bytesRead;
                return result;
              }
            );
          };
        },
      });
    },
  };
});

import {
  encodeGrokCwdDirname,
  findGrokSessionDirs,
  getGrokHome,
  listGrokSessions,
} from '../src/grok/processing/discovery.js';

const REPO_CWD = '/Users/darkomijic/dev-libar/libar-agent-harness-kit';
const REAL_SESSION_ID = '019ff923-c6d2-7561-952c-6bfe0eb50c22';
const REAL_CWD_DIR = join(
  homedir(),
  '.grok',
  'sessions',
  '%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit'
);
const REAL_SESSION_DIR = join(REAL_CWD_DIR, REAL_SESSION_ID);

let fixtureRoot: string;
let grokHome: string;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function upstreamSlug(input: string, maxLength: number): string {
  const lowered = input.toLowerCase();
  let result = '';
  let previousWasDash = false;

  for (const character of lowered) {
    if (/^[a-z0-9]$/.test(character)) {
      result += character;
      previousWasDash = false;
    } else if (!previousWasDash) {
      result += '-';
      previousWasDash = true;
    }
  }

  return result.replace(/^-+|-+$/g, '').slice(0, maxLength);
}

function validSummary(modelId: string): Record<string, unknown> {
  return {
    info: { id: 'session-id', cwd: REPO_CWD },
    session_summary: 'Fixture session',
    created_at: '2026-08-13T10:00:00Z',
    updated_at: '2026-08-13T10:01:00Z',
    num_messages: 2,
    current_model_id: modelId,
    future_field: true,
  };
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'grok-discovery-'));
  grokHome = join(fixtureRoot, 'home');
  await mkdir(grokHome, { recursive: true });
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('Grok session discovery', () => {
  it('matches upstream URL encoding for this repository cwd', () => {
    expect(encodeGrokCwdDirname(REPO_CWD)).toBe(
      '%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit'
    );
  });

  it('escapes every byte outside the upstream unreserved character set', () => {
    expect(encodeGrokCwdDirname('/a-b_c.d~e!f')).toBe('%2Fa-b_c.d~e%21f');
  });

  it('matches the independently restated upstream long-path algorithm', () => {
    const cwd = `/Users/example/${'nested directory/'.repeat(30)}My Project_日本語`;
    const encodedByteLength = Buffer.byteLength(
      encodeURIComponent(cwd).replace(
        /[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    );
    expect(encodedByteLength).toBeGreaterThan(255);

    const leaf = basename(cwd) || 'workspace';
    const slug = upstreamSlug(leaf, 40) || 'workspace';
    const hash16 = bytesToHex(blake3(new TextEncoder().encode(cwd))).slice(
      0,
      16
    );

    expect(encodeGrokCwdDirname(cwd)).toBe(`${slug}-${hash16}`);
  });

  it('does not cache GROK_HOME across injected environments', () => {
    expect(getGrokHome({ GROK_HOME: '/tmp/grok-one' })).toBe('/tmp/grok-one');
    expect(getGrokHome({ GROK_HOME: '/tmp/grok-two' })).toBe('/tmp/grok-two');
  });

  it('returns empty arrays when GROK_HOME does not exist', async () => {
    const env = { GROK_HOME: join(fixtureRoot, 'missing') };

    await expect(findGrokSessionDirs(REPO_CWD, env)).resolves.toEqual([]);
    await expect(listGrokSessions(REPO_CWD, env)).resolves.toEqual([]);
  });

  it('reads oversized summary and cwd files only through their byte bounds', async () => {
    const cwd = '/fixtures/bounded-discovery';
    const cwdDir = join(grokHome, 'sessions', 'hashed-cwd-deadbeefdeadbeef');
    const sessionDir = join(cwdDir, 'bounded-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(cwdDir, '.cwd'), cwd);
    await writeFile(join(sessionDir, 'summary.json'), 'x'.repeat(128 * 1024));
    fsReadTracker.recordsByPath.clear();
    const cwdPath = join(cwdDir, '.cwd');
    const summaryPath = join(sessionDir, 'summary.json');
    const sessions = await listGrokSessions(cwd, { GROK_HOME: grokHome });

    expect(sessions[0]?.kind).toBe('invalid');
    const cwdRecord = fsReadTracker.recordsByPath.get(cwdPath);
    const summaryRecord = fsReadTracker.recordsByPath.get(summaryPath);
    expect(cwdRecord?.requested.length).toBeGreaterThan(0);
    expect(summaryRecord?.requested.length).toBeGreaterThan(0);
    expect(cwdRecord?.requested.every(length => length <= 4 * 1024)).toBe(true);
    expect(summaryRecord?.requested.every(length => length <= 64 * 1024)).toBe(
      true
    );
    expect(cwdRecord?.requested).toContain(4 * 1024);
    expect(summaryRecord?.requested).toContain(64 * 1024);
    expect(cwdRecord?.actual).toBeLessThanOrEqual(4 * 1024);
    expect(summaryRecord?.actual).toBeLessThanOrEqual(64 * 1024);
  });

  it('surfaces an oversized summary as an invalid session', async () => {
    const cwd = '/fixtures/oversized-summary';
    const sessionDir = join(
      grokHome,
      'sessions',
      encodeGrokCwdDirname(cwd),
      'oversized-session'
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'summary.json'), 'x'.repeat(65 * 1024));

    const sessions = await listGrokSessions(cwd, { GROK_HOME: grokHome });

    expect(sessions).toEqual([
      expect.objectContaining({
        kind: 'invalid',
        sessionId: 'oversized-session',
      }),
    ]);
  });

  it('surfaces one malformed summary without hiding a valid sibling', async () => {
    const cwd = '/fixtures/mixed-summaries';
    const cwdDir = join(grokHome, 'sessions', encodeGrokCwdDirname(cwd));
    const validDir = join(cwdDir, 'valid-session');
    const invalidDir = join(cwdDir, 'invalid-session');
    await mkdir(validDir, { recursive: true });
    await mkdir(invalidDir, { recursive: true });
    await writeFile(
      join(validDir, 'summary.json'),
      JSON.stringify(validSummary('grok-4'))
    );
    await writeFile(join(invalidDir, 'summary.json'), '{"info":');

    const sessions = await listGrokSessions(cwd, { GROK_HOME: grokHome });

    expect(sessions).toHaveLength(2);
    const valid = sessions.find(session => session.kind === 'valid');
    expect(valid?.sessionId).toBe('valid-session');
    expect(valid?.summary.current_model_id).toBe('grok-4');
    const invalid = sessions.find(session => session.kind === 'invalid');
    expect(invalid?.sessionId).toBe('invalid-session');
    expect(invalid?.error).toBeInstanceOf(ZodError);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'surfaces a summary.json read failure as the underlying error',
    async () => {
      const cwd = '/fixtures/unreadable-summary';
      const sessionDir = join(
        grokHome,
        'sessions',
        encodeGrokCwdDirname(cwd),
        'unreadable-session'
      );
      const summaryPath = join(sessionDir, 'summary.json');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(summaryPath, JSON.stringify(validSummary('grok-4')));
      await chmod(summaryPath, 0o000);

      try {
        const sessions = await listGrokSessions(cwd, { GROK_HOME: grokHome });
        expect(sessions).toHaveLength(1);
        const invalid = sessions.find(session => session.kind === 'invalid');
        expect(invalid?.error).toBeInstanceOf(Error);
        expect(invalid?.error).not.toBeInstanceOf(ZodError);
        expect(invalid?.error.message).not.toBe('Required');
        expect(invalid?.error.message).toMatch(/EACCES|permission denied/i);
      } finally {
        await chmod(summaryPath, 0o600);
      }
    }
  );

  it('finds a hashed cwd directory through its plain-text .cwd fallback', async () => {
    const cwd = '/fixtures/fallback/workspace';
    const fallbackDir = join(
      grokHome,
      'sessions',
      'workspace-deadbeefdeadbeef'
    );
    const sessionDir = join(fallbackDir, 'fallback-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(fallbackDir, '.cwd'), `${cwd}\n`);
    await writeFile(
      join(sessionDir, 'summary.json'),
      JSON.stringify(validSummary('grok-fallback'))
    );

    await expect(
      findGrokSessionDirs(cwd, { GROK_HOME: grokHome })
    ).resolves.toEqual([sessionDir]);
    const sessions = await listGrokSessions(cwd, { GROK_HOME: grokHome });
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        kind: 'valid',
        sessionId: 'fallback-session',
      })
    );
  });

  it.skipIf(!existsSync(REAL_SESSION_DIR))(
    'resolves the known real Grok session',
    async () => {
      const sessions = await listGrokSessions(REPO_CWD);
      expect(
        sessions.some(session => session.sessionId === REAL_SESSION_ID)
      ).toBe(true);
    }
  );
});
