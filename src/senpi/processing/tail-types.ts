import type { JsonlScanStatus } from '../../internal/jsonl-cursor.js';
import type { SenpiBlockChange } from './blocks.js';
import type {
  SenpiSessionCheckpoint,
  SenpiSessionCheckpointCommitOptions,
} from './checkpoint-types.js';
import type {
  SenpiOffPathRecord,
  SenpiProjectionMutation,
  SenpiProjectionRecord,
  SenpiProjectionWarningCode,
} from './projection.js';

/** Options controlling one Senpi session tail pass. */
export interface SenpiSessionTailOptions extends SenpiSessionCheckpointCommitOptions {
  readonly checkpointMode?: 'automatic' | 'manual';
  readonly fromStart?: boolean;
  readonly includeOffPath?: boolean;
  readonly maxLineBytes?: number;
  readonly maxScanBytes?: number;
  readonly maxScanLines?: number;
  readonly maxResultBytes?: number;
  readonly maxResultRecords?: number;
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

/** One revisioned suffix splice over active projection records. */
export interface SenpiSessionSpliceMutation extends SenpiProjectionMutation {
  readonly baseRevision: number;
  readonly revision: number;
}

/** Semantic cursor and projection position used to detect observable movement. */
export interface SenpiTailPosition {
  readonly generation: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly pendingKind: 'discarding_oversized' | null;
  readonly projectionRevision: number;
}

/** Outcome of checkpoint handling after one Senpi tail pass. */
export type SenpiCheckpointStatus =
  | { readonly status: 'committed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'manual' }
  | { readonly status: 'failed'; readonly error: string }
  | {
      readonly status: 'deferred';
      readonly reason: 'invalid_projection' | 'projection_limit';
    };

/** Result of one bounded Senpi cursor, projection, and reduction pass. */
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
  readonly scanStatus: JsonlScanStatus;
  readonly scannedBytes: number;
  readonly scannedLines: number;
  readonly previousPosition: SenpiTailPosition;
  readonly nextPosition: SenpiTailPosition;
  readonly moved: boolean;
  readonly checkpoint: SenpiSessionCheckpoint;
  readonly checkpointStatus: SenpiCheckpointStatus;
}
