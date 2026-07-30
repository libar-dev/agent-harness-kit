/**
 * JSONL session file parser.
 *
 * Handles both the main session file and subagent logs:
 *   <session-id>.jsonl              — main session
 *   <session-id>/subagents/agent-*.jsonl — subagent logs
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { TranscriptParseDiagnosticsSchema } from '../validation/schemas.js';
import { safeValidateRawHistoryLine } from '../validation/validators.js';
import type { RawHistoryLine } from './types.js';

export interface JsonlParseDiagnostic {
  readonly kind: 'invalid_json' | 'invalid_shape';
  readonly lineNumber: number;
  readonly rawLine: string;
  readonly message: string;
  readonly validation?: TranscriptParseDiagnosticsSchema;
}

interface ParseJsonlContentOptions {
  readonly defaultSessionId?: string;
}

/** Result of parsing all files for one session */
export interface RawSession {
  readonly sessionId: string;
  readonly mainLines: readonly RawHistoryLine[];
  readonly subagentFiles: readonly {
    readonly filename: string;
    readonly lines: readonly RawHistoryLine[];
  }[];
}

/**
 * Parse a single JSONL file into an array of history lines.
 * Skips malformed lines instead of throwing.
 */
export function parseJsonlContent(
  content: string,
  diagnostics?: JsonlParseDiagnostic[],
  options: ParseJsonlContentOptions = {}
): RawHistoryLine[] {
  const lines: RawHistoryLine[] = [];

  for (const [index, raw] of content.split('\n').entries()) {
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    try {
      const parsedJson: unknown = JSON.parse(trimmed);
      const parsed = withDefaultSessionId(parsedJson, options.defaultSessionId);
      const result = safeValidateRawHistoryLine(parsed);
      if (result.success) {
        lines.push(result.data);
        continue;
      }

      diagnostics?.push({
        kind: 'invalid_shape',
        lineNumber,
        rawLine: raw,
        message: result.diagnostics.summary,
        validation: result.diagnostics,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Invalid JSONL line';

      diagnostics?.push({
        kind: 'invalid_json',
        lineNumber,
        rawLine: raw,
        message,
      });

      // Malformed line — skip
    }
  }

  return lines;
}

/**
 * Backfill a missing `sessionId` on a raw, not-yet-validated parsed line.
 *
 * Sibling of `withDefaultSessionId` in tail.ts. They are intentionally NOT
 * merged: this one accepts raw `unknown` and guards via `'sessionId' in parsed`
 * (and a nullable `defaultSessionId`), whereas the tail variant takes a typed,
 * validated payload and guards on `payload.sessionId !== undefined`. Their
 * backfill behavior is equivalent and pinned by
 * tests/processing-core-hardening.test.ts so they cannot silently drift.
 */
function withDefaultSessionId(
  parsed: unknown,
  defaultSessionId: string | undefined
): unknown {
  if (
    defaultSessionId === undefined ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    'sessionId' in parsed
  ) {
    return parsed;
  }

  return { ...parsed, sessionId: defaultSessionId };
}

/**
 * Read and parse a session's JSONL files from disk.
 *
 * @param projectDir - The Claude projects directory
 *   (e.g., ~/.claude/projects/-Users-darkomijic-dev-projects-foo)
 * @param sessionId - The session UUID
 */
export async function readSessionFiles(
  projectDir: string,
  sessionId: string
): Promise<RawSession> {
  // Read main session file
  const mainPath = join(projectDir, `${sessionId}.jsonl`);
  const mainContent = await readFile(mainPath, 'utf-8');
  const mainLines = parseJsonlContent(mainContent, undefined, {
    defaultSessionId: sessionId,
  });

  // Read subagent files if the folder exists
  const subagentDir = join(projectDir, sessionId, 'subagents');
  const subagentFiles: { filename: string; lines: RawHistoryLine[] }[] = [];

  try {
    const entries = await readdir(subagentDir);
    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl')).sort();

    for (const filename of jsonlFiles) {
      const content = await readFile(join(subagentDir, filename), 'utf-8');
      subagentFiles.push({
        filename: basename(filename, '.jsonl'),
        lines: parseJsonlContent(content, undefined, {
          defaultSessionId: sessionId,
        }),
      });
    }
  } catch {
    // No subagents directory — that's fine
  }

  return { sessionId, mainLines, subagentFiles };
}

/**
 * Parse JSONL content directly (for use without filesystem access).
 * Useful when you already have the content in memory (e.g., from a hook).
 */
export function parseSessionContent(
  sessionId: string,
  mainContent: string,
  subagentContents?: readonly { filename: string; content: string }[]
): RawSession {
  const mainLines = parseJsonlContent(mainContent, undefined, {
    defaultSessionId: sessionId,
  });

  const subagentFiles = (subagentContents ?? []).map(
    ({ filename, content }) => ({
      filename,
      lines: parseJsonlContent(content, undefined, {
        defaultSessionId: sessionId,
      }),
    })
  );

  return { sessionId, mainLines, subagentFiles };
}
