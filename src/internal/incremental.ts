import type { JsonlCursor } from './jsonl-cursor.js';

/** Return the next semantic revision, advancing only for observable state. */
export function checkpointRevision(base: number, changed: boolean): number {
  return changed ? base + 1 : base;
}

/** Compare complete durable byte cursors, including reset identity. */
export function byteCursorsEqual(
  left: JsonlCursor | null,
  right: JsonlCursor | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.offset === right.offset &&
    left.lineNumber === right.lineNumber &&
    left.generation === right.generation &&
    left.headDigest === right.headDigest &&
    left.boundaryDigest === right.boundaryDigest
  );
}

/** True when a cursor scan observed bytes, identity, or generation movement. */
export function byteCursorChanged(
  previous: JsonlCursor | null,
  next: JsonlCursor | null
): boolean {
  return !byteCursorsEqual(previous, next);
}
