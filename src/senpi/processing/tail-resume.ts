import {
  readJsonlDelta,
  type JsonlCursor,
  type ReadJsonlDeltaOptions,
} from '../../internal/jsonl-cursor.js';
import {
  isPureAppendDelta,
  SENPI_REBUILD_MAX_PASSES,
  type SenpiAcceptedGraphEntry,
} from './accepted-graph.js';
import type { SenpiEntryParseResult } from './parse.js';
import { parseLines, type ParsedLines } from './tail-parse.js';
import type { SenpiTailDiagnostic } from './tail.js';

/** Private aggregate cursor and accounting carried across rebuild calls. */
export type SenpiRebuildProgress = {
  readonly cursor: JsonlCursor;
  readonly scannedBytes: number;
  readonly scannedLines: number;
};

/** Private per-pass and aggregate bounds for exact rebuild work. */
export type SenpiScanLimits = {
  readonly maxLineBytes?: number;
  readonly maxScanBytes: number;
  readonly maxScanLines: number;
  readonly maxRebuildBytes: number;
  readonly maxRebuildLines: number;
};

/** Complete rebuild projection or private deferred continuation state. */
export type SenpiRebuildOutcome =
  | {
      readonly kind: 'complete';
      readonly parsed: ParsedLines;
      readonly cursor: JsonlCursor;
      readonly fileSize: number;
      readonly reset: boolean;
    }
  | {
      readonly kind: 'deferred';
      readonly parsed: ParsedLines;
      readonly progress: SenpiRebuildProgress;
      readonly fileSize: number;
      readonly reset: boolean;
    };

/** Convert private Senpi limits to shared cursor options. */
export function cursorOptions(limits: SenpiScanLimits): ReadJsonlDeltaOptions {
  return {
    maxScanBytes: limits.maxScanBytes,
    maxScanLines: limits.maxScanLines,
    ...(limits.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: limits.maxLineBytes }),
  };
}

/** True when a bounded marker graph can safely seed this append pass. */
export function canUseGraphAppend(args: {
  readonly graph: readonly SenpiAcceptedGraphEntry[] | undefined;
  readonly leafId: string | null;
  readonly delta: readonly SenpiEntryParseResult[];
  readonly fileSize: number;
  readonly maxScanBytes: number;
}): boolean {
  if (args.graph === undefined) return false;
  if (args.fileSize <= args.maxScanBytes) return false;
  return isPureAppendDelta(args.graph, args.leafId, args.delta);
}

/**
 * Continue an exact byte-zero rebuild for at most four bounded scans.
 *
 * @param sessionPath - Session JSONL path.
 * @param start - Prior private rebuild cursor, or null.
 * @param prior - Aggregate parse state from earlier bounded calls.
 * @param limits - Fixed production or private test bounds.
 * @returns Complete projection state or an opaque deferred continuation.
 */
export async function rebuildFromZero(
  sessionPath: string,
  start: JsonlCursor | null,
  prior: {
    readonly inputs: readonly SenpiEntryParseResult[];
    readonly diagnostics: readonly SenpiTailDiagnostic[];
    readonly sessionId: string | null;
    readonly scannedBytes: number;
    readonly scannedLines: number;
  },
  limits: SenpiScanLimits
): Promise<SenpiRebuildOutcome> {
  const options = cursorOptions(limits);
  let cursor = start;
  let inputs = [...prior.inputs];
  let diagnostics = [...prior.diagnostics];
  let sessionId = prior.sessionId;
  let callBytes = 0;
  let callLines = 0;
  let fileSize = 0;
  let reset = false;
  let lastParsed: ParsedLines = {
    inputs: [],
    diagnostics: [],
    sessionId,
    successful: sessionId !== null,
    terminalMalformed: false,
  };

  const maxLineBytes = limits.maxLineBytes ?? 16 * 1024 * 1024;
  for (let pass = 0; pass < SENPI_REBUILD_MAX_PASSES; pass += 1) {
    const remainingBytes = limits.maxRebuildBytes - callBytes;
    const remainingLines = limits.maxRebuildLines - callLines;
    if (remainingBytes < maxLineBytes + 1 || remainingLines < 1) break;
    const delta = await readJsonlDelta(sessionPath, cursor, {
      ...options,
      maxScanBytes: Math.min(limits.maxScanBytes, remainingBytes),
      maxScanLines: Math.min(limits.maxScanLines, remainingLines),
    });
    if (delta.fileSize === null || delta.cursor === null) {
      throw new Error(`Missing required Senpi session source '${sessionPath}'`);
    }
    fileSize = delta.fileSize;
    reset = reset || delta.reset;
    cursor = delta.cursor;
    callBytes += delta.scannedBytes;
    callLines += delta.scannedLines;
    lastParsed = parseLines(delta.lines, delta.diagnostics, sessionId);
    inputs = [...inputs, ...lastParsed.inputs];
    diagnostics = [...diagnostics, ...lastParsed.diagnostics];
    sessionId = lastParsed.sessionId ?? sessionId;
    if (delta.scanStatus.status === 'complete') {
      return {
        kind: 'complete',
        parsed: {
          inputs,
          diagnostics,
          sessionId,
          successful: lastParsed.successful && sessionId !== null,
          terminalMalformed: lastParsed.terminalMalformed,
        },
        cursor,
        fileSize,
        reset,
      };
    }
  }

  if (cursor === null) {
    throw new Error(`Missing required Senpi session source '${sessionPath}'`);
  }
  return {
    kind: 'deferred',
    parsed: {
      inputs,
      diagnostics,
      sessionId,
      successful: sessionId !== null,
      terminalMalformed: lastParsed.terminalMalformed,
    },
    progress: {
      cursor,
      scannedBytes: prior.scannedBytes + callBytes,
      scannedLines: prior.scannedLines + callLines,
    },
    fileSize,
    reset,
  };
}
