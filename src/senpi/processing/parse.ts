import { z } from 'zod';

import {
  SENPI_ENTRY_TAGS,
  senpiSessionEntrySchema,
  type SenpiSessionEntry,
} from '../types.js';

/**
 * Tree-link fields shared by every non-header entry. Unknown tags that still
 * satisfy this base remain tree participants under the parse policy.
 */
const senpiUnknownEntrySchema = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  timestamp: z.string(),
});

/** Peek-only: dispatch on `type` without requiring the rest of the payload. */
const entryTagPeekSchema = z.looseObject({
  type: z.string(),
});

const KNOWN_ENTRY_TAGS: ReadonlySet<string> = new Set([
  'session',
  ...SENPI_ENTRY_TAGS,
]);

/**
 * An unknown-tag entry whose base `{type,id,parentId,timestamp}` validated.
 * Extra fields survive via `z.looseObject` so later projection can keep them.
 */
export type SenpiUnknownEntry = z.infer<typeof senpiUnknownEntrySchema>;

/**
 * Result of parsing one decoded session JSONL record.
 *
 * - `known`: session header or one of the 9 known non-header tags.
 * - `unknown`: any other tag whose base fields still validate (tree participant).
 * - `invalid`: malformed known tag, missing tag, or base-invalid line.
 */
export type SenpiEntryParseResult =
  | { kind: 'known'; entry: SenpiSessionEntry }
  | { kind: 'unknown'; tag: string; entry: SenpiUnknownEntry; raw: unknown }
  | { kind: 'invalid'; error: string; raw: unknown };

/**
 * Parses one decoded session JSONL record without throwing.
 *
 * Tag-peek dispatch: first read `type`, then either the known-entry union or
 * the unknown-entry base schema. Known tags that fail their branch schema are
 * invalid rather than being downgraded. Unknown tags with a valid base stay
 * tree participants. Hostile or non-object input is always `invalid`.
 *
 * @param raw Decoded JSON value from one session JSONL line.
 * @returns A known entry, unknown tree-joining entry, or validation failure.
 */
export function parseSenpiEntry(raw: unknown): SenpiEntryParseResult {
  const tagResult = entryTagPeekSchema.safeParse(raw);
  if (!tagResult.success) {
    return { kind: 'invalid', error: tagResult.error.message, raw };
  }

  const tag = tagResult.data.type;
  if (!KNOWN_ENTRY_TAGS.has(tag)) {
    const unknownResult = senpiUnknownEntrySchema.safeParse(raw);
    if (!unknownResult.success) {
      return { kind: 'invalid', error: unknownResult.error.message, raw };
    }
    return {
      kind: 'unknown',
      tag,
      entry: unknownResult.data,
      raw,
    };
  }

  const knownResult = senpiSessionEntrySchema.safeParse(raw);
  if (!knownResult.success) {
    return { kind: 'invalid', error: knownResult.error.message, raw };
  }
  return { kind: 'known', entry: knownResult.data };
}
