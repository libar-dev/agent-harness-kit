import { mkdir, lstat, readFile } from 'node:fs/promises';
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
