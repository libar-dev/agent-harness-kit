import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  commitSenpiSessionCheckpoint,
  createSenpiSessionPathDigest,
  evaluateSenpiCheckpointInvalidation,
  readSenpiSessionMarker,
  type SenpiSessionCheckpoint,
  type SenpiSessionCheckpointCommitOptions,
  type SenpiSessionMarker,
} from './checkpoint.js';
import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  reduceSenpiProjection,
  type SenpiBlockChange,
} from './blocks.js';
import { readJsonlDelta, type JsonlLine } from './jsonl-cursor.js';
import { parseSenpiEntry, type SenpiEntryParseResult } from './parse.js';
import {
  computeProjectionMutation,
  projectSenpiBranch,
  resolveSenpiLeaf,
  type SenpiLeafResolution,
  type SenpiOffPathRecord,
  type SenpiProjectionMutation,
  type SenpiProjectionRecord,
  type SenpiProjectionResult,
  type SenpiProjectionWarningCode,
} from './projection.js';

const DIGEST_WINDOW_BYTES = 4096;

/** Options controlling one Senpi session tail pass. */
export interface SenpiSessionTailOptions extends SenpiSessionCheckpointCommitOptions {
  /** Return a caller-committable checkpoint without writing its marker. */
  readonly checkpointMode?: 'automatic' | 'manual';
  /** Discard any saved position and rebuild from byte zero. */
  readonly fromStart?: boolean;
  /** Include accepted records outside the active projected branch. */
  readonly includeOffPath?: boolean;
  /** Maximum bytes accepted in one newline-terminated JSONL line. */
  readonly maxLineBytes?: number;
}

/** Stable diagnostic categories produced by tail parsing and projection. */
export type SenpiTailDiagnosticCode =
  | 'checkpoint_invalid'
  | 'invalid_json'
  | 'invalid_session_header'
  | 'invalid_entry'
  | 'oversized_line'
  | SenpiProjectionWarningCode;

/** A machine-readable diagnostic from one tail pass. */
export interface SenpiTailDiagnostic {
  readonly code: SenpiTailDiagnosticCode;
  readonly message: string;
  readonly lineNumber?: number;
  readonly byteStart?: number;
  readonly byteEnd?: number;
  readonly entryId?: string;
  readonly relatedId?: string;
}

/** Leaf resolution exposed without leaking the internal tree index. */
export type SenpiTailLeaf =
  | { readonly kind: 'empty'; readonly leafId: null }
  | { readonly kind: 'resolved'; readonly leafId: string }
  | { readonly kind: 'invalid'; readonly leafId: string | null };

/**
 * One revisioned suffix splice over active projection records.
 *
 * Consumers must first assert that their local revision equals
 * `baseRevision`, then replace `deleteCount` records at `index` with
 * `records`, and finally store `revision`. A pass emits zero or one splice.
 */
export interface SenpiSessionSpliceMutation extends SenpiProjectionMutation {
  readonly baseRevision: number;
  readonly revision: number;
}

/** Result of one complete Senpi cursor, projection, and reduction pass. */
export interface SenpiSessionTailResult {
  readonly records: readonly SenpiProjectionRecord[];
  readonly mutations: readonly SenpiSessionSpliceMutation[];
  readonly changes: readonly SenpiBlockChange[];
  readonly offPath: readonly SenpiOffPathRecord[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly leaf: SenpiTailLeaf;
  readonly previousByteOffset: number;
  readonly nextByteOffset: number;
  readonly fileSize: number;
  readonly generation: number;
  readonly revision: number;
  readonly reset: boolean;
  readonly checkpoint: SenpiSessionCheckpoint;
}

interface ParsedLines {
  readonly inputs: readonly SenpiEntryParseResult[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly sessionId: string | null;
  readonly successful: boolean;
  readonly terminalMalformed: boolean;
}

interface MarkerObservation {
  readonly device: string;
  readonly inode: string;
  readonly fileSize: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly offsetAtLineBoundary: boolean;
}

/**
 * Tail a Senpi session into its persisted root-to-leaf projection.
 *
 * A valid marker contributes only prior projection keys and revision state;
 * the committed prefix is replayed to rebuild the tree before appended lines
 * are projected. Any stale marker condition causes a byte-zero rebuild and a
 * full splice at index zero. Automatic mode writes only after every complete
 * line parses and projection is complete; manual mode never writes.
 *
 * @param file - Senpi session JSONL file.
 * @param options - Cursor, marker, projection, and line-size controls.
 * @returns Projection records, at most one revisioned splice, diagnostics,
 * reduction changes, offsets, and a caller-committable checkpoint.
 * @throws If the session file is missing or cannot be read, or automatic
 * checkpoint persistence fails.
 */
export async function tailSenpiSession(
  file: string,
  options: SenpiSessionTailOptions = {}
): Promise<SenpiSessionTailResult> {
  const sessionPath = resolve(file);
  const markerOptions = checkpointOptions(options);
  const markerRead = await readSenpiSessionMarker(sessionPath, markerOptions);
  const marker = markerRead.kind === 'valid' ? markerRead.marker : null;
  const cursorOptions =
    options.maxLineBytes === undefined
      ? undefined
      : { maxLineBytes: options.maxLineBytes };
  const full = await readJsonlDelta(sessionPath, null, cursorOptions);
  if (full.fileSize === null || full.cursor === null) {
    throw new Error(`Missing required Senpi session source '${sessionPath}'`);
  }

  const parsed = parseLines(full.lines, full.diagnostics);
  const diagnostics: SenpiTailDiagnostic[] = [...parsed.diagnostics];
  let reset = marker === null || options.fromStart === true;
  let invalidationMessage: string | null = null;

  if (markerRead.kind === 'invalid') {
    invalidationMessage = markerRead.error;
  } else if (marker !== null && options.fromStart !== true) {
    const observed = await observeMarkerOffset(sessionPath, marker);
    const invalidation = evaluateSenpiCheckpointInvalidation(marker, observed);
    if (invalidation.invalidate) {
      reset = true;
      invalidationMessage = invalidation.reason ?? 'checkpoint invalidated';
    } else if (parsed.sessionId !== marker.sessionId) {
      reset = true;
      invalidationMessage = 'session header id changed';
    }
  } else if (options.fromStart === true) {
    invalidationMessage = 'fromStart requested';
  }

  if (invalidationMessage !== null) {
    diagnostics.push({
      code: 'checkpoint_invalid',
      message: `Saved checkpoint was discarded: ${invalidationMessage}.`,
    });
  }

  const previousKeys = reset ? [] : (marker?.projectedRecordKeys ?? []);
  const previousByteOffset = reset ? 0 : (marker?.offset ?? 0);
  const baseRevision = marker?.revision ?? 0;
  const rawResolution = resolveSenpiLeaf(parsed.inputs);
  const terminalInvalid = parsed.terminalMalformed;
  const projection = terminalInvalid
    ? invalidProjection(rawResolution)
    : projectSenpiBranch(
        parsed.inputs,
        rawResolution.leafId,
        options.includeOffPath === undefined
          ? {}
          : { includeOffPath: options.includeOffPath }
      );
  diagnostics.push(
    ...projection.warnings.map(warning => ({
      code: warning.code,
      message: warning.message,
      ...(warning.entryId === undefined ? {} : { entryId: warning.entryId }),
      ...(warning.relatedId === undefined
        ? {}
        : { relatedId: warning.relatedId }),
    }))
  );

  const mutation = computeProjectionMutation(previousKeys, projection.records);
  const stateChanged =
    reset || mutation !== null || previousByteOffset !== full.cursor.offset;
  const revision = stateChanged ? baseRevision + 1 : baseRevision;
  const mutations =
    mutation === null
      ? []
      : [
          {
            ...mutation,
            baseRevision,
            revision,
          } satisfies SenpiSessionSpliceMutation,
        ];

  const previousReduction = reset
    ? { state: EMPTY_SENPI_BLOCK_REDUCTION_STATE }
    : reducePriorProjection(previousByteOffset, full.lines, marker);
  const reduction = reduceSenpiProjection(previousReduction.state, projection);
  const generation = reset
    ? (marker?.generation ?? -1) + 1
    : (marker?.generation ?? 0);
  const checkpoint: SenpiSessionCheckpoint = {
    sessionPathDigest: createSenpiSessionPathDigest(sessionPath),
    sessionId: parsed.sessionId ?? marker?.sessionId ?? '',
    device: full.cursor.device,
    inode: full.cursor.inode,
    generation,
    offset: full.cursor.offset,
    lineNumber: full.cursor.lineNumber,
    headDigest: full.cursor.headDigest,
    boundaryDigest: full.cursor.boundaryDigest,
    baseRevision,
    leafId: terminalInvalid ? null : projection.leafId,
    projectedRecordKeys: projection.records.map(record => record.key),
  };

  const projectionSuccessful =
    parsed.successful && projection.kind !== 'invalid' && projection.complete;
  if (
    options.checkpointMode !== 'manual' &&
    stateChanged &&
    projectionSuccessful
  ) {
    await commitSenpiSessionCheckpoint(sessionPath, checkpoint, markerOptions);
  }

  return {
    records: projection.records,
    mutations,
    changes: reduction.changes,
    offPath: projection.offPath,
    diagnostics,
    leaf: terminalInvalid
      ? { kind: 'invalid', leafId: null }
      : tailLeaf(rawResolution),
    previousByteOffset,
    nextByteOffset: full.cursor.offset,
    fileSize: full.fileSize,
    generation,
    revision,
    reset,
    checkpoint,
  };
}

function checkpointOptions(
  options: SenpiSessionTailOptions
): SenpiSessionCheckpointCommitOptions {
  return {
    ...(options.markerDir === undefined
      ? {}
      : { markerDir: options.markerDir }),
    ...(options.allowedMarkerRoots === undefined
      ? {}
      : { allowedMarkerRoots: options.allowedMarkerRoots }),
  };
}

function parseLines(
  lines: readonly JsonlLine[],
  oversized: readonly {
    readonly lineNumber: number;
    readonly byteStart: number;
    readonly byteEnd: number;
  }[]
): ParsedLines {
  const inputs: SenpiEntryParseResult[] = [];
  const diagnostics: SenpiTailDiagnostic[] = oversized.map(item => ({
    code: 'oversized_line',
    message: `Line ${String(item.lineNumber)} exceeded maxLineBytes.`,
    lineNumber: item.lineNumber,
    byteStart: item.byteStart,
    byteEnd: item.byteEnd,
  }));
  let sessionId: string | null = null;
  let successful = oversized.length === 0;
  let lastMalformedLine = oversized.at(-1)?.lineNumber ?? -1;

  for (const line of lines) {
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

function invalidProjection(
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

function tailLeaf(resolution: SenpiLeafResolution): SenpiTailLeaf {
  if (resolution.kind === 'empty') return { kind: 'empty', leafId: null };
  if (resolution.kind === 'resolved') {
    return { kind: 'resolved', leafId: resolution.leafId };
  }
  return { kind: 'invalid', leafId: resolution.leafId };
}

function reducePriorProjection(
  previousByteOffset: number,
  lines: readonly JsonlLine[],
  marker: SenpiSessionMarker | null
): ReturnType<typeof reduceSenpiProjection> {
  const prefixLines = lines.filter(line => line.byteEnd <= previousByteOffset);
  const prefix = parseLines(prefixLines, []);
  const prior = projectSenpiBranch(prefix.inputs, marker?.leafId ?? null);
  return reduceSenpiProjection(EMPTY_SENPI_BLOCK_REDUCTION_STATE, prior);
}

async function observeMarkerOffset(
  path: string,
  marker: SenpiSessionMarker
): Promise<MarkerObservation> {
  const file = await open(path, 'r');
  try {
    const stats = await file.stat();
    const offset = Math.min(marker.offset, stats.size);
    const headLength = Math.min(offset, DIGEST_WINDOW_BYTES);
    const boundaryStart = Math.max(0, offset - DIGEST_WINDOW_BYTES);
    const [head, boundary, preceding] = await Promise.all([
      readRange(file, 0, headLength),
      readRange(file, boundaryStart, offset - boundaryStart),
      marker.offset === 0 || marker.offset > stats.size
        ? Promise.resolve(Buffer.alloc(0))
        : readRange(file, marker.offset - 1, 1),
    ]);
    return {
      device: String(stats.dev),
      inode: String(stats.ino),
      fileSize: stats.size,
      headDigest: createHash('sha256').update(head).digest('hex'),
      boundaryDigest: createHash('sha256').update(boundary).digest('hex'),
      offsetAtLineBoundary: marker.offset === 0 || preceding[0] === 0x0a,
    };
  } finally {
    await file.close();
  }
}

async function readRange(
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await file.read(
      buffer,
      read,
      length - read,
      position + read
    );
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return buffer.subarray(0, read);
}
