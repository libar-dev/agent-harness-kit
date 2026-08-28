import { utf8JsonSize } from './accepted-graph.js';
import type { InternalSenpiSessionCheckpoint } from './checkpoint-internal-types.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';
import { commitSenpiSessionCheckpointInternal } from './checkpoint-write.js';
import type { SenpiCheckpointStatus } from './tail-types.js';

/**
 * True when a projection batch exceeds an injected result-size cap.
 *
 * Unspecified caps are not enforced, matching the maxLineBytes wiring
 * precedent: only an explicit option binds the check.
 *
 * @param records - Projection records produced by this pass.
 * @param maxResultBytes - Optional UTF-8 JSON byte cap.
 * @param maxResultRecords - Optional record-count cap.
 * @returns Whether either injected cap is exceeded.
 */
export function senpiProjectionExceedsResultLimit(
  records: readonly unknown[],
  maxResultBytes: number | undefined,
  maxResultRecords: number | undefined
): boolean {
  if (maxResultRecords !== undefined && records.length > maxResultRecords) {
    return true;
  }
  return maxResultBytes !== undefined && utf8JsonSize(records) > maxResultBytes;
}

/**
 * Persist an automatic checkpoint or return the matching status-as-data.
 *
 * Automatic write failures are caught and returned as `{ status: 'failed' }`.
 * The public explicit commit API keeps its throw contract.
 *
 * @param args - Commit inputs, mode, and the reasons a write must not occur.
 * @returns Checkpoint persistence status for one tail result.
 */
export async function persistSenpiTailCheckpoint(args: {
  readonly sessionPath: string;
  readonly checkpoint: InternalSenpiSessionCheckpoint;
  readonly markerOptions: SenpiSessionCheckpointCommitOptions;
  readonly checkpointMode: 'automatic' | 'manual' | undefined;
  readonly stateChanged: boolean;
  readonly blocksCommit: boolean;
  readonly exceedsResultLimit: boolean;
}): Promise<SenpiCheckpointStatus> {
  if (args.exceedsResultLimit) {
    return { status: 'deferred', reason: 'projection_limit' };
  }
  if (args.checkpointMode === 'manual') {
    return { status: 'manual' };
  }
  if (args.blocksCommit) {
    return { status: 'deferred', reason: 'invalid_projection' };
  }
  if (!args.stateChanged) {
    return { status: 'unchanged' };
  }
  try {
    await commitSenpiSessionCheckpointInternal(
      args.sessionPath,
      args.checkpoint,
      args.markerOptions
    );
    return { status: 'committed' };
  } catch (error: unknown) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Status for a tail pass that never attempted a marker write.
 *
 * @param checkpointMode - Caller-selected persist mode.
 * @returns `manual` when requested, otherwise `unchanged`.
 */
export function unwrittenCheckpointStatus(
  checkpointMode: 'automatic' | 'manual' | undefined
): SenpiCheckpointStatus {
  return checkpointMode === 'manual'
    ? { status: 'manual' }
    : { status: 'unchanged' };
}
