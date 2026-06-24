/**
 * Internal / test import surface.
 *
 * These are deliberately kept out of the public barrel (`index.ts`) but are
 * exported here so tests (and internal callers) can still reach them:
 *
 * - parseJsonlContent / parseSessionContent / mergeTimeline are retained as the
 *   internal/test surface for functions that were removed from the public API.
 * - getMarkerPath / writeMarker are the CLI's runtime dependency (the shipped
 *   tail CLI consumes them); readMarker rounds out the marker trio for tests.
 */

export { parseJsonlContent, parseSessionContent } from './parser.js';

export { mergeTimeline } from './formatter.js';

export { readMarker, writeMarker, getMarkerPath } from './tail.js';
