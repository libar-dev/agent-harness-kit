import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SenpiSessionTailResult } from '../src/senpi/processing/tail.js';
import {
  watchSenpiSessionInternal,
  type SenpiWatchCycle,
} from '../src/senpi/processing/watch.js';
import {
  createManualClock,
  createSignal,
  waitForSignal,
} from './senpi-watch-clock-utils.js';

import {
  hasDeferredContinuation,
  rebuildProgress,
} from './senpi-internal-state-utils.js';

import {
  getSenpiSessionMarkerPath,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';

import {
  ONE_MIB,
  drainAutomatic,
  linearParents,
  senpiCompaction,
  senpiHeader,
  senpiMessage,
  stripGraph,
  temporaryRoot,
  writeChain,
} from './senpi-marker-graph-utils.js';

describe('senpi accepted-graph marker resume', () => {
  it('treats a planted 2MiB marker as bounded-invalid without unbounded allocation', async () => {
    const root = await temporaryRoot('senpi-2mib-marker-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    await writeFile(
      sessionPath,
      `${senpiHeader()}${senpiMessage('a', null, 'hi')}`
    );
    await tailSenpiSession(sessionPath, options);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
    await writeFile(markerPath, `${'x'.repeat(2 * ONE_MIB)}`);
    const rssBefore = process.memoryUsage().rss;
    const read = await readSenpiSessionMarker(sessionPath, options);
    const rssAfter = process.memoryUsage().rss;
    expect(read.kind).toBe('invalid');
    expect(rssAfter - rssBefore).toBeLessThan(8 * ONE_MIB);
    const result = await tailSenpiSession(sessionPath, options);
    expect(result.reset).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'checkpoint_invalid' }),
      ])
    );
  });

  it('rebuilds exactly after a suffix compaction', async () => {
    const root = await temporaryRoot('senpi-compact-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };
    await writeChain(sessionPath, linearParents(20), true);
    await drainAutomatic(sessionPath, options);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(sessionPath, senpiCompaction('comp-1', 'm00019'));
    const compacted = await tailSenpiSession(sessionPath, options);
    expect(compacted.records.map(record => record.key)).toEqual(['comp-1']);
    expect(hasDeferredContinuation(compacted.checkpoint)).toBe(false);
  });

  it('advances a cold watch through exact deferred rebuild states before commit', async () => {
    const root = await temporaryRoot('senpi-watch-defer-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    const caps = {
      markerDir,
      allowedMarkerRoots: [root],
      maxLineBytes: 1024,
      maxScanBytes: 2048,
      maxScanLines: 2,
      maxRebuildBytes: 4096,
      maxRebuildLines: 4,
    };
    await writeChain(sessionPath, linearParents(20), false);
    await tailSenpiSession(sessionPath, caps);
    await stripGraph(sessionPath, caps);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, caps);
    const markerBefore = await readFile(markerPath, 'utf8');

    const clock = createManualClock();
    const reconciled = createSignal<SenpiSessionTailResult>();
    const cycles = createSignal<SenpiWatchCycle>();
    const controller = new AbortController();
    const iterator = watchSenpiSessionInternal(sessionPath, {
      ...caps,
      signal: controller.signal,
      quiescenceMs: 1_000,
      coalesceMs: 5,
      pollMs: 20,
      clock,
      onTailResult: result => reconciled.emit(result),
      onCycle: cycle => cycles.emit(cycle),
    });

    const firstResult = waitForSignal(reconciled, () => true);
    const ready = iterator.next();
    const first = await firstResult;
    expect((await ready).value?.type).toBe('ready');
    const firstProgress = rebuildProgress(first.checkpoint);
    expect(firstProgress?.scannedLines).toBe(4);
    expect(await readFile(markerPath, 'utf8')).toBe(markerBefore);

    const initialWaiting = waitForSignal(
      cycles,
      cycle => cycle.type === 'waiting'
    );
    const nextEvent = iterator.next();
    await initialWaiting;
    const offsets = [firstProgress?.cursor.offset ?? 0];
    const scanned = [firstProgress?.scannedLines ?? 0];
    for (const expectedLines of [8, 12, 16, 20]) {
      const nextResult = waitForSignal(reconciled, () => true);
      const nextWaiting = waitForSignal(
        cycles,
        cycle => cycle.type === 'waiting'
      );
      clock.advanceBy(20);
      const partial = await nextResult;
      const progress = rebuildProgress(partial.checkpoint);
      expect(progress?.scannedLines).toBe(expectedLines);
      offsets.push(progress?.cursor.offset ?? 0);
      scanned.push(progress?.scannedLines ?? 0);
      expect(await readFile(markerPath, 'utf8')).toBe(markerBefore);
      await nextWaiting;
    }
    expect(
      offsets.slice(1).every((offset, index) => {
        const previous = offsets[index];
        return previous !== undefined && offset > previous;
      })
    ).toBe(true);
    expect(scanned).toEqual([4, 8, 12, 16, 20]);

    const completedResult = waitForSignal(reconciled, () => true);
    clock.advanceBy(20);
    const completed = await completedResult;
    expect(hasDeferredContinuation(completed.checkpoint)).toBe(false);
    expect(completed.records).toHaveLength(20);
    const yielded = await nextEvent;
    expect(yielded.value?.type).toBe('result');
    expect(await readFile(markerPath, 'utf8')).not.toBe(markerBefore);

    const closed = waitForSignal(cycles, cycle => cycle.type === 'closed');
    controller.abort();
    await closed;
    await iterator.return();
  });
});
