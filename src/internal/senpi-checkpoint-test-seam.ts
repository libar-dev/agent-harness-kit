/** Reveal carrier operations only to unbarreled bounded-continuation tests. */
export {
  publicCheckpoint,
  publicTailResult,
  restoreInternalCheckpoint,
} from '../senpi/processing/checkpoint-carrier.js';
/** Marker byte bound asserted by hostile-file integration tests. */
export { SENPI_MARKER_MAX_BYTES } from '../senpi/processing/accepted-graph.js';
/** Private checkpoint and marker shapes used for internal state assertions. */
export type {
  InternalSenpiSessionCheckpoint,
  InternalSenpiSessionMarker,
} from '../senpi/processing/checkpoint-internal-types.js';
/** Resolve the exact marker file inspected by integration tests. */
export { getSenpiSessionMarkerPath } from '../senpi/processing/checkpoint-path.js';
/** Parse and read markers without erasing private fields inside tests. */
export {
  parseSenpiSessionMarkerInternal,
  readSenpiSessionMarkerInternal,
} from '../senpi/processing/checkpoint-read.js';
/** Marker schema version pinned by compatibility tests. */
export { SENPI_MARKER_VERSION } from '../senpi/processing/checkpoint-types.js';
/** Exercise explicit private over-cap rejection without widening public types. */
export { commitSenpiSessionCheckpointInternal } from '../senpi/processing/checkpoint-write.js';
