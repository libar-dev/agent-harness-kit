import type { FileHandle } from 'node:fs/promises';

import type {
  JsonlLine,
  JsonlOversizedDiagnostic,
  JsonlOversizedPending,
} from './jsonl-cursor-types.js';

const SCAN_CHUNK_BYTES = 64 * 1024;

/** Resolved positive limits used by the byte scanner. */
export interface JsonlScanLimits {
  readonly maxLineBytes: number;
  readonly maxScanBytes: number;
  readonly maxScanLines: number;
}

/** Inputs for one bounded complete-line scan. */
export interface JsonlScanRequest {
  readonly file: FileHandle;
  readonly startOffset: number;
  readonly startLineNumber: number;
  readonly snapshotSize: number;
  readonly pending: JsonlOversizedPending | null;
  readonly limits: JsonlScanLimits;
}

/** Internal scan result consumed by the cursor identity layer. */
export interface JsonlScanResult {
  readonly lines: readonly JsonlLine[];
  readonly diagnostics: readonly JsonlOversizedDiagnostic[];
  readonly offset: number;
  readonly lineNumber: number;
  readonly pending: JsonlOversizedPending | null;
  readonly scannedBytes: number;
  readonly scannedLines: number;
  readonly limitReason: 'bytes' | 'lines' | null;
}

/**
 * Scan a snapshotted range while buffering at most one bounded line.
 *
 * Invariant: committed offsets advance only past newline terminators.
 * Oversized content is discarded incrementally and diagnosed once its newline
 * arrives. A new line starts only when enough budget remains to classify it.
 *
 * @param request - Open handle, cursor position, snapshot, pending, and limits.
 * @returns Complete lines, diagnostics, accounting, and continuation state.
 */
export async function scanJsonlCompleteLines(
  request: JsonlScanRequest
): Promise<JsonlScanResult> {
  const { file, startOffset, startLineNumber, snapshotSize, limits } = request;
  const lines: JsonlLine[] = [];
  const diagnostics: JsonlOversizedDiagnostic[] = [];
  const readBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let consumeEnd = startOffset;
  let committedOffset = startOffset;
  let lineStart = request.pending?.byteStart ?? startOffset;
  let lineNumber = startLineNumber;
  let lineByteLength = 0;
  let lineChunks: Buffer[] = [];
  let discarding = request.pending !== null;
  let midLine = discarding;
  let scannedLines = 0;
  let limitReason: 'bytes' | 'lines' | null = null;

  const remaining = (): number =>
    limits.maxScanBytes - (consumeEnd - startOffset);
  const beginLimit = (): 'bytes' | 'lines' | null => {
    if (consumeEnd >= snapshotSize) return null;
    if (scannedLines >= limits.maxScanLines) return 'lines';
    if (remaining() < limits.maxLineBytes + 1) return 'bytes';
    return null;
  };

  if (!midLine) {
    const reason = beginLimit();
    if (reason !== null) {
      return emptyLimitedResult(committedOffset, lineNumber, reason);
    }
  }

  while (consumeEnd < snapshotSize && remaining() > 0) {
    const requestedBytes = Math.min(
      readBuffer.byteLength,
      snapshotSize - consumeEnd,
      remaining()
    );
    const { bytesRead } = await file.read(
      readBuffer,
      0,
      requestedBytes,
      consumeEnd
    );
    if (bytesRead === 0) break;

    let chunkOffset = 0;
    let stop = false;
    while (chunkOffset < bytesRead) {
      const newlineIndex = readBuffer.indexOf(0x0a, chunkOffset);
      const hasNewline = newlineIndex >= 0 && newlineIndex < bytesRead;
      const segmentEnd = hasNewline ? newlineIndex : bytesRead;
      const segmentLength = segmentEnd - chunkOffset;

      if (!discarding) {
        if (lineByteLength + segmentLength > limits.maxLineBytes) {
          discarding = true;
          lineChunks = [];
        } else if (segmentLength > 0) {
          lineChunks.push(
            Buffer.from(
              readBuffer.subarray(chunkOffset, chunkOffset + segmentLength)
            )
          );
        }
      }
      lineByteLength += segmentLength;
      consumeEnd += segmentLength;
      midLine = true;
      if (!hasNewline) break;

      consumeEnd += 1;
      const byteEnd = consumeEnd;
      if (discarding) {
        diagnostics.push({
          kind: 'oversized',
          lineNumber,
          byteStart: lineStart,
          byteEnd,
        });
      } else {
        lines.push({
          value: Buffer.concat(lineChunks, lineByteLength).toString('utf8'),
          lineNumber,
          byteStart: lineStart,
          byteEnd,
        });
      }

      committedOffset = byteEnd;
      lineStart = byteEnd;
      lineNumber += 1;
      lineByteLength = 0;
      lineChunks = [];
      discarding = false;
      midLine = false;
      scannedLines += 1;
      chunkOffset = newlineIndex + 1;
      const reason = beginLimit();
      if (reason !== null) {
        limitReason = reason;
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  if (midLine && consumeEnd < snapshotSize && remaining() <= 0) {
    limitReason = 'bytes';
  }
  const pending: JsonlOversizedPending | null =
    midLine && discarding
      ? { kind: 'discarding_oversized', byteStart: lineStart }
      : null;
  return {
    lines,
    diagnostics,
    offset: pending === null ? committedOffset : consumeEnd,
    lineNumber,
    pending,
    scannedBytes: consumeEnd - startOffset,
    scannedLines,
    limitReason,
  };
}

function emptyLimitedResult(
  offset: number,
  lineNumber: number,
  reason: 'bytes' | 'lines'
): JsonlScanResult {
  return {
    lines: [],
    diagnostics: [],
    offset,
    lineNumber,
    pending: null,
    scannedBytes: 0,
    scannedLines: 0,
    limitReason: reason,
  };
}
