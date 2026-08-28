import type {
  JsonlCursor,
  JsonlScanStatus,
} from '../../internal/jsonl-cursor.js';
import type {
  GrokActivity,
  GrokBlockChange,
  GrokNormalizedRecord,
} from './blocks.js';

/** Native JSONL filenames keyed by Grok source kind. */
export const GROK_SOURCE_FILENAMES = {
  updates: 'updates.jsonl',
  events: 'events.jsonl',
} as const;

/** A persisted Grok session source. */
export type GrokTailSourceKind = keyof typeof GROK_SOURCE_FILENAMES;

/** Options shared by Grok session tail and watch operations. */
export interface GrokSessionTailOptions {
  readonly markerDir?: string;
  readonly allowedMarkerRoots?: readonly string[];
  readonly fromStart?: boolean;
  readonly checkpointMode?: 'automatic' | 'manual';
  readonly maxLineBytes?: number;
  readonly maxScanBytes?: number;
  readonly maxScanLines?: number;
  readonly includeActivities?: boolean;
  readonly checkpoint?: GrokSessionCheckpoint;
}

/**
 * Injectable time source driving the optional poll backstop.
 *
 * Production callers omit this and receive real timers. Tests inject a clock
 * so poll delays never appear as real sleeps.
 */
export interface GrokWatchClock {
  /** Current time in milliseconds. */
  readonly now: () => number;
  /** Schedule `handler` after `delayMs`; returns a cancellable timer handle. */
  readonly setTimeout: (
    handler: () => void,
    delayMs: number
  ) => NodeJS.Timeout | number;
  /** Cancel a handle previously returned by `setTimeout`. */
  readonly clearTimeout: (handle: NodeJS.Timeout | number) => void;
}

/** Options for watching a Grok session directory. */
export interface GrokSessionWatchOptions extends GrokSessionTailOptions {
  readonly signal?: AbortSignal;
  /**
   * Optional wake-up backstop interval in milliseconds on the injected clock.
   * When set, a repeating timer periodically triggers a reconcile so progress
   * never depends on filesystem event delivery latency or loss. Omitted or
   * zero disables polling.
   */
  readonly pollMs?: number;
  /** Clock for the poll backstop; defaults to real timers. */
  readonly clock?: GrokWatchClock;
}

/** Marker controls accepted by manual checkpoint commits. */
export interface GrokSessionCheckpointCommitOptions {
  readonly markerDir?: string;
  readonly allowedMarkerRoots?: readonly string[];
}

/** Serializable cursor state for one Grok session source. */
export interface GrokSessionSourceCheckpoint {
  readonly sourceKind: GrokTailSourceKind;
  readonly cursor: JsonlCursor | null;
}

/** Adapter-local semantic state retained alongside neutral source cursors. */
export interface GrokSessionCheckpointState {
  readonly records: readonly GrokTailRecord[];
}

/** Revision-bound checkpoint returned by a successful two-source read. */
export interface GrokSessionCheckpoint {
  readonly sessionPathDigest: string;
  readonly baseRevision: number;
  readonly sources: readonly GrokSessionSourceCheckpoint[];
  readonly state?: GrokSessionCheckpointState;
}

/** One parsed, ordered record emitted by a Grok session tail. */
export interface GrokTailRecord {
  readonly sourceKind: GrokTailSourceKind;
  readonly effectiveTimestamp: number;
  readonly nativeType: string;
  readonly generation: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly record: GrokNormalizedRecord;
}

/** A parse or cursor diagnostic tied to one physical source record. */
export interface GrokTailDiagnostic {
  readonly sourceKind: GrokTailSourceKind;
  readonly kind:
    | 'invalid_json'
    | 'invalid_record'
    | 'unknown_record'
    | 'oversized';
  readonly lineNumber: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly message: string;
}

/** State reached for one source during a tail pass. */
export interface GrokSourceTailResult {
  readonly sourceKind: GrokTailSourceKind;
  readonly sourcePath: string;
  readonly status: 'read' | 'missing';
  readonly recordCount: number;
  readonly generation: number;
  readonly previousByteOffset: number;
  readonly newByteOffset: number;
  readonly fileSize: number | null;
  readonly reset: boolean;
}

/** Notification that a source was replaced, truncated, or rewritten. */
export interface GrokSourceReset {
  readonly type: 'source_reset';
  readonly sourceKind: GrokTailSourceKind;
  readonly generation: number;
}

/** Outcome of checkpoint handling after a successful two-source read. */
export type GrokCheckpointStatus =
  | { readonly status: 'committed' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'manual' }
  | { readonly status: 'failed'; readonly error: string };

/** Result of one atomic two-source Grok session read. */
export interface GrokSessionTailResult {
  readonly sessionDir: string;
  readonly records: readonly GrokTailRecord[];
  readonly changes: readonly GrokBlockChange[];
  readonly activities: readonly GrokActivity[];
  readonly diagnostics: readonly GrokTailDiagnostic[];
  readonly sources: readonly GrokSourceTailResult[];
  readonly resets: readonly GrokSourceReset[];
  readonly checkpoint: GrokSessionCheckpoint;
  readonly checkpointStatus: GrokCheckpointStatus;
  /** Whether semantic checkpoint state was reconstructed from complete source reads. */
  readonly stateComplete: boolean;
  readonly scanStatus: JsonlScanStatus;
}
