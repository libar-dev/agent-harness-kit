import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  SENPI_HOOK_TRUST_STATE_VERSION,
  SENPI_HOOKS_STATE_FILENAME,
  SENPI_PROJECT_CONFIG_DIR,
  senpiHashCommandHook,
  senpiHookTrustId,
  type SenpiHookSourceScope,
  type SenpiHookTrustEntry,
  type SenpiHookTrustOptions,
  type SenpiHookTrustStorageScope,
  type SenpiTrustCommandHookHandler,
} from './trust.js';

/**
 * Typed error thrown when the explicit-consent gate rejects a write attempt.
 *
 * Raised BEFORE any filesystem access when `consent` is not exactly `true`
 * or `reason` is missing/blank. No lock is taken, no directory is created,
 * and no state file is touched.
 */
export class SenpiTrustConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenpiTrustConsentError';
  }
}

/**
 * Typed error thrown when an existing hooks-state.json document is
 * malformed (invalid JSON, non-object root, wrong version, non-object
 * `hooks`, unreadable file, or any entry failing trust-entry field
 * validation).
 *
 * The write aborts fail-closed: no temp files remain and the state file is
 * left byte-for-byte untouched (no blind overwrite of stale state).
 */
export class SenpiTrustStateMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenpiTrustStateMalformedError';
  }
}

/**
 * Typed error thrown when the internal file lock cannot be acquired within
 * the bounded retry budget (mirroring vendored trust-storage.js:
 * 10 attempts spaced ~20 ms apart) or when acquisition fails with a
 * non-contention filesystem error.
 */
export class SenpiTrustLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenpiTrustLockError';
  }
}

/** Lock retry budget, mirroring vendored trust-storage.js (`maxAttempts`). */
const LOCK_MAX_ATTEMPTS = 10;

/** Delay between lock attempts in ms, mirroring vendored trust-storage.js. */
const LOCK_RETRY_DELAY_MS = 20;

/**
 * Age (ms) after which an orphaned lock file is considered stale and may be
 * removed by the next writer. Vendored proper-lockfile usage never expires;
 * this internal implementation adds stale-lock handling as required.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Injectable time seam for lock retry/staleness. Production uses wall clock;
 * tests inject a deterministic clock so lock-budget assertions never sleep.
 */
export interface SenpiTrustWriterClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULT_TRUST_WRITER_CLOCK: SenpiTrustWriterClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Internal sentinel: lock file exists (contention), retry later. */
class LockContentionError extends Error {}

/**
 * Options for {@link writeSenpiHookTrustEntry}.
 *
 * @property consent - MUST be the literal `true`. Calling
 * {@link writeSenpiHookTrustEntry} IS the approval act itself: passing
 * `consent: true` asserts that an explicit human/operator decision has been
 * made to trust this exact command hook. There is no default, no prompt,
 * and no ambient trust source; anything else is rejected before any
 * filesystem access.
 * @property reason - Non-empty human-readable justification for the grant,
 * recorded verbatim on the written entry as `grantReason`.
 * @property handler - Executable command handler identity to trust.
 * @property scope - Storage scope: `global` writes
 * `<agentHome>/hooks-state.json`, `project` writes
 * `<cwd>/.senpi/hooks-state.json`.
 * @property agentHome - Agent home directory (used for `global` scope).
 * @property cwd - Project working directory (used for `project` scope).
 * @property platform - Optional injected platform for hash/preview parity;
 * defaults to `process.platform`.
 * @property enabled - Enabled flag recorded on the entry; defaults `true`.
 * @property clock - Optional injectable lock clock (`now` + `sleep`) for
 * deterministic tests; defaults to wall clock.
 */
export interface WriteSenpiHookTrustEntryOptions {
  readonly consent: true;
  readonly reason: string;
  readonly handler: SenpiTrustCommandHookHandler;
  readonly scope: SenpiHookTrustStorageScope;
  readonly agentHome: string;
  readonly cwd: string;
  readonly platform?: SenpiHookTrustOptions['platform'];
  readonly enabled?: boolean;
  readonly clock?: SenpiTrustWriterClock;
}

/**
 * Result of a successful trust entry write.
 *
 * @property path - hooks-state.json path that was written.
 * @property id - Trust id (`hk_...`) of the written entry.
 * @property entry - The exact entry serialized into the state file.
 */
export interface WriteSenpiHookTrustEntryResult {
  readonly path: string;
  readonly id: string;
  readonly entry: WrittenSenpiHookTrustEntry;
}

/**
 * Options for {@link removeSenpiHookTrustEntry}.
 *
 * @property consent - MUST be the literal `true`. Calling the remover IS
 * the revoke act.
 * @property reason - Non-empty justification for the revoke.
 * @property handler - Executable command handler identity whose trust id
 * is removed.
 * @property scope - Storage scope selecting the state file.
 * @property agentHome - Agent home directory (used for `global` scope).
 * @property cwd - Project working directory (used for `project` scope).
 * @property clock - Optional injectable lock clock for deterministic tests.
 */
export interface RemoveSenpiHookTrustEntryOptions {
  readonly consent: true;
  readonly reason: string;
  readonly handler: SenpiTrustCommandHookHandler;
  readonly scope: SenpiHookTrustStorageScope;
  readonly agentHome: string;
  readonly cwd: string;
  readonly clock?: SenpiTrustWriterClock;
}

/** Result of a consented trust-entry removal. */
export interface RemoveSenpiHookTrustEntryResult {
  readonly path: string;
  readonly id: string;
  readonly removed: boolean;
}

/**
 * Trust entry shape produced by this writer: the vendored HookTrustEntry
 * fields plus the recorded `grantReason` consent justification.
 */
export type WrittenSenpiHookTrustEntry = SenpiHookTrustEntry & {
  readonly grantReason: string;
};

/**
 * Perform an EXPLICIT, caller-authorized write of ONE command-hook trust
 * entry to the scoped `hooks-state.json` document.
 *
 * CONSENT CONTRACT: calling this function IS the approval act. It must only
 * be invoked directly on behalf of an explicitly-granting user action -
 * never from runner/settings/install code paths; there is no implicit or
 * automatic trust grant anywhere in this library.
 *
 * Behavior:
 * - Validates `consent === true` and a non-blank `reason` BEFORE any
 *   filesystem access; violations throw {@link SenpiTrustConsentError} with
 *   zero filesystem effect (no directory creation, no lock, no write).
 * - Locks the target state file INTERNALLY via O_EXCL lock-file creation
 *   with bounded retry ({@link SenpiTrustLockError} on exhaustion) and
 *   stale-lock removal (locks older than 10 s are treated as orphaned).
 *   No external locking dependency is used.
 * - Read-modify-write under the lock: parses the existing document
 *   fail-closed (malformed state aborts with
 *   {@link SenpiTrustStateMalformedError}, writing nothing), then adds or
 *   updates ONLY the target trust id while preserving all unrelated
 *   entries and unknown top-level keys byte-for-byte where untouched.
 * - Serializes with sorted hook ids (vendored format), writes atomically
 *   via temp-file + rename onto the same directory, and enforces 0600
 *   permissions on the state file.
 *
 * @param opts - Consent-gated options; see
 * {@link WriteSenpiHookTrustEntryOptions}.
 * @returns The written path, trust id, and entry.
 */
export async function writeSenpiHookTrustEntry(
  opts: WriteSenpiHookTrustEntryOptions
): Promise<WriteSenpiHookTrustEntryResult> {
  // Consent gate FIRST - before any filesystem access of any kind.
  if (opts.consent !== true) {
    throw new SenpiTrustConsentError(
      'writeSenpiHookTrustEntry requires explicit consent:true - calling it IS the approval act'
    );
  }
  if (typeof opts.reason !== 'string' || opts.reason.trim() === '') {
    throw new SenpiTrustConsentError(
      'writeSenpiHookTrustEntry requires a non-empty reason string recorded with the grant'
    );
  }

  const statePath = resolveStatePath(opts.scope, opts.agentHome, opts.cwd);
  const platform = opts.platform ?? process.platform;
  const id = senpiHookTrustId(opts.handler);
  const trustedHash = senpiHashCommandHook(opts.handler, { platform });
  const entry: WrittenSenpiHookTrustEntry = {
    enabled: opts.enabled ?? true,
    trustedHash,
    scope: opts.handler.source.scope,
    sourcePath: opts.handler.source.sourcePath,
    commandPreview: selectedCommandPreview(opts.handler, platform),
    updatedAt: new Date().toISOString(),
    grantReason: opts.reason,
    ...(opts.handler.matcher === undefined
      ? {}
      : { matcher: opts.handler.matcher }),
  };

  return withStateLock(
    statePath,
    () => {
      const { root, hooks } = readRawStateForUpdate(statePath);
      hooks[id] = entry;
      atomicWriteState(statePath, serializeState(root, hooks));
      return { path: statePath, id, entry };
    },
    opts.clock ?? DEFAULT_TRUST_WRITER_CLOCK
  );
}

/**
 * Perform an EXPLICIT, caller-authorized removal of ONE command-hook trust
 * entry from the scoped `hooks-state.json` document.
 *
 * CONSENT CONTRACT: calling this function IS the revoke act. It must only
 * be invoked directly on behalf of an explicitly-revoking user action.
 * Cockpit product integration is observe-only and must not call this helper.
 *
 * Missing files are a successful no-op (`removed: false`) and do not create
 * directories. When the last entry is removed and no unknown top-level keys
 * remain, the state file itself is deleted so a grant/revoke cycle is a
 * reversible file delta.
 *
 * @param opts - Consent-gated options; see
 * {@link RemoveSenpiHookTrustEntryOptions}.
 * @returns The state path, trust id, and whether an entry was removed.
 */
export async function removeSenpiHookTrustEntry(
  opts: RemoveSenpiHookTrustEntryOptions
): Promise<RemoveSenpiHookTrustEntryResult> {
  if (!isRecord(opts) || opts['consent'] !== true) {
    throw new SenpiTrustConsentError(
      'removeSenpiHookTrustEntry requires explicit consent:true - calling it IS the approval act'
    );
  }
  const reason = opts['reason'];
  const handler = opts['handler'];
  const scope = opts['scope'];
  const agentHome = opts['agentHome'];
  const cwd = opts['cwd'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new SenpiTrustConsentError(
      'removeSenpiHookTrustEntry requires a non-empty reason string recorded with the revoke'
    );
  }
  if (handler === undefined || scope === undefined) {
    throw new SenpiTrustConsentError(
      'removeSenpiHookTrustEntry requires an explicit handler and scope target'
    );
  }
  if (typeof agentHome !== 'string' || typeof cwd !== 'string') {
    throw new SenpiTrustConsentError(
      'removeSenpiHookTrustEntry requires an explicit agentHome and cwd target'
    );
  }

  const statePath = resolveStatePath(
    scope as SenpiHookTrustStorageScope,
    agentHome,
    cwd
  );
  const id = senpiHookTrustId(handler as SenpiTrustCommandHookHandler);
  if (!existsSync(statePath)) {
    return { path: statePath, id, removed: false };
  }

  return withStateLock(
    statePath,
    () => {
      if (!existsSync(statePath)) {
        return { path: statePath, id, removed: false };
      }
      const { root, hooks } = readRawStateForUpdate(statePath);
      const existed = Object.prototype.hasOwnProperty.call(hooks, id);
      delete hooks[id];
      const leftoverIds = Object.keys(hooks);
      const leftoverRootKeys = Object.keys(root).filter(
        key => key !== 'version' && key !== 'hooks'
      );
      if (leftoverIds.length === 0 && leftoverRootKeys.length === 0) {
        rmSync(statePath, { force: true });
        return { path: statePath, id, removed: existed };
      }
      atomicWriteState(statePath, serializeState(root, hooks));
      return { path: statePath, id, removed: existed };
    },
    opts.clock ?? DEFAULT_TRUST_WRITER_CLOCK
  );
}

/**
 * Resolve the on-disk state path for a storage scope.
 *
 * Authority: vendored `docs/upstream/senpi/hooks/trust-storage.js`
 * (`global` -> `<agentHome>/hooks-state.json`,
 * `project` -> `<cwd>/.senpi/hooks-state.json`).
 */
function resolveStatePath(
  scope: SenpiHookTrustStorageScope,
  agentHome: string,
  cwd: string
): string {
  if (scope === 'global') {
    return join(agentHome, SENPI_HOOKS_STATE_FILENAME);
  }
  return join(cwd, SENPI_PROJECT_CONFIG_DIR, SENPI_HOOKS_STATE_FILENAME);
}

function selectedCommandPreview(
  handler: SenpiTrustCommandHookHandler,
  platform: string
): string {
  if (platform === 'win32' && handler.config.commandWindows !== undefined) {
    return handler.config.commandWindows;
  }
  return handler.config.command;
}

/**
 * Read the raw parsed state document for mutation, fail-closed.
 *
 * Missing file or empty content yields `{ version: 1, hooks: {} }`. Any
 * malformed shape - including ANY existing entry failing trust-entry field
 * validation - throws {@link SenpiTrustStateMalformedError} instead of
 * blindly overwriting (stale/malformed-state guard).
 *
 * The raw parsed values are returned so untouched entries and unknown
 * top-level keys re-serialize byte-for-byte identically.
 */
function readRawStateForUpdate(path: string): {
  root: Record<string, unknown>;
  hooks: Record<string, unknown>;
} {
  const empty = (): {
    root: Record<string, unknown>;
    hooks: Record<string, unknown>;
  } => ({
    root: { version: SENPI_HOOK_TRUST_STATE_VERSION, hooks: {} },
    hooks: {},
  });
  if (!existsSync(path)) {
    return empty();
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    throw new SenpiTrustStateMalformedError(
      `Cannot read hooks-state.json at ${path}: ${errorMessage(error)}`
    );
  }
  if (text.trim() === '') {
    return empty();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SenpiTrustStateMalformedError(
      `Malformed hooks-state.json at ${path}: invalid JSON; refusing to overwrite`
    );
  }
  if (!isRecord(parsed)) {
    throw new SenpiTrustStateMalformedError(
      `Malformed hooks-state.json at ${path}: root is not an object`
    );
  }
  if (parsed['version'] !== SENPI_HOOK_TRUST_STATE_VERSION) {
    throw new SenpiTrustStateMalformedError(
      `Malformed hooks-state.json at ${path}: unsupported or missing version`
    );
  }
  if (!isRecord(parsed['hooks'])) {
    throw new SenpiTrustStateMalformedError(
      `Malformed hooks-state.json at ${path}: "hooks" is not an object`
    );
  }
  for (const [id, hookEntry] of Object.entries(parsed['hooks'])) {
    if (!isValidTrustEntry(hookEntry)) {
      throw new SenpiTrustStateMalformedError(
        `Malformed hooks-state.json at ${path}: entry "${id}" fails trust-entry validation; refusing to overwrite`
      );
    }
  }
  const hooks = parsed['hooks'];
  return { root: parsed, hooks };
}

/**
 * Structural validation mirroring `parseHookTrustEntry` in
 * `src/senpi/trust.ts` (boolean enabled, optional string trustedHash /
 * matcher, known scope, string sourcePath / commandPreview / updatedAt).
 * Unknown extra fields on entries are permitted and preserved verbatim.
 */
function isValidTrustEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const scope = value['scope'];
  return (
    typeof value['enabled'] === 'boolean' &&
    (value['trustedHash'] === undefined ||
      typeof value['trustedHash'] === 'string') &&
    typeof scope === 'string' &&
    isKnownScope(scope) &&
    typeof value['sourcePath'] === 'string' &&
    (value['matcher'] === undefined || typeof value['matcher'] === 'string') &&
    typeof value['commandPreview'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function isKnownScope(value: string): value is SenpiHookSourceScope {
  return (
    value === 'global' ||
    value === 'project' ||
    value === 'plugin' ||
    value === 'runtime' ||
    value === 'cli' ||
    value === 'managed'
  );
}

/**
 * Serialize the mutated document preserving unknown top-level keys and
 * untouched raw entry values; hook ids are sorted (vendored
 * `serializeHookTrustState` format: 2-space indent + trailing newline).
 */
function serializeState(
  root: Record<string, unknown>,
  hooks: Record<string, unknown>
): string {
  const sortedHooks: Record<string, unknown> = {};
  for (const key of Object.keys(hooks).sort()) {
    const hookEntry = hooks[key];
    if (hookEntry !== undefined) {
      sortedHooks[key] = hookEntry;
    }
  }
  const next: Record<string, unknown> = {
    ...root,
    version: SENPI_HOOK_TRUST_STATE_VERSION,
    hooks: sortedHooks,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Atomic replacement: temp file created O_EXCL with 0600 (chmod enforced
 * against permissive umasks), fsynced, then renamed over the target. On any
 * failure the temp file is removed and the target is untouched.
 */
function atomicWriteState(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, path);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Acquire the internal lock, run `fn`, and always release.
 *
 * Lock protocol (internal replication of vendored trust-storage.js lock
 * semantics WITHOUT proper-lockfile): exclusive creation of
 * `<statePath>.lock` via O_EXCL with a fresh ownership token written into
 * the lock file; on contention, retry up to {@link LOCK_MAX_ATTEMPTS} times
 * spaced {@link LOCK_RETRY_DELAY_MS} apart; a lock file whose mtime is older
 * than {@link LOCK_STALE_MS} is treated as orphaned and removed before
 * retrying. The critical section `fn` is fully synchronous so it cannot
 * interleave with another writer in-process. Release removes the lock file
 * only when its token still matches ours: a stale lease can be reclaimed by
 * another owner while our critical section runs, and deleting the
 * replacement's lock would admit a third writer and lose updates.
 *
 * Module-level export for intra-package reuse and lock-contract tests; the
 * senpi barrel decides the public API surface.
 *
 * @param statePath - Target hooks-state.json path to lock around.
 * @param fn - Synchronous critical section.
 * @returns Whatever `fn` returns.
 */
export async function withStateLock<T>(
  statePath: string,
  fn: () => T,
  clock: SenpiTrustWriterClock
): Promise<T> {
  mkdirSync(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let ownedToken: string | undefined;
  let acquired = false;
  let lastContention = false;
  for (let attempt = 1; attempt <= LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      ownedToken = acquireLock(lockPath);
      acquired = true;
      break;
    } catch (error: unknown) {
      if (!(error instanceof LockContentionError)) {
        throw new SenpiTrustLockError(
          `Failed to acquire hook state lock at ${lockPath}: ${errorMessage(error)}`
        );
      }
      lastContention = true;
      if (attempt === LOCK_MAX_ATTEMPTS) {
        break;
      }
      if (!isStaleLock(lockPath, clock.now)) {
        await clock.sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      // Orphaned lock: claim it atomically, re-verify staleness on the
      // private claim, and only then remove. A fresh lock that replaced the
      // stale one between the staleness check and the claim is restored and
      // acquisition retried instead of deleted.
      if (removeStaleStateLock(lockPath, clock.now)) {
        continue;
      }
      await clock.sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  if (!acquired) {
    throw new SenpiTrustLockError(
      lastContention
        ? `Timed out acquiring hook state lock at ${lockPath} after ${LOCK_MAX_ATTEMPTS} attempts`
        : `Failed to acquire hook state lock at ${lockPath}`
    );
  }
  try {
    return await fn();
  } finally {
    if (ownedToken !== undefined) releaseStateLock(lockPath, ownedToken);
  }
}

/**
 * Remove a trust-state lock file this owner acquired, leaving it untouched
 * when the lock no longer belongs to us. A stale lease can be reclaimed by
 * another owner while our critical section still runs; deleting the
 * replacement's lock would admit a third writer and lose trust-state
 * updates. The token is freshly generated at acquire time, so any
 * replacement lock carries a different one.
 *
 * Check and removal race unless the lock is claimed atomically first: the
 * file is renamed to a private uuid path, verified there, and only then
 * removed. On a token mismatch (or unparseable content) the claimed file is
 * restored to the lock path; if that restore is blocked the claimed file is
 * deleted — it is no longer at the lock path, so it cannot be the lock any
 * acquirer would see, and keeping it would leak a path nothing reclaims.
 */
function releaseStateLock(lockPath: string, ownedToken: string): void {
  const claimedPath = `${lockPath}.release.${randomUUID()}`;
  try {
    renameSync(lockPath, claimedPath);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (claimedTokenIs(claimedPath, ownedToken)) {
    rmSync(claimedPath, { force: true });
    return;
  }
  restoreClaimedStateLock(claimedPath, lockPath);
}

/**
 * Atomically claim a stale trust-state lock and remove it. Returns true when
 * a stale lock was claimed and removed; false when the path vanished or the
 * claimed file is no longer stale (a fresh lock replaced it between the
 * caller's staleness check and the claim — it is restored and acquisition
 * retried rather than deleted).
 */
export function removeStaleStateLock(
  lockPath: string,
  now: () => number
): boolean {
  const claimedPath = `${lockPath}.reclaim.${randomUUID()}`;
  try {
    renameSync(lockPath, claimedPath);
  } catch {
    // Lock vanished between the staleness check and the claim; nothing to
    // remove. Caller retries acquisition.
    return false;
  }
  try {
    if (now() - statSync(claimedPath).mtimeMs > LOCK_STALE_MS) {
      rmSync(claimedPath, { force: true });
      return true;
    }
    restoreClaimedStateLock(claimedPath, lockPath);
    return false;
  } catch (error: unknown) {
    restoreClaimedStateLock(claimedPath, lockPath);
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function claimedTokenIs(claimedPath: string, ownedToken: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(claimedPath, 'utf-8');
  } catch {
    // Claimed but unreadable: not verifiably ours.
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable lock content belongs to an owner we cannot identify.
    return false;
  }
  return isRecord(parsed) && parsed['token'] === ownedToken;
}

function restoreClaimedStateLock(claimedPath: string, lockPath: string): void {
  try {
    renameSync(claimedPath, lockPath);
  } catch {
    // Lock path occupied mid-restore: the claimed copy is no longer at the
    // lock path, so it cannot be the lock any acquirer sees; delete it to
    // avoid leaking a path nothing reclaims.
    rmSync(claimedPath, { force: true });
  }
}

function acquireLock(lockPath: string): string {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      throw new LockContentionError(`lock exists: ${lockPath}`);
    }
    throw error;
  }
  const token = randomUUID();
  try {
    writeSync(fd, `${JSON.stringify({ token, pid: process.pid })}\n`);
  } finally {
    closeSync(fd);
  }
  return token;
}

function isStaleLock(lockPath: string, now: () => number): boolean {
  try {
    return now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Lock vanished between attempts - treat as free.
    return false;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
