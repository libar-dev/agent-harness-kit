import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  encodeSenpiCwdDirname,
  findSenpiSessionDirs,
  getSenpiSessionsRoot,
} from '../src/senpi/processing/discovery.js';
import {
  listAllSenpiSessions,
  listSenpiSessions,
  type SenpiSessionListing,
} from '../src/senpi/processing/listing.js';

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

/** Every temp store created during this run; removed in afterAll. */
const createdStores: string[] = [];

let agentHomeRoot: string;

afterAll(async () => {
  await Promise.all(
    createdStores.map(store => rm(store, { recursive: true, force: true }))
  );
});

async function makeStore(): Promise<string> {
  agentHomeRoot = await mkdtemp(join(tmpdir(), 'senpi-discovery-'));
  createdStores.push(agentHomeRoot);
  return agentHomeRoot;
}

function sessionsDir(agentHome: string): string {
  return getSenpiSessionsRoot(agentHome);
}

function projectDir(agentHome: string, cwd: string): string {
  return join(sessionsDir(agentHome), encodeSenpiCwdDirname(cwd));
}

interface SessionSpec {
  readonly file: string;
  readonly cwd: string;
  readonly id: string;
  readonly name?: string;
  readonly parentSession?: string;
  readonly userMessages?: readonly string[];
  readonly assistantMessages?: number;
  readonly rawLines?: readonly unknown[];
}

interface HeaderSpec {
  readonly cwd: string;
  readonly id: string;
  readonly parentSession?: string;
}

function headerLine(spec: HeaderSpec): Record<string, unknown> {
  const header: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: spec.id,
    timestamp: '2026-08-20T10:00:00.000Z',
    cwd: spec.cwd,
  };
  if (spec.parentSession !== undefined) {
    header['parentSession'] = spec.parentSession;
  }
  return header;
}

function userMessageLine(
  id: string,
  parentId: string | null,
  text: string
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-20T10:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1771000001000 },
  };
}

function assistantMessageLine(
  id: string,
  parentId: string | null
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-20T10:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: USAGE,
      stopReason: 'stop',
      timestamp: 1771000002000,
    },
  };
}

function sessionInfoLine(
  id: string,
  parentId: string | null,
  name: string
): Record<string, unknown> {
  return {
    type: 'session_info',
    id,
    parentId,
    timestamp: '2026-08-20T10:00:03.000Z',
    name,
  };
}

async function writeSession(
  agentHome: string,
  spec: SessionSpec
): Promise<string> {
  const dir = projectDir(agentHome, spec.cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, spec.file);

  const lines: unknown[] = [headerLine(spec)];
  let previousId: string | null = null;
  let counter = 0;
  for (const text of spec.userMessages ?? []) {
    const entryId = `${spec.id}-u${counter}`;
    lines.push(userMessageLine(entryId, previousId, text));
    previousId = entryId;
    counter += 1;
  }
  for (let i = 0; i < (spec.assistantMessages ?? 0); i += 1) {
    const entryId = `${spec.id}-a${i}`;
    lines.push(assistantMessageLine(entryId, previousId));
    previousId = entryId;
  }
  if (spec.name !== undefined) {
    lines.push(sessionInfoLine(`${spec.id}-n`, previousId, spec.name));
  }
  lines.push(...(spec.rawLines ?? []));

  await writeFile(path, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
  return path;
}

async function writeRawFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function validInfos(listings: readonly SenpiSessionListing[]): string[] {
  return listings
    .filter(listing => listing.kind === 'valid')
    .map(listing => (listing.kind === 'valid' ? listing.info.id : ''))
    .sort((a, b) => a.localeCompare(b));
}

describe('senpi discovery', () => {
  it('encodes cwd path separators as dashes with -- wrapping', () => {
    expect(encodeSenpiCwdDirname('/home/me/proj')).toBe('--home-me-proj--');
    expect(encodeSenpiCwdDirname('rel/path')).toBe('--rel-path--');
    // Ambiguity is documented and irreversible: no decoder exists.
  });

  it('resolves the sessions root under an injected agent home only', async () => {
    const agentHome = await makeStore();
    expect(getSenpiSessionsRoot(agentHome)).toBe(join(agentHome, 'sessions'));
  });

  it('finds the encoded candidate dir and returns [] on a missing root', async () => {
    const agentHome = await makeStore();
    const cwd = '/work/alpha';
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl',
      cwd,
      id: 's-alpha-1',
    });

    const dirs = await findSenpiSessionDirs(cwd, agentHome);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(projectDir(agentHome, cwd));
    await expect(
      findSenpiSessionDirs('/work/none', agentHome)
    ).resolves.toEqual([]);
    await expect(
      findSenpiSessionDirs('/work/alpha', join(agentHome, 'missing-home'))
    ).resolves.toEqual([]);
  });

  it('lists a 3-project store per-project and across all projects', async () => {
    const agentHome = await makeStore();
    const alphaFiles = [
      {
        file: '2026-08-20T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl',
        cwd: '/work/alpha',
        id: 's-alpha-1',
        userMessages: ['hello alpha'],
      },
      {
        file: '2026-08-20T11-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl',
        cwd: '/work/alpha',
        id: 's-alpha-2',
      },
    ];
    for (const spec of alphaFiles) {
      await writeSession(agentHome, spec);
    }
    await writeSession(agentHome, {
      file: '2026-08-20T12-00-00-000Z_33333333-3333-4333-8333-333333333333.jsonl',
      cwd: '/work/beta',
      id: 's-beta-1',
    });
    await writeSession(agentHome, {
      file: '2026-08-20T13-00-00-000Z_44444444-4444-4444-8444-444444444444.jsonl',
      cwd: '/work/gamma/deep',
      id: 's-gamma-1',
    });

    const alpha = await listSenpiSessions('/work/alpha', { agentHome });
    expect(validInfos(alpha)).toEqual(['s-alpha-1', 's-alpha-2']);
    const beta = await listSenpiSessions('/work/beta', { agentHome });
    expect(validInfos(beta)).toEqual(['s-beta-1']);
    const gamma = await listSenpiSessions('/work/gamma/deep', { agentHome });
    expect(validInfos(gamma)).toEqual(['s-gamma-1']);

    const all = await listAllSenpiSessions({ agentHome });
    expect(validInfos(all)).toEqual([
      's-alpha-1',
      's-alpha-2',
      's-beta-1',
      's-gamma-1',
    ]);
  });

  it('disambiguates ambiguous dirnames via header-cwd verification', async () => {
    const agentHome = await makeStore();
    // `/a/b` and `/a-b` both encode to `--a-b--`, so both sessions share one
    // dirname; only the header cwd can tell them apart.
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
      cwd: '/a/b',
      id: 's-slash',
      userMessages: ['from /a/b'],
    });
    await writeSession(agentHome, {
      file: '2026-08-20T10-01-00-000Z_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
      cwd: '/a-b',
      id: 's-dash',
      userMessages: ['from /a-b'],
    });

    // The misleading-success guard: filtering must actually run, not just
    // return everything because both files live in the matched directory.
    const slashList = await listSenpiSessions('/a/b', { agentHome });
    expect(slashList).toHaveLength(1);
    expect(slashList[0]?.kind).toBe('valid');
    if (slashList[0]?.kind === 'valid') {
      expect(slashList[0].info.id).toBe('s-slash');
      expect(slashList[0].info.cwd).toBe('/a/b');
    }
    const dashList = await listSenpiSessions('/a-b', { agentHome });
    expect(dashList).toHaveLength(1);
    if (dashList[0]?.kind === 'valid') {
      expect(dashList[0].info.id).toBe('s-dash');
      expect(dashList[0].info.cwd).toBe('/a-b');
    }

    // Without the filter, listAll returns both.
    const all = await listAllSenpiSessions({ agentHome });
    expect(all).toHaveLength(2);
  });

  it('excludes *-artifacts directories and extensions subdirectories', async () => {
    const agentHome = await makeStore();
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl',
      cwd: '/work/alpha',
      id: 's-real',
    });

    const projDir = projectDir(agentHome, '/work/alpha');
    await writeRawFile(
      join(
        projDir,
        '2026-08-20T10-00-00-000Z_11111111-1111-4111-8111-111111111111-artifacts',
        'stray.jsonl'
      ),
      '{"type":"session"}\n'
    );
    await writeRawFile(
      join(projDir, 'extensions', 'state.jsonl'),
      '{"type":"session"}\n'
    );

    const perProject = await listSenpiSessions('/work/alpha', { agentHome });
    expect(perProject.map(entry => entry.kind)).toEqual(['valid']);
    if (perProject[0]?.kind === 'valid') {
      expect(perProject[0].info.id).toBe('s-real');
    }

    const all = await listAllSenpiSessions({ agentHome });
    expect(all.map(entry => entry.kind)).toEqual(['valid']);
    if (all[0]?.kind === 'valid') {
      expect(all[0].info.id).toBe('s-real');
    }
  });

  it('excludes root-level *-artifacts directories while retaining legitimate sessions', async () => {
    const agentHome = await makeStore();
    const artifactDir = join(
      sessionsDir(agentHome),
      '2026-08-20T10-00-00-000Z_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-artifacts'
    );
    await writeRawFile(
      join(artifactDir, 'stray.jsonl'),
      `${JSON.stringify(headerLine({ cwd: '/work/artifacts', id: 's-artifact' }))}\n`
    );

    const legitimateDir = join(sessionsDir(agentHome), 'legitimate-session');
    const legitimatePath = join(legitimateDir, 'session.jsonl');
    await writeRawFile(
      legitimatePath,
      `${JSON.stringify(headerLine({ cwd: '/work/legitimate', id: 's-legitimate' }))}\n`
    );

    const all = await listAllSenpiSessions({ agentHome });

    expect(all.map(entry => entry.kind)).toEqual(['valid']);
    if (all[0]?.kind === 'valid') {
      expect(all[0].info.id).toBe('s-legitimate');
    }
  });

  it('surfaces corrupt JSONL as an invalid entry without failing siblings', async () => {
    const agentHome = await makeStore();
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl',
      cwd: '/work/alpha',
      id: 's-good',
    });

    const projDir = projectDir(agentHome, '/work/alpha');
    await writeRawFile(
      join(projDir, 'bad-header.jsonl'),
      'not json at all {{{\n'
    );
    await writeRawFile(
      join(projDir, 'bad-tail.jsonl'),
      `${JSON.stringify(headerLine({ cwd: '/work/alpha', id: 'x' }))}\n{broken json\n`
    );
    await writeRawFile(
      join(projDir, 'bad-entry.jsonl'),
      `${JSON.stringify(headerLine({ cwd: '/work/alpha', id: 'y' }))}\n${JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: 'nope' })}\n`
    );

    const listings = await listSenpiSessions('/work/alpha', { agentHome });
    const validIds = listings
      .filter(l => l.kind === 'valid')
      .map(l => (l.kind === 'valid' ? l.info.id : ''));
    expect(validIds).toEqual(['s-good']);

    const invalidPaths = listings
      .filter(l => l.kind === 'invalid')
      .map(l => (l.kind === 'invalid' ? l.path : ''))
      .sort();
    expect(invalidPaths).toEqual([
      join(projDir, 'bad-entry.jsonl'),
      join(projDir, 'bad-header.jsonl'),
      join(projDir, 'bad-tail.jsonl'),
    ]);
    for (const listing of listings) {
      if (listing.kind === 'invalid') {
        expect(listing.error).toBeInstanceOf(Error);
        expect(listing.error.message.length).toBeGreaterThan(0);
      }
    }

    // Failure isolation also holds in the unfiltered listing.
    const all = await listAllSenpiSessions({ agentHome });
    expect(all.filter(l => l.kind === 'invalid')).toHaveLength(3);
    expect(all.filter(l => l.kind === 'valid')).toHaveLength(1);
  });

  it('fills SenpiSessionInfo fields from validated entries', async () => {
    const agentHome = await makeStore();
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl',
      cwd: '/work/alpha',
      id: 's-fields',
      userMessages: ['first question'],
      assistantMessages: 2,
      name: 'my session',
      parentSession: '/other/store/earlier.jsonl',
    });

    const listings = await listSenpiSessions('/work/alpha', { agentHome });
    expect(listings).toHaveLength(1);
    const listing = listings[0];
    if (listing?.kind !== 'valid') {
      throw new Error('expected a valid listing');
    }
    const info = listing.info;
    expect(info.id).toBe('s-fields');
    expect(info.cwd).toBe('/work/alpha');
    expect(info.name).toBe('my session');
    expect(info.parentSessionPath).toBe('/other/store/earlier.jsonl');
    expect(info.created).toEqual(new Date('2026-08-20T10:00:00.000Z'));
    expect(info.modified).toBeInstanceOf(Date);
    expect(info.messageCount).toBe(3);
    expect(info.firstMessage).toBe('first question');

    // Latest session_info wins when several exist.
    await writeSession(agentHome, {
      file: '2026-08-20T11-00-00-000Z_66666666-6666-4666-8666-666666666666.jsonl',
      cwd: '/work/alpha',
      id: 's-renamed',
      name: 'final-name',
      rawLines: [
        sessionInfoLine('r-n1', null, 'stale-name'),
        sessionInfoLine('r-n2', 'r-n1', 'final-name'),
      ],
    });
    const renamed = await listSenpiSessions('/work/alpha', { agentHome });
    const renamedListing = renamed.find(
      l => l.kind === 'valid' && l.info.id === 's-renamed'
    );
    if (renamedListing?.kind !== 'valid') {
      throw new Error('expected s-renamed to list as valid');
    }
    expect(renamedListing.info.name).toBe('final-name');
  });

  it('reports firstMessage null for a session without user messages', async () => {
    const agentHome = await makeStore();
    await writeSession(agentHome, {
      file: '2026-08-20T10-00-00-000Z_77777777-7777-4777-8777-777777777777.jsonl',
      cwd: '/work/quiet',
      id: 's-quiet',
    });
    const listings = await listSenpiSessions('/work/quiet', { agentHome });
    if (listings[0]?.kind !== 'valid') {
      throw new Error('expected s-quiet to list as valid');
    }
    expect(listings[0].info.firstMessage).toBe(null);
  });
});
