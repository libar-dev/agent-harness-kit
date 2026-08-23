import { join } from 'node:path';

import {
  readDiscoveryDirectory,
  sortDiscoveredPaths,
} from '../../processing/discovery-primitives.js';
import { resolveSenpiAgentHome } from '../home.js';

/**
 * Suffix the engine appends to per-session artifact directories (e.g.
 * `<timestamp>_<uuid>-artifacts/`). Artifact directories never contain
 * session files and are excluded from discovery.
 */
const SENPI_ARTIFACTS_SUFFIX = '-artifacts';

/**
 * Name of the per-project extensions directory stored inside a per-cwd
 * session directory. It holds extension state, never session files.
 */
const SENPI_EXTENSIONS_DIRNAME = 'extensions';

/**
 * File suffix of persisted sessions inside a per-cwd session directory.
 */
export const SENPI_SESSION_FILE_SUFFIX = '.jsonl';

/**
 * Resolve the sessions root of an agent home: `<agentHome>/sessions`.
 *
 * @param agentHome - Explicit agent home; when omitted the home is resolved
 *   with {@link resolveSenpiAgentHome} (env overrides, sentinel detection,
 *   then fallbacks).
 * @returns Absolute sessions-root path.
 */
export function getSenpiSessionsRoot(agentHome?: string | undefined): string {
  return join(agentHome ?? resolveSenpiAgentHome(), 'sessions');
}

/**
 * Encode a working directory as the engine's per-project session-directory
 * name: leading and trailing `/` separators are dropped, every remaining
 * `/` is replaced by `-`, and the result is wrapped in `--...--`
 * (e.g. `/home/me/proj` becomes `--home-me-proj--`). This matches real
 * on-disk stores, where cwd `/Users/me` yields `--Users-me--`, not a
 * triple-dash.
 *
 * Encoding ambiguity invariant: a literal `-` inside a cwd is encoded to the
 * same character as a `/`, so distinct cwds can share one dirname (e.g.
 * `/a/b` and `/a-b` both become `--a-b--`). Decoding is therefore IMPOSSIBLE
 * and is never attempted anywhere in this adapter; ambiguity is resolved
 * exclusively by verifying the session header's `cwd` field during listing
 * (see `listSenpiSessions`). Candidate generation may accordingly over-match.
 *
 * @param cwd - Original working directory path.
 * @returns The engine's encoded per-cwd directory name.
 */
export function encodeSenpiCwdDirname(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, '');
  return `--${trimmed.replaceAll('/', '-')}--`;
}

/**
 * Find per-cwd session-directory candidates for a working directory under
 * `<agentHome>/sessions/`.
 *
 * Candidate generation matches the encoded dirname only and may therefore
 * over-match: because {@link encodeSenpiCwdDirname} is ambiguous, the matched
 * directory can also contain sessions belonging to a different cwd. This is
 * accepted by design - listing verifies each file's header cwd, which is the
 * sole source of truth. A missing sessions root yields an empty result.
 *
 * @param projectCwd - Working directory whose sessions should be found.
 * @param agentHome - Explicit agent home override (never falls back to the
 *   real user home unless omitted by the caller).
 * @returns Deterministically ordered absolute candidate directory paths.
 */
export async function findSenpiSessionDirs(
  projectCwd: string,
  agentHome?: string | undefined
): Promise<string[]> {
  const sessionsRoot = getSenpiSessionsRoot(agentHome);
  const encoded = encodeSenpiCwdDirname(projectCwd);

  const entries = await readDiscoveryDirectory(sessionsRoot);

  const matches = entries
    .filter(entry => entry.isDirectory() && entry.name === encoded)
    .map(entry => join(sessionsRoot, entry.name));
  return sortDiscoveredPaths(matches);
}

/**
 * Enumerate candidate session `.jsonl` files inside per-cwd session
 * directories.
 *
 * Subdirectory exclusions: `*-artifacts/` directories and the per-cwd
 * `extensions/` directory are skipped; they never contain session files.
 * Non-`.jsonl` files are ignored.
 *
 * @param sessionDirs - Per-cwd session directories to scan.
 * @returns Deterministically ordered absolute session-file paths.
 */
export async function listSenpiSessionFiles(
  sessionDirs: readonly string[]
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of sessionDirs) {
    const entries = await readDiscoveryDirectory(dir);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Always skip directories. Named engine-owned exclusions never hold
        // session files; every other directory is equally irrelevant here.
        if (
          entry.name.endsWith(SENPI_ARTIFACTS_SUFFIX) ||
          entry.name === SENPI_EXTENSIONS_DIRNAME
        ) {
          continue;
        }
        continue;
      }
      if (entry.name.endsWith(SENPI_SESSION_FILE_SUFFIX)) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return sortDiscoveredPaths(files);
}
