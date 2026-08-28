import type { SenpiEntryParseResult } from './parse.js';
import type {
  SenpiOffPathRecord,
  SenpiProjectionRecord,
} from './projection.js';
import type { SenpiTailDiagnostic } from './tail-types.js';

/** On-disk marker schema version persisted as `markerVersion`. */
export const SENPI_MARKER_VERSION = 1;

/** Public persisted-marker fields retained from the original marker contract. */
export interface SenpiSessionMarker {
  readonly sessionPathDigest: string;
  readonly sessionId: string;
  readonly device: string;
  readonly inode: string;
  readonly generation: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly revision: number;
  readonly leafId: string | null;
  readonly projectedRecordKeys: readonly string[];
  readonly markerVersion: typeof SENPI_MARKER_VERSION;
}

/** Adapter-local semantic state carried between incremental tail passes. */
export interface SenpiSessionCheckpointState {
  readonly inputs: readonly SenpiEntryParseResult[];
  readonly records: readonly SenpiProjectionRecord[];
  readonly offPath: readonly SenpiOffPathRecord[];
  readonly parseDiagnostics: readonly SenpiTailDiagnostic[];
  readonly diagnostics: readonly SenpiTailDiagnostic[];
  readonly includeOffPath: boolean;
}

/** Caller-held checkpoint accepted by the explicit commit API. */
export interface SenpiSessionCheckpoint {
  readonly sessionPathDigest: string;
  readonly sessionId: string;
  readonly device: string;
  readonly inode: string;
  readonly generation: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly baseRevision: number;
  readonly leafId: string | null;
  readonly projectedRecordKeys: readonly string[];
  readonly revision?: number;
  readonly state?: SenpiSessionCheckpointState;
}

/** Marker destination and root-gate controls for commit and read. */
export interface SenpiSessionCheckpointCommitOptions {
  /** Custom marker directory. */
  readonly markerDir?: string;
  /** Roots allowed to contain a custom marker directory. */
  readonly allowedMarkerRoots?: readonly string[];
}

/** Observed file identity used by the invalidation predicate. */
export interface SenpiCheckpointObservedState {
  readonly device: string;
  readonly inode: string;
  readonly fileSize: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
  readonly offsetAtLineBoundary: boolean;
}

/** Why checkpoint invalidation rejected a marker. */
export type SenpiCheckpointInvalidationReason =
  | 'malformed_marker'
  | 'inode_changed'
  | 'size_below_offset'
  | 'head_digest_changed'
  | 'boundary_digest_changed'
  | 'offset_not_at_line_boundary';

/** Result of the pure invalidation predicate. */
export interface SenpiCheckpointInvalidation {
  readonly invalidate: boolean;
  readonly reason: SenpiCheckpointInvalidationReason | null;
}

/** Outcome of reading a marker file without exposing private continuation state. */
export type SenpiSessionMarkerReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly marker: SenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };

/** Outcome of parsing an in-memory marker value. */
export type SenpiSessionMarkerParseResult =
  | { readonly kind: 'valid'; readonly marker: SenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };
