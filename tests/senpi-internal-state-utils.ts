import {
  restoreInternalCheckpoint,
  type InternalSenpiSessionCheckpoint,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import type { SenpiSessionCheckpoint } from '../src/senpi/processing/checkpoint.js';
import type { SenpiRebuildProgress } from '../src/senpi/processing/tail-resume.js';

/** Reveal private checkpoint fields only inside todo-5 integration tests. */
export function internalCheckpoint(
  checkpoint: SenpiSessionCheckpoint
): InternalSenpiSessionCheckpoint {
  return restoreInternalCheckpoint(checkpoint);
}

/** Return private bounded-rebuild progress from the existing opaque state slot. */
export function rebuildProgress(
  checkpoint: SenpiSessionCheckpoint
): SenpiRebuildProgress | undefined {
  return internalCheckpoint(checkpoint).state?.rebuild;
}

/** True when a result carries private deferred-rebuild continuation state. */
export function hasDeferredContinuation(
  checkpoint: SenpiSessionCheckpoint
): boolean {
  return rebuildProgress(checkpoint) !== undefined;
}
