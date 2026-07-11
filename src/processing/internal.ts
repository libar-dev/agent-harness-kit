/**
 * Shared CLI / test import surface.
 *
 * Parser and formatter helpers stay outside the public barrel. Marker helpers
 * provide the CLI and tests with the same operations exposed to library
 * consumers by `./processing`.
 */

export { parseJsonlContent, parseSessionContent } from './parser.js';

export { mergeTimeline } from './formatter.js';

export { readMarker, writeMarker, getMarkerPath } from './tail.js';
