/** In-progress oversized discard carried across scan passes. */
export type JsonlOversizedPending = {
  readonly kind: 'discarding_oversized';
  readonly byteStart: number;
};

/**
 * Parse optional serialized oversized-discard state.
 *
 * @param value - Raw `pending` field from a cursor, marker, or checkpoint.
 * @returns Normalized state, or `undefined` when a present shape is invalid.
 */
export function parseJsonlOversizedPending(
  value: unknown
): JsonlOversizedPending | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value['kind'] !== 'discarding_oversized') {
    return undefined;
  }
  const byteStart = value['byteStart'];
  if (
    typeof byteStart !== 'number' ||
    !Number.isSafeInteger(byteStart) ||
    byteStart < 0
  ) {
    return undefined;
  }
  return { kind: 'discarding_oversized', byteStart };
}

/** Whether one scan finished the snapshotted range or stopped on a cap. */
export type JsonlScanStatus =
  | { readonly status: 'complete' }
  | { readonly status: 'limited'; readonly reason: 'bytes' | 'lines' };

/** Serializable position and file identity for incremental JSONL reads. */
export interface JsonlCursor {
  /** Device identifier from the opened file. */
  readonly device: string;
  /** Inode identifier from the opened file. */
  readonly inode: string;
  /** Byte offset of the next uncommitted line, or discard resume point. */
  readonly offset: number;
  /** One-based number of the next uncommitted line. */
  readonly lineNumber: number;
  /** Number of identity or content resets observed by this cursor. */
  readonly generation: number;
  /** SHA-256 digest of the committed prefix's leading window. */
  readonly headDigest: string;
  /** SHA-256 digest of the committed prefix's trailing boundary window. */
  readonly boundaryDigest: string;
  /** Multi-pass oversized discard, or null at a line boundary. */
  readonly pending?: JsonlOversizedPending | null;
}

/** One complete newline-terminated JSONL line. */
export interface JsonlLine {
  /** UTF-8 decoded content without its newline. */
  readonly value: string;
  /** One-based source line number. */
  readonly lineNumber: number;
  /** Inclusive byte offset. */
  readonly byteStart: number;
  /** Exclusive byte offset including newline. */
  readonly byteEnd: number;
}

/** Diagnostic for one fully consumed oversized line. */
export interface JsonlOversizedDiagnostic {
  readonly kind: 'oversized';
  readonly lineNumber: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

/** Result of one bounded JSONL delta scan. */
export interface JsonlDelta {
  readonly lines: readonly JsonlLine[];
  readonly diagnostics: readonly JsonlOversizedDiagnostic[];
  readonly cursor: JsonlCursor | null;
  readonly fileSize: number | null;
  readonly reset: boolean;
  readonly scanStatus: JsonlScanStatus;
  readonly scannedBytes: number;
  readonly scannedLines: number;
}

/** Options controlling a JSONL delta scan. */
export interface ReadJsonlDeltaOptions {
  /** Maximum buffered bytes per line before streaming discard begins. */
  readonly maxLineBytes?: number;
  /** Maximum bytes one pass may consume from the resume offset. */
  readonly maxScanBytes?: number;
  /** Maximum complete lines one pass may commit or discard. */
  readonly maxScanLines?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
