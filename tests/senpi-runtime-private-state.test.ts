import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getSenpiSessionMarkerPath,
  publicTailResult,
  restoreInternalCheckpoint,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSession } from '../src/senpi/processing/tail.js';
import { tailSenpiSessionInternal } from '../src/senpi/processing/tail-run.js';
import type { SenpiSessionCheckpoint } from '../src/senpi/processing/checkpoint.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

function header(): Record<string, unknown> {
  return {
    type: 'session',
    id: 'session',
    version: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
  };
}

function message(id: string, parentId: string | null): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: id }],
      timestamp: 1,
    },
  };
}

async function fixture(lines: readonly Record<string, unknown>[]): Promise<{
  readonly root: string;
  readonly path: string;
  readonly markerDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'senpi-private-runtime-'));
  roots.push(root);
  const path = join(root, 'session.jsonl');
  const markerDir = join(root, 'markers');
  await writeFile(
    path,
    `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
  );
  return { root, path, markerDir };
}

function expectPublicCheckpoint(checkpoint: SenpiSessionCheckpoint): void {
  expect(Reflect.ownKeys(checkpoint).sort()).toEqual(
    [
      'baseRevision',
      'boundaryDigest',
      'device',
      'generation',
      'headDigest',
      'inode',
      'leafId',
      'lineNumber',
      'offset',
      'projectedRecordKeys',
      'revision',
      'sessionId',
      'sessionPathDigest',
      'state',
    ].sort()
  );
  expect(Reflect.ownKeys(checkpoint.state ?? {})).not.toContain('rebuild');
  const serialized = JSON.stringify(checkpoint);
  expect(serialized).not.toContain('acceptedEntries');
  expect(serialized).not.toContain('projectedRecordCount');
  expect(serialized).not.toContain('"pending"');
  expect(serialized).not.toContain('"rebuild"');
}

describe('Senpi public runtime checkpoint privacy', () => {
  it('returns a recursively declaration-shaped normal checkpoint', async () => {
    const { root, path, markerDir } = await fixture([
      header(),
      message('a', null),
    ]);
    const result = await tailSenpiSession(path, {
      markerDir,
      allowedMarkerRoots: [root],
    });
    expectPublicCheckpoint(result.checkpoint);

    const cloned: SenpiSessionCheckpoint = structuredClone(result.checkpoint);
    await writeFile(
      path,
      `${[header(), message('a', null), message('b', 'a')]
        .map(line => JSON.stringify(line))
        .join('\n')}\n`
    );
    const resumed = await tailSenpiSession(path, {
      markerDir,
      allowedMarkerRoots: [root],
      checkpoint: cloned,
    });
    expect(resumed.records.map(record => record.entryId)).toContain('b');
    expectPublicCheckpoint(resumed.checkpoint);
  });

  it('keeps deferred continuation only in the WeakMap carrier', async () => {
    const lines = [
      header(),
      ...Array.from({ length: 20 }, (_, index) =>
        message(
          `m${String(index)}`,
          index === 0 ? null : `m${String(index - 1)}`
        )
      ),
    ];
    const { root, path, markerDir } = await fixture(lines);
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      maxLineBytes: 1024,
      maxScanBytes: 2048,
      maxScanLines: 2,
      maxRebuildBytes: 4096,
      maxRebuildLines: 4,
    } as const;
    await tailSenpiSessionInternal(path, options);
    const markerPath = getSenpiSessionMarkerPath(path, options);
    const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(marker)) throw new Error('expected marker object');
    delete marker['acceptedEntries'];
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    const internal = await tailSenpiSessionInternal(path, options);
    const result = publicTailResult(internal);
    expectPublicCheckpoint(result.checkpoint);
    expect(
      restoreInternalCheckpoint(result.checkpoint).state?.rebuild
    ).toBeDefined();

    const cloned: SenpiSessionCheckpoint = structuredClone(result.checkpoint);
    const fallback = restoreInternalCheckpoint(cloned);
    expect(fallback.acceptedEntries).toBeUndefined();
    expect(fallback.projectedRecordCount).toBeUndefined();
    expect(fallback.pending).toBeNull();
    expect(fallback.state?.rebuild).toBeUndefined();
  });

  it('rebuilds cloned and JSON-roundtripped deferred checkpoints exactly', async () => {
    for (const roundTrip of ['structured', 'json'] as const) {
      const lines = [
        header(),
        ...Array.from({ length: 20 }, (_, index) =>
          message(
            `c${String(index)}`,
            index === 0 ? null : `c${String(index - 1)}`
          )
        ),
      ];
      const { root, path, markerDir } = await fixture(lines);
      const privateOptions = {
        markerDir,
        allowedMarkerRoots: [root],
        maxLineBytes: 1024,
        maxScanBytes: 2048,
        maxScanLines: 2,
        maxRebuildBytes: 4096,
        maxRebuildLines: 4,
      } as const;
      await tailSenpiSessionInternal(path, privateOptions);
      const markerPath = getSenpiSessionMarkerPath(path, privateOptions);
      const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
      if (!isRecord(marker)) throw new Error('expected marker object');
      delete marker['acceptedEntries'];
      await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
      const deferred = publicTailResult(
        await tailSenpiSessionInternal(path, privateOptions)
      );
      const checkpoint =
        roundTrip === 'structured'
          ? structuredClone(deferred.checkpoint)
          : parseCheckpoint(JSON.stringify(deferred.checkpoint));

      const resumed = await tailSenpiSession(path, {
        markerDir,
        allowedMarkerRoots: [root],
        checkpoint,
      });
      expect(
        resumed.records.map(record => record.entryId),
        JSON.stringify(resumed.diagnostics)
      ).toHaveLength(20);
      expect(
        resumed.diagnostics.some(item => item.code === 'duplicate_id')
      ).toBe(false);
      expect(resumed.nextByteOffset).toBe(resumed.fileSize);
      const committed: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
      if (!isRecord(committed)) throw new Error('expected committed marker');
      expect(committed['offset']).toBe(resumed.nextByteOffset);
      expect(resumed.nextByteOffset).toBeGreaterThan(deferred.nextByteOffset);
      expectPublicCheckpoint(resumed.checkpoint);
    }
  });
});

function parseCheckpoint(serialized: string): SenpiSessionCheckpoint {
  const value: unknown = JSON.parse(serialized);
  if (!isSerializedCheckpoint(value)) {
    throw new Error('expected serialized checkpoint');
  }
  return value;
}

function isSerializedCheckpoint(
  value: unknown
): value is SenpiSessionCheckpoint {
  return (
    isRecord(value) &&
    typeof value['sessionPathDigest'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['device'] === 'string' &&
    typeof value['inode'] === 'string' &&
    typeof value['generation'] === 'number' &&
    typeof value['offset'] === 'number' &&
    typeof value['lineNumber'] === 'number' &&
    typeof value['headDigest'] === 'string' &&
    typeof value['boundaryDigest'] === 'string' &&
    typeof value['baseRevision'] === 'number' &&
    (value['leafId'] === null || typeof value['leafId'] === 'string') &&
    Array.isArray(value['projectedRecordKeys']) &&
    value['projectedRecordKeys'].every(key => typeof key === 'string') &&
    (value['state'] === undefined || isRecord(value['state']))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
