import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'vitest';

import {
  hasDeferredContinuation,
  internalCheckpoint,
} from './senpi-internal-state-utils.js';

import { getSenpiSessionMarkerPath } from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';

/** Test fixture contract consumed by bounded graph regression cases. */
export const ONE_MIB = 1024 * 1024;
/** Test fixture contract consumed by bounded graph regression cases. */
export const EXACT_MIB_CHAIN = 40;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true }))
  );
});

/** Test fixture contract consumed by bounded graph regression cases. */
export async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function senpiHeader(): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0007',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/Users/fixture-user/projects/demo',
  })}\n`;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function senpiMessage(
  id: string,
  parentId: string | null,
  text: string
): string {
  return `${JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1704067201000,
    },
  })}\n`;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function senpiExactMiBMessage(
  id: string,
  parentId: string | null
): string {
  const empty = senpiMessage(id, parentId, '');
  const pad = ONE_MIB - Buffer.byteLength(empty);
  if (pad < 0) throw new Error('Senpi message header exceeds 1 MiB');
  const line = senpiMessage(id, parentId, 'x'.repeat(pad));
  if (Buffer.byteLength(line) !== ONE_MIB) {
    throw new Error('Senpi message is not exactly 1 MiB');
  }
  return line;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function senpiCompaction(id: string, parentId: string): string {
  return `${JSON.stringify({
    type: 'compaction',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:08.000Z',
    summary: 'Compacted branch context.',
    tokensBefore: 100,
    retainedTail: [],
  })}\n`;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export async function writeChain(
  path: string,
  parents: readonly (string | null)[],
  exactMiB: boolean
): Promise<readonly string[]> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'w');
  const ids: string[] = [];
  try {
    await handle.writeFile(senpiHeader());
    const batch: string[] = [];
    for (let index = 0; index < parents.length; index += 1) {
      const id = `m${String(index).padStart(5, '0')}`;
      ids.push(id);
      const parent = parents[index] ?? null;
      batch.push(
        exactMiB
          ? senpiExactMiBMessage(id, parent)
          : senpiMessage(id, parent, `t-${String(index)}`)
      );
      if (batch.length === 4) {
        await handle.writeFile(batch.join(''));
        batch.length = 0;
      }
    }
    if (batch.length > 0) await handle.writeFile(batch.join(''));
  } finally {
    await handle.close();
  }
  return ids;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function linearParents(count: number): readonly (string | null)[] {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? null : `m${String(index - 1).padStart(5, '0')}`
  );
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function branchParents(
  count: number,
  forkAt: number
): readonly (string | null)[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return null;
    if (index === forkAt) {
      return `m${String(Math.max(0, forkAt - 8)).padStart(5, '0')}`;
    }
    return `m${String(index - 1).padStart(5, '0')}`;
  });
}

/** Test fixture contract consumed by bounded graph regression cases. */
export function markerOffset(raw: string): number {
  const decoded: unknown = JSON.parse(raw);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('offset' in decoded) ||
    typeof decoded.offset !== 'number'
  ) {
    throw new Error('marker offset missing');
  }
  return decoded.offset;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export async function stripGraph(
  sessionPath: string,
  options: {
    readonly markerDir?: string;
    readonly allowedMarkerRoots?: readonly string[];
  }
): Promise<string> {
  const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
  const decoded: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('marker JSON is not an object');
  }
  const parsed: Record<string, unknown> = { ...decoded };
  delete parsed['acceptedEntries'];
  delete parsed['projectedRecordCount'];
  const stripped = JSON.stringify(parsed, null, 2);
  await writeFile(markerPath, stripped);
  return stripped;
}

/** Test fixture contract consumed by bounded graph regression cases. */
export async function drainAutomatic(
  sessionPath: string,
  options: {
    readonly markerDir?: string;
    readonly allowedMarkerRoots?: readonly string[];
  },
  maxPasses = 8
): Promise<readonly Awaited<ReturnType<typeof tailSenpiSession>>[]> {
  const results = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await tailSenpiSession(sessionPath, options);
    results.push(result);
    if (
      result.nextByteOffset >= result.fileSize &&
      (internalCheckpoint(result.checkpoint).pending ?? null) === null &&
      !hasDeferredContinuation(result.checkpoint)
    ) {
      break;
    }
  }
  return results;
}
