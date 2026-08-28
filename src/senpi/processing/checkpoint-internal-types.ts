import type { JsonlOversizedPending } from '../../internal/jsonl-cursor.js';
import type { SenpiAcceptedGraphEntry } from './accepted-graph.js';
import type {
  SenpiSessionCheckpoint,
  SenpiSessionCheckpointState,
  SenpiSessionMarker,
} from './checkpoint-types.js';
import type { SenpiRebuildProgress } from './tail-resume.js';

/** Private marker extension used only by unbarreled processing internals. */
export interface InternalSenpiSessionMarker extends SenpiSessionMarker {
  readonly pending: JsonlOversizedPending | null;
  readonly projectedRecordCount?: number;
  readonly acceptedEntries?: readonly SenpiAcceptedGraphEntry[];
}

/** Private semantic continuation carried inside the existing opaque state slot. */
export interface InternalSenpiSessionCheckpointState extends SenpiSessionCheckpointState {
  readonly rebuild?: SenpiRebuildProgress;
}

/** Private checkpoint extension never re-exported from the public facade. */
export interface InternalSenpiSessionCheckpoint extends SenpiSessionCheckpoint {
  readonly projectedRecordCount?: number;
  readonly acceptedEntries?: readonly SenpiAcceptedGraphEntry[];
  readonly pending?: JsonlOversizedPending | null;
  readonly state?: InternalSenpiSessionCheckpointState;
}

/** Private marker read outcome retaining bounded continuation fields. */
export type InternalSenpiSessionMarkerReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly marker: InternalSenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };

/** Private marker parse outcome retaining bounded continuation fields. */
export type InternalSenpiSessionMarkerParseResult =
  | { readonly kind: 'valid'; readonly marker: InternalSenpiSessionMarker }
  | { readonly kind: 'invalid'; readonly error: string };
