import type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionCheckpointState,
  InternalSenpiSessionMarker,
} from './checkpoint-internal-types.js';
import type {
  SenpiSessionCheckpoint,
  SenpiSessionCheckpointState,
  SenpiSessionMarker,
} from './checkpoint-types.js';
import type { SenpiSessionTailResult } from './tail-types.js';

interface PrivateCheckpointFields {
  readonly acceptedEntries: InternalSenpiSessionCheckpoint['acceptedEntries'];
  readonly pending: InternalSenpiSessionCheckpoint['pending'];
  readonly projectedRecordCount: InternalSenpiSessionCheckpoint['projectedRecordCount'];
  readonly rebuild: InternalSenpiSessionCheckpointState['rebuild'];
}

const privateCheckpointFields = new WeakMap<
  SenpiSessionCheckpoint,
  PrivateCheckpointFields
>();

/**
 * Create a declaration-shaped checkpoint and retain private continuation in memory.
 *
 * @param checkpoint - Internal checkpoint produced by one bounded pass.
 * @returns A recursively public checkpoint with no private own keys.
 */
export function publicCheckpoint(
  checkpoint: InternalSenpiSessionCheckpoint
): SenpiSessionCheckpoint {
  const {
    acceptedEntries,
    pending,
    projectedRecordCount,
    state,
    ...publicFields
  } = checkpoint;
  let publicState: SenpiSessionCheckpointState | undefined;
  let rebuild: InternalSenpiSessionCheckpointState['rebuild'];
  if (state !== undefined) {
    const { rebuild: privateRebuild, ...visibleState } = state;
    rebuild = privateRebuild;
    publicState = visibleState;
  }
  const result: SenpiSessionCheckpoint = {
    ...publicFields,
    ...(publicState === undefined ? {} : { state: publicState }),
  };
  privateCheckpointFields.set(result, {
    acceptedEntries,
    pending,
    projectedRecordCount,
    rebuild,
  });
  return result;
}

/**
 * Restore private state when available, or safely treat a clone as absent-state.
 *
 * @param checkpoint - Public checkpoint, possibly cloned or deserialized.
 * @returns Internal continuation with conservative defaults for absent private state.
 */
export function restoreInternalCheckpoint(
  checkpoint: SenpiSessionCheckpoint
): InternalSenpiSessionCheckpoint {
  const internal: InternalSenpiSessionCheckpoint = checkpoint;
  const retained = privateCheckpointFields.get(checkpoint);
  const hasPrivateOwnState =
    Object.hasOwn(checkpoint, 'acceptedEntries') ||
    Object.hasOwn(checkpoint, 'pending') ||
    Object.hasOwn(checkpoint, 'projectedRecordCount') ||
    Object.hasOwn(checkpoint.state ?? {}, 'rebuild');
  const privateFields: PrivateCheckpointFields = retained ?? {
    acceptedEntries: internal.acceptedEntries,
    pending: internal.pending,
    projectedRecordCount: internal.projectedRecordCount,
    rebuild: internal.state?.rebuild,
  };
  // A clone has neither its WeakMap entry nor private own fields. Its exposed
  // semantic state may describe bytes beyond the held marker offset, so using
  // it incrementally could replay duplicate IDs. Dropping state forces the
  // marker/graph path to perform an exact bounded rebuild from byte zero.
  const state: InternalSenpiSessionCheckpointState | undefined =
    retained === undefined && !hasPrivateOwnState
      ? undefined
      : checkpoint.state === undefined
        ? undefined
        : {
            ...checkpoint.state,
            ...(privateFields.rebuild === undefined
              ? {}
              : { rebuild: privateFields.rebuild }),
          };
  const {
    acceptedEntries: _acceptedEntries,
    pending: _pending,
    projectedRecordCount: _projectedRecordCount,
    state: _state,
    ...checkpointFields
  } = internal;
  return {
    ...checkpointFields,
    pending: privateFields.pending ?? null,
    ...(privateFields.acceptedEntries === undefined
      ? {}
      : { acceptedEntries: privateFields.acceptedEntries }),
    ...(privateFields.projectedRecordCount === undefined
      ? {}
      : { projectedRecordCount: privateFields.projectedRecordCount }),
    ...(state === undefined ? {} : { state }),
  };
}

/** Remove private marker fields before returning a public marker result. */
export function publicMarker(
  marker: InternalSenpiSessionMarker
): SenpiSessionMarker {
  const {
    acceptedEntries: _acceptedEntries,
    pending: _pending,
    projectedRecordCount: _projectedRecordCount,
    ...visible
  } = marker;
  return visible;
}

/** Remove private checkpoint fields from a public tail result. */
export function publicTailResult(
  result: SenpiSessionTailResult
): SenpiSessionTailResult {
  return {
    ...result,
    checkpoint: publicCheckpoint(result.checkpoint),
  };
}
