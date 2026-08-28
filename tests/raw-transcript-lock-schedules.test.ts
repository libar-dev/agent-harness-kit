import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as NodeTimersPromises from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsSchedule = vi.hoisted(() => ({
  clockOffsetMs: 0,
  onOwnerReadAfterRead: undefined as
    | ((path: string) => Promise<void>)
    | undefined,
  onRenameAfter: undefined as
    | ((sourcePath: string, destinationPath: string) => Promise<void>)
    | undefined,
  onRmAfter: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  const callReadFile = actual.readFile as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const callRename = actual.rename as unknown as (
    ...args: unknown[]
  ) => Promise<void>;
  const callRm = actual.rm as unknown as (...args: unknown[]) => Promise<void>;
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const result = await callReadFile(...args);
      const path = String(args[0]);
      if (path.endsWith('/owner.json')) {
        await fsSchedule.onOwnerReadAfterRead?.(path);
      }
      return result;
    },
    rename: async (...args: unknown[]) => {
      await callRename(...args);
      await fsSchedule.onRenameAfter?.(String(args[0]), String(args[1]));
    },
    rm: async (...args: unknown[]) => {
      await callRm(...args);
      await fsSchedule.onRmAfter?.(String(args[0]));
    },
  };
});

vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof NodeTimersPromises>();
  return {
    ...actual,
    setTimeout: async () => {
      fsSchedule.clockOffsetMs += 5_001;
    },
  };
});

import {
  commitRawTranscriptSessionCheckpoint,
  getRawTranscriptSessionMarkerPath,
} from '../src/processing/tail.js';
import type { RawTranscriptSessionCheckpoint } from '../src/processing/types.js';

const tempRoots: string[] = [];
const realDateNow = Date.now.bind(Date);

afterEach(async () => {
  fsSchedule.clockOffsetMs = 0;
  fsSchedule.onOwnerReadAfterRead = undefined;
  fsSchedule.onRenameAfter = undefined;
  fsSchedule.onRmAfter = undefined;
  vi.restoreAllMocks();
  const roots = tempRoots.splice(0, tempRoots.length);
  await Promise.all(
    roots.map(root => rm(root, { recursive: true, force: true }))
  );
});

async function makeFixture(label: string): Promise<{
  readonly root: string;
  readonly mainPath: string;
  readonly markerDir: string;
  readonly markerPath: string;
  readonly lockPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `raw-transcript-lock-${label}-`));
  tempRoots.push(root);
  const mainPath = join(root, 'session.jsonl');
  const markerDir = join(root, 'markers');
  await writeFile(mainPath, '');
  const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerDir, [
    root,
  ]);
  return {
    root,
    mainPath,
    markerDir,
    markerPath,
    lockPath: `${markerPath}.lock`,
  };
}

function checkpoint(
  mainPath: string,
  baseRevision: number
): RawTranscriptSessionCheckpoint {
  return {
    sessionId: 'session',
    mainPathDigest: createHash('sha256')
      .update(resolve(mainPath))
      .digest('hex'),
    baseRevision,
    sources: [
      {
        sourceKind: 'main',
        sourceId: 'main',
        generation: 0,
        byteOffset: 0,
        fileSize: 0,
      },
    ],
  };
}

function commitOptions(fixture: {
  readonly root: string;
  readonly markerDir: string;
}): { readonly markerDir: string; readonly allowedMarkerRoots: string[] } {
  return {
    markerDir: fixture.markerDir,
    allowedMarkerRoots: [fixture.root],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('raw transcript session lock three-party schedules', () => {
  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T1 keeps fresh owner B canonical while displaced owner A releases', async () => {
    const fixture = await makeFixture('t1-displaced-owner');
    vi.spyOn(Date, 'now').mockImplementation(
      () => realDateNow() + fsSchedule.clockOffsetMs
    );

    let resumeAOwnerRead!: () => void;
    const ownerReadBarrier = new Promise<void>(resolveBarrier => {
      resumeAOwnerRead = resolveBarrier;
    });
    let sawAOwnerRead!: () => void;
    const aOwnerReadPaused = new Promise<void>(resolve => {
      sawAOwnerRead = resolve;
    });
    fsSchedule.onOwnerReadAfterRead = async path => {
      if (path !== join(fixture.lockPath, 'owner.json')) return;
      fsSchedule.onOwnerReadAfterRead = undefined;
      sawAOwnerRead();
      await ownerReadBarrier;
    };

    const ownerA = commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 0),
      commitOptions(fixture)
    );
    await aOwnerReadPaused;

    const ownerPath = join(fixture.lockPath, 'owner.json');
    const staleOwner: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (typeof staleOwner !== 'object' || staleOwner === null) {
      throw new Error('expected owner A document');
    }
    await writeFile(
      ownerPath,
      JSON.stringify({
        ...staleOwner,
        pid: 2_147_483_647,
        createdAt: Date.now() - 31_000,
      })
    );

    let resumeBAction!: () => void;
    const bActionBarrier = new Promise<void>(resolveBarrier => {
      resumeBAction = resolveBarrier;
    });
    let sawBAction!: () => void;
    const bActionPaused = new Promise<void>(resolve => {
      sawBAction = resolve;
    });
    fsSchedule.onRenameAfter = async (_sourcePath, destinationPath) => {
      if (destinationPath !== fixture.markerPath) return;
      fsSchedule.onRenameAfter = undefined;
      sawBAction();
      await bActionBarrier;
    };
    const ownerB = commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 1),
      commitOptions(fixture)
    );
    await bActionPaused;
    const ownerBBeforeRelease = await readFile(ownerPath, 'utf8');

    resumeAOwnerRead();
    await ownerA;
    const canonicalDuringBAction = await stat(fixture.lockPath).then(
      () => true,
      () => false
    );
    const ownerAfterARelease = await readFile(ownerPath, 'utf8').then(
      value => value,
      () => null
    );

    resumeBAction();
    await ownerB;

    expect(
      canonicalDuringBAction,
      'canonical raw transcript lock was removed while fresh owner B was live'
    ).toBe(true);
    expect(
      ownerAfterARelease,
      'displaced owner A disturbed fresh owner B ownership'
    ).toBe(ownerBBeforeRelease);
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T2 rejects interloper C while displaced owner A release is in flight', async () => {
    const fixture = await makeFixture('t2-release-interloper');
    vi.spyOn(Date, 'now').mockImplementation(
      () => realDateNow() + fsSchedule.clockOffsetMs
    );

    let resumeAOwnerRead!: () => void;
    const ownerReadBarrier = new Promise<void>(resolveBarrier => {
      resumeAOwnerRead = resolveBarrier;
    });
    let sawAOwnerRead!: () => void;
    const aOwnerReadPaused = new Promise<void>(resolve => {
      sawAOwnerRead = resolve;
    });
    fsSchedule.onOwnerReadAfterRead = async path => {
      if (path !== join(fixture.lockPath, 'owner.json')) return;
      fsSchedule.onOwnerReadAfterRead = undefined;
      sawAOwnerRead();
      await ownerReadBarrier;
    };

    let resumeARelease!: () => void;
    const releaseBarrier = new Promise<void>(resolveBarrier => {
      resumeARelease = resolveBarrier;
    });
    let sawARelease!: () => void;
    const aReleasePaused = new Promise<void>(resolve => {
      sawARelease = resolve;
    });
    fsSchedule.onRmAfter = async path => {
      if (path !== fixture.lockPath) return;
      fsSchedule.onRmAfter = undefined;
      sawARelease();
      await releaseBarrier;
    };

    const ownerA = commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 0),
      commitOptions(fixture)
    );
    await aOwnerReadPaused;
    const ownerPath = join(fixture.lockPath, 'owner.json');
    const staleOwner: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (typeof staleOwner !== 'object' || staleOwner === null) {
      throw new Error('expected owner A document');
    }
    await writeFile(
      ownerPath,
      JSON.stringify({
        ...staleOwner,
        pid: 2_147_483_647,
        createdAt: Date.now() - 31_000,
      })
    );

    let resumeBAction!: () => void;
    const bActionBarrier = new Promise<void>(resolveBarrier => {
      resumeBAction = resolveBarrier;
    });
    let sawBAction!: () => void;
    const bActionPaused = new Promise<void>(resolve => {
      sawBAction = resolve;
    });
    fsSchedule.onRenameAfter = async (_sourcePath, destinationPath) => {
      if (destinationPath !== fixture.markerPath) return;
      fsSchedule.onRenameAfter = undefined;
      sawBAction();
      await bActionBarrier;
    };
    const ownerB = commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 1),
      commitOptions(fixture)
    );
    await bActionPaused;

    resumeAOwnerRead();
    await aReleasePaused;
    const interloperError = await commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 2),
      commitOptions(fixture)
    ).then(
      () => null,
      (error: unknown) => error
    );
    const interloperEntered = interloperError === null;

    resumeARelease();
    await ownerA;
    resumeBAction();
    await ownerB;

    expect(
      interloperEntered,
      'interloper C entered through the canonical release vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toContain(
      'Timed out acquiring session marker lock'
    );
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T3 rejects interloper C while stale owner A reclamation is in flight', async () => {
    const fixture = await makeFixture('t3-reclaim-interloper');
    vi.spyOn(Date, 'now').mockImplementation(
      () => realDateNow() + fsSchedule.clockOffsetMs
    );
    const ownerPath = join(fixture.lockPath, 'owner.json');
    await mkdir(fixture.lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      ownerPath,
      JSON.stringify({
        token: '11111111-1111-4111-8111-111111111111',
        pid: 2_147_483_647,
        createdAt: Date.now() - 31_000,
      })
    );

    let resumeReclaimer!: () => void;
    const reclaimBarrier = new Promise<void>(resolveBarrier => {
      resumeReclaimer = resolveBarrier;
    });
    let sawReclaimGap!: () => void;
    const reclaimerPaused = new Promise<void>(resolve => {
      sawReclaimGap = resolve;
    });
    fsSchedule.onRenameAfter = async (sourcePath, destinationPath) => {
      if (
        sourcePath !== fixture.lockPath ||
        !destinationPath.startsWith(`${fixture.lockPath}.stale.`)
      ) {
        return;
      }
      fsSchedule.onRenameAfter = undefined;
      sawReclaimGap();
      await reclaimBarrier;
    };

    const reclaimer = commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 0),
      commitOptions(fixture)
    ).then(
      () => null,
      (error: unknown) => error
    );
    await reclaimerPaused;

    const interloperError = await commitRawTranscriptSessionCheckpoint(
      fixture.mainPath,
      checkpoint(fixture.mainPath, 0),
      commitOptions(fixture)
    ).then(
      () => null,
      (error: unknown) => error
    );
    const interloperEntered = interloperError === null;

    resumeReclaimer();
    await reclaimer;

    expect(
      interloperEntered,
      'interloper C entered through the canonical reclamation vacancy'
    ).toBe(false);
    expect(errorMessage(interloperError)).toContain(
      'Timed out acquiring session marker lock'
    );
  });
});
