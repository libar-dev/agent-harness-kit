import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import {
  scanJsonlCompleteLines,
  type JsonlScanLimits,
} from './jsonl-cursor-scan.js';
import type {
  JsonlCursor,
  JsonlDelta,
  JsonlScanStatus,
  ReadJsonlDeltaOptions,
} from './jsonl-cursor-types.js';

/** Shared cursor value, result, option, line, diagnostic, and pending contracts. */
export {
  parseJsonlOversizedPending,
  type JsonlCursor,
  type JsonlDelta,
  type JsonlLine,
  type JsonlOversizedDiagnostic,
  type JsonlOversizedPending,
  type JsonlScanStatus,
  type ReadJsonlDeltaOptions,
} from './jsonl-cursor-types.js';

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SCAN_LINES = 10_000;
const DIGEST_WINDOW_BYTES = 4096;

/**
 * Read complete JSONL lines added after a cursor position.
 *
 * Reads stop at the opened handle's size snapshot. Complete lines and
 * oversized discards are bounded by byte and line caps; unterminated tails
 * remain uncommitted. Identity and bounded prefix digests invalidate stale
 * cursors without reading the entire file.
 *
 * @param path - JSONL file path.
 * @param cursor - Prior serializable cursor, or null for a full scan.
 * @param options - Per-scan line and pass-size limits.
 * @returns Complete lines, diagnostics, accounting, and the next cursor.
 * @throws If the file cannot be read, except when the path is missing.
 * @throws If limits are not positive safe integers or the byte relationship is invalid.
 */
export async function readJsonlDelta(
  path: string,
  cursor: JsonlCursor | null,
  options: ReadJsonlDeltaOptions = {}
): Promise<JsonlDelta> {
  const limits = resolveScanLimits(options);
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return missingDelta(cursor);
    throw error;
  }

  try {
    const stats = await file.stat();
    const fileSize = stats.size;
    const device = String(stats.dev);
    const inode = String(stats.ino);
    const reset = await shouldResetCursor(
      file,
      fileSize,
      device,
      inode,
      cursor
    );
    const scan = await scanJsonlCompleteLines({
      file,
      startOffset: reset ? 0 : (cursor?.offset ?? 0),
      startLineNumber: reset ? 1 : (cursor?.lineNumber ?? 1),
      snapshotSize: fileSize,
      pending: reset ? null : (cursor?.pending ?? null),
      limits,
    });
    const digests = await digestCommittedBoundary(file, scan.offset);
    const scanStatus: JsonlScanStatus =
      scan.limitReason === null
        ? { status: 'complete' }
        : { status: 'limited', reason: scan.limitReason };
    return {
      lines: scan.lines,
      diagnostics: scan.diagnostics,
      cursor: {
        device,
        inode,
        offset: scan.offset,
        lineNumber: scan.lineNumber,
        generation: (cursor?.generation ?? 0) + (reset ? 1 : 0),
        headDigest: digests.headDigest,
        boundaryDigest: digests.boundaryDigest,
        pending: scan.pending,
      },
      fileSize,
      reset,
      scanStatus,
      scannedBytes: scan.scannedBytes,
      scannedLines: scan.scannedLines,
    };
  } finally {
    await file.close();
  }
}

/**
 * Validate one cursor identity without consuming JSONL content.
 *
 * @param path - JSONL path to validate.
 * @param cursor - Existing cursor identity and committed boundary.
 * @returns True when the cursor must be discarded.
 */
export async function jsonlCursorNeedsReset(
  path: string,
  cursor: JsonlCursor
): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return true;
    throw error;
  }
  try {
    const stats = await file.stat();
    return shouldResetCursor(
      file,
      stats.size,
      String(stats.dev),
      String(stats.ino),
      cursor
    );
  } finally {
    await file.close();
  }
}

function resolveScanLimits(options: ReadJsonlDeltaOptions): JsonlScanLimits {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  assertPositiveLimit(maxLineBytes, 'maxLineBytes');
  assertPositiveLimit(maxScanBytes, 'maxScanBytes');
  assertPositiveLimit(maxScanLines, 'maxScanLines');
  if (maxScanBytes < maxLineBytes + 1) {
    throw new RangeError('maxScanBytes must be >= maxLineBytes + 1');
  }
  return { maxLineBytes, maxScanBytes, maxScanLines };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

async function shouldResetCursor(
  file: FileHandle,
  fileSize: number,
  device: string,
  inode: string,
  cursor: JsonlCursor | null
): Promise<boolean> {
  if (cursor === null) return false;
  if (cursor.device !== device || cursor.inode !== inode) return true;
  if (fileSize < cursor.offset) return true;
  const digests = await digestCommittedBoundary(file, cursor.offset);
  return (
    digests.headDigest !== cursor.headDigest ||
    digests.boundaryDigest !== cursor.boundaryDigest
  );
}

async function digestCommittedBoundary(
  file: FileHandle,
  offset: number
): Promise<{ readonly headDigest: string; readonly boundaryDigest: string }> {
  const headLength = Math.min(offset, DIGEST_WINDOW_BYTES);
  const boundaryStart = Math.max(0, offset - DIGEST_WINDOW_BYTES);
  const [head, boundary] = await Promise.all([
    readRange(file, 0, headLength),
    readRange(file, boundaryStart, offset - boundaryStart),
  ]);
  return {
    headDigest: createHash('sha256').update(head).digest('hex'),
    boundaryDigest: createHash('sha256').update(boundary).digest('hex'),
  };
}

async function readRange(
  file: FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await file.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead
    );
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return buffer.subarray(0, totalRead);
}

function missingDelta(cursor: JsonlCursor | null): JsonlDelta {
  return {
    lines: [],
    diagnostics: [],
    cursor,
    fileSize: null,
    reset: false,
    scanStatus: { status: 'complete' },
    scannedBytes: 0,
    scannedLines: 0,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
