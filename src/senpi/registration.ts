import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type SenpiHookEventName } from './settings.js';

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
 * Atomically writes a hooks.json document to disk.
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
 * @param filePath - Destination path for the hooks.json document.
 * @param document - Document produced by `buildSenpiHooksRegistration`.
 * @throws {Error} When directory creation, temp write, or rename fails; any
 * leftover temp file is removed before the error propagates.
 */
export async function writeSenpiHooksConfig(
  filePath: string,
  document: SenpiHooksRegistrationDocument
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
