import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 64 * 1024;
const DIGEST_WINDOW_BYTES = 4096;

/**
 * Serializable position and file identity for incremental JSONL reads.
 *
 * The cursor is a plain value object so it survives JSON round-trips across
 * process boundaries; identity fields are decimal strings, never numbers.
 */
export interface JsonlCursor {
  /** Device identifier from the opened file. */
  readonly device: string;
  /** Inode identifier from the opened file. */
  readonly inode: string;
  /** Byte offset of the next uncommitted line. */
  readonly offset: number;
  /** One-based number of the next uncommitted line. */
  readonly lineNumber: number;
  /** Number of file identity or content resets observed by this cursor. */
  readonly generation: number;
  /** SHA-256 digest of the committed prefix's leading window. */
  readonly headDigest: string;
  /** SHA-256 digest of the committed prefix's trailing boundary window. */
  readonly boundaryDigest: string;
}

/** One complete newline-terminated JSONL line. */
export interface JsonlLine {
  /** UTF-8 decoded line content without its terminating newline. */
  readonly value: string;
  /** One-based physical line number. */
  readonly lineNumber: number;
  /** Inclusive byte offset at which the line begins. */
  readonly byteStart: number;
  /** Exclusive byte offset after the terminating newline. */
  readonly byteEnd: number;
}

/** Diagnostic emitted for a complete line that exceeded the configured limit. */
export interface JsonlOversizedDiagnostic {
  /** Diagnostic discriminator. */
  readonly kind: 'oversized';
  /** One-based physical line number. */
  readonly lineNumber: number;
  /** Inclusive byte offset at which the discarded line begins. */
  readonly byteStart: number;
  /** Exclusive byte offset after the terminating newline. */
  readonly byteEnd: number;
}

/** Result of one size-snapshotted JSONL scan. */
export interface JsonlDelta {
  /** Complete lines committed by this scan. */
  readonly lines: readonly JsonlLine[];
  /** Complete lines discarded by this scan. */
  readonly diagnostics: readonly JsonlOversizedDiagnostic[];
  /** Position to use for the next scan, or null when no file has been seen. */
  readonly cursor: JsonlCursor | null;
  /** Open-file size snapshot, or null when the path was missing. */
  readonly fileSize: number | null;
  /** Whether this scan discarded stale cursor position and rescanned from zero. */
  readonly reset: boolean;
}

/** Options controlling a JSONL delta scan. */
export interface ReadJsonlDeltaOptions {
  /** Maximum buffered bytes per line before streaming discard begins. */
  readonly maxLineBytes?: number;
}

interface ScanResult {
  readonly lines: readonly JsonlLine[];
  readonly diagnostics: readonly JsonlOversizedDiagnostic[];
  readonly offset: number;
  readonly lineNumber: number;
}

/**
 * Read complete JSONL lines added after a cursor position.
 *
 * Scanning is byte-oriented on 0x0a: only newline-terminated byte ranges are
 * decoded, so a trailing partial line stays uncommitted and is picked up on a
 * later call once its newline arrives. Reads stop at the size snapshotted from
 * the opened handle, so bytes appended mid-scan are never half-read. Line
 * identity is validated against the cursor before use: a device/inode change
 * or a shrink triggers a full rescan, and head+boundary digests catch
 * same-size rewrites that offsets alone cannot see.
 *
 * The dual digest exists because neither window alone is sufficient: the head
 * window detects rewrites of early content, while the boundary window detects
 * same-size rewrites near the committed tail (the common truncate-and-rewrite
 * pattern) that leave the head window untouched. Both windows are bounded, so
 * validation stays O(window) regardless of file size.
 *
 * @param path - JSONL file path.
 * @param cursor - Prior serializable cursor, or null for a full scan.
 * @param options - Per-scan line size limit.
 * @returns Complete lines, diagnostics, and the next cursor.
 * @throws If the file cannot be read, except when the path is missing.
 * @throws If `maxLineBytes` is not a non-negative safe integer.
 */
export async function readJsonlDelta(
  path: string,
  cursor: JsonlCursor | null,
  options: ReadJsonlDeltaOptions = {}
): Promise<JsonlDelta> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0) {
    throw new RangeError('maxLineBytes must be a non-negative safe integer');
  }

  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return {
        lines: [],
        diagnostics: [],
        cursor,
        fileSize: null,
        reset: false,
      };
    }
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
    const startOffset = reset ? 0 : (cursor?.offset ?? 0);
    const startLineNumber = reset ? 1 : (cursor?.lineNumber ?? 1);
    const generation = (cursor?.generation ?? 0) + (reset ? 1 : 0);
    const scan = await scanCompleteLines(
      file,
      startOffset,
      startLineNumber,
      fileSize,
      maxLineBytes
    );
    const digests = await digestCommittedBoundary(file, scan.offset);

    return {
      lines: scan.lines,
      diagnostics: scan.diagnostics,
      cursor: {
        device,
        inode,
        offset: scan.offset,
        lineNumber: scan.lineNumber,
        generation,
        headDigest: digests.headDigest,
        boundaryDigest: digests.boundaryDigest,
      },
      fileSize,
      reset,
    };
  } finally {
    await file.close();
  }
}

/**
 * Decide whether the stored cursor still describes this file.
 *
 * Identity mismatch (device/inode) or a shrink below the committed offset
 * means the cursor is stale. Same-size content changes are caught by
 * re-digesting the head and boundary windows and comparing against the
 * cursor's stored digests.
 */
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

/**
 * Scan up to the size snapshot, buffering only complete lines.
 *
 * Invariant: `committedOffset` advances exclusively past 0x0a terminators, so
 * a partial tail never enters `lines` and is re-read next scan. Oversized
 * lines switch to discard mode: their bytes stream through the chunk buffer
 * without accumulating, and only a bounded diagnostic is emitted.
 */
async function scanCompleteLines(
  file: FileHandle,
  startOffset: number,
  startLineNumber: number,
  snapshotSize: number,
  maxLineBytes: number
): Promise<ScanResult> {
  const lines: JsonlLine[] = [];
  const diagnostics: JsonlOversizedDiagnostic[] = [];
  const readBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let readOffset = startOffset;
  let committedOffset = startOffset;
  let lineStart = startOffset;
  let lineNumber = startLineNumber;
  let lineByteLength = 0;
  let lineChunks: Buffer[] = [];
  let discarding = false;

  while (readOffset < snapshotSize) {
    const requestedBytes = Math.min(
      readBuffer.byteLength,
      snapshotSize - readOffset
    );
    const { bytesRead } = await file.read(
      readBuffer,
      0,
      requestedBytes,
      readOffset
    );
    if (bytesRead === 0) break;

    let chunkOffset = 0;
    while (chunkOffset < bytesRead) {
      const newlineIndex = readBuffer.indexOf(0x0a, chunkOffset);
      const segmentEnd =
        newlineIndex >= 0 && newlineIndex < bytesRead
          ? newlineIndex
          : bytesRead;
      const segmentLength = segmentEnd - chunkOffset;

      if (!discarding) {
        if (lineByteLength + segmentLength > maxLineBytes) {
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

      if (newlineIndex < 0 || newlineIndex >= bytesRead) break;

      const byteEnd = readOffset + newlineIndex + 1;
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
      chunkOffset = newlineIndex + 1;
    }
    readOffset += bytesRead;
  }

  return { lines, diagnostics, offset: committedOffset, lineNumber };
}

/**
 * Digest the committed prefix's head and boundary windows.
 *
 * Head window: bytes [0, min(offset, 4096)). Boundary window: the last
 * min(offset, 4096) bytes before `offset`. For small files the windows
 * overlap entirely, which is still correct - any same-size rewrite of the
 * committed prefix changes at least one window.
 */
async function digestCommittedBoundary(
  file: FileHandle,
  offset: number
): Promise<{ readonly headDigest: string; readonly boundaryDigest: string }> {
  const headLength = Math.min(offset, DIGEST_WINDOW_BYTES);
  const boundaryStart = Math.max(0, offset - DIGEST_WINDOW_BYTES);
  const boundaryLength = offset - boundaryStart;
  const [head, boundary] = await Promise.all([
    readRange(file, 0, headLength),
    readRange(file, boundaryStart, boundaryLength),
  ]);
  return {
    headDigest: createHash('sha256').update(head).digest('hex'),
    boundaryDigest: createHash('sha256').update(boundary).digest('hex'),
  };
}

/**
 * Read exactly `length` bytes starting at `position`, looping over short
 * reads. Returns fewer bytes only at EOF, which the size snapshot makes
 * unreachable in practice.
 */
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
