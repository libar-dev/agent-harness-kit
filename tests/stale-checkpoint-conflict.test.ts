import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  isStaleCheckpointConflict,
} from '../src/processing/stale-checkpoint-conflict.js';
import {
  commitRawTranscriptSessionCheckpoint,
  tailRawTranscriptSessionRecords,
} from '../src/processing/tail.js';
import {
  commitGrokSessionCheckpoint,
  tailGrokSession,
} from '../src/grok/processing/tail.js';
import {
  commitSenpiSessionCheckpoint,
  createSenpiSessionPathDigest,
  getSenpiSessionMarkerPath,
  type SenpiSessionCheckpoint,
} from '../src/senpi/processing/checkpoint.js';
import { tailSenpiSession } from '../src/senpi/processing/tail.js';
import {
  assertSenpiSmokeProbeInputsUnchanged,
  hashSenpiSmokeProbeInputs,
} from '../scripts/senpi-smoke-safety.js';

const execFileAsync = promisify(execFile);
const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, '..');
const senpiFixture = join(
  testsDir,
  'fixtures/senpi/synthetic-header-only.jsonl'
);
const grokUpdatesFixture = join(testsDir, 'fixtures/grok/updates.sample.jsonl');
const grokEventsFixture = join(testsDir, 'fixtures/grok/events.sample.jsonl');

const SENPI_STALE_PROSE =
  'Senpi session checkpoint is stale for the current marker';
const RAW_STALE_PROSE = 'Session checkpoint is stale for the current marker';
const GROK_STALE_PROSE =
  'Grok session checkpoint is stale for the current marker';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true }))
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function identifiedByExactProse(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

function expectTypedConflict(
  error: unknown,
  expectedRevision: number,
  actualRevision: number
): void {
  expect(isStaleCheckpointConflict(error)).toBe(true);
  if (!isStaleCheckpointConflict(error)) {
    throw new Error('expected a typed stale checkpoint conflict');
  }
  expect(error).toBeInstanceOf(StaleCheckpointConflict);
  expect(error.code).toBe(STALE_CHECKPOINT_CONFLICT_CODE);
  expect(error.expectedRevision).toBe(expectedRevision);
  expect(error.actualRevision).toBe(actualRevision);
}

describe('stale checkpoint conflict identity', () => {
  it('proves prose matching cannot reliably identify a conflict', async () => {
    const lookalike = new Error(SENPI_STALE_PROSE);
    expect(identifiedByExactProse(lookalike, SENPI_STALE_PROSE)).toBe(true);
    expect(isStaleCheckpointConflict(lookalike)).toBe(false);

    const root = await temporaryRoot('senpi-conflict-prose-');
    const sessionPath = join(root, 'sess-1.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(sessionPath, '{"type":"session"}\n');
    const checkpoint = sampleSenpiCheckpoint(sessionPath);
    await commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
      markerDir,
      allowedMarkerRoots: [root],
    });

    let thrown: unknown;
    try {
      await commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
        markerDir,
        allowedMarkerRoots: [root],
      });
      thrown = undefined;
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(identifiedByExactProse(thrown, SENPI_STALE_PROSE)).toBe(false);
    expect(identifiedByExactProse(thrown, RAW_STALE_PROSE)).toBe(false);
    expect(identifiedByExactProse(thrown, GROK_STALE_PROSE)).toBe(false);
    expectTypedConflict(thrown, 0, 1);
  });

  it('does not classify malformed revision fields as a conflict or success', () => {
    const malformed = {
      name: 'StaleCheckpointConflict',
      message: 'ok',
      code: STALE_CHECKPOINT_CONFLICT_CODE,
      expectedRevision: '0',
      actualRevision: 1,
    };
    expect(isStaleCheckpointConflict(malformed)).toBe(false);
    expect(
      () =>
        new StaleCheckpointConflict({
          expectedRevision: Number.NaN,
          actualRevision: 1,
        })
    ).toThrow(TypeError);
    expect(
      () =>
        new StaleCheckpointConflict({
          expectedRevision: 0,
          actualRevision: -1,
        })
    ).toThrow(TypeError);
  });
});

describe('checkpoint writers throw the typed conflict', () => {
  it('senpi commit exposes structured expected and actual revisions', async () => {
    const root = await temporaryRoot('senpi-conflict-writer-');
    const sessionPath = join(root, 'sess-1.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(sessionPath, '{"type":"session"}\n');
    const checkpoint = sampleSenpiCheckpoint(sessionPath);
    await commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
      markerDir,
      allowedMarkerRoots: [root],
    });

    await expect(
      commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
        markerDir,
        allowedMarkerRoots: [root],
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        isStaleCheckpointConflict(error) &&
        error.expectedRevision === 0 &&
        error.actualRevision === 1 &&
        error.code === STALE_CHECKPOINT_CONFLICT_CODE
    );
  });

  it('raw transcript commit exposes structured expected and actual revisions', async () => {
    const root = await temporaryRoot('raw-conflict-writer-');
    const mainPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(
      mainPath,
      `${JSON.stringify({
        type: 'queue-operation',
        sessionId: 'raw-stale',
        uuid: 'raw-1',
        value: 'raw-1',
      })}\n`
    );
    const first = await tailRawTranscriptSessionRecords(mainPath, {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual',
      rawRedactionMode: 'unsafe-unredacted',
    });
    await commitRawTranscriptSessionCheckpoint(mainPath, first.checkpoint, {
      markerDir,
      allowedMarkerRoots: [root],
    });

    await expect(
      commitRawTranscriptSessionCheckpoint(mainPath, first.checkpoint, {
        markerDir,
        allowedMarkerRoots: [root],
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        isStaleCheckpointConflict(error) &&
        error.expectedRevision === first.checkpoint.baseRevision &&
        error.actualRevision === first.checkpoint.baseRevision + 1 &&
        error.code === STALE_CHECKPOINT_CONFLICT_CODE
    );
  });

  it('grok commit exposes structured expected and actual revisions', async () => {
    const root = await temporaryRoot('grok-conflict-writer-');
    const session = join(root, 'session');
    const markerDir = join(root, 'markers');
    await mkdir(session);
    await Promise.all([
      copyFile(grokUpdatesFixture, join(session, 'updates.jsonl')),
      copyFile(grokEventsFixture, join(session, 'events.jsonl')),
    ]);
    const first = await tailGrokSession(session, {
      markerDir,
      allowedMarkerRoots: [root],
      fromStart: true,
      checkpointMode: 'manual',
    });
    await commitGrokSessionCheckpoint(session, first.checkpoint, {
      markerDir,
      allowedMarkerRoots: [root],
    });

    await expect(
      commitGrokSessionCheckpoint(session, first.checkpoint, {
        markerDir,
        allowedMarkerRoots: [root],
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        isStaleCheckpointConflict(error) &&
        error.expectedRevision === first.checkpoint.baseRevision &&
        error.actualRevision === first.checkpoint.baseRevision + 1 &&
        error.code === STALE_CHECKPOINT_CONFLICT_CODE
    );
  });
});

describe('senpi live smoke mutation safety', () => {
  it('leaves marker, config, and transcript hashes unchanged in manual mode', async () => {
    const fixture = await createIsolatedSmokeFixture();
    const before = await hashSenpiSmokeProbeInputs(fixture.probePaths);

    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', 'scripts/senpi-live-smoke.mts', fixture.sessionPath],
      {
        cwd: repoRoot,
        env: isolatedSmokeEnv(fixture.home),
      }
    );

    expect(stderr).toBe('');
    expect(stdout).toContain('tail:');
    expect(stdout).toContain('blocks:');
    const after = await hashSenpiSmokeProbeInputs(fixture.probePaths);
    assertSenpiSmokeProbeInputsUnchanged(before, after);
  });

  it('fails the mutation detector when manual checkpoint mode is omitted', async () => {
    const fixture = await createIsolatedSmokeFixture();
    const before = await hashSenpiSmokeProbeInputs(fixture.probePaths);

    await tailSenpiSession(fixture.sessionPath);

    const after = await hashSenpiSmokeProbeInputs(fixture.probePaths);
    expect(() => assertSenpiSmokeProbeInputsUnchanged(before, after)).toThrow(
      /Smoke probe inputs mutated/
    );
  });
});

function sampleSenpiCheckpoint(sessionPath: string): SenpiSessionCheckpoint {
  return {
    sessionPathDigest: createSenpiSessionPathDigest(sessionPath),
    sessionId: 'sess-1',
    device: '16777220',
    inode: '123456',
    generation: 0,
    offset: 20,
    lineNumber: 2,
    headDigest: 'a'.repeat(64),
    boundaryDigest: 'b'.repeat(64),
    baseRevision: 0,
    leafId: 'leaf-1',
    projectedRecordKeys: ['rec:1'],
  };
}

async function createIsolatedSmokeFixture(): Promise<{
  readonly home: string;
  readonly sessionPath: string;
  readonly probePaths: readonly string[];
}> {
  const home = await temporaryRoot('senpi-smoke-fixture-');
  const sessionDir = join(home, 'sessions', 'demo');
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'session.jsonl');
  const configPath = join(home, 'settings.json');
  await Promise.all([
    copyFile(senpiFixture, sessionPath),
    writeFile(configPath, `${JSON.stringify({ model: 'fixture' }, null, 2)}\n`),
  ]);
  return {
    home,
    sessionPath,
    probePaths: [
      getSenpiSessionMarkerPath(sessionPath),
      configPath,
      sessionPath,
    ],
  };
}

function isolatedSmokeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMO_CODING_AGENT_DIR: home,
    SENPI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
  };
}
