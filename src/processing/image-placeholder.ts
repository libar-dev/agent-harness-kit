/**
 * Safe placeholders for image content blocks.
 */

import { isRecord } from '../utils/index.js';

/**
 * Return a safe placeholder for image content blocks.
 *
 * Arrays are normalized to the generic placeholder even though the shared
 * `isRecord()` helper accepts them, because image `source` is expected to be a
 * plain object with an optional safe `media_type` field.
 */
export function imagePlaceholder(source: unknown): string {
  if (!isRecord(source) || Array.isArray(source)) return '[Image]';
  const mediaType = source['media_type'];
  if (!isSafeMediaType(mediaType)) return '[Image]';
  return `[Image: ${mediaType}]`;
}

function isSafeMediaType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value)
  );
}
