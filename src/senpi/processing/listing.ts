import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { senpiSessionHeaderSchema, type SenpiUserMessage } from '../types.js';
import {
  findSenpiSessionDirs,
  getSenpiSessionsRoot,
  listSenpiSessionFiles,
} from './discovery.js';
import { parseSenpiEntry } from './parse.js';

/**
 * Options for session listing.
 *
 * When {@link agentHome} is omitted the real agent home is resolved via
 * `resolveSenpiAgentHome`; tests and multi-home consumers always inject an
 * explicit home instead.
 */
export interface SenpiListingOptions {
  readonly agentHome?: string | undefined;
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

/** Accumulated scan state for one session file (bounded, never retains entries). */
interface ScanResult {
  messageCount: number;
  firstMessage: string | null;
  lastName: string | undefined;
}

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
  return listFromDirs(dirs, projectCwd);
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
    return [];
  }

  const dirs = rootEntries
    .filter(entry => entry.isDirectory())
    .map(entry => join(getSenpiSessionsRoot(options?.agentHome), entry.name));
  return listFromDirs(dirs.sort((a, b) => a.localeCompare(b)));
}

async function listFromDirs(
  dirs: readonly string[],
  requiredCwd?: string
): Promise<SenpiSessionListing[]> {
  const files = await listSenpiSessionFiles(dirs);
  const listings = await Promise.all(
    files.map(file => readSenpiSessionFile(file, requiredCwd))
  );
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
    const headerLine = await readFirstLine(path);
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

    const scan = await scanSessionFile(path);

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

/**
 * Stream the whole session file line by line, counting `message` entries and
 * capturing the first user message text plus the latest session name.
 *
 * Deliberately O(store) time and O(1) memory per file: lines are processed as
 * streamed and no entry content is retained beyond the two scalars.
 *
 * @param path - Absolute session `.jsonl` path.
 * @throws Error naming the offending line number when any line cannot be
 *   decoded or fails entry validation - silent under-counting would be a
 *   misleading success.
 */
async function scanSessionFile(path: string): Promise<ScanResult> {
  const result: ScanResult = {
    messageCount: 0,
    firstMessage: null,
    lastName: undefined,
  };

  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        continue;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch (error: unknown) {
        throw new Error(
          `invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const parsed = parseSenpiEntry(decoded);
      if (parsed.kind === 'invalid') {
        throw new Error(`invalid entry on line ${lineNumber}: ${parsed.error}`);
      }
      if (parsed.kind === 'unknown') {
        continue;
      }

      const entry = parsed.entry;
      if (entry.type === 'message') {
        result.messageCount += 1;
        if (result.firstMessage === null && entry.message.role === 'user') {
          result.firstMessage = userMessageText(entry.message);
        }
      } else if (entry.type === 'session_info') {
        result.lastName = entry.name;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }
  return result;
}

function userMessageText(message: SenpiUserMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Stream-read the first non-empty line of a file without loading it fully.
 *
 * @param path - File to read.
 * @returns The first non-empty line, or null for an empty file.
 */
async function readFirstLine(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length > 0) {
        return line;
      }
    }
    return null;
  } finally {
    lines.close();
    stream.close();
  }
}
