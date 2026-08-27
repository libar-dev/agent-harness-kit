import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { hasErrorCode } from './marker-store.js';

/** Lock directories older than this age are treated as abandoned. */
export const DEFAULT_STALE_MARKER_LOCK_MS = 30_000;

/**
 * Options for {@link withMarkerLock}.
 *
 * `lockedLabel` is interpolated as `<label> is locked: '<markerPath>'`.
 */
export type WithMarkerLockOptions = {
  readonly lockedLabel: string;
  readonly staleLockMs?: number;
};

/**
 * Hold an exclusive directory lock around a marker write.
 *
 * Creates `<markerPath>.lock` with `mkdir`/`O_EXCL` semantics (`mode 0o700`).
 * A lock whose mtime is older than `staleLockMs` (default
 * {@link DEFAULT_STALE_MARKER_LOCK_MS}) is removed once and retried. Fresh
 * contention throws using `lockedLabel`.
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
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!(await removeStaleMarkerLock(lockPath, staleLockMs))) {
      throw new Error(lockedMessage);
    }
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (retryError: unknown) {
      if (hasErrorCode(retryError, 'EEXIST')) {
        throw new Error(lockedMessage);
      }
      throw retryError;
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleMarkerLock(
  lockPath: string,
  staleLockMs: number
): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= staleLockMs) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    // no-excuse-ok: catch — missing lock mid-race is treated as not stale-removable
    return false;
  }
}
