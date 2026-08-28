import {
  mkdir,
  lstat,
  readdir,
  readFile,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  LeaseLockBusyError,
  withLeaseLock,
  type ExpiredLeaseToken,
  type Lease,
  type LegacyLeaseTokenData,
} from './lease-lock.js';

/** Lock directories older than this age are treated as abandoned. */
export const DEFAULT_STALE_MARKER_LOCK_MS = 30_000;

const VERSION2_TOKEN_NAME_PATTERN =
  /^owner\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * Identity captured for stale-lock reclamation hooks.
 *
 * `nonce` is taken from a legacy `owner.json` `{ nonce }` token when present.
 * Version-2 tokens use `owner.<ownerId>.<leaseId>` and report `nonce: null`.
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
  /** Test-schedule hooks for interleaving tests; they observe lock protocol points only. */
  readonly onAfterReleaseTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
  readonly onAfterExpiredTokensClassified?: () => void | Promise<void>;
  readonly onAfterExpiredTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
  readonly onAfterCanonicalMkdirBeforeToken?: () => void | Promise<void>;
  /**
   * Test-only hook fired from `canReclaimExpiredToken` after the first identity
   * capture and stale-age check, before the re-stat / nonce re-read that gates
   * whether the captured token is treated as reclaimable.
   *
   * @internal
   */
  readonly onBeforeStaleUnlink?: (
    captured: MarkerLockIdentity
  ) => void | Promise<void>;
  /**
   * Test-only hook fired after identity and stale-age re-verification,
   * immediately before the core unlinks expired tokens / rmdirs (claim).
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
 * Creates `<markerPath>.lock` via the shared token-lease core (`mkdir` /
 * `O_EXCL` semantics, mode `0o700`). New holders publish a version-2 token
 * named `owner.<ownerId>.<leaseId>` (the core default). The previous
 * `owner.json` `{ nonce }` naming is legacy only: the core still captures
 * that shape when the token is mtime-stale. The canonical lock path is never
 * renamed; release unlinks this holder's tokens and `rmdir`s.
 *
 * A competing lock whose age exceeds `staleLockMs` (default
 * {@link DEFAULT_STALE_MARKER_LOCK_MS}) is reclaimed by the core. Fresh
 * contention throws using `lockedLabel`.
 *
 * @param markerPath - Marker file path whose sibling `.lock` directory is held.
 * @param action - Critical section run while the lock is held. Zero-arg
 *   callbacks stay source-compatible; `action` may also receive the `Lease`.
 * @param options - Adapter lock label and optional stale age.
 * @returns The value returned by `action`.
 * @throws {Error} When a fresh competing lock is present (`lockedLabel`
 *   message) or lock creation fails.
 * @throws {LeaseLockLostError} When `action` calls `renew` or `assertHeld`
 *   after the lease is no longer held.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 */
export async function withMarkerLock<T>(
  markerPath: string,
  action: (lease: Lease) => T | Promise<T>,
  options: WithMarkerLockOptions
): Promise<T> {
  const lockPath = `${markerPath}.lock`;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_MARKER_LOCK_MS;
  const lockedMessage = `${options.lockedLabel} is locked: '${markerPath}'`;

  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  await alignStaleDirectoryTokenMtimes(lockPath, staleLockMs);

  let claimIdentity: MarkerLockIdentity | undefined;
  try {
    return await withLeaseLock(lockPath, action, {
      staleMs: staleLockMs,
      ...(options.onAfterCanonicalMkdirBeforeToken === undefined
        ? {}
        : {
            onAfterCanonicalMkdirBeforeToken:
              options.onAfterCanonicalMkdirBeforeToken,
          }),
      ...(options.onAfterExpiredTokensUnlinkedBeforeRmdir === undefined
        ? {}
        : {
            onAfterExpiredTokensUnlinkedBeforeRmdir:
              options.onAfterExpiredTokensUnlinkedBeforeRmdir,
          }),
      ...(options.onAfterReleaseTokensUnlinkedBeforeRmdir === undefined
        ? {}
        : {
            onAfterReleaseTokensUnlinkedBeforeRmdir:
              options.onAfterReleaseTokensUnlinkedBeforeRmdir,
          }),
      onAfterExpiredTokensClassified: async () => {
        if (claimIdentity !== undefined) {
          await options.onBeforeStaleClaim?.(claimIdentity);
        }
        await options.onAfterExpiredTokensClassified?.();
      },
      canReclaimExpiredToken: async captured => {
        const first = await identityFromExpired(lockPath, captured);
        await options.onBeforeStaleUnlink?.(first);
        let second: MarkerLockIdentity;
        try {
          second = await captureMarkerLockIdentity(lockPath);
        } catch {
          return false;
        }
        if (!identitiesMatch(first, second)) return false;
        if (Date.now() - second.mtimeMs <= staleLockMs) return false;
        claimIdentity = second;
        return true;
      },
    });
  } catch (error: unknown) {
    if (error instanceof LeaseLockBusyError) {
      throw new Error(lockedMessage);
    }
    throw error;
  }
}

/**
 * Previous marker locks used directory mtime as the staleness clock. Tests
 * (and the three-party schedules) still age the lock directory with `utimes`.
 * The core expires tokens by file mtime, so a stale directory's capturable
 * tokens are aligned to the directory clock before acquire. Malformed
 * `owner.json` is dropped only when the directory is already stale, matching
 * the previous "unreadable owner.json is a legacy occupant" rule that the
 * core's fail-closed parser would otherwise refuse.
 */
async function alignStaleDirectoryTokenMtimes(
  lockPath: string,
  staleLockMs: number
): Promise<void> {
  let dirStats: { readonly isDirectory: boolean; readonly mtimeMs: number };
  try {
    const stats = await lstat(lockPath);
    dirStats = { isDirectory: stats.isDirectory(), mtimeMs: stats.mtimeMs };
  } catch {
    return;
  }
  if (!dirStats.isDirectory) return;
  if (Date.now() - dirStats.mtimeMs <= staleLockMs) return;

  let names: readonly string[];
  try {
    names = await readdir(lockPath);
  } catch {
    return;
  }
  const past = new Date(dirStats.mtimeMs);
  for (const name of names) {
    const tokenPath = join(lockPath, name);
    if (name === 'owner.json') {
      await prepareLegacyOwnerJson(lockPath, tokenPath, past);
      continue;
    }
    if (!VERSION2_TOKEN_NAME_PATTERN.test(name)) continue;
    try {
      await utimes(tokenPath, past, past);
    } catch {
      // no-excuse-ok: catch — token vanished or is not utimes-able mid-race
    }
  }
}

async function prepareLegacyOwnerJson(
  lockPath: string,
  tokenPath: string,
  past: Date
): Promise<void> {
  try {
    const raw = await readFile(tokenPath, 'utf8');
    if (isCapturableLegacyDocument(parseJson(raw))) {
      await utimes(tokenPath, past, past);
      return;
    }
  } catch {
    // no-excuse-ok: catch — unreadable or non-JSON owner.json is legacy debris
  }
  try {
    await unlink(tokenPath);
    // Unlink refreshes the directory clock; restore the stale mtime so the
    // core's empty-dir reclaim still sees an abandoned lock.
    await utimes(lockPath, past, past);
  } catch {
    // no-excuse-ok: catch — already gone, or unlink raced with another reclaimer
  }
}

async function identityFromExpired(
  lockPath: string,
  captured: ExpiredLeaseToken
): Promise<MarkerLockIdentity> {
  const stats = await lstat(lockPath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    nonce: nonceFromToken(captured.token),
    mtimeMs: stats.mtimeMs,
  };
}

async function captureMarkerLockIdentity(
  lockPath: string
): Promise<MarkerLockIdentity> {
  const stats = await lstat(lockPath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    nonce: await readLegacyNonce(lockPath),
    mtimeMs: stats.mtimeMs,
  };
}

async function readLegacyNonce(lockPath: string): Promise<string | null> {
  try {
    const parsed = parseJson(
      await readFile(join(lockPath, 'owner.json'), 'utf8')
    );
    return isCapturableLegacyDocument(parsed) ? parsed.nonce : null;
  } catch {
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

function nonceFromToken(token: ExpiredLeaseToken['token']): string | null {
  return 'nonce' in token && typeof token.nonce === 'string'
    ? token.nonce
    : null;
}

function isCapturableLegacyDocument(
  value: unknown
): value is Extract<LegacyLeaseTokenData, { readonly nonce: string }> {
  if (typeof value !== 'object' || value === null) return false;
  const nonce = (value as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce.length > 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
