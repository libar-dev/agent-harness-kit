import { describe, expect, it } from 'vitest';

import {
  STALE_CHECKPOINT_CONFLICT_CODE,
  StaleCheckpointConflict,
  isStaleCheckpointConflict,
} from '../src/processing/index.js';
import {
  byteCursorsEqual,
  type JsonlCursor,
} from '../src/grok/processing/index.js';

// Cockpit matches stale conflicts on `name`; renaming the class or its name
// field is a CROSS-REPO BREAKING CHANGE.

describe('public stale checkpoint conflict contract', () => {
  it('pins the runtime shape and nominal guard', () => {
    const conflict = new StaleCheckpointConflict({
      expectedRevision: 7,
      actualRevision: 11,
    });

    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.name).toBe('StaleCheckpointConflict');
    expect(conflict.message).toBe(
      'Checkpoint conflict: expected revision 7 but marker is at 11'
    );
    expect(conflict.code).toBe(STALE_CHECKPOINT_CONFLICT_CODE);
    expect(conflict.expectedRevision).toBe(7);
    expect(conflict.actualRevision).toBe(11);
    expect(isStaleCheckpointConflict(conflict)).toBe(true);

    const lookalike = new Error(conflict.message);
    lookalike.name = 'StaleCheckpointConflict';
    expect(isStaleCheckpointConflict(lookalike)).toBe(false);
  });
});

function cursor(overrides: Partial<JsonlCursor> = {}): JsonlCursor {
  return {
    device: 'device-1',
    inode: 'inode-1',
    offset: 128,
    lineNumber: 9,
    generation: 2,
    headDigest: 'head-digest',
    boundaryDigest: 'boundary-digest',
    pending: null,
    ...overrides,
  };
}

type SourceCursors = Readonly<Record<string, JsonlCursor>>;

function sameSourceSet(left: SourceCursors, right: SourceCursors): boolean {
  const leftSources = Object.keys(left).sort();
  const rightSources = Object.keys(right).sort();
  return (
    leftSources.length === rightSources.length &&
    leftSources.every((source, index) => source === rightSources[index])
  );
}

function sourceCursorsEqual(
  left: SourceCursors,
  right: SourceCursors
): boolean {
  return (
    sameSourceSet(left, right) &&
    Object.entries(left).every(([source, leftCursor]) => {
      const rightCursor = right[source];
      return (
        rightCursor !== undefined && byteCursorsEqual(leftCursor, rightCursor)
      );
    })
  );
}

describe('public Grok byte cursor equality contract', () => {
  it('returns true for equal per-source cursors with the same source set', () => {
    const previous: SourceCursors = {
      events: cursor(),
      updates: cursor({ offset: 256, lineNumber: 15 }),
    };
    const next: SourceCursors = {
      events: cursor(),
      updates: cursor({ offset: 256, lineNumber: 15 }),
    };

    expect(sourceCursorsEqual(previous, next)).toBe(true);
  });

  it('treats omitted and null pending as equal', () => {
    const omitted = cursor();
    Reflect.deleteProperty(omitted, 'pending');
    expect(byteCursorsEqual(omitted, cursor({ pending: null }))).toBe(true);
  });

  it.each([
    ['device', { device: 'device-2' }],
    ['inode', { inode: 'inode-2' }],
    ['offset', { offset: 129 }],
    ['lineNumber', { lineNumber: 10 }],
    ['generation', { generation: 3 }],
    ['headDigest', { headDigest: 'changed-head' }],
    ['boundaryDigest', { boundaryDigest: 'changed-boundary' }],
    [
      'pending kind',
      { pending: { kind: 'discarding_oversized', byteStart: 128 } },
    ],
    [
      'pending byteStart',
      { pending: { kind: 'discarding_oversized', byteStart: 129 } },
    ],
  ] as const)('returns false when %s differs', (_field, changed) => {
    expect(byteCursorsEqual(cursor(), cursor(changed))).toBe(false);
  });

  it('returns false when the source sets differ', () => {
    const previous: SourceCursors = { events: cursor(), updates: cursor() };
    const next: SourceCursors = { events: cursor() };

    expect(sourceCursorsEqual(previous, next)).toBe(false);
  });
});
