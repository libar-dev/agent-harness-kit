import { describe, expect, it } from 'vitest';

import { byteCursorsEqual } from '../src/internal/incremental.js';
import type { JsonlCursor } from '../src/internal/jsonl-cursor.js';

function cursor(overrides: Partial<JsonlCursor> = {}): JsonlCursor {
  return {
    device: '1',
    inode: '2',
    offset: 10,
    lineNumber: 2,
    generation: 0,
    headDigest: 'aa',
    boundaryDigest: 'bb',
    ...overrides,
  };
}

describe('byteCursorsEqual pending', () => {
  it('treats omitted pending and null pending as the same cursor', () => {
    const omitted = cursor();
    const explicitNull = cursor({ pending: null });
    expect(byteCursorsEqual(omitted, explicitNull)).toBe(true);
  });

  it('distinguishes a discarding pending from a clear cursor at the same offset', () => {
    const clear = cursor({ pending: null });
    const pending = cursor({
      pending: { kind: 'discarding_oversized', byteStart: 0 },
    });
    expect(byteCursorsEqual(clear, pending)).toBe(false);
    expect(byteCursorsEqual(pending, pending)).toBe(true);
  });

  it('distinguishes pending byteStart values', () => {
    const left = cursor({
      pending: { kind: 'discarding_oversized', byteStart: 0 },
    });
    const right = cursor({
      pending: { kind: 'discarding_oversized', byteStart: 4 },
    });
    expect(byteCursorsEqual(left, right)).toBe(false);
  });
});
