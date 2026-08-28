import {
  parseJsonlOversizedPending,
  type JsonlCursor,
  type JsonlLine,
} from '../../internal/jsonl-cursor.js';
import { parseSenpiEntry, type SenpiEntryParseResult } from './parse.js';
import {
  type SenpiLeafResolution,
  type SenpiProjectionResult,
} from './projection.js';
import type {
  SenpiTailDiagnostic,
  SenpiTailDiagnosticCode,
} from './tail-types.js';

/** Parsed complete lines and commit-safety metadata for one scan. */
export interface ParsedLines {
  readonly inputs: readonly SenpiEntryParseResult[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly sessionId: string | null;
  readonly successful: boolean;
  readonly terminalMalformed: boolean;
}

const SCAN_DIAGNOSTIC_CODES: ReadonlySet<SenpiTailDiagnosticCode> = new Set([
  'oversized_line',
  'checkpoint_invalid',
]);

/** Parse newline-complete cursor output into projection inputs. */
export function parseLines(
  lines: readonly JsonlLine[],
  oversized: readonly {
    readonly lineNumber: number;
    readonly byteStart: number;
    readonly byteEnd: number;
  }[],
  priorSessionId: string | null = null
): ParsedLines {
  const inputs: SenpiEntryParseResult[] = [];
  const diagnostics: SenpiTailDiagnostic[] = oversized.map(item => ({
    code: 'oversized_line',
    message: `Line ${String(item.lineNumber)} exceeded maxLineBytes.`,
    lineNumber: item.lineNumber,
    byteStart: item.byteStart,
    byteEnd: item.byteEnd,
  }));
  let sessionId: string | null = priorSessionId;
  let successful = true;
  let lastMalformedLine = -1;

  for (const line of lines) {
    if (line.value.trim().length === 0) continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(line.value) as unknown;
    } catch {
      successful = false;
      lastMalformedLine = line.lineNumber;
      diagnostics.push({
        code: 'invalid_json',
        message: `Line ${String(line.lineNumber)} is not valid JSON.`,
        lineNumber: line.lineNumber,
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
      });
      continue;
    }
    const parsed = parseSenpiEntry(decoded);
    inputs.push(parsed);
    if (parsed.kind === 'invalid') {
      successful = false;
      lastMalformedLine = line.lineNumber;
      diagnostics.push({
        code: 'invalid_entry',
        message: parsed.error,
        lineNumber: line.lineNumber,
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
      });
    } else if (
      sessionId === null &&
      parsed.kind === 'known' &&
      parsed.entry.type === 'session'
    ) {
      sessionId = parsed.entry.id;
    }
  }

  const lastCompleteLine = Math.max(
    lines.at(-1)?.lineNumber ?? -1,
    oversized.at(-1)?.lineNumber ?? -1
  );
  if (sessionId === null) {
    successful = false;
    diagnostics.push({
      code: 'invalid_session_header',
      message: 'Session has no valid header.',
    });
  }
  return {
    inputs,
    diagnostics,
    sessionId,
    successful,
    terminalMalformed:
      lastMalformedLine >= 0 && lastMalformedLine === lastCompleteLine,
  };
}

/** True when parse/projection errors must block automatic marker commit. */
export function hasUnsafeProjectionFailure(
  diagnostics: readonly SenpiTailDiagnostic[],
  projection: SenpiProjectionResult,
  pending: JsonlCursor['pending']
): boolean {
  if (projection.kind === 'invalid' || !projection.complete) return true;
  for (const diagnostic of diagnostics) {
    if (SCAN_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
    if (
      diagnostic.code === 'invalid_session_header' &&
      (pending !== null || projection.kind === 'empty')
    ) {
      continue;
    }
    if (
      diagnostic.code === 'invalid_json' ||
      diagnostic.code === 'invalid_entry' ||
      diagnostic.code === 'invalid_session_header'
    ) {
      return true;
    }
  }
  return false;
}

/** Convert a marker or checkpoint into a validated JSONL cursor. */
export function checkpointCursor(
  checkpoint:
    | {
        readonly device: string;
        readonly inode: string;
        readonly offset: number;
        readonly lineNumber: number;
        readonly generation: number;
        readonly headDigest: string;
        readonly boundaryDigest: string;
        readonly pending?: JsonlCursor['pending'];
      }
    | null
    | undefined
): JsonlCursor | null {
  if (checkpoint === null || checkpoint === undefined) return null;
  const pending = parseJsonlOversizedPending(checkpoint.pending);
  if (pending === undefined) {
    throw new Error('Senpi session checkpoint is malformed');
  }
  return {
    device: checkpoint.device,
    inode: checkpoint.inode,
    offset: checkpoint.offset,
    lineNumber: checkpoint.lineNumber,
    generation: checkpoint.generation,
    headDigest: checkpoint.headDigest,
    boundaryDigest: checkpoint.boundaryDigest,
    pending,
  };
}

/** Convert an invalid leaf resolution into a blocked projection. */
export function invalidProjection(
  resolution: SenpiLeafResolution
): SenpiProjectionResult {
  return {
    kind: 'invalid',
    leafId: resolution.leafId,
    index: resolution.index,
    records: [],
    offPath: [],
    warnings: resolution.warnings,
    complete: false,
  };
}
