import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import {
  LeaseLockBusyError,
  LeaseLockLostError,
  type ExpiredLeaseToken,
  type Lease,
  type LeaseLockHooks,
  type LeaseLockOptions,
  type LeaseTokenContext,
  type LeaseTokenData,
  type LegacyLeaseTokenData,
  type SyncLease,
} from './lease-lock-types.js';

export type {
  ExpiredLeaseToken,
  Lease,
  LeaseLockHooks,
  LeaseLockOptions,
  LeaseTokenContext,
  LeaseTokenData,
  LegacyLeaseTokenData,
  SyncLease,
};
export { LeaseLockBusyError, LeaseLockLostError };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_NAME_PATTERN =
  /^owner\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export const leaseTokenSchema = z
  .object({
    version: z.literal(2),
    ownerId: z.string().regex(UUID_PATTERN),
    leaseId: z.string().regex(UUID_PATTERN),
    pid: z.number().int().positive(),
  })
  .strict();

const legacyTokenSchema = z.union([
  z.object({ nonce: z.string().min(1) }).strict(),
  z
    .object({
      token: z.string().min(1),
      pid: z.number().int().positive(),
      createdAt: z.number(),
    })
    .strict(),
]);

type Entry = { readonly name: string; readonly isFile: boolean };
type Stats = {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
};

interface FileOps {
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<readonly Entry[]>;
  readAndStat(
    path: string
  ): Promise<{ readonly raw: string; readonly stats: Stats }>;
  writeToken(path: string, contents: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

const asyncOps: FileOps = {
  mkdir: async path => mkdir(path, { mode: 0o700 }),
  stat: async path => toStats(await stat(path)),
  lstat: async path => toStats(await lstat(path)),
  readdir: async path =>
    (await readdir(path, { withFileTypes: true })).map(entry => ({
      name: entry.name,
      isFile: entry.isFile(),
    })),
  readAndStat: async path => {
    const handle = await open(path, 'r');
    try {
      const stats = toStats(await handle.stat());
      const raw = await handle.readFile('utf8');
      return { raw, stats };
    } finally {
      await handle.close();
    }
  },
  writeToken: async (path, contents) => {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      return toStats(await handle.stat());
    } catch (error: unknown) {
      await handle.close();
      await unlink(path).catch(unlinkError => {
        if (!hasCode(unlinkError, 'ENOENT')) throw unlinkError;
      });
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
  unlink,
  rmdir,
};

const syncOps: FileOps = {
  mkdir: path => resolved(() => mkdirSync(path, { mode: 0o700 })),
  stat: path => resolved(() => toStats(statSync(path))),
  lstat: path => resolved(() => toStats(lstatSync(path))),
  readdir: path =>
    resolved(() =>
      readdirSync(path, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        isFile: entry.isFile(),
      }))
    ),
  readAndStat: path =>
    resolved(() => {
      const fd = openSync(path, 'r');
      try {
        const stats = toStats(fstatSync(fd));
        const raw = readFileSync(fd, 'utf8');
        return { raw, stats };
      } finally {
        closeSync(fd);
      }
    }),
  writeToken: (path, contents) =>
    resolved(() => {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, contents, 'utf8');
        fsyncSync(fd);
        return toStats(fstatSync(fd));
      } catch (error: unknown) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch (unlinkError: unknown) {
          if (!hasCode(unlinkError, 'ENOENT')) throw unlinkError;
        }
        throw error;
      } finally {
        try {
          closeSync(fd);
        } catch (error: unknown) {
          if (!hasCode(error, 'EBADF')) throw error;
        }
      }
    }),
  unlink: path => resolved(() => unlinkSync(path)),
  rmdir: path => resolved(() => rmdirSync(path)),
};

/**
 * Acquire an exclusive token lease on `lockPath` using async filesystem calls.
 *
 * Creates the canonical lock directory if absent, then publishes an
 * `owner.<ownerId>.<leaseId>` token. On `EEXIST`, entries are classified
 * and only captured mtime-expired tokens are unlinked before a
 * non-recursive `rmdir`. Expiry is `now - token.mtimeMs > staleMs`.
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock directory path.
 * @param options - Stale age, clock, owner identity, token schema, and
 *   optional reclaim / schedule hooks.
 * @returns A {@link Lease} whose `release` unlinks this owner's tokens
 *   and `rmdir`s when the directory is empty.
 * @throws {RangeError} When `options.staleMs` is not a non-negative finite number.
 * @throws {LeaseLockBusyError} When a live occupant remains after reclaim
 *   attempts, or the directory identity changes before the token is bound.
 * @throws {Error} When the published token path is not a regular file.
 */
export function acquireLeaseLock(
  lockPath: string,
  options: LeaseLockOptions
): Promise<Lease> {
  return acquire(lockPath, options, asyncOps);
}

/**
 * Acquire an exclusive token lease on `lockPath` using synchronous
 * filesystem calls. Schedule hooks may still be async, so the function
 * returns a Promise.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock directory path.
 * @param options - Stale age, clock, owner identity, token schema, and
 *   optional reclaim / schedule hooks.
 * @returns A {@link SyncLease} (same shape as {@link Lease}).
 * @throws {RangeError} When `options.staleMs` is not a non-negative finite number.
 * @throws {LeaseLockBusyError} When a live occupant remains after reclaim
 *   attempts, or the directory identity changes before the token is bound.
 * @throws {Error} When the published token path is not a regular file.
 */
export function acquireLeaseLockSync(
  lockPath: string,
  options: LeaseLockOptions
): Promise<SyncLease> {
  return acquire(lockPath, options, syncOps);
}

/**
 * Acquire a lease, run `action`, and release in `finally`.
 *
 * Call `lease.renew()` or `lease.assertHeld()` at commit points; there is
 * no heartbeat. The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock directory path.
 * @param action - Critical section. Receives the {@link Lease}.
 * @param options - Stale age, clock, owner identity, token schema, and
 *   optional reclaim / schedule hooks.
 * @returns The value returned by `action`.
 * @throws {RangeError} When `options.staleMs` is not a non-negative finite number.
 * @throws {LeaseLockBusyError} When a live occupant remains after reclaim
 *   attempts, or the directory identity changes before the token is bound.
 * @throws {LeaseLockLostError} When `action` calls `renew` or `assertHeld`
 *   after the lease is released or the token is no longer held.
 * @throws {Error} When the published token path is not a regular file.
 */
export async function withLeaseLock<T>(
  lockPath: string,
  action: (lease: Lease) => T | Promise<T>,
  options: LeaseLockOptions
): Promise<T> {
  const lease = await acquireLeaseLock(lockPath, options);
  try {
    return await action(lease);
  } finally {
    await lease.release();
  }
}

/**
 * Same as {@link withLeaseLock}, using {@link acquireLeaseLockSync}.
 *
 * The canonical lock directory is never renamed or recursively removed; live tokens are never unlinked by another owner.
 *
 * @param lockPath - Canonical lock directory path.
 * @param action - Critical section. Receives the {@link SyncLease}.
 * @param options - Stale age, clock, owner identity, token schema, and
 *   optional reclaim / schedule hooks.
 * @returns The value returned by `action`.
 * @throws {RangeError} When `options.staleMs` is not a non-negative finite number.
 * @throws {LeaseLockBusyError} When a live occupant remains after reclaim
 *   attempts, or the directory identity changes before the token is bound.
 * @throws {LeaseLockLostError} When `action` calls `renew` or `assertHeld`
 *   after the lease is released or the token is no longer held.
 * @throws {Error} When the published token path is not a regular file.
 */
export async function withLeaseLockSync<T>(
  lockPath: string,
  action: (lease: SyncLease) => T | Promise<T>,
  options: LeaseLockOptions
): Promise<T> {
  const lease = await acquireLeaseLockSync(lockPath, options);
  try {
    return await action(lease);
  } finally {
    await lease.release();
  }
}

async function acquire(
  lockPath: string,
  options: LeaseLockOptions,
  ops: FileOps
): Promise<Lease> {
  validateOptions(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let directory: Stats;
    try {
      await ops.mkdir(lockPath);
      directory = await ops.stat(lockPath);
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (await reclaim(lockPath, options, ops)) continue;
      throw new LeaseLockBusyError(lockPath);
    }

    try {
      await options.onAfterCanonicalMkdirBeforeToken?.();
      return await createLease(lockPath, directory, options, ops);
    } catch (error: unknown) {
      if (!(error instanceof LeaseLockBusyError)) {
        await removeEmptyOwnedDirectory(lockPath, directory, ops);
      }
      throw error;
    }
  }
  throw new LeaseLockBusyError(lockPath);
}

async function createLease(
  lockPath: string,
  directory: Stats,
  options: LeaseLockOptions,
  ops: FileOps
): Promise<Lease> {
  const ownerId = options.ownerId ?? randomUUID();
  const created = new Set<string>();
  let leaseId = randomUUID();
  let tokenPath = tokenName(lockPath, ownerId, leaseId);
  try {
    await publishToken(tokenPath, ownerId, leaseId, options, ops);
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) throw new LeaseLockBusyError(lockPath);
    throw error;
  }
  created.add(tokenPath);

  if (
    !(await ownsPublishedDirectory(
      lockPath,
      directory,
      created,
      tokenPath,
      ops
    ))
  ) {
    await discardPublishedToken(tokenPath, ops);
    throw new LeaseLockBusyError(lockPath);
  }

  let released = false;
  const handle: Lease = {
    lockPath,
    ownerId,
    get leaseId() {
      return leaseId;
    },
    get tokenPath() {
      return tokenPath;
    },
    get createdTokenPaths() {
      return [...created];
    },
    async renew() {
      if (
        released ||
        !(await tokenIsHeld(
          lockPath,
          directory,
          tokenPath,
          ownerId,
          leaseId,
          options,
          ops
        ))
      ) {
        throw new LeaseLockLostError(lockPath);
      }
      const previousPath = tokenPath;
      const nextLeaseId = randomUUID();
      const nextPath = tokenName(lockPath, ownerId, nextLeaseId);
      await publishToken(nextPath, ownerId, nextLeaseId, options, ops);
      created.add(nextPath);
      if (
        !(await ownsPublishedDirectory(
          lockPath,
          directory,
          created,
          nextPath,
          ops
        ))
      ) {
        await discardPublishedToken(nextPath, ops);
        throw new LeaseLockLostError(lockPath);
      }
      leaseId = nextLeaseId;
      tokenPath = nextPath;
      await unlinkIfPresent(previousPath, ops);
    },
    async assertHeld() {
      if (
        released ||
        !(await tokenIsHeld(
          lockPath,
          directory,
          tokenPath,
          ownerId,
          leaseId,
          options,
          ops
        ))
      ) {
        throw new LeaseLockLostError(lockPath);
      }
    },
    async release() {
      if (released) return;
      released = true;
      let firstError: unknown;
      for (const path of created) {
        try {
          await unlinkIfPresent(path, ops);
        } catch (error: unknown) {
          firstError ??= error;
        }
      }
      await options.onAfterReleaseTokensUnlinkedBeforeRmdir?.();
      try {
        await safeRmdir(lockPath, ops);
      } catch (error: unknown) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    },
  };
  return handle;
}

async function publishToken(
  path: string,
  ownerId: string,
  leaseId: string,
  options: LeaseLockOptions,
  ops: FileOps
): Promise<void> {
  const now = (options.now ?? Date.now)();
  const pid = options.pid ?? process.pid;
  const candidate: unknown = {
    version: 2,
    ownerId,
    leaseId,
    pid,
    ...options.tokenFields?.({ ownerId, leaseId, pid, now }),
  };
  const parsed = tokenSchema(options).parse(candidate);
  const stats = await ops.writeToken(path, JSON.stringify(parsed));
  if (!stats.isFile)
    throw new Error(`Lease token is not a regular file: '${path}'`);
}

async function reclaim(
  lockPath: string,
  options: LeaseLockOptions,
  ops: FileOps
): Promise<boolean> {
  let initial: Stats;
  try {
    initial = await ops.lstat(lockPath);
  } catch (error: unknown) {
    return hasCode(error, 'ENOENT');
  }
  const now = (options.now ?? Date.now)();
  if (!initial.isDirectory) {
    if (now - initial.mtimeMs <= options.staleMs) return false;
    await options.onAfterExpiredTokensClassified?.();
    let current: Stats;
    try {
      current = await ops.lstat(lockPath);
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return true;
      throw error;
    }
    if (
      current.isDirectory ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      now - current.mtimeMs <= options.staleMs
    ) {
      return false;
    }
    try {
      await ops.unlink(lockPath);
      return true;
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return true;
      throw error;
    }
  }

  let entries: readonly Entry[];
  try {
    entries = await ops.readdir(lockPath);
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return true;
    return false;
  }
  const expired: string[] = [];
  let hasLive = false;
  for (const entry of entries) {
    if (!entry.isFile) return false;
    const match = TOKEN_NAME_PATTERN.exec(entry.name);
    const isLegacy = entry.name === 'owner.json';
    if (match === null && !isLegacy) return false;
    let captured: { readonly raw: string; readonly stats: Stats };
    try {
      captured = await ops.readAndStat(join(lockPath, entry.name));
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) continue;
      return false;
    }
    if (!captured.stats.isFile) return false;
    const parsed = parseJson(captured.raw);
    const validation = isLegacy
      ? legacyTokenSchema.safeParse(parsed)
      : tokenSchema(options).safeParse(parsed);
    if (!validation.success) return false;
    const capturedPath = join(lockPath, entry.name);
    const capturedToken = validation.data;
    if (
      match !== null &&
      ('ownerId' in capturedToken === false ||
        capturedToken.ownerId !== match[1] ||
        capturedToken.leaseId !== match[2])
    ) {
      return false;
    }
    const ageExpired = now - captured.stats.mtimeMs > options.staleMs;
    if (
      ageExpired &&
      (options.canReclaimExpiredToken === undefined ||
        (await options.canReclaimExpiredToken({
          path: capturedPath,
          mtimeMs: captured.stats.mtimeMs,
          token: capturedToken,
        })))
    ) {
      expired.push(capturedPath);
    } else {
      hasLive = true;
    }
  }

  await options.onAfterExpiredTokensClassified?.();
  // dev+ino may be reused after replacement, but reclaim remains fail-closed:
  // non-recursive rmdir cannot remove a replacement containing a fresh token.
  // Removing a replacement that is still tokenless only interrupts a stalled
  // publisher, whose subsequent ENOENT write is treated as contention.
  if (!(await sameDirectory(lockPath, initial, ops))) return false;
  if (entries.length === 0) {
    let current: Stats;
    try {
      current = await ops.stat(lockPath);
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return true;
      throw error;
    }
    if (now - current.mtimeMs <= options.staleMs) return false;
  }
  for (const path of expired) await unlinkIfPresent(path, ops);
  await options.onAfterExpiredTokensUnlinkedBeforeRmdir?.();
  if (hasLive) return false;
  return safeRmdir(lockPath, ops);
}

async function tokenIsHeld(
  lockPath: string,
  directory: Stats,
  path: string,
  ownerId: string,
  leaseId: string,
  options: LeaseLockOptions,
  ops: FileOps
): Promise<boolean> {
  if (!(await sameDirectory(lockPath, directory, ops))) return false;
  try {
    const captured = await ops.readAndStat(path);
    const parsed = tokenSchema(options).safeParse(parseJson(captured.raw));
    return (
      captured.stats.isFile &&
      parsed.success &&
      parsed.data.ownerId === ownerId &&
      parsed.data.leaseId === leaseId &&
      (options.now ?? Date.now)() - captured.stats.mtimeMs <= options.staleMs
    );
  } catch {
    return false;
  }
}

function tokenSchema(options: LeaseLockOptions): z.ZodType<LeaseTokenData> {
  return options.tokenSchema ?? leaseTokenSchema;
}

function tokenName(lockPath: string, ownerId: string, leaseId: string): string {
  return join(lockPath, `owner.${ownerId}.${leaseId}`);
}

// If two stalled publishers reach one recreated directory, each sees the
// other's token and fails, or the first verified publisher wins and the later
// one fails. Cleanup may leave an orphan token, which is safer than admitting
// two owners and remains reclaimable by the normal stale-token path.
async function ownsPublishedDirectory(
  path: string,
  expected: Stats,
  createdTokenPaths: ReadonlySet<string>,
  requiredTokenPath: string,
  ops: FileOps
): Promise<boolean> {
  if (!(await sameDirectory(path, expected, ops))) return false;
  try {
    const entries = await ops.readdir(path);
    const createdNames = new Set(
      [...createdTokenPaths].map(createdPath =>
        createdPath.slice(path.length + 1)
      )
    );
    const entryNames = entries.map(entry => entry.name);
    return (
      entryNames.includes(requiredTokenPath.slice(path.length + 1)) &&
      entryNames.every(name => createdNames.has(name))
    );
  } catch {
    return false;
  }
}

async function sameDirectory(
  path: string,
  expected: Stats,
  ops: FileOps
): Promise<boolean> {
  try {
    const current = await ops.stat(path);
    return (
      current.isDirectory &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    );
  } catch {
    return false;
  }
}

async function removeEmptyOwnedDirectory(
  path: string,
  expected: Stats,
  ops: FileOps
): Promise<void> {
  if (await sameDirectory(path, expected, ops)) await safeRmdir(path, ops);
}

async function discardPublishedToken(
  path: string,
  ops: FileOps
): Promise<void> {
  try {
    await unlinkIfPresent(path, ops);
  } catch {
    // Ownership is already disproven, so the contention/lost result must win.
    // An unremovable orphan fails closed and ages into normal stale reclaim.
  }
}

async function unlinkIfPresent(path: string, ops: FileOps): Promise<void> {
  try {
    await ops.unlink(path);
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

async function safeRmdir(path: string, ops: FileOps): Promise<boolean> {
  try {
    await ops.rmdir(path);
    return true;
  } catch (error: unknown) {
    if (
      hasCode(error, 'ENOENT') ||
      hasCode(error, 'ENOTEMPTY') ||
      hasCode(error, 'EEXIST')
    ) {
      return hasCode(error, 'ENOENT');
    }
    throw error;
  }
}

function validateOptions(options: LeaseLockOptions): void {
  if (!Number.isFinite(options.staleMs) || options.staleMs < 0) {
    throw new RangeError('staleMs must be a non-negative finite number');
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function toStats(stats: {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}): Stats {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function resolved<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error: unknown) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
