import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { senpiSessionHeaderSchema } from '../types.js';
import {
  findSenpiSessionDirs,
  getSenpiSessionsRoot,
  listSenpiSessionFiles,
} from './discovery.js';
import { mapConcurrentOrdered } from './concurrent-map.js';
import {
  readSenpiHeaderLine,
  scanSenpiSessionSummary,
} from './listing-scan.js';

const DEFAULT_SCAN_CONCURRENCY = 4;

/**
 * Options for session listing.
 *
 * When {@link agentHome} is omitted the real agent home is resolved via
 * `resolveSenpiAgentHome`; tests and multi-home consumers always inject an
 * explicit home instead.
 */
export interface SenpiListingOptions {
  readonly agentHome?: string | undefined;
  /**
   * Internal synchronization seam for deterministic scanner tests. Production
   * callers omit it; when supplied, it runs inside the bounded worker slot.
   * @internal
   */
  readonly beforeCandidateScan?: ((path: string) => Promise<void>) | undefined;
}

/**
 * One listed senpi session, mirroring the engine's `SessionManager.list` /
 * `listAll` summary shape minus `allMessagesText` (deliberately omitted:
 * building it costs O(store) memory). No folding or tailing happens here.
 */
export interface SenpiSessionInfo {
  /** Absolute path of the session `.jsonl` file. */
  readonly path: string;
  /** Session UUID from the validated header. */
  readonly id: string;
  /** Working directory recorded by the validated header (never decoded from
   *  the dash-encoded dirname - decoding is impossible). */
  readonly cwd: string;
  /** Display name from the latest `session_info` entry, when one exists. */
  readonly name?: string;
  /** Source session file of forked/cloned sessions, from the header. */
  readonly parentSessionPath?: string;
  /** Session creation time from the header timestamp. */
  readonly created: Date;
  /** File modification time. */
  readonly modified: Date;
  /** Total number of `message` entries across all branches. */
  readonly messageCount: number;
  /** Text of the first user message, or null when the session has none. */
  readonly firstMessage: string | null;
}

/** A session file that parsed and validated completely. */
export interface ValidSenpiSession {
  readonly kind: 'valid';
  readonly info: SenpiSessionInfo;
}

/**
 * A session file that could not be read, parsed, or validated. Failure is
 * isolated per file: one corrupt file never fails the whole listing.
 */
export interface InvalidSenpiSession {
  readonly kind: 'invalid';
  readonly path: string;
  readonly error: Error;
}

/** Result of reading one discovered session file. */
export type SenpiSessionListing = ValidSenpiSession | InvalidSenpiSession;

/**
 * List sessions of one project working directory.
 *
 * Candidates come from dash-encoded dirname matching, which may over-match
 * because the encoding is ambiguous (e.g. `/a/b` vs `/a-b`); each file's
 * header cwd is verified against `projectCwd`, and files whose header records
 * a different cwd are silently skipped as another project's sessions. Files
 * that fail to parse or validate surface as `invalid` entries without
 * affecting valid siblings.
 *
 * @param projectCwd - Working directory whose sessions should be listed.
 * @param options - Optional injected agent home.
 * @returns Valid and invalid results, ordered by session path.
 */
export async function listSenpiSessions(
  projectCwd: string,
  options?: SenpiListingOptions
): Promise<SenpiSessionListing[]> {
  const dirs = await findSenpiSessionDirs(projectCwd, options?.agentHome);
  return listFromDirs(dirs, projectCwd, options?.beforeCandidateScan);
}

/**
 * List every session across all projects in an agent home.
 *
 * Same shape as {@link listSenpiSessions} but without any header-cwd filter.
 *
 * @param options - Optional injected agent home.
 * @returns Valid and invalid results, ordered by session path.
 */
export async function listAllSenpiSessions(
  options?: SenpiListingOptions
): Promise<SenpiSessionListing[]> {
  let rootEntries;
  try {
    rootEntries = await readdir(getSenpiSessionsRoot(options?.agentHome), {
      withFileTypes: true,
    });
  } catch {
    // Missing or unreadable sessions root (ENOENT/EACCES/etc.) yields [];
    // conflation is deliberate and matches the empty-on-missing-root design.
    return [];
  }

  const dirs = rootEntries
    .filter(entry => entry.isDirectory())
    .map(entry => join(getSenpiSessionsRoot(options?.agentHome), entry.name));
  return listFromDirs(
    dirs.sort((a, b) => a.localeCompare(b)),
    undefined,
    options?.beforeCandidateScan
  );
}

async function listFromDirs(
  dirs: readonly string[],
  requiredCwd?: string,
  beforeCandidateScan?: (path: string) => Promise<void>
): Promise<SenpiSessionListing[]> {
  const files = await listSenpiSessionFiles(dirs);
  const listings = await mapConcurrentOrdered(files, {
    concurrency: DEFAULT_SCAN_CONCURRENCY,
    map: async file => {
      await beforeCandidateScan?.(file);
      return readSenpiSessionFile(file, requiredCwd);
    },
  });
  return listings.filter(
    (listing): listing is SenpiSessionListing => listing !== null
  );
}

/**
 * Read one session file into a listing result.
 *
 * @param path - Absolute session `.jsonl` path.
 * @param requiredCwd - When set, a file whose header cwd differs yields null
 *   (it belongs to another project sharing the ambiguous encoded dirname).
 * @returns The listing result, or null when the file belongs to another cwd.
 */
async function readSenpiSessionFile(
  path: string,
  requiredCwd?: string
): Promise<SenpiSessionListing | null> {
  try {
    const headerLine = await readSenpiHeaderLine(path);
    if (headerLine === null) {
      throw new Error('session file has no header line');
    }

    let decodedHeader: unknown;
    try {
      decodedHeader = JSON.parse(headerLine);
    } catch (error: unknown) {
      throw new Error(
        `invalid header JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const headerResult = senpiSessionHeaderSchema.safeParse(decodedHeader);
    if (!headerResult.success) {
      throw new Error(`invalid session header: ${headerResult.error.message}`);
    }
    const header = headerResult.data;

    if (requiredCwd !== undefined && header.cwd !== requiredCwd) {
      return null;
    }

    const scan = await scanSenpiSessionSummary(path);

    const fileStat = await stat(path);
    const parsedCreated = new Date(header.timestamp);
    const created = Number.isNaN(parsedCreated.getTime())
      ? fileStat.birthtime
      : parsedCreated;

    const info: SenpiSessionInfo = {
      path,
      id: header.id,
      cwd: header.cwd,
      created,
      modified: fileStat.mtime,
      messageCount: scan.messageCount,
      firstMessage: scan.firstMessage,
      ...(scan.lastName !== undefined ? { name: scan.lastName } : {}),
      ...(header.parentSession !== undefined
        ? { parentSessionPath: header.parentSession }
        : {}),
    };
    return { kind: 'valid', info };
  } catch (error: unknown) {
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
