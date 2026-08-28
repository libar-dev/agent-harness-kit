import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hasErrorCode } from './marker-store.js';

/** Lock directories older than this age are treated as abandoned. */
export const DEFAULT_STALE_MARKER_LOCK_MS = 30_000;

const MARKER_LOCK_OWNER_FILENAME = 'owner.json';

/**
 * Identity captured for stale-lock reclamation.
 *
 * `nonce` is null for legacy lock dirs that predate `owner.json`.
 */
export type MarkerLockIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly nonce: string | null;
  readonly mtimeMs: number;
};

/**
 * Options for {@link withMarkerLock}.
 *
 * `lockedLabel` is interpolated as `<label> is locked: '<markerPath>'`.
 */
export type WithMarkerLockOptions = {
  readonly lockedLabel: string;
  readonly staleLockMs?: number;
  /**
   * Test-only hook fired after the first identity capture and stale-age check,
   * before the re-stat / nonce re-read that gates unlink.
   *
   * @internal
   */
  readonly onBeforeStaleUnlink?: (
    captured: MarkerLockIdentity
  ) => void | Promise<void>;
  /**
   * Test-only hook fired after identity and stale-age re-verification,
   * immediately before attempting to claim the stale lock.
   *
   * @internal
   */
  readonly onBeforeStaleClaim?: (
    captured: MarkerLockIdentity
  ) => void | Promise<void>;
};

/**
 * Hold an exclusive directory lock around a marker write.
 *
 * Creates `<markerPath>.lock` with `mkdir`/`O_EXCL` semantics (`mode 0o700`)
 * and writes `owner.json` `{ nonce }` into the new lock dir. A lock whose
 * mtime is older than `staleLockMs` (default
 * {@link DEFAULT_STALE_MARKER_LOCK_MS}) is atomically replaced, but only when
 * an atomic rename claim and post-rename re-verification still match the
 * captured `{dev, ino}` and nonce (legacy locks with no `owner.json` compare
 * nonce as null). Fresh contention or an identity mismatch throws using
 * `lockedLabel`.
 *
 * @param markerPath - Marker file path whose sibling `.lock` directory is held.
 * @param action - Critical section run while the lock is held.
 * @param options - Adapter lock label and optional stale age.
 * @returns The value returned by `action`.
 * @throws When a fresh competing lock is present or lock creation fails.
 */
export async function withMarkerLock<T>(
  markerPath: string,
  action: () => Promise<T>,
  options: WithMarkerLockOptions
): Promise<T> {
  const lockPath = `${markerPath}.lock`;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_MARKER_LOCK_MS;
  const lockedMessage = `${options.lockedLabel} is locked: '${markerPath}'`;

  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  try {
    await createExclusiveLockDir(lockPath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (
      !(await replaceStaleMarkerLock(
        lockPath,
        staleLockMs,
        options.onBeforeStaleUnlink,
        options.onBeforeStaleClaim
      ))
    ) {
      throw new Error(lockedMessage);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function createExclusiveLockDir(lockPath: string): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 });
  await initializeOwnedLockDir(lockPath);
}

async function initializeOwnedLockDir(lockPath: string): Promise<void> {
  try {
    await writeFile(
      join(lockPath, MARKER_LOCK_OWNER_FILENAME),
      JSON.stringify({ nonce: randomUUID() }),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error: unknown) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function captureLockIdentity(
  lockPath: string
): Promise<MarkerLockIdentity> {
  const stats = await stat(lockPath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    nonce: await readLockNonce(lockPath),
    mtimeMs: stats.mtimeMs,
  };
}

async function readLockNonce(lockPath: string): Promise<string | null> {
  try {
    const raw = await readFile(
      join(lockPath, MARKER_LOCK_OWNER_FILENAME),
      'utf8'
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const nonce = (parsed as { nonce?: unknown }).nonce;
    return typeof nonce === 'string' && nonce.length > 0 ? nonce : null;
  } catch {
    // no-excuse-ok: catch — missing or unreadable owner.json is a legacy lock
    return null;
  }
}

function identitiesMatch(
  first: MarkerLockIdentity,
  second: MarkerLockIdentity
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.nonce === second.nonce
  );
}

async function replaceStaleMarkerLock(
  lockPath: string,
  staleLockMs: number,
  onBeforeStaleUnlink?: (captured: MarkerLockIdentity) => void | Promise<void>,
  onBeforeStaleClaim?: (captured: MarkerLockIdentity) => void | Promise<void>
): Promise<boolean> {
  let first: MarkerLockIdentity;
  try {
    first = await captureLockIdentity(lockPath);
  } catch {
    // no-excuse-ok: catch — missing lock mid-race is treated as not stale-removable
    return false;
  }
  if (Date.now() - first.mtimeMs <= staleLockMs) {
    return false;
  }
  if (onBeforeStaleUnlink) {
    await onBeforeStaleUnlink(first);
  }
  let second: MarkerLockIdentity;
  try {
    second = await captureLockIdentity(lockPath);
  } catch {
    // no-excuse-ok: catch — lock vanished between capture and re-stat
    return false;
  }
  if (!identitiesMatch(first, second)) {
    return false;
  }
  if (Date.now() - second.mtimeMs <= staleLockMs) {
    return false;
  }
  if (onBeforeStaleClaim) {
    await onBeforeStaleClaim(second);
  }
  const claimedPath = `${lockPath}.reclaim.${randomUUID()}`;
  try {
    await rename(lockPath, claimedPath);
  } catch {
    // no-excuse-ok: catch — another reclaimer won the atomic rename
    return false;
  }

  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    // no-excuse-ok: catch — fail closed if a creator occupied the rename gap
    return false;
  }

  let claimed: MarkerLockIdentity;
  try {
    claimed = await captureLockIdentity(claimedPath);
  } catch {
    // no-excuse-ok: catch — preserve the guard when the claim is unverifiable
    return false;
  }
  if (
    !identitiesMatch(first, claimed) ||
    Date.now() - claimed.mtimeMs <= staleLockMs
  ) {
    try {
      // Replacing our empty guard restores a recreated live lock atomically.
      await rename(claimedPath, lockPath);
    } catch {
      // no-excuse-ok: catch — preserve both paths rather than delete unknown state
    }
    return false;
  }

  await rm(claimedPath, { recursive: true, force: true });
  await initializeOwnedLockDir(lockPath);
  return true;
}
