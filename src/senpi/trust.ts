import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Default command-hook timeout in seconds when a handler omits `timeout`.
 *
 * Authority: vendored `docs/upstream/senpi/hooks/safety.d.ts`
 * (`DEFAULT_HOOK_TIMEOUT_SECONDS = 600`, engine 2026.8.19).
 */
export const SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

/**
 * Filename of the on-disk hook trust state document.
 *
 * Authority: vendored `docs/upstream/senpi/hooks/trust-storage.js`
 * (joins `hooks-state.json` under agent-home or project config dir).
 */
export const SENPI_HOOKS_STATE_FILENAME = 'hooks-state.json';

/**
 * Project-local config directory name used for project-scoped trust state.
 *
 * Authority: vendored engine `CONFIG_DIR_NAME` (`.senpi`) as used by
 * `docs/upstream/senpi/hooks/trust-storage.js` project path
 * `<cwd>/.senpi/hooks-state.json`.
 */
export const SENPI_PROJECT_CONFIG_DIR = '.senpi';

/** Hook-trust state document version accepted by this module. */
export const SENPI_HOOK_TRUST_STATE_VERSION = 1 as const;

/**
 * Source scopes a trust entry may record.
 *
 * Authority: vendored `HookSourceScope` in
 * `docs/upstream/senpi/hooks/types.d.ts`.
 */
export type SenpiHookSourceScope =
  | 'global'
  | 'project'
  | 'plugin'
  | 'runtime'
  | 'cli'
  | 'managed';

/**
 * Storage scopes that map to on-disk trust state paths.
 *
 * Authority: vendored `HookTrustStorageScope` in
 * `docs/upstream/senpi/hooks/trust.d.ts` —
 * `global` → `<agentHome>/hooks-state.json`,
 * `project` → `<cwd>/.senpi/hooks-state.json`.
 */
export type SenpiHookTrustStorageScope = 'global' | 'project';

/**
 * Platform string used when selecting `command` vs `commandWindows` for the
 * trust hash input. Inject for deterministic tests; defaults to
 * `process.platform`.
 *
 * Authority: vendored `HookTrustPlatform` / `options.platform` in
 * `docs/upstream/senpi/hooks/trust.js`.
 */
export type SenpiHookTrustPlatform = NodeJS.Platform;

/**
 * Options for platform-sensitive trust hashing.
 *
 * @property platform - Injected platform; defaults to `process.platform`.
 */
export type SenpiHookTrustOptions = {
  readonly platform?: SenpiHookTrustPlatform;
};

/**
 * One trusted/enabled command-hook record inside HookTrustState v1.
 *
 * Authority: vendored `HookTrustEntry` in
 * `docs/upstream/senpi/hooks/types.d.ts` and `parseHookTrustEntry` in
 * `docs/upstream/senpi/hooks/trust.js`.
 *
 * @property enabled - When false the hook is not executable even if hashed.
 * @property trustedHash - Optional `sha256:...` digest previously granted.
 * @property scope - Source scope recorded at grant time.
 * @property sourcePath - Config path that declared the handler.
 * @property matcher - Optional matcher string from the handler group.
 * @property commandPreview - Platform-selected command string preview.
 * @property updatedAt - ISO-8601 timestamp of the last trust write.
 */
export interface SenpiHookTrustEntry {
  readonly enabled: boolean;
  readonly trustedHash?: string;
  readonly scope: SenpiHookSourceScope;
  readonly sourcePath: string;
  readonly matcher?: string;
  readonly commandPreview: string;
  readonly updatedAt: string;
}

/**
 * On-disk / in-memory HookTrustState v1 document.
 *
 * Shape: `{ version: 1, hooks: { <id>: SenpiHookTrustEntry } }`.
 *
 * Authority: vendored `HookTrustState` in
 * `docs/upstream/senpi/hooks/types.d.ts`.
 *
 * @property version - Must be `1`.
 * @property hooks - Map of `senpiHookTrustId` → entry.
 */
export interface SenpiHookTrustState {
  readonly version: typeof SENPI_HOOK_TRUST_STATE_VERSION;
  readonly hooks: Readonly<Record<string, SenpiHookTrustEntry>>;
}

/**
 * Source metadata required by the trust id/hash algorithm.
 *
 * Authority: vendored `HookSourceMetadata` fields consumed by
 * `sourceKeyHash` in `docs/upstream/senpi/hooks/trust.js`
 * (`scope`, `sourcePath`, optional `pluginRoot`/`manifestPath`).
 *
 * @property scope - Handler source scope.
 * @property sourcePath - Absolute or logical path of the declaring config.
 * @property pluginRoot - Optional plugin root (null-coalesced to `""` in hash).
 * @property manifestPath - Optional plugin manifest path (null-coalesced to `""`).
 */
export interface SenpiTrustHookSource {
  readonly scope: SenpiHookSourceScope;
  readonly sourcePath: string;
  readonly pluginRoot?: string;
  readonly manifestPath?: string;
}

/**
 * Command-hook config fields consumed by trust hashing.
 *
 * Authority: vendored `CommandHookConfig` in
 * `docs/upstream/senpi/hooks/types.d.ts`.
 *
 * @property type - Always `"command"`.
 * @property command - POSIX/default command string.
 * @property commandWindows - Optional Windows override.
 * @property timeout - Optional timeout seconds (`> 0` when present).
 * @property statusMessage - Optional status message included in the hash.
 */
export interface SenpiTrustCommandHookConfig {
  readonly type: 'command';
  readonly command: string;
  readonly commandWindows?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
}

/**
 * Executable command handler identity used by trust id/hash/check APIs.
 *
 * Authority: vendored `ExecutableHookHandler` in
 * `docs/upstream/senpi/hooks/types.d.ts`, consumed by
 * `hookTrustId` / `hashCommandHook` in
 * `docs/upstream/senpi/hooks/trust.js`.
 *
 * @property event - Hook event name (e.g. `PreToolUse`).
 * @property matcher - Optional matcher from the handler group.
 * @property groupIndex - Zero-based group index within the event.
 * @property handlerIndex - Zero-based handler index within the group.
 * @property config - Command handler configuration.
 * @property source - Declaring source metadata.
 */
export interface SenpiTrustCommandHookHandler {
  readonly event: string;
  readonly matcher?: string;
  readonly groupIndex: number;
  readonly handlerIndex: number;
  readonly config: SenpiTrustCommandHookConfig;
  readonly source: SenpiTrustHookSource;
}

/**
 * Fail-closed result of reading a hooks-state.json document.
 *
 * Malformed, wrong-version, or unreadable files yield `ok: false` and never
 * throw. Missing or empty files yield an empty valid state (`ok: true`).
 *
 * @property ok - Whether a usable state was produced.
 * @property state - Parsed state when `ok` is true.
 * @property error - Human-readable reason when `ok` is false.
 * @property path - Absolute or given path that was read.
 */
export type SenpiHookTrustStateReadResult =
  | {
      readonly ok: true;
      readonly state: SenpiHookTrustState;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly path: string;
    };

/**
 * Build an empty HookTrustState v1 document.
 *
 * Authority: vendored `emptyHookTrustState` in
 * `docs/upstream/senpi/hooks/trust.js`.
 *
 * @returns Empty `{ version: 1, hooks: {} }` state.
 */
export function emptySenpiHookTrustState(): SenpiHookTrustState {
  return { version: SENPI_HOOK_TRUST_STATE_VERSION, hooks: {} };
}

/**
 * Resolve the on-disk path for a trust-storage scope.
 *
 * Authority: vendored `FileHookStateStorage` constructor in
 * `docs/upstream/senpi/hooks/trust-storage.js`:
 * - `global` → `<agentHome>/hooks-state.json`
 * - `project` → `<cwd>/.senpi/hooks-state.json`
 *
 * @param scope - Storage scope to resolve.
 * @param options - `agentHome` for global; `cwd` for project.
 * @returns Absolute-or-joined filesystem path for that scope.
 */
export function resolveSenpiHookTrustStatePath(
  scope: SenpiHookTrustStorageScope,
  options: { readonly agentHome: string; readonly cwd: string }
): string {
  if (scope === 'global') {
    return join(options.agentHome, SENPI_HOOKS_STATE_FILENAME);
  }
  return join(
    options.cwd,
    SENPI_PROJECT_CONFIG_DIR,
    SENPI_HOOKS_STATE_FILENAME
  );
}

/**
 * Compute the stable trust id for a command handler.
 *
 * Format: `hk_<sourceKeyHash>_<event>_<groupIndex>_<handlerIndex>` where
 * `sourceKeyHash` is the first 12 hex chars of sha256 over
 * `scope\\0sourcePath\\0pluginRoot\\0manifestPath` (empty string for missing
 * plugin fields).
 *
 * Authority: vendored `hookTrustId` + `sourceKeyHash` in
 * `docs/upstream/senpi/hooks/trust.js`.
 *
 * @param handler - Executable command handler identity.
 * @returns Trust id string of the form `hk_...`.
 */
export function senpiHookTrustId(
  handler: SenpiTrustCommandHookHandler
): string {
  return `hk_${sourceKeyHash(handler.source)}_${handler.event}_${handler.groupIndex}_${handler.handlerIndex}`;
}

/**
 * Compute the content hash of a command hook for trust comparison.
 *
 * Builds a canonical-JSON identity of
 * `{ event, hook: { async:false, command, commandWindows?, platformCommand,
 * statusMessage?, timeout, type:"command" }, matcher?, sourceKeyHash }` and
 * returns `sha256:<hex>`. Undefined optional fields are omitted by canonical
 * JSON. `platformCommand` is `commandWindows` on `win32` when set, else
 * `command`. Missing timeout defaults to
 * {@link SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS}; invalid timeout throws
 * (mirrors upstream).
 *
 * Authority: vendored `hashCommandHook` in
 * `docs/upstream/senpi/hooks/trust.js`.
 *
 * @param handler - Executable command handler identity.
 * @param options - Optional injected `platform` (defaults to `process.platform`).
 * @returns Hash string `sha256:<hex>`.
 */
export function senpiHashCommandHook(
  handler: SenpiTrustCommandHookHandler,
  options: SenpiHookTrustOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const hook: Record<string, unknown> = {
    async: false,
    command: handler.config.command,
    commandWindows: handler.config.commandWindows,
    platformCommand: selectedCommand(handler, platform),
    statusMessage: handler.config.statusMessage,
    timeout: normalizedTimeout(handler.config.timeout),
    type: 'command',
  };
  const identity: Record<string, unknown> = {
    event: handler.event,
    hook,
    matcher: handler.matcher,
    sourceKeyHash: sourceKeyHash(handler.source),
  };
  return `sha256:${sha256Hex(JSON.stringify(canonicalJson(identity)))}`;
}

/**
 * Read and validate a HookTrustState v1 document from disk (read-only).
 *
 * Fail-closed: invalid JSON, wrong/missing version, non-object root, or
 * non-object `hooks` yields `{ ok: false, error }` and never throws.
 * Missing path or empty/whitespace content yields `{ ok: true }` with an
 * empty state. Individual entries that fail field validation are skipped
 * (same salvage rule as vendored `parseHookTrustState`).
 *
 * This function never writes, creates directories, or renames files.
 *
 * Authority: vendored `readHookTrustStateJson` / `parseHookTrustState` in
 * `docs/upstream/senpi/hooks/trust.js`, adapted to a typed result object
 * instead of silently returning empty state on root malformation.
 *
 * @param path - Filesystem path of a `hooks-state.json` document.
 * @returns Typed ok/error result; never throws.
 */
export function readSenpiHookTrustState(
  path: string
): SenpiHookTrustStateReadResult {
  try {
    if (!existsSync(path)) {
      return { ok: true, state: emptySenpiHookTrustState(), path };
    }
    const text = readFileSync(path, 'utf-8');
    if (text.trim() === '') {
      return { ok: true, state: emptySenpiHookTrustState(), path };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        error: `Malformed hooks-state.json at ${path}: invalid JSON`,
        path,
      };
    }
    const state = parseHookTrustState(parsed);
    if (state === undefined) {
      return {
        ok: false,
        error: `Malformed hooks-state.json at ${path}: invalid trust state shape or version`,
        path,
      };
    }
    return { ok: true, state, path };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Failed to read hooks-state.json at ${path}: ${message}`,
      path,
    };
  }
}

/**
 * Return whether a command hook is currently trusted and enabled in `state`.
 *
 * A handler is trusted when `state.hooks[id].trustedHash` equals the live
 * {@link senpiHashCommandHook} digest and `enabled` is not false
 * (missing entry ⇒ enabled defaults true but hash mismatch ⇒ not trusted).
 *
 * Authority: vendored `isCommandHookTrusted` /
 * `buildStatefulHookTrustRecord` in `docs/upstream/senpi/hooks/trust.js`
 * (`executable = enabled && trusted`).
 *
 * @param handler - Executable command handler identity.
 * @param state - Previously loaded HookTrustState v1.
 * @param options - Optional injected `platform` for hash parity.
 * @returns `true` when the handler is enabled and hash-trusted.
 */
export function isSenpiCommandHookTrusted(
  handler: SenpiTrustCommandHookHandler,
  state: SenpiHookTrustState,
  options: SenpiHookTrustOptions = {}
): boolean {
  const id = senpiHookTrustId(handler);
  const entry = state.hooks[id];
  const enabled = entry?.enabled ?? true;
  const currentHash = senpiHashCommandHook(handler, options);
  const trusted = entry?.trustedHash === currentHash;
  return enabled && trusted;
}

function parseHookTrustState(input: unknown): SenpiHookTrustState | undefined {
  if (
    !isRecord(input) ||
    input['version'] !== SENPI_HOOK_TRUST_STATE_VERSION ||
    !isRecord(input['hooks'])
  ) {
    return undefined;
  }
  const hooks: Record<string, SenpiHookTrustEntry> = {};
  for (const [id, entry] of Object.entries(input['hooks'])) {
    const parsed = parseHookTrustEntry(entry);
    if (parsed !== undefined) {
      hooks[id] = parsed;
    }
  }
  return { version: SENPI_HOOK_TRUST_STATE_VERSION, hooks };
}

function parseHookTrustEntry(input: unknown): SenpiHookTrustEntry | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const enabled = input['enabled'];
  const trustedHash = input['trustedHash'];
  const scope = input['scope'];
  const sourcePath = input['sourcePath'];
  const matcher = input['matcher'];
  const commandPreview = input['commandPreview'];
  const updatedAt = input['updatedAt'];

  if (
    typeof enabled !== 'boolean' ||
    (trustedHash !== undefined && typeof trustedHash !== 'string') ||
    !isHookSourceScope(scope) ||
    typeof sourcePath !== 'string' ||
    (matcher !== undefined && typeof matcher !== 'string') ||
    typeof commandPreview !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return undefined;
  }

  const entry: SenpiHookTrustEntry = {
    enabled,
    scope,
    sourcePath,
    commandPreview,
    updatedAt,
    ...(trustedHash === undefined ? {} : { trustedHash }),
    ...(matcher === undefined ? {} : { matcher }),
  };
  return entry;
}

function selectedCommand(
  handler: SenpiTrustCommandHookHandler,
  platform: string
): string {
  if (platform === 'win32' && handler.config.commandWindows !== undefined) {
    return handler.config.commandWindows;
  }
  return handler.config.command;
}

function normalizedTimeout(timeout: number | undefined): number {
  if (timeout === undefined) {
    return SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS;
  }
  if (!isValidHookTimeoutSeconds(timeout)) {
    throw new Error('Invalid command hook timeout reached trust hashing.');
  }
  return timeout;
}

/**
 * Authority: vendored `isValidHookTimeoutSeconds` in engine safety.js
 * (`Number.isFinite(timeout) && timeout > 0`).
 */
function isValidHookTimeoutSeconds(timeout: number): boolean {
  return Number.isFinite(timeout) && timeout > 0;
}

function sourceKeyHash(source: SenpiTrustHookSource): string {
  return sha256Hex(
    [
      source.scope,
      source.sourcePath,
      source.pluginRoot ?? '',
      source.manifestPath ?? '',
    ].join('\0')
  ).slice(0, 12);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalJson(item));
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      result[key] = canonicalJson(child);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookSourceScope(value: unknown): value is SenpiHookSourceScope {
  return (
    value === 'global' ||
    value === 'project' ||
    value === 'plugin' ||
    value === 'runtime' ||
    value === 'cli' ||
    value === 'managed'
  );
}
