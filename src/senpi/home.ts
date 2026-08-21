import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Environment variables that override agent-home detection, in precedence order.
 *
 * The first non-empty value wins. Empty and whitespace-only values are skipped.
 */
export const AGENT_DIR_ENV_NAMES = [
  'OMO_CODING_AGENT_DIR',
  'SENPI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
] as const;

/**
 * Filename that marks a directory as an agent home rather than a name collision.
 */
export const AGENT_HOME_SENTINEL = 'settings.json';

/**
 * Optional seams for {@link resolveSenpiAgentHome}.
 *
 * Omitted fields are evaluated from the live process on each call.
 */
export interface ResolveSenpiAgentHomeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly exists?: (path: string) => boolean;
}

/**
 * Resolve the senpi/OmO agent-home directory.
 *
 * Precedence is invariant:
 * 1. First non-empty value among {@link AGENT_DIR_ENV_NAMES}, resolved absolute.
 * 2. `<homeDir>/.omo/agent` when it contains {@link AGENT_HOME_SENTINEL}.
 * 3. `<homeDir>/.omo` when it contains {@link AGENT_HOME_SENTINEL}.
 * 4. `<homeDir>/.senpi/agent`.
 *
 * Seams are re-read on every call. There is no cache.
 *
 * @param options - Optional env, home directory, and exists predicate.
 * @returns Absolute agent-home path.
 */
export function resolveSenpiAgentHome(
  options?: ResolveSenpiAgentHomeOptions
): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? homedir();
  const exists = options?.exists ?? existsSync;

  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim();
    if (configured) {
      return resolve(configured);
    }
  }

  const brandedHome = join(homeDir, '.omo');
  const canonical = join(brandedHome, 'agent');
  if (exists(join(canonical, AGENT_HOME_SENTINEL))) {
    return canonical;
  }
  if (exists(join(brandedHome, AGENT_HOME_SENTINEL))) {
    return brandedHome;
  }

  return join(homeDir, '.senpi', 'agent');
}
