import { publicTailResult } from './checkpoint-carrier.js';
import { SenpiMissingSessionSourceError } from './missing-session-source.js';
import { tailSenpiSessionInternal } from './tail-run.js';
import type {
  SenpiSessionTailOptions,
  SenpiSessionTailResult,
} from './tail-types.js';

/**
 * Tail one Senpi session with the stable public option surface.
 *
 * Automatic checkpoint write failures are returned as
 * `checkpointStatus: { status: 'failed', error }` with the batch intact
 * and the marker unchanged. Explicit commitSenpiSessionCheckpoint still
 * rejects on write failure.
 *
 * @param file - Senpi session JSONL file.
 * @param options - Existing checkpoint, marker, and projection controls.
 * @returns One bounded projection pass, continuation checkpoint, and
 *   checkpoint persistence status.
 * @throws {SenpiMissingSessionSourceError} When the session file is absent.
 * @throws If a supplied checkpoint does not match the session path.
 */
export function tailSenpiSession(
  file: string,
  options: SenpiSessionTailOptions = {}
): Promise<SenpiSessionTailResult> {
  return tailSenpiSessionInternal(file, options).then(publicTailResult);
}

/** Typed error thrown when a required Senpi session JSONL file is absent. */
export { SenpiMissingSessionSourceError };

/** Public tail result, option, splice, leaf, and diagnostic contracts. */
export {
  type SenpiCheckpointStatus,
  type SenpiSessionSpliceMutation,
  type SenpiSessionTailOptions,
  type SenpiSessionTailResult,
  type SenpiTailDiagnostic,
  type SenpiTailDiagnosticCode,
  type SenpiTailLeaf,
  type SenpiTailPosition,
} from './tail-types.js';
