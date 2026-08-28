import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SENPI_HOOKS_STATE_FILENAME,
  SENPI_PROJECT_CONFIG_DIR,
  isSenpiCommandHookTrusted,
  readSenpiHookTrustState,
  type SenpiTrustCommandHookHandler,
} from '../src/senpi/trust.js';
import {
  SenpiTrustConsentError,
  SenpiTrustLockError,
  SenpiTrustStateMalformedError,
  removeSenpiHookTrustEntry,
  removeStaleStateLock,
  writeSenpiHookTrustEntry,
  withStateLock,
  type SenpiTrustWriterClock,
  type WriteSenpiHookTrustEntryOptions,
} from '../src/senpi/trust-writer.js';

/** Instant no-op sleep; used when the lock path does not need gated release. */
function instantClock(now = (): number => 0): SenpiTrustWriterClock {
  return {
    now,
    sleep: async () => undefined,
  };
}

/**
 * Clock whose first sleep parks until `release()`; later sleeps resolve
 * immediately. Lets tests drop an external lock between retry attempts
 * without wall-clock delays.
 */
function gatedReleaseClock(): {
  readonly clock: SenpiTrustWriterClock;
  readonly waitForFirstSleep: () => Promise<void>;
  readonly release: () => void;
} {
  let firstSleepResolve: (() => void) | undefined;
  let firstSleepSeen!: () => void;
  const firstSleepSeenPromise = new Promise<void>(resolve => {
    firstSleepSeen = resolve;
  });
  let firstSleepDone = false;
  return {
    clock: {
      now: () => 0,
      sleep: () =>
        new Promise<void>(resolve => {
          if (!firstSleepDone) {
            firstSleepDone = true;
            firstSleepResolve = resolve;
            firstSleepSeen();
            return;
          }
          resolve();
        }),
    },
    waitForFirstSleep: () => firstSleepSeenPromise,
    release: () => {
      firstSleepResolve?.();
      firstSleepResolve = undefined;
    },
  };
}

const FIXED_PLATFORM = 'linux' as const;

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    const dir = CLEANUP_DIRS.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'senpi-trust-writer-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

let handlerCounter = 0;

function makeHandler(overrides?: {
  readonly command?: string;
}): SenpiTrustCommandHookHandler {
  handlerCounter += 1;
  const n = handlerCounter;
  return {
    event: n % 2 === 0 ? 'PreToolUse' : 'PostToolUse',
    matcher: 'Bash',
    groupIndex: n,
    handlerIndex: 0,
    config: {
      type: 'command',
      command: overrides?.command ?? `node ./hooks/hook-${n}.mjs`,
    },
    source: {
      scope: 'project',
      sourcePath: `/repo/.senpi/hooks-${n}.json`,
    },
  };
}

function baseOpts(
  agentHome: string,
  handler: SenpiTrustCommandHookHandler
): WriteSenpiHookTrustEntryOptions {
  return {
    consent: true,
    reason: 'explicit user approval via desktop observer setup',
    handler,
    scope: 'global',
    agentHome,
    cwd: join(agentHome, 'unused-project'),
    platform: FIXED_PLATFORM,
  };
}

function globalStatePath(agentHome: string): string {
  return join(agentHome, SENPI_HOOKS_STATE_FILENAME);
}

function plantTokenDir(
  lockPath: string,
  stale: boolean
): { ownerId: string; leaseId: string; tokenName: string; tokenPath: string } {
  mkdirSync(lockPath, { recursive: true });
  const ownerId = randomUUID();
  const leaseId = randomUUID();
  const tokenName = `owner.${ownerId}.${leaseId}`;
  const tokenPath = join(lockPath, tokenName);
  writeFileSync(
    tokenPath,
    JSON.stringify({ version: 2, ownerId, leaseId, pid: 1 })
  );
  if (stale) {
    utimesSync(tokenPath, new Date(0), new Date(0));
  }
  return { ownerId, leaseId, tokenName, tokenPath };
}

function plantStaleTokenDir(lockPath: string) {
  return plantTokenDir(lockPath, true);
}

function plantLiveTokenDir(lockPath: string) {
  return plantTokenDir(lockPath, false);
}

interface StatSnapshot {
  readonly mtimeMs: number;
  readonly ino: number;
  readonly text: string;
}

function snapshot(path: string): StatSnapshot {
  const st = statSync(path);
  return {
    mtimeMs: st.mtimeMs,
    ino: st.ino,
    text: readFileSync(path, 'utf-8'),
  };
}

function tokenDirectorySnapshot(lockPath: string): Record<string, string> {
  const names = readdirSync(lockPath).sort();
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^owner\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i);
  const result: Record<string, string> = {};
  for (const name of names) {
    result[name] = readFileSync(join(lockPath, name), 'utf-8');
  }
  return result;
}

describe('senpi trust writer - preservation', () => {
  it('preserves unrelated entries and unknown top-level keys byte-for-byte', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const unrelated = {
      enabled: true,
      scope: 'project',
      sourcePath: '/repo/.senpi/other.json',
      commandPreview: 'echo keep-me',
      updatedAt: '2026-01-01T00:00:00.000Z',
      trustedHash: 'sha256:deadbeef',
      futureField: { nested: ['a', 1] },
    };
    const before = {
      version: 1,
      customTopLevelKey: { some: 'extension data' },
      hooks: { hk_unrelated_0_0: unrelated },
    };
    writeFileSync(globalStatePath(home), JSON.stringify(before, null, 2));

    const handler = makeHandler();
    await writeSenpiHookTrustEntry(baseOpts(home, handler));

    const afterText = readFileSync(globalStatePath(home), 'utf-8');
    const after: typeof before = JSON.parse(afterText);
    expect(after.version).toBe(1);
    expect(after.customTopLevelKey).toEqual({ some: 'extension data' });
    const kept = after.hooks['hk_unrelated_0_0'];
    expect(kept).toBeDefined();
    // Serialized value of the untouched entry is unchanged exactly.
    expect(JSON.stringify(after.hooks['hk_unrelated_0_0'])).toBe(
      JSON.stringify(unrelated)
    );
    // Target entry written alongside.
    const ids = Object.keys(after.hooks);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('hk_unrelated_0_0');
    void handler;
  });

  it('updates an existing entry for the same trust id in place', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const handler = makeHandler();
    await writeSenpiHookTrustEntry(baseOpts(home, handler));
    const second = await writeSenpiHookTrustEntry(baseOpts(home, handler));
    const state = readSenpiHookTrustState(globalStatePath(home));
    expect(state.ok).toBe(true);
    if (!state.ok) {
      throw new Error('expected ok');
    }
    expect(Object.keys(state.state.hooks)).toHaveLength(1);
    const reread: {
      hooks: Record<string, { grantReason?: string }>;
    } = JSON.parse(readFileSync(globalStatePath(home), 'utf-8'));
    expect(reread.hooks[second.id]?.grantReason).toBe(
      'explicit user approval via desktop observer setup'
    );
  });
});

describe('senpi trust writer - removal locking', () => {
  it('does not delete replacement state after its lease expires during removal', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const handler = makeHandler();
    const granted = await writeSenpiHookTrustEntry(baseOpts(home, handler));
    const statePath = globalStatePath(home);
    const replacementText = `${JSON.stringify(
      {
        version: 1,
        hooks: {
          hk_interloper_0_0: {
            ...granted.entry,
            grantReason: 'concurrent owner replacement',
          },
        },
      },
      null,
      2
    )}\n`;
    let nowCalls = 0;
    const clock = instantClock(() => {
      nowCalls += 1;
      if (nowCalls === 4) {
        writeFileSync(statePath, replacementText, 'utf-8');
        return Date.now() + 20_000;
      }
      return Date.now();
    });

    await expect(
      removeSenpiHookTrustEntry({
        consent: true,
        reason: 'explicit user revoke',
        handler,
        scope: 'global',
        agentHome: home,
        cwd: join(home, 'unused-project'),
        clock,
      })
    ).rejects.toMatchObject({ name: 'LeaseLockLostError' });

    expect(nowCalls).toBe(4);
    expect(readFileSync(statePath, 'utf-8')).toBe(replacementText);
  });
});

describe('senpi trust writer - locking', () => {
  it('serializes two concurrent writers; both entries present, no corruption', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const a = makeHandler();
    const b = makeHandler();
    const [ra, rb] = await Promise.all([
      writeSenpiHookTrustEntry(baseOpts(home, a)),
      writeSenpiHookTrustEntry(baseOpts(home, b)),
    ]);
    expect(ra.id).not.toBe(rb.id);
    const parsed: { version: number; hooks: Record<string, unknown> } =
      JSON.parse(readFileSync(globalStatePath(home), 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks).sort()).toEqual([ra.id, rb.id].sort());
  });

  it('retries while an external lock holder holds the lock, then succeeds', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, '999999\n', 'utf-8');
    const { clock, waitForFirstSleep, release } = gatedReleaseClock();
    const writePromise = writeSenpiHookTrustEntry({
      ...baseOpts(home, makeHandler()),
      clock,
    });
    // Drop the foreign lock exactly between retry attempts (no wall sleep).
    await waitForFirstSleep();
    rmSync(lockPath, { force: true });
    release();
    const result = await writePromise;
    expect(result.path).toBe(statePath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails bounded (no hang) when a lock is held forever, leaving state untouched', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    writeFileSync(statePath, '{\n  "version": 1,\n  "hooks": {}\n}', 'utf-8');
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, '123456\n', 'utf-8');
    const before = snapshot(statePath);
    let sleepCount = 0;
    // now() stays below lock mtime so the foreign lock is never treated stale.
    const clock: SenpiTrustWriterClock = {
      now: () => 0,
      sleep: async () => {
        sleepCount += 1;
      },
    };
    await expect(
      writeSenpiHookTrustEntry({ ...baseOpts(home, makeHandler()), clock })
    ).rejects.toMatchObject({ name: 'SenpiTrustLockError' });
    // Bounded budget: 10 attempts, sleep between the first 9 contentions.
    expect(sleepCount).toBe(9);
    expect(existsSync(lockPath)).toBe(true); // foreign lock never deleted
    expect(snapshot(statePath)).toEqual(before);
    expect(SenpiTrustLockError.name).toBe('SenpiTrustLockError');
  });

  it('release does not delete a lock reclaimed by another owner', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;

    // Owner A holds the trust lock; while its critical section runs it goes
    // stale and owner B reclaims. A's release must leave B's lock intact:
    // deleting it would admit a third writer and lose trust-state updates.
    let finishA!: () => void;
    const holdA = new Promise<void>(resolve => {
      finishA = resolve;
    });
    let sawA!: () => void;
    const aEntered = new Promise<void>(resolve => {
      sawA = resolve;
    });
    let finishB!: () => void;
    const holdB = new Promise<void>(resolve => {
      finishB = resolve;
    });
    let sawB!: () => void;
    const bEntered = new Promise<void>(resolve => {
      sawB = resolve;
    });

    const ownerA = withStateLock(
      statePath,
      async () => {
        sawA();
        await holdA;
      },
      instantClock()
    );
    await aEntered;
    const ownerB = withStateLock(
      statePath,
      async () => {
        sawB();
        await holdB;
      },
      instantClock(() => Date.now() + 20_000)
    );
    await bEntered;
    expect(statSync(lockPath).isDirectory()).toBe(true);
    const ownerBTokens = readdirSync(lockPath).sort();
    expect(ownerBTokens.length).toBeGreaterThan(0);
    expect(ownerBTokens.every(name => name.startsWith('owner.'))).toBe(true);

    finishA();
    await ownerA;
    expect(statSync(lockPath).isDirectory()).toBe(true);
    expect(readdirSync(lockPath).sort()).toEqual(ownerBTokens);
    finishB();
    await ownerB;
  });

  it('release leaves a malformed-content lock in place without throwing', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;

    // Owner A holds a directory lock; a non-JSON writer plants foreign
    // material inside it. Release must fail safe: no throw from the
    // unparseable content, and the foreign lock material is left untouched.
    await withStateLock(
      statePath,
      () => {
        writeFileSync(join(lockPath, 'owner.json'), 'not-json{\n', 'utf-8');
        return 'held';
      },
      instantClock()
    );

    expect(statSync(lockPath).isDirectory()).toBe(true);
    expect(readFileSync(join(lockPath, 'owner.json'), 'utf-8')).toBe(
      'not-json{\n'
    );
  });

  it('claims and removes a stale lock, leaving no reclaim leftovers', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;

    writeFileSync(lockPath, '1\n', 'utf-8');
    utimesSync(lockPath, new Date(0), new Date(0));
    expect(
      await removeStaleStateLock(lockPath, instantClock(() => 10_001).now)
    ).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(home)).toEqual([]);

    const planted = plantStaleTokenDir(lockPath);
    expect(
      await removeStaleStateLock(lockPath, instantClock(() => 10_001).now)
    ).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(planted.tokenPath)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(home).some(name => name.includes('.reclaim.'))).toBe(
      false
    );
    expect(readdirSync(home).some(name => name.includes('.release.'))).toBe(
      false
    );
  });

  it('restores a fresh lock that replaced a stale one before the claim', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;
    // Fresh FILE-shaped legacy lock; injected now() is in the past so the
    // live owner cannot be treated as stale.
    writeFileSync(lockPath, '{"token":"owner-b"}\n', 'utf-8');

    expect(
      await removeStaleStateLock(lockPath, instantClock(() => 0).now)
    ).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).isFile()).toBe(true);
    expect(readFileSync(lockPath, 'utf-8')).toContain('owner-b');

    rmSync(lockPath, { force: true });
    const live = plantLiveTokenDir(lockPath);
    expect(
      await removeStaleStateLock(lockPath, instantClock(() => 0).now)
    ).toBe(false);
    expect(statSync(lockPath).isDirectory()).toBe(true);
    expect(readdirSync(lockPath)).toEqual([live.tokenName]);
    expect(readFileSync(live.tokenPath, 'utf-8')).toContain(live.ownerId);
  });

  it('removes a stale orphaned lock older than the staleness window', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, '1\n', 'utf-8');
    // Fixture mtime at epoch; injected now() is past the 10s staleness window.
    utimesSync(lockPath, new Date(0), new Date(0));
    const result = await writeSenpiHookTrustEntry({
      ...baseOpts(home, makeHandler()),
      clock: instantClock(() => 10_001),
    });
    expect(result.id).toMatch(/^hk_/);
    expect(existsSync(lockPath)).toBe(false);
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T1 keeps fresh owner B canonical while displaced owner A releases', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;

    let finishA!: () => void;
    const holdA = new Promise<void>(resolve => {
      finishA = resolve;
    });
    let sawA!: () => void;
    const aEntered = new Promise<void>(resolve => {
      sawA = resolve;
    });
    let resumeARelease!: () => void;
    const releaseBarrier = new Promise<void>(resolve => {
      resumeARelease = resolve;
    });
    let sawARelease!: () => void;
    const aReleasePaused = new Promise<void>(resolve => {
      sawARelease = resolve;
    });
    let finishB!: () => void;
    const holdB = new Promise<void>(resolve => {
      finishB = resolve;
    });
    let sawB!: () => void;
    const bEntered = new Promise<void>(resolve => {
      sawB = resolve;
    });

    const ownerA = withStateLock(
      statePath,
      async () => {
        sawA();
        await holdA;
      },
      instantClock(),
      {
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          sawARelease();
          await releaseBarrier;
        },
      }
    );
    await aEntered;
    const ownerB = withStateLock(
      statePath,
      async () => {
        sawB();
        await holdB;
      },
      instantClock(() => Date.now() + 20_000)
    );
    await bEntered;
    const ownerBBeforeRelease = tokenDirectorySnapshot(lockPath);

    finishA();
    await aReleasePaused;
    const canonicalDuringRelease = existsSync(lockPath);
    const ownerDuringRelease = canonicalDuringRelease
      ? tokenDirectorySnapshot(lockPath)
      : null;

    resumeARelease();
    await ownerA;
    const ownerAfterARelease = existsSync(lockPath)
      ? tokenDirectorySnapshot(lockPath)
      : null;
    finishB();
    await ownerB;

    expect(
      canonicalDuringRelease,
      'canonical trust lock was vacated while fresh owner B was live'
    ).toBe(true);
    expect(
      ownerDuringRelease,
      'fresh owner B ownership vanished during displaced owner A release'
    ).toEqual(ownerBBeforeRelease);
    expect(
      ownerAfterARelease,
      'displaced owner A disturbed fresh owner B ownership'
    ).toEqual(ownerBBeforeRelease);
  });

  // RED (three-party schedule): fails until the token-lease protocol lands
  // (todos 4-6); flipped GREEN in todo 7.
  it('T2 rejects interloper C while displaced owner A release is in flight', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);

    let finishA!: () => void;
    const holdA = new Promise<void>(resolve => {
      finishA = resolve;
    });
    let sawA!: () => void;
    const aEntered = new Promise<void>(resolve => {
      sawA = resolve;
    });
    let resumeARelease!: () => void;
    const releaseBarrier = new Promise<void>(resolve => {
      resumeARelease = resolve;
    });
    let sawARelease!: () => void;
    const aReleasePaused = new Promise<void>(resolve => {
      sawARelease = resolve;
    });
    let finishB!: () => void;
    const holdB = new Promise<void>(resolve => {
      finishB = resolve;
    });
    let sawB!: () => void;
    const bEntered = new Promise<void>(resolve => {
      sawB = resolve;
    });

    const ownerA = withStateLock(
      statePath,
      async () => {
        sawA();
        await holdA;
      },
      instantClock(),
      {
        onAfterReleaseTokensUnlinkedBeforeRmdir: async () => {
          sawARelease();
          await releaseBarrier;
        },
      }
    );
    await aEntered;
    const ownerB = withStateLock(
      statePath,
      async () => {
        sawB();
        await holdB;
      },
      instantClock(() => Date.now() + 20_000)
    );
    await bEntered;

    finishA();
    await aReleasePaused;
    let interloperEntered = false;
    const interloperError = await withStateLock(
      statePath,
      () => {
        interloperEntered = true;
      },
      instantClock()
    ).then(
      () => null,
      (error: unknown) => error
    );

    resumeARelease();
    await ownerA;
    finishB();
    await ownerB;

    expect(
      interloperEntered,
      'interloper C entered through the canonical release vacancy'
    ).toBe(false);
    expect(interloperError).toBeInstanceOf(SenpiTrustLockError);
  });

  // Mechanism-specific old-protocol assertion reformed to the protocol-level
  // single-ownership invariant under the token-lease protocol: after the
  // expired legacy object is unlinked, a new acquirer is the legitimate sole
  // owner, and the resumed reclaimer must contend without disturbing it.
  it('T3 preserves interloper C ownership across stale owner A reclamation', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({ token: randomUUID() })}\n`);
    utimesSync(lockPath, new Date(0), new Date(0));

    let resumeReclaimer!: () => void;
    const reclaimBarrier = new Promise<void>(resolve => {
      resumeReclaimer = resolve;
    });
    let sawReclaimGap!: () => void;
    const reclaimerPaused = new Promise<void>(resolve => {
      sawReclaimGap = resolve;
    });
    let reclaimerEntered = false;
    const reclaimer = withStateLock(
      statePath,
      () => {
        reclaimerEntered = true;
      },
      instantClock(() => Date.now()),
      {
        onAfterExpiredTokensUnlinkedBeforeRmdir: async () => {
          sawReclaimGap();
          await reclaimBarrier;
        },
      }
    );
    await reclaimerPaused;
    expect(
      existsSync(lockPath),
      'legacy canonical path must be absent at the post-unlink barrier'
    ).toBe(false);

    let finishInterloper!: () => void;
    const holdInterloper = new Promise<void>(resolve => {
      finishInterloper = resolve;
    });
    let sawInterloper!: () => void;
    const interloperEntered = new Promise<void>(resolve => {
      sawInterloper = resolve;
    });
    const interloper = withStateLock(
      statePath,
      async () => {
        sawInterloper();
        await holdInterloper;
      },
      instantClock(() => Date.now())
    );
    await interloperEntered;
    const interloperOwnership = tokenDirectorySnapshot(lockPath);

    resumeReclaimer();
    const reclaimerError = await reclaimer.then(
      () => null,
      (error: unknown) => error
    );
    const ownershipAfterReclaimer = tokenDirectorySnapshot(lockPath);

    finishInterloper();
    await interloper;

    expect(reclaimerEntered, 'reclaimer entered alongside interloper C').toBe(
      false
    );
    expect(reclaimerError).toBeInstanceOf(SenpiTrustLockError);
    expect(
      ownershipAfterReclaimer,
      'resumed reclaimer disturbed interloper C ownership data'
    ).toEqual(interloperOwnership);
    expect(Object.keys(ownershipAfterReclaimer)).toHaveLength(1);
    expect(existsSync(lockPath), 'interloper release left lock residue').toBe(
      false
    );
  });
});

describe('senpi trust writer - fail-closed on malformed state', () => {
  it.each([
    ['invalid JSON', '{not-json!!'],
    ['wrong version', JSON.stringify({ version: 2, hooks: {} })],
    ['non-object hooks', JSON.stringify({ version: 1, hooks: [] })],
    [
      'entry failing validation',
      JSON.stringify({
        version: 1,
        hooks: { hk_bad_0_0: { enabled: 'yes', scope: 'bogus' } },
      }),
    ],
  ])(
    '%s aborts with typed error and zero mutation',
    async (_label, content) => {
      const home = tempDir();
      mkdirSync(home, { recursive: true });
      const statePath = globalStatePath(home);
      writeFileSync(statePath, content, 'utf-8');
      const before = snapshot(statePath);

      await expect(
        writeSenpiHookTrustEntry(baseOpts(home, makeHandler()))
      ).rejects.toMatchObject({ name: 'SenpiTrustStateMalformedError' });

      expect(snapshot(statePath)).toEqual(before);
      expect(statSync(statePath).ino).toBe(before.ino);
      // No temp or lock residue.
      expect(readdirSync(home).sort()).toEqual([SENPI_HOOKS_STATE_FILENAME]);
    }
  );

  it('exposes SenpiTrustStateMalformedError as instanceof-checkable class', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    writeFileSync(globalStatePath(home), '][', 'utf-8');
    const error = await writeSenpiHookTrustEntry(
      baseOpts(home, makeHandler())
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SenpiTrustStateMalformedError);
  });
});

describe('senpi trust writer - consent gate', () => {
  it('consent:false rejects with typed error and zero filesystem effect', async () => {
    // home points at a path that does NOT exist yet; a compliant rejection
    // must not even create the agent-home directory.
    const home = join(tempDir(), 'agent-home');
    const raw = {
      ...baseOpts(home, makeHandler()),
    } as unknown as Record<string, unknown>;
    raw['consent'] = false;
    const opts = raw as unknown as WriteSenpiHookTrustEntryOptions;

    await expect(writeSenpiHookTrustEntry(opts)).rejects.toThrow(
      SenpiTrustConsentError
    );
    // Zero effect: not even the agent-home directory was created.
    expect(existsSync(home)).toBe(false);
  });

  it('missing reason rejects with typed error and leaves existing state untouched', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const statePath = globalStatePath(home);
    writeFileSync(statePath, '{\n  "version": 1,\n  "hooks": {}\n}', 'utf-8');
    const before = snapshot(statePath);
    const opts = {
      ...baseOpts(home, makeHandler()),
      reason: '',
    };

    await expect(writeSenpiHookTrustEntry(opts)).rejects.toThrow(
      SenpiTrustConsentError
    );
    expect(snapshot(statePath)).toEqual(before);
    expect(readdirSync(home).sort()).toEqual([SENPI_HOOKS_STATE_FILENAME]);
  });

  it('whitespace-only reason rejects; absent reason property rejects', async () => {
    const home = join(tempDir(), 'agent-home');
    const whitespace = { ...baseOpts(home, makeHandler()), reason: '   ' };
    await expect(writeSenpiHookTrustEntry(whitespace)).rejects.toThrow(
      SenpiTrustConsentError
    );

    const absent = baseOpts(home, makeHandler()) as unknown as Record<
      string,
      unknown
    >;
    delete absent['reason'];
    await expect(
      writeSenpiHookTrustEntry(
        absent as unknown as WriteSenpiHookTrustEntryOptions
      )
    ).rejects.toThrow(SenpiTrustConsentError);
    expect(existsSync(home)).toBe(false);
  });
});

describe('senpi trust writer - round-trip with readers', () => {
  it('grant then isSenpiCommandHookTrusted true (global scope, 0600)', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const handler = makeHandler();
    await writeSenpiHookTrustEntry(baseOpts(home, handler));

    const statePath = globalStatePath(home);
    const st = statSync(statePath);
    expect(st.mode & 0o777).toBe(0o600);

    const result = readSenpiHookTrustState(statePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(
      isSenpiCommandHookTrusted(handler, result.state, {
        platform: FIXED_PLATFORM,
      })
    ).toBe(true);
  });

  it('project scope writes <cwd>/.senpi/hooks-state.json and reads back trusted', async () => {
    const project = tempDir();
    mkdirSync(project, { recursive: true });
    const handler = makeHandler();
    const opts: WriteSenpiHookTrustEntryOptions = {
      ...baseOpts(join(project, 'agent-home-unused'), handler),
      scope: 'project',
      cwd: project,
    };
    await writeSenpiHookTrustEntry(opts);

    const statePath = join(
      project,
      SENPI_PROJECT_CONFIG_DIR,
      SENPI_HOOKS_STATE_FILENAME
    );
    expect(existsSync(statePath)).toBe(true);
    const result = readSenpiHookTrustState(statePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(
      isSenpiCommandHookTrusted(handler, result.state, {
        platform: FIXED_PLATFORM,
      })
    ).toBe(true);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it('records grantReason and hash parity fields on the written entry', async () => {
    const home = tempDir();
    mkdirSync(home, { recursive: true });
    const handler = makeHandler();
    const result = await writeSenpiHookTrustEntry(baseOpts(home, handler));
    expect(result.entry.grantReason).toBe(
      'explicit user approval via desktop observer setup'
    );
    expect(result.entry.enabled).toBe(true);
    expect(result.entry.trustedHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.entry.commandPreview).toBe(handler.config.command);
    expect(typeof result.entry.updatedAt).toBe('string');
    expect(isNaN(Date.parse(result.entry.updatedAt))).toBe(false);
  });
});
