import type {
  JsonlCursor,
  JsonlScanStatus,
} from '../../internal/jsonl-cursor.js';
import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';
import type { SenpiEntryParseResult } from './parse.js';
import type { ParsedLines } from './tail-parse.js';
import type { SenpiScanLimits } from './tail-resume.js';
import type { SenpiInternalSessionTailOptions } from './tail-run-support.js';

/** Complete inputs for projection and optional automatic marker commit. */
export interface SenpiProjectRequest {
  readonly sessionPath: string;
  readonly options: SenpiInternalSessionTailOptions;
  readonly markerOptions: SenpiSessionCheckpointCommitOptions;
  readonly sessionPathDigest: string;
  readonly marker: InternalSenpiSessionMarker | null;
  readonly supplied: InternalSenpiSessionCheckpoint | undefined;
  readonly delta: {
    readonly cursor: JsonlCursor | null;
    readonly fileSize: number | null;
    readonly reset: boolean;
    readonly scanStatus: JsonlScanStatus;
    readonly scannedBytes: number;
    readonly scannedLines: number;
  };
  readonly parsed: ParsedLines;
  readonly includeOffPath: boolean;
  readonly reset: boolean;
  readonly invalidationMessage: string | null;
  readonly priorCursor: JsonlCursor | null;
  readonly graphSeeds: readonly SenpiEntryParseResult[];
  readonly previousKeys: readonly string[];
  readonly previousCount: number | undefined;
  readonly limits: SenpiScanLimits;
}
