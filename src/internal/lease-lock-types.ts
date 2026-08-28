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

export type SyncLease = Lease;

export class LeaseLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`Lease lock is busy: '${lockPath}'`);
    this.name = 'LeaseLockBusyError';
  }
}

export class LeaseLockLostError extends Error {
  constructor(lockPath: string) {
    super(`Lease lock is no longer held: '${lockPath}'`);
    this.name = 'LeaseLockLostError';
  }
}
