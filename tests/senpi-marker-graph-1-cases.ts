import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasDeferredContinuation } from './senpi-internal-state-utils.js';

import {
  getSenpiSessionMarkerPath,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';

import {
  EXACT_MIB_CHAIN,
  ONE_MIB,
  branchParents,
  drainAutomatic,
  linearParents,
  markerOffset,
  senpiExactMiBMessage,
  senpiHeader,
  stripGraph,
  temporaryRoot,
  writeChain,
} from './senpi-marker-graph-utils.js';

describe('senpi accepted-graph marker resume', () => {
  it('matches threaded control on a 40x1MiB off-path branch splice', async () => {
    const root = await temporaryRoot('senpi-branch-40-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    const parents = branchParents(EXACT_MIB_CHAIN, 20);
    await writeChain(sessionPath, parents, true);

    const control = await tailSenpiSession(sessionPath, {
      ...options,
      checkpointMode: 'manual',
    });
    const controlSecond = await tailSenpiSession(sessionPath, {
      ...options,
      checkpointMode: 'manual',
      checkpoint: control.checkpoint,
    });
    const controlThird = await tailSenpiSession(sessionPath, {
      ...options,
      checkpointMode: 'manual',
      checkpoint: controlSecond.checkpoint,
    });
    expect(controlThird.records.map(record => record.key)).toHaveLength(33);

    const auto = await drainAutomatic(sessionPath, options);
    const last = auto.at(-1);
    expect(last).toBeDefined();
    expect(last?.records.map(record => record.key)).toEqual(
      controlThird.records.map(record => record.key)
    );
    const firstAuto = auto[0];
    const rebuild = auto.find(
      result =>
        result !== firstAuto &&
        result.records.length === controlThird.records.length
    );
    expect(rebuild?.mutations[0]?.index).toBeDefined();
    expect(rebuild?.mutations[0]?.removedRecordKeys).toEqual(
      firstAuto?.records
        .map(record => record.key)
        .slice(rebuild?.mutations[0]?.index ?? 0)
    );
  });

  it('blocks commit on a duplicate across a pass boundary and keeps the marker identical', async () => {
    const root = await temporaryRoot('senpi-dup-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    const parents = [...linearParents(16), 'm00000'];
    const { open } = await import('node:fs/promises');
    const handle = await open(sessionPath, 'w');
    try {
      await handle.writeFile(senpiHeader());
      for (let index = 0; index < 16; index += 1) {
        const id = `m${String(index).padStart(5, '0')}`;
        const parent =
          index === 0 ? null : `m${String(index - 1).padStart(5, '0')}`;
        await handle.writeFile(senpiExactMiBMessage(id, parent));
      }
      await handle.writeFile(senpiExactMiBMessage('m00000', 'm00015'));
    } finally {
      await handle.close();
    }

    const first = await tailSenpiSession(sessionPath, options);
    expect(first.records).toHaveLength(16);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
    const before = await readFile(markerPath);
    const second = await tailSenpiSession(sessionPath, options);
    expect(
      second.diagnostics.some(
        item => item.code === 'duplicate_id' || item.code === 'missing_parent'
      )
    ).toBe(true);
    const after = await readFile(markerPath);
    expect(Buffer.compare(before, after)).toBe(0);
    expect(
      second.nextByteOffset === first.nextByteOffset || after.equals(before)
    ).toBe(true);
    void parents;
  });

  it('rebuilds a legacy marker exactly within budget and defers intact beyond it', async () => {
    const root = await temporaryRoot('senpi-legacy-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    await writeChain(sessionPath, linearParents(EXACT_MIB_CHAIN), true);
    await tailSenpiSession(sessionPath, options);
    const before = await stripGraph(sessionPath, options);

    const rebuilt = await tailSenpiSession(sessionPath, options);
    expect(hasDeferredContinuation(rebuilt.checkpoint)).toBe(false);
    expect(rebuilt.records.map(record => record.key)).toHaveLength(40);

    await writeFile(getSenpiSessionMarkerPath(sessionPath, options), before);
    const deferred = await tailSenpiSession(sessionPath, {
      ...options,
      maxLineBytes: 2 * ONE_MIB,
      maxScanBytes: 4 * ONE_MIB + 1,
      maxRebuildBytes: 4 * ONE_MIB + 1,
      maxRebuildLines: 8,
    });
    expect(hasDeferredContinuation(deferred.checkpoint)).toBe(true);
    expect(deferred.records).toEqual([]);
    expect(deferred.mutations).toEqual([]);
    expect(deferred.nextByteOffset).toBe(markerOffset(before));
    const after = await readFile(
      getSenpiSessionMarkerPath(sessionPath, options),
      'utf8'
    );
    expect(after).toBe(before);
  });

  it('omits an over-cap graph, stores [] keys with exact projectedRecordCount, then rebuilds', async () => {
    const root = await temporaryRoot('senpi-overcap-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    await writeChain(sessionPath, linearParents(2100), false);
    const first = await tailSenpiSession(sessionPath, options);
    const marker = await readSenpiSessionMarker(sessionPath, options);
    expect(marker.kind).toBe('valid');
    if (marker.kind !== 'valid') throw new Error('expected marker');
    expect(marker.marker.acceptedEntries).toBeUndefined();
    expect(marker.marker.projectedRecordKeys).toEqual([]);
    expect(marker.marker.projectedRecordCount).toBe(first.records.length);
    expect(first.records.length).toBeGreaterThan(2048);

    const second = await tailSenpiSession(sessionPath, options);
    expect(hasDeferredContinuation(second.checkpoint)).toBe(false);
    expect(second.records.map(record => record.key).length).toBe(2100);
  });
});
