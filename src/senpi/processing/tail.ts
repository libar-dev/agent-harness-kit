import { resolve } from 'node:path';

import {
  byteCursorChanged,
  checkpointRevision,
} from '../../internal/incremental.js';

import {
  commitSenpiSessionCheckpoint,
  createSenpiSessionPathDigest,
  readSenpiSessionMarker,
  type SenpiSessionCheckpoint,
  type SenpiSessionCheckpointCommitOptions,
  type SenpiSessionCheckpointState,
} from './checkpoint.js';
import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  reduceSenpiProjection,
  type SenpiBlockChange,
} from './blocks.js';
import {
  readJsonlDelta,
  type JsonlCursor,
  type JsonlLine,
} from '../../internal/jsonl-cursor.js';
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
  /** Resume from a checkpoint returned by a prior pass. */
  readonly checkpoint?: SenpiSessionCheckpoint;
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

/**
 * Tail a Senpi session into its persisted root-to-leaf projection.
 *
 * A supplied checkpoint contributes its byte cursor and adapter-local parsed
 * state, so only appended bytes are parsed before the Senpi projector runs.
 * Marker-only continuation retains the disk-compatible replay path. Any stale
 * cursor condition causes a byte-zero rebuild and a full splice at index zero.
 * Automatic mode writes only after every complete line parses and projection
 * is complete; manual mode never writes.
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
  const providedCheckpoint = options.checkpoint;
  const supplied = options.fromStart === true ? undefined : providedCheckpoint;
  const sessionPathDigest = createSenpiSessionPathDigest(sessionPath);
  if (
    supplied !== undefined &&
    supplied.sessionPathDigest !== sessionPathDigest
  ) {
    throw new Error('Senpi session checkpoint does not match the session path');
  }
  const cursorOptions =
    options.maxLineBytes === undefined
      ? undefined
      : { maxLineBytes: options.maxLineBytes };
  const restartCheckpoint = providedCheckpoint ?? marker;
  const priorCursor =
    options.fromStart === true ? null : checkpointCursor(supplied ?? marker);
  let delta = await readJsonlDelta(sessionPath, priorCursor, cursorOptions);
  if (
    options.fromStart === true &&
    restartCheckpoint !== null &&
    restartCheckpoint !== undefined &&
    delta.cursor !== null
  ) {
    delta = {
      ...delta,
      cursor: {
        ...delta.cursor,
        generation: restartCheckpoint.generation + 1,
      },
    };
  }
  if (delta.fileSize === null || delta.cursor === null) {
    throw new Error(`Missing required Senpi session source '${sessionPath}'`);
  }

  const reset =
    options.fromStart === true ||
    delta.reset ||
    (supplied === undefined && marker === null);
  let invalidationMessage: string | null = null;
  if (markerRead.kind === 'invalid' && supplied === undefined) {
    invalidationMessage = markerRead.error;
  } else if (options.fromStart === true) {
    invalidationMessage = 'fromStart requested';
  } else if (delta.reset) {
    invalidationMessage = 'source identity or committed content changed';
  }

  const includeOffPath = options.includeOffPath === true;
  const priorState = supplied?.state;
  const cursorMoved = byteCursorChanged(priorCursor, delta.cursor);
  if (
    !reset &&
    !cursorMoved &&
    delta.lines.length === 0 &&
    delta.diagnostics.length === 0 &&
    priorState?.includeOffPath === includeOffPath
  ) {
    if (supplied === undefined) {
      throw new Error('Incremental Senpi state requires a supplied checkpoint');
    }
    const revision = supplied.revision ?? marker?.revision ?? 0;
    return unchangedResult(
      supplied,
      priorState,
      delta.cursor,
      delta.fileSize,
      revision
    );
  }

  const fallbackWithoutState = !reset && priorState === undefined;
  if (fallbackWithoutState) {
    const full = await readJsonlDelta(sessionPath, null, cursorOptions);
    if (full.fileSize === null || full.cursor === null) {
      throw new Error(`Missing required Senpi session source '${sessionPath}'`);
    }
    delta = {
      ...full,
      cursor: {
        ...full.cursor,
        generation: priorCursor?.generation ?? full.cursor.generation,
      },
    };
  }

  const nextCursor = delta.cursor;
  const fileSize = delta.fileSize;
  if (nextCursor === null || fileSize === null) {
    throw new Error(`Missing required Senpi session source '${sessionPath}'`);
  }
  const parsedDelta = parseLines(
    delta.lines,
    delta.diagnostics,
    reset ? null : (supplied?.sessionId ?? marker?.sessionId ?? null)
  );
  const inputs =
    reset || fallbackWithoutState
      ? parsedDelta.inputs
      : [...(priorState?.inputs ?? []), ...parsedDelta.inputs];
  const parseDiagnostics: SenpiTailDiagnostic[] =
    reset || fallbackWithoutState
      ? [...parsedDelta.diagnostics]
      : [...(priorState?.parseDiagnostics ?? []), ...parsedDelta.diagnostics];
  const diagnostics: SenpiTailDiagnostic[] = [...parseDiagnostics];
  const sessionId =
    parsedDelta.sessionId ?? supplied?.sessionId ?? marker?.sessionId ?? null;
  if (
    reset &&
    supplied !== undefined &&
    sessionId !== null &&
    sessionId !== supplied.sessionId
  ) {
    invalidationMessage = 'session header id changed';
  }
  if (invalidationMessage !== null) {
    diagnostics.push({
      code: 'checkpoint_invalid',
      message: `Saved checkpoint was discarded: ${invalidationMessage}.`,
    });
  }

  const baseRevision = supplied?.revision ?? marker?.revision ?? 0;
  const previousRecords = reset ? [] : (priorState?.records ?? []);
  const previousKeys = reset
    ? []
    : (priorState?.records.map(record => record.key) ??
      marker?.projectedRecordKeys ??
      supplied?.projectedRecordKeys ??
      []);
  const previousByteOffset = reset ? 0 : (priorCursor?.offset ?? 0);
  const rawResolution = resolveSenpiLeaf(inputs);
  const terminalInvalid = parsedDelta.terminalMalformed;
  const projection = terminalInvalid
    ? invalidProjection(rawResolution)
    : projectSenpiBranch(
        inputs,
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
  const stateChanged = reset || mutation !== null || cursorMoved;
  const revision = checkpointRevision(baseRevision, stateChanged);
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
    : fallbackWithoutState
      ? reducePriorProjection(
          priorCursor?.offset ?? 0,
          delta.lines,
          marker?.leafId ?? supplied?.leafId ?? null
        )
      : reductionFromRecords(previousRecords, projection);
  const reduction = reduceSenpiProjection(previousReduction.state, projection);
  const generation = nextCursor.generation;
  const state: SenpiSessionCheckpointState = {
    inputs,
    records: projection.records,
    offPath: projection.offPath,
    parseDiagnostics,
    diagnostics,
    includeOffPath,
  };
  const checkpoint: SenpiSessionCheckpoint = {
    sessionPathDigest,
    sessionId: sessionId ?? '',
    device: nextCursor.device,
    inode: nextCursor.inode,
    generation,
    offset: nextCursor.offset,
    lineNumber: nextCursor.lineNumber,
    headDigest: nextCursor.headDigest,
    boundaryDigest: nextCursor.boundaryDigest,
    baseRevision: marker?.revision ?? supplied?.baseRevision ?? 0,
    leafId: terminalInvalid ? null : projection.leafId,
    projectedRecordKeys: projection.records.map(record => record.key),
    revision,
    state,
  };

  const projectionSuccessful =
    parsedDelta.successful &&
    projection.kind !== 'invalid' &&
    projection.complete;
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
    nextByteOffset: nextCursor.offset,
    fileSize,
    generation,
    revision,
    reset,
    checkpoint,
  };
}
function checkpointCursor(
  checkpoint:
    | SenpiSessionCheckpoint
    | {
        readonly device: string;
        readonly inode: string;
        readonly offset: number;
        readonly lineNumber: number;
        readonly generation: number;
        readonly headDigest: string;
        readonly boundaryDigest: string;
      }
    | null
    | undefined
): JsonlCursor | null {
  if (checkpoint === null || checkpoint === undefined) return null;
  return {
    device: checkpoint.device,
    inode: checkpoint.inode,
    offset: checkpoint.offset,
    lineNumber: checkpoint.lineNumber,
    generation: checkpoint.generation,
    headDigest: checkpoint.headDigest,
    boundaryDigest: checkpoint.boundaryDigest,
  };
}

function unchangedResult(
  supplied: SenpiSessionCheckpoint,
  state: SenpiSessionCheckpointState,
  cursor: JsonlCursor,
  fileSize: number,
  revision: number
): SenpiSessionTailResult {
  return {
    records: state.records,
    mutations: [],
    changes: [],
    offPath: state.offPath,
    diagnostics: state.diagnostics,
    leaf:
      supplied.leafId === null
        ? { kind: 'empty', leafId: null }
        : { kind: 'resolved', leafId: supplied.leafId },
    previousByteOffset: cursor.offset,
    nextByteOffset: cursor.offset,
    fileSize,
    generation: cursor.generation,
    revision,
    reset: false,
    checkpoint: { ...supplied, revision, state },
  };
}

function reductionFromRecords(
  records: readonly SenpiProjectionRecord[],
  current: SenpiProjectionResult
): ReturnType<typeof reduceSenpiProjection> {
  const prior: SenpiProjectionResult = {
    ...current,
    kind: records.length === 0 ? 'empty' : 'projected',
    leafId: records.at(-1)?.entryId ?? null,
    records,
    offPath: [],
    warnings: [],
    complete: true,
  };
  return reduceSenpiProjection(EMPTY_SENPI_BLOCK_REDUCTION_STATE, prior);
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

function reducePriorProjection(
  previousByteOffset: number,
  lines: readonly JsonlLine[],
  leafId: string | null
): ReturnType<typeof reduceSenpiProjection> {
  const prefixLines = lines.filter(line => line.byteEnd <= previousByteOffset);
  const prefix = parseLines(prefixLines, []);
  const prior = projectSenpiBranch(prefix.inputs, leafId);
  return reduceSenpiProjection(EMPTY_SENPI_BLOCK_REDUCTION_STATE, prior);
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
