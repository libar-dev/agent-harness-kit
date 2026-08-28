import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hasDeferredContinuation,
  rebuildProgress,
} from './senpi-internal-state-utils.js';

import {
  SENPI_MARKER_MAX_BYTES,
  SENPI_MARKER_VERSION,
  commitSenpiSessionCheckpointInternal as commitSenpiSessionCheckpoint,
  getSenpiSessionMarkerPath,
  parseSenpiSessionMarkerInternal as parseSenpiSessionMarker,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';

import {
  ONE_MIB,
  linearParents,
  markerOffset,
  senpiHeader,
  senpiMessage,
  stripGraph,
  temporaryRoot,
  writeChain,
} from './senpi-marker-graph-utils.js';

describe('senpi accepted-graph marker resume', () => {
  it('cannot produce or read a marker larger than 1MiB for hostile 20k x 2KiB ids', async () => {
    const root = await temporaryRoot('senpi-hostile-ids-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    const { open } = await import('node:fs/promises');
    const handle = await open(sessionPath, 'w');
    try {
      await handle.writeFile(senpiHeader());
      const batch: string[] = [];
      let parent: string | null = null;
      for (let index = 0; index < 20_000; index += 1) {
        const id = `h${String(index).padStart(5, '0')}${'y'.repeat(2048)}`;
        batch.push(senpiMessage(id, parent, 'z'));
        parent = id;
        if (batch.length === 250) {
          await handle.writeFile(batch.join(''));
          batch.length = 0;
        }
      }
      if (batch.length > 0) await handle.writeFile(batch.join(''));
    } finally {
      await handle.close();
    }
    const rssBefore = process.memoryUsage().rss;
    const first = await tailSenpiSession(sessionPath, options);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
    const markerStat = await stat(markerPath);
    expect(markerStat.size).toBeLessThanOrEqual(SENPI_MARKER_MAX_BYTES);
    const rssAfter = process.memoryUsage().rss;
    expect(rssAfter - rssBefore).toBeLessThan(512 * ONE_MIB);
    const reread = await readSenpiSessionMarker(sessionPath, options);
    expect(reread.kind).toBe('valid');
    if (reread.kind !== 'valid') throw new Error('expected valid marker');
    expect(reread.marker.acceptedEntries).toBeUndefined();
    expect(reread.marker.projectedRecordKeys).toEqual([]);
    expect(reread.marker.projectedRecordCount).toBe(first.records.length);
    expect(SENPI_MARKER_VERSION).toBe(1);
  });

  it('defers a 128MiB+ automatic rebuild then completes from the threaded checkpoint', async () => {
    const root = await temporaryRoot('senpi-128mib-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    await writeChain(sessionPath, linearParents(129), true);
    await tailSenpiSession(sessionPath, options);
    const before = await stripGraph(sessionPath, options);
    const deferred = await tailSenpiSession(sessionPath, options);
    expect(hasDeferredContinuation(deferred.checkpoint)).toBe(true);
    expect(deferred.records).toEqual([]);
    expect(deferred.nextByteOffset).toBe(markerOffset(before));
    expect(
      await readFile(getSenpiSessionMarkerPath(sessionPath, options), 'utf8')
    ).toBe(before);
    expect(rebuildProgress(deferred.checkpoint)).toBeDefined();

    let current = deferred;
    for (let pass = 0; pass < 6; pass += 1) {
      current = await tailSenpiSession(sessionPath, {
        ...options,
        checkpoint: current.checkpoint,
      });
      if (!hasDeferredContinuation(current.checkpoint)) {
        break;
      }
    }
    expect(hasDeferredContinuation(current.checkpoint)).toBe(false);
    expect(current.records.map(record => record.key)).toHaveLength(129);
  });

  it('rejects an over-cap graph on explicit commit and never silently truncates', async () => {
    const root = await temporaryRoot('senpi-explicit-graph-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(sessionPath, senpiHeader());
    const first = await tailSenpiSession(sessionPath, {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual',
    });
    const overGraph = Array.from({ length: 2049 }, (_, i) => ({
      id: `g${String(i)}`,
      p: i === 0 ? null : `g${String(i - 1)}`,
    }));
    await expect(
      commitSenpiSessionCheckpoint(
        sessionPath,
        { ...first.checkpoint, acceptedEntries: overGraph },
        { markerDir, allowedMarkerRoots: [root] }
      )
    ).rejects.toThrow(/acceptedEntries/);
  });

  it('parses a legacy v1 marker without a graph as valid absent-state', async () => {
    const checkpoint = {
      sessionPathDigest: 'a'.repeat(64),
      sessionId: 's',
      device: '1',
      inode: '2',
      generation: 0,
      offset: 4,
      lineNumber: 2,
      headDigest: 'h'.repeat(64),
      boundaryDigest: 'b'.repeat(64),
      revision: 1,
      leafId: 'leaf',
      projectedRecordKeys: ['leaf'],
      markerVersion: 1,
      pending: null,
    };
    const parsed = parseSenpiSessionMarker(checkpoint);
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid');
    expect(parsed.marker.acceptedEntries).toBeUndefined();
    expect(parsed.marker.projectedRecordCount).toBeUndefined();
    expect(parsed.marker.markerVersion).toBe(1);
  });
});
