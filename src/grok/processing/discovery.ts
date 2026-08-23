import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { blake3 } from '@noble/hashes/blake3.js';
import { z } from 'zod';

import {
  readDiscoveryDirectory,
  sortDiscoveredPaths,
} from '../../processing/discovery-primitives.js';

const MAX_DIRNAME_BYTES = 255;
const LONG_CWD_SLUG_LENGTH = 40;

/** Grok's persisted session summary fields used during discovery. */
export const grokSummarySchema = z.looseObject({
  info: z.looseObject({}),
  session_summary: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  num_messages: z.number().int().nonnegative(),
  current_model_id: z.string(),
});

/** A validated Grok session summary. */
export type GrokSummary = z.infer<typeof grokSummarySchema>;

/** A Grok session whose summary passed validation. */
export interface ValidGrokSession {
  readonly kind: 'valid';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly summary: GrokSummary;
}

/** A Grok session whose summary could not be read, parsed, or validated. */
export interface InvalidGrokSession {
  readonly kind: 'invalid';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly error: Error;
}

/** The result of reading one discovered Grok session. */
export type GrokSession = ValidGrokSession | InvalidGrokSession;

const grokSummaryJsonSchema = z
  .string()
  .transform((raw, context): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      context.addIssue({
        code: 'custom',
        message: `Invalid summary.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      return z.NEVER;
    }
  })
  .pipe(grokSummarySchema);

/**
 * Resolve the Grok data directory from an environment object.
 *
 * The supplied object is evaluated on each call so callers can isolate
 * discovery from process-wide environment state.
 *
 * @param env - Environment containing an optional `GROK_HOME` override.
 * @returns The configured Grok home or `~/.grok`.
 */
export function getGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['GROK_HOME'] ?? join(homedir(), '.grok');
}

/**
 * Encode a working directory as Grok's filesystem directory component.
 *
 * URL-encoded names up to 255 bytes are retained. Longer names use the
 * basename slug and the first 16 hexadecimal characters of BLAKE3(cwd).
 *
 * @param cwd - Original working directory.
 * @returns Grok's encoded CWD directory name.
 */
export function encodeGrokCwdDirname(cwd: string): string {
  const encoded = encodeURIComponent(cwd).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  if (Buffer.byteLength(encoded) <= MAX_DIRNAME_BYTES) {
    return encoded;
  }

  const leaf = basename(cwd) || 'workspace';
  const slug = slugify(leaf, LONG_CWD_SLUG_LENGTH) || 'workspace';
  const hash16 = Buffer.from(blake3(new TextEncoder().encode(cwd)))
    .toString('hex')
    .slice(0, 16);
  return `${slug}-${hash16}`;
}

/**
 * Find persisted Grok session directories for a working directory.
 *
 * Hashed CWD directories are matched through their plain-text `.cwd` file.
 * Directories without `summary.json` are not resumable sessions and are
 * excluded.
 *
 * @param cwd - Working directory recorded by Grok.
 * @param env - Environment containing an optional `GROK_HOME` override.
 * @returns Deterministically ordered absolute session directory paths.
 */
export async function findGrokSessionDirs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const sessionsRoot = join(getGrokHome(env), 'sessions');
  const encodedCwd = encodeGrokCwdDirname(cwd);

  const cwdEntries = await readDiscoveryDirectory(sessionsRoot);

  const matchingCwdDirs: string[] = [];
  for (const entry of cwdEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const cwdDir = join(sessionsRoot, entry.name);
    if (entry.name === encodedCwd || (await cwdMetadataMatches(cwdDir, cwd))) {
      matchingCwdDirs.push(cwdDir);
    }
  }

  const sessionDirs: string[] = [];
  for (const cwdDir of matchingCwdDirs) {
    const entries = await readDiscoveryDirectory(cwdDir);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = join(cwdDir, entry.name);
        if (await fileExists(join(sessionDir, 'summary.json'))) {
          sessionDirs.push(sessionDir);
        }
      }
    }
  }

  return sortDiscoveredPaths(sessionDirs);
}

/**
 * List Grok sessions and validate each persisted `summary.json` independently.
 *
 * A malformed summary produces an `invalid` result for that session without
 * suppressing valid siblings.
 *
 * @param cwd - Working directory recorded by Grok.
 * @param env - Environment containing an optional `GROK_HOME` override.
 * @returns Valid and invalid session results in session-directory order.
 */
export async function listGrokSessions(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GrokSession[]> {
  const sessionDirs = await findGrokSessionDirs(cwd, env);
  return Promise.all(sessionDirs.map(readGrokSession));
}

function slugify(input: string, maxLength: number): string {
  let result = '';
  let previousWasDash = false;

  for (const character of input.toLowerCase()) {
    if (/^[a-z0-9]$/.test(character)) {
      result += character;
      previousWasDash = false;
    } else if (!previousWasDash) {
      result += '-';
      previousWasDash = true;
    }
  }

  return result.replace(/^-+|-+$/g, '').slice(0, maxLength);
}

async function cwdMetadataMatches(
  cwdDirectory: string,
  cwd: string
): Promise<boolean> {
  try {
    const storedCwd = await readFile(join(cwdDirectory, '.cwd'), 'utf8');
    return storedCwd.trim() === cwd;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readGrokSession(sessionDir: string): Promise<GrokSession> {
  const sessionId = basename(sessionDir);
  try {
    const summaryJson = await readFile(
      join(sessionDir, 'summary.json'),
      'utf8'
    );
    const summary = grokSummaryJsonSchema.parse(summaryJson);
    return { kind: 'valid', sessionId, sessionDir, summary };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { kind: 'invalid', sessionId, sessionDir, error };
    }
    return {
      kind: 'invalid',
      sessionId,
      sessionDir,
      error: new Error(String(error)),
    };
  }
}
