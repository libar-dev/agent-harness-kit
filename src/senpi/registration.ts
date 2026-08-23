import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type SenpiHookEventName } from './settings.js';
import { SENPI_PROJECT_CONFIG_DIR } from './trust.js';

/**
 * Filename of a senpi hooks registration document.
 *
 * Authority: vendored engine config loader
 * (`<agentHome>/hooks.json`, `<cwd>/.senpi/hooks.json`).
 */
export const SENPI_HOOKS_CONFIG_FILENAME = 'hooks.json';

/**
 * Typed error thrown when a mutating registration helper is called without
 * an explicit options object, `consent: true`, a non-empty `reason`, or a
 * target. Raised BEFORE any filesystem access.
 */
export class SenpiHooksConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenpiHooksConsentError';
  }
}

/**
 * One command handler in a generated hooks registration document.
 *
 * Mirrors the vendored `CommandHookConfig` restricted to the fields this
 * helper emits: only the `command` target is set. Observe-only guarantee:
 * registration never carries gate or decision configuration.
 */
export interface SenpiHooksRegistrationHandler {
  readonly type: 'command';
  readonly command: string;
}

/**
 * One matcher group in a generated hooks registration document.
 *
 * No `matcher` is emitted, which upstream resolves to matching every input
 * for the event.
 */
export interface SenpiHooksRegistrationGroup {
  readonly hooks: readonly SenpiHooksRegistrationHandler[];
}

/**
 * A senpi `hooks.json` document for the registered subset of events.
 *
 * Shape accepted by `validateSenpiHooksConfig` and by the engine's config
 * loader (`docs/upstream/senpi/hooks/config-loader.d.ts`). Observe-only
 * guarantee: documents built here contain command handlers only and carry no
 * trust-state or gate-enabling configuration.
 */
export interface SenpiHooksRegistrationDocument {
  readonly hooks: {
    readonly [event in SenpiHookEventName]?: readonly SenpiHooksRegistrationGroup[];
  };
}

/**
 * Explicit destination for a hooks.json mutation or inspection.
 *
 * Callers own the path. Library helpers never default to `~/.omo`.
 */
export type SenpiHooksConfigTarget =
  | { readonly filePath: string }
  | { readonly scope: 'global'; readonly agentHome: string }
  | { readonly scope: 'project'; readonly cwd: string };

/**
 * Options for {@link writeSenpiHooksConfig}.
 *
 * @property consent - MUST be the literal `true`. Calling the writer IS the
 * approval act. There is no default, prompt, or ambient install.
 * @property reason - Non-empty justification recorded by the caller.
 * @property target - Explicit destination; never inferred from process env.
 * @property document - Document produced by {@link buildSenpiHooksRegistration}.
 */
export interface WriteSenpiHooksConfigOptions {
  readonly consent: true;
  readonly reason: string;
  readonly target: SenpiHooksConfigTarget;
  readonly document: SenpiHooksRegistrationDocument;
}

/**
 * Options for {@link removeSenpiHooksConfig}.
 *
 * @property consent - MUST be the literal `true`.
 * @property reason - Non-empty justification for the unregister.
 * @property target - Explicit destination of the file to remove.
 */
export interface RemoveSenpiHooksConfigOptions {
  readonly consent: true;
  readonly reason: string;
  readonly target: SenpiHooksConfigTarget;
}

/**
 * Options for {@link readSenpiHooksConfig}.
 *
 * Inspection is read-only and does not require consent.
 *
 * @property target - Explicit destination to read.
 */
export interface ReadSenpiHooksConfigOptions {
  readonly target: SenpiHooksConfigTarget;
}

/**
 * Result of inspecting a hooks.json document.
 *
 * Missing or empty files yield `ok: true` with `document: null`. Malformed
 * files yield `ok: false` and never throw.
 */
export type SenpiHooksConfigReadResult =
  | {
      readonly ok: true;
      readonly document: SenpiHooksRegistrationDocument | null;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly path: string;
    };

/** Result of a consented hooks.json write. */
export interface WriteSenpiHooksConfigResult {
  readonly path: string;
}

/** Result of a consented hooks.json removal. */
export interface RemoveSenpiHooksConfigResult {
  readonly path: string;
  readonly removed: boolean;
}

/**
 * Builds a senpi hooks.json registration document for a subset of the seven
 * supported events.
 *
 * Each listed event maps to a single matcher group running one `type:
 * "command"` handler with the given command - typically an invocation of the
 * bundled observe-only forwarder asset
 * (`dist/standalone/hook-forwarder-senpi.mjs`). Duplicate event names are
 * collapsed preserving first-occurrence order.
 *
 * Observe-only guarantee: this function is pure; it never writes trust state,
 * never enables gates, and produces a document whose only handler type is
 * `command`.
 *
 * @param events - Subset of the seven canonical senpi hook event names.
 * @param command - Shell command string for every registered handler.
 * @returns A document that round-trips through `validateSenpiHooksConfig`
 * with zero diagnostics (for any non-blank command).
 * @throws {RangeError} When `command` is blank, since such a document could
 * not validate cleanly.
 */
export function buildSenpiHooksRegistration(
  events: readonly SenpiHookEventName[],
  command: string
): SenpiHooksRegistrationDocument {
  if (command.trim() === '') {
    throw new RangeError('command must be a non-empty string');
  }

  const hooks: Partial<
    Record<SenpiHookEventName, readonly SenpiHooksRegistrationGroup[]>
  > = {};
  const seen = new Set<SenpiHookEventName>();
  for (const event of events) {
    if (seen.has(event)) continue;
    seen.add(event);
    hooks[event] = [{ hooks: [{ type: 'command', command }] }];
  }
  return { hooks };
}

/**
 * Resolve the on-disk path for a hooks.json target.
 *
 * - `{ filePath }` → that path, unchanged
 * - `{ scope: "global", agentHome }` → `<agentHome>/hooks.json`
 * - `{ scope: "project", cwd }` → `<cwd>/.senpi/hooks.json`
 *
 * This helper is pure. It never creates directories or reads the filesystem.
 *
 * @param target - Explicit destination.
 * @returns Resolved filesystem path.
 * @throws {RangeError} When the target object is missing required fields.
 */
export function resolveSenpiHooksConfigPath(
  target: SenpiHooksConfigTarget
): string {
  if (!isRecord(target)) {
    throw new RangeError('explicit target object is required');
  }
  if ('filePath' in target) {
    if (typeof target.filePath !== 'string' || target.filePath.trim() === '') {
      throw new RangeError('target.filePath must be a non-empty string');
    }
    return target.filePath;
  }
  if (target.scope === 'global') {
    if (
      typeof target.agentHome !== 'string' ||
      target.agentHome.trim() === ''
    ) {
      throw new RangeError('global target requires a non-empty agentHome');
    }
    return join(target.agentHome, SENPI_HOOKS_CONFIG_FILENAME);
  }
  if (target.scope === 'project') {
    if (typeof target.cwd !== 'string' || target.cwd.trim() === '') {
      throw new RangeError('project target requires a non-empty cwd');
    }
    return join(
      target.cwd,
      SENPI_PROJECT_CONFIG_DIR,
      SENPI_HOOKS_CONFIG_FILENAME
    );
  }
  throw new RangeError(
    'target must be { filePath } or { scope: "global"|"project", ... }'
  );
}

/**
 * Read a hooks.json document without writing.
 *
 * Missing or empty files yield `{ ok: true, document: null }`. Invalid JSON
 * or a non-object root yields `{ ok: false }`. This function never creates
 * directories and never runs at module import.
 *
 * @param options - Explicit `{ target }` to inspect.
 * @returns Typed ok/error result; never throws on I/O or parse failure.
 */
export function readSenpiHooksConfig(
  options: ReadSenpiHooksConfigOptions
): SenpiHooksConfigReadResult {
  if (!isRecord(options) || !isRecord(options['target'])) {
    throw new RangeError(
      'readSenpiHooksConfig requires an explicit target object'
    );
  }
  const path = resolveSenpiHooksConfigPath(
    options['target'] as SenpiHooksConfigTarget
  );
  try {
    if (!existsSync(path)) {
      return { ok: true, document: null, path };
    }
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') {
      return { ok: true, document: null, path };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        error: `Malformed hooks.json at ${path}: invalid JSON`,
        path,
      };
    }
    if (!isRegistrationDocument(parsed)) {
      return {
        ok: false,
        error: `Malformed hooks.json at ${path}: invalid registration shape`,
        path,
      };
    }
    return {
      ok: true,
      document: parsed,
      path,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Failed to read hooks.json at ${path}: ${errorMessage(error)}`,
      path,
    };
  }
}

/**
 * Atomically writes a hooks.json document to an explicit target.
 *
 * CONSENT CONTRACT: calling this function IS the approval act. It must only
 * be invoked directly on behalf of an explicitly-granting user action -
 * never from runner/settings/import code paths and never at module import.
 * Cockpit product integration is observe-only and must not call this helper.
 *
 * The payload is serialized as pretty-printed JSON into a sibling temp file
 * in the destination directory, then moved onto the target path with a
 * single rename, so readers never observe a partially written document. The
 * parent directory is created if missing.
 *
 * Observe-only guarantee: this helper writes ONLY the hooks configuration
 * document given to it - it never touches hook trust state, never enables
 * gates, and never merges into settings files.
 *
 * @param options - Consent-gated options; see
 * {@link WriteSenpiHooksConfigOptions}.
 * @returns The written path.
 * @throws {SenpiHooksConsentError} When consent, reason, or target is
 * missing. Raised before any filesystem access.
 */
export async function writeSenpiHooksConfig(
  options: WriteSenpiHooksConfigOptions
): Promise<WriteSenpiHooksConfigResult> {
  const gated = requireMutationOptions(options, 'writeSenpiHooksConfig');
  if (!isRecord(options) || !isRecord(options['document'])) {
    throw new RangeError('writeSenpiHooksConfig requires a document object');
  }
  const filePath = resolveSenpiHooksConfigPath(gated.target);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(options['document'], null, 2)}\n`,
      'utf8'
    );
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path: filePath };
}

/**
 * Removes a hooks.json document from an explicit target.
 *
 * CONSENT CONTRACT: calling this function IS the unregister act. Missing
 * files are a successful no-op (`removed: false`). Parent directories are
 * left in place. No trust state is touched.
 *
 * @param options - Consent-gated options; see
 * {@link RemoveSenpiHooksConfigOptions}.
 * @returns The target path and whether a file was deleted.
 * @throws {SenpiHooksConsentError} When consent, reason, or target is
 * missing. Raised before any filesystem access.
 */
export async function removeSenpiHooksConfig(
  options: RemoveSenpiHooksConfigOptions
): Promise<RemoveSenpiHooksConfigResult> {
  const gated = requireMutationOptions(options, 'removeSenpiHooksConfig');
  const filePath = resolveSenpiHooksConfigPath(gated.target);
  if (!existsSync(filePath)) {
    return { path: filePath, removed: false };
  }
  await rm(filePath);
  return { path: filePath, removed: true };
}

function requireMutationOptions(
  options: unknown,
  verb: string
): {
  readonly consent: true;
  readonly reason: string;
  readonly target: SenpiHooksConfigTarget;
} {
  if (!isRecord(options)) {
    throw new SenpiHooksConsentError(
      `${verb} requires an explicit options object with consent and target - calling it IS the approval act`
    );
  }
  if (options['consent'] !== true) {
    throw new SenpiHooksConsentError(
      `${verb} requires explicit consent:true - calling it IS the approval act`
    );
  }
  if (
    typeof options['reason'] !== 'string' ||
    options['reason'].trim() === ''
  ) {
    throw new SenpiHooksConsentError(
      `${verb} requires a non-empty reason string recorded with the mutation`
    );
  }
  const target = options['target'];
  if (!isConfigTarget(target)) {
    throw new SenpiHooksConsentError(
      `${verb} requires an explicit target object`
    );
  }
  return {
    consent: true,
    reason: options['reason'],
    target,
  };
}

function isConfigTarget(value: unknown): value is SenpiHooksConfigTarget {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value['filePath'] === 'string' &&
    value['filePath'].trim() !== ''
  ) {
    return true;
  }
  if (
    value['scope'] === 'global' &&
    typeof value['agentHome'] === 'string' &&
    value['agentHome'].trim() !== ''
  ) {
    return true;
  }
  return (
    value['scope'] === 'project' &&
    typeof value['cwd'] === 'string' &&
    value['cwd'].trim() !== ''
  );
}

function isRegistrationDocument(
  value: unknown
): value is SenpiHooksRegistrationDocument {
  return isRecord(value) && isRecord(value['hooks']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
