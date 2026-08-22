import type { SenpiUserMessage } from '../types.js';
import { readBoundedLines } from './bounded-lines.js';
import { parseSenpiEntry } from './parse.js';

/**
 * Header ceiling: 64 KiB, over 380x the largest real/synthetic fixture header
 * (172 bytes) while keeping attacker-controlled discovery reads small.
 */
export const SENPI_LISTING_HEADER_MAX_BYTES = 64 * 1024;

/**
 * Record ceiling shared with the established JSONL cursor contract: 16 MiB,
 * over 240x the largest real fixture record (67,880 bytes).
 */
export const SENPI_LISTING_RECORD_MAX_BYTES = 16 * 1024 * 1024;

/** Machine-readable reason a session listing stopped its bounded scan. */
export type SenpiListingDiagnosticCode =
  | 'header-line-too-large'
  | 'record-line-too-large';

interface SenpiListingDiagnostic {
  readonly code: SenpiListingDiagnosticCode;
  readonly lineNumber: number;
  readonly maxLineBytes: number;
}

/** Typed per-file diagnostic for a line that exceeded a listing byte limit. */
export class SenpiListingDiagnosticError extends Error {
  readonly code: SenpiListingDiagnosticCode;
  readonly lineNumber: number;
  readonly maxLineBytes: number;

  constructor(diagnostic: SenpiListingDiagnostic) {
    super(
      `${diagnostic.code} on line ${diagnostic.lineNumber}: exceeds ${diagnostic.maxLineBytes} bytes`
    );
    this.name = 'SenpiListingDiagnosticError';
    this.code = diagnostic.code;
    this.lineNumber = diagnostic.lineNumber;
    this.maxLineBytes = diagnostic.maxLineBytes;
  }
}

/** Accumulated scan state for one session file (bounded, never retains entries). */
export interface SenpiSessionSummary {
  readonly messageCount: number;
  readonly firstMessage: string | null;
  readonly lastName: string | undefined;
}

/** Mutable accumulator used only while one summary is being streamed. */
interface SummaryAccumulator {
  messageCount: number;
  firstMessage: string | null;
  lastName: string | undefined;
}

/** Stream-read the first non-empty line under the listing header ceiling. */
export async function readSenpiHeaderLine(
  path: string
): Promise<string | null> {
  for await (const line of readBoundedLines(
    path,
    SENPI_LISTING_HEADER_MAX_BYTES
  )) {
    if (line.kind === 'oversized') {
      throw new SenpiListingDiagnosticError({
        code: 'header-line-too-large',
        lineNumber: line.lineNumber,
        maxLineBytes: SENPI_LISTING_HEADER_MAX_BYTES,
      });
    }
    if (line.value.trim().length > 0) return line.value;
  }
  return null;
}

/** Stream a session summary without retaining parsed entries. */
export async function scanSenpiSessionSummary(
  path: string
): Promise<SenpiSessionSummary> {
  const result: SummaryAccumulator = {
    messageCount: 0,
    firstMessage: null,
    lastName: undefined,
  };

  for await (const line of readBoundedLines(
    path,
    SENPI_LISTING_RECORD_MAX_BYTES
  )) {
    if (line.kind === 'oversized') {
      throw new SenpiListingDiagnosticError({
        code: 'record-line-too-large',
        lineNumber: line.lineNumber,
        maxLineBytes: SENPI_LISTING_RECORD_MAX_BYTES,
      });
    }
    if (line.value.trim().length === 0) continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(line.value);
    } catch (error: unknown) {
      throw new Error(
        `invalid JSON on line ${line.lineNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const parsed = parseSenpiEntry(decoded);
    if (parsed.kind === 'invalid') {
      throw new Error(
        `invalid entry on line ${line.lineNumber}: ${parsed.error}`
      );
    }
    if (parsed.kind === 'unknown') continue;

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
  return result;
}

function userMessageText(message: SenpiUserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}
