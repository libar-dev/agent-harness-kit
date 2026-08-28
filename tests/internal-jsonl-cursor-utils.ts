import type { PathLike } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { vi } from 'vitest';

import type { JsonlCursor } from '../src/internal/jsonl-cursor.js';

/** One observed real FileHandle read request and completion. */
export interface TrackedFileRead {
  readonly position: number;
  readonly requestedBytes: number;
  readonly actualBytes: number;
}

interface IoTestState {
  targetPath: string;
  appendAfterStat: Buffer<ArrayBuffer>;
  truncateAfterStat: number | null;
  trackingPath: string;
  reads: TrackedFileRead[];
}

const ioState = vi.hoisted(
  (): IoTestState => ({
    targetPath: '',
    appendAfterStat: Buffer.alloc(0),
    truncateAfterStat: null,
    trackingPath: '',
    reads: [],
  })
);

/** Configure one append immediately after the matching file's stat snapshot. */
export function configureSnapshotRace(
  path: string,
  appended: Buffer<ArrayBuffer>
): void {
  ioState.targetPath = path;
  ioState.appendAfterStat = appended;
}

/** Track reads and truncate only after the open handle snapshots the old size. */
export function configureReadTracking(
  path: string,
  truncateAfterStat: number
): void {
  ioState.targetPath = path;
  ioState.trackingPath = path;
  ioState.truncateAfterStat = truncateAfterStat;
  ioState.reads = [];
}

/** Return an immutable copy of real FileHandle read observations. */
export function trackedFileReads(): readonly TrackedFileRead[] {
  return [...ioState.reads];
}

/** Clear configured stat races and read tracking. */
export function resetSnapshotRace(): void {
  ioState.targetPath = '';
  ioState.appendAfterStat = Buffer.alloc(0);
  ioState.truncateAfterStat = null;
  ioState.trackingPath = '';
  ioState.reads = [];
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: async (path: PathLike, flags: string): Promise<FileHandle> => {
      const handle = await actual.open(path, flags);
      const resolvedPath = String(path);
      if (
        resolvedPath !== ioState.targetPath &&
        resolvedPath !== ioState.trackingPath
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (): Promise<
              Awaited<ReturnType<FileHandle['stat']>>
            > => {
              const snapshot = await target.stat();
              if (ioState.appendAfterStat.byteLength > 0) {
                const appended = ioState.appendAfterStat;
                ioState.appendAfterStat = Buffer.alloc(0);
                await actual.appendFile(path, appended);
              }
              if (ioState.truncateAfterStat !== null) {
                const size = ioState.truncateAfterStat;
                ioState.truncateAfterStat = null;
                await actual.truncate(path, size);
              }
              return snapshot;
            };
          }
          if (property === 'read') {
            return async (
              buffer: Buffer<ArrayBuffer>,
              offset: number,
              length: number,
              position: number
            ): Promise<{ bytesRead: number; buffer: Buffer<ArrayBuffer> }> => {
              const result = await target.read(
                buffer,
                offset,
                length,
                position
              );
              if (resolvedPath === ioState.trackingPath) {
                ioState.reads.push({
                  position,
                  requestedBytes: length,
                  actualBytes: result.bytesRead,
                });
              }
              return result;
            };
          }
          if (property === 'close') return target.close.bind(target);
          if (property === 'then') return undefined;
          throw new Error(`Unexpected FileHandle property ${String(property)}`);
        },
      });
    },
  };
});

/** Narrow an unknown serialized value to the cursor shape used by tests. */
export function isJsonlCursor(value: unknown): value is JsonlCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'device' in value &&
    typeof value.device === 'string' &&
    'inode' in value &&
    typeof value.inode === 'string' &&
    'offset' in value &&
    typeof value.offset === 'number' &&
    'lineNumber' in value &&
    typeof value.lineNumber === 'number' &&
    'generation' in value &&
    typeof value.generation === 'number' &&
    'headDigest' in value &&
    typeof value.headDigest === 'string' &&
    'boundaryDigest' in value &&
    typeof value.boundaryDigest === 'string' &&
    (!('pending' in value) ||
      value.pending === null ||
      (typeof value.pending === 'object' &&
        value.pending !== null &&
        'kind' in value.pending &&
        value.pending.kind === 'discarding_oversized' &&
        'byteStart' in value.pending &&
        typeof value.pending.byteStart === 'number'))
  );
}
