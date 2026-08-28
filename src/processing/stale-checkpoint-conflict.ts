/**
 * One exported stale-checkpoint conflict used by every kit checkpoint writer.
 *
 * Consumers must identify this error by {@link isStaleCheckpointConflict} or
 * `instanceof` plus {@link STALE_CHECKPOINT_CONFLICT_CODE} and the structured
 * revision fields. Error prose is not part of the machine contract.
 */

/** Stable machine-consumed code on every {@link StaleCheckpointConflict}. */
export const STALE_CHECKPOINT_CONFLICT_CODE = 'stale_checkpoint_conflict';

/**
 * A checkpoint commit lost the revision race against the current marker.
 *
 * `expectedRevision` is the `baseRevision` the caller presented.
 * `actualRevision` is the revision persisted on the marker (0 when absent).
 */
export class StaleCheckpointConflict extends Error {
  readonly code: typeof STALE_CHECKPOINT_CONFLICT_CODE =
    STALE_CHECKPOINT_CONFLICT_CODE;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  /**
   * @param fields - Expected caller revision and actual marker revision.
   * @throws If either revision is not a safe nonnegative integer.
   */
  constructor(fields: {
    readonly expectedRevision: number;
    readonly actualRevision: number;
  }) {
    if (
      !isSafeNonnegativeInteger(fields.expectedRevision) ||
      !isSafeNonnegativeInteger(fields.actualRevision)
    ) {
      throw new TypeError(
        'StaleCheckpointConflict revisions must be safe nonnegative integers'
      );
    }
    super(
      `Checkpoint conflict: expected revision ${fields.expectedRevision} but marker is at ${fields.actualRevision}`
    );
    this.name = 'StaleCheckpointConflict';
    this.expectedRevision = fields.expectedRevision;
    this.actualRevision = fields.actualRevision;
  }
}

/**
 * Narrow an unknown thrown value to a well-formed stale-checkpoint conflict.
 *
 * Rejects lookalike `Error` instances, duck-typed objects, and instances
 * whose `code` or revision fields have been tampered into a non-integer or
 * non-code shape. Those values are neither a conflict nor a success.
 *
 * @param error - Unknown thrown value or probe stand-in.
 * @returns Whether `error` is a {@link StaleCheckpointConflict} with valid fields.
 */
export function isStaleCheckpointConflict(
  error: unknown
): error is StaleCheckpointConflict {
  if (!(error instanceof StaleCheckpointConflict)) {
    return false;
  }
  return (
    error.code === STALE_CHECKPOINT_CONFLICT_CODE &&
    isSafeNonnegativeInteger(error.expectedRevision) &&
    isSafeNonnegativeInteger(error.actualRevision)
  );
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
