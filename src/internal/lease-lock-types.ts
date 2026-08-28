import type { z } from 'zod';

export interface LeaseTokenData {
  readonly version: 2;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly pid: number;
}

export interface LeaseTokenContext {
  readonly ownerId: string;
  readonly leaseId: string;
  readonly pid: number;
  readonly now: number;
}

export interface LeaseLockHooks {
  readonly onAfterCanonicalMkdirBeforeToken?: () => void | Promise<void>;
  readonly onAfterExpiredTokensClassified?: () => void | Promise<void>;
  readonly onAfterExpiredTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
  readonly onAfterReleaseTokensUnlinkedBeforeRmdir?: () => void | Promise<void>;
}

export type LegacyLeaseTokenData =
  | { readonly nonce: string }
  | {
      readonly token: string;
      readonly pid: number;
      readonly createdAt: number;
    };

export interface ExpiredLeaseToken {
  readonly path: string;
  readonly mtimeMs: number;
  readonly token: LeaseTokenData | LegacyLeaseTokenData;
}

export interface LeaseLockOptions extends LeaseLockHooks {
  readonly staleMs: number;
  readonly now?: () => number;
  readonly ownerId?: string;
  readonly pid?: number;
  readonly tokenFields?: (
    context: LeaseTokenContext
  ) => Readonly<Record<string, unknown>>;
  readonly tokenSchema?: z.ZodType<LeaseTokenData>;
  /** Adapter policy that may keep an age-expired token live. */
  readonly canReclaimExpiredToken?: (
    captured: ExpiredLeaseToken
  ) => boolean | Promise<boolean>;
}

/**
 * Handle for one owner on a canonical lock directory.
 *
 * `renew` publishes the successor token before unlinking this owner's
 * previous token. `release` unlinks this owner's created tokens and
 * non-recursively `rmdir`s. The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock directory this handle occupies.
 * @param ownerId - Owner UUID written into token names and bodies.
 * @param leaseId - Current lease UUID; changes on a successful `renew`.
 * @param tokenPath - Current token file path.
 * @param createdTokenPaths - Every token pathname this handle created.
 * @returns The handle object; `renew`, `assertHeld`, and `release` return `Promise<void>`.
 * @throws {LeaseLockLostError} From `renew` or `assertHeld` when the
 *   lease is no longer held.
 */
export interface Lease {
  readonly lockPath: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly tokenPath: string;
  /** Every token pathname created by this handle, including retired tokens. */
  readonly createdTokenPaths: readonly string[];
  renew(): Promise<void>;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Alias of {@link Lease}. Produced by the sync-filesystem acquire path.
 * Handle methods stay async because schedule hooks may be async.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @returns The same shape as {@link Lease}.
 */
export type SyncLease = Lease;

/**
 * Thrown when acquire cannot take the canonical lock directory because a
 * live occupant remains, or the directory identity changed mid-claim.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock path included in the message.
 */
export class LeaseLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`Lease lock is busy: '${lockPath}'`);
    this.name = 'LeaseLockBusyError';
  }
}

/**
 * Thrown by `Lease.renew` or `Lease.assertHeld` when this handle no
 * longer holds a live token.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock path included in the message.
 */
export class LeaseLockLostError extends Error {
  constructor(lockPath: string) {
    super(`Lease lock is no longer held: '${lockPath}'`);
    this.name = 'LeaseLockLostError';
  }
}
