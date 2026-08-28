import {
  appendFile,
  chmod,
  mkdir,
  link,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { watchSenpiSession } from '../src/senpi/processing/watch.js';
import { createManualClock } from './senpi-watch-clock-utils.js';
import {
  COALESCE_MS,
  POLL_MS,
  QUIESCENCE_MS,
  advancePastPolls,
  advanceToQuiescence,
  countType,
  flushCoalesceHints,
  headerLine,
  makeTemporaryFile,
  messageLine,
  processingCycles,
  reconcileEdit,
  recordKeys,
  requireResult,
  resultEvents,
  startWatch,
} from './senpi-watch-utils.js';

describe('watchSenpiSession', () => {
  it('wakes on append and yields the reconciled result', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);
    expect(recordKeys(running.events[0])).toEqual(['a1']);

    const cycleStart = running.cycles.length;
    const resultDelivered = running.waitForEvent(
      event => event.type === 'result'
    );
    await reconcileEdit(running, () =>
      appendFile(file, messageLine('a2', 'a1', 'second'))
    );
    await resultDelivered;

    expect(processingCycles(running.cycles.slice(cycleStart))).toEqual([
      { type: 'wake-consumed', reason: 'change' },
      { type: 'reconciled', source: 'present' },
      { type: 'waiting' },
    ]);
    const results = resultEvents(running.events);
    expect(results).toHaveLength(1);
    expect(recordKeys(results[0])).toEqual(['a1', 'a2']);
    expect(requireResult(results[0]).reset).toBe(false);
    expect(requireResult(results[0]).nextByteOffset).toBeGreaterThan(0);
  });

  it('emits quiescence exactly once after one stable-cursor window', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);
    const resultDelivered = running.waitForEvent(
      event => event.type === 'result'
    );
    await reconcileEdit(running, () =>
      appendFile(file, messageLine('a2', 'a1', 'second'))
    );
    await resultDelivered;

    const beforeSubWindow = running.events.length;
    await advancePastPolls(running, POLL_MS * 6);
    expect(running.events).toHaveLength(beforeSubWindow);

    await advanceToQuiescence(running);
    expect(countType(running.events, 'quiescent')).toBe(1);
    expect(resultEvents(running.events)).toHaveLength(1);

    const quiescentAfterFirst = countType(running.events, 'quiescent');
    await advancePastPolls(running, COALESCE_MS * 4);
    expect(countType(running.events, 'quiescent')).toBe(quiescentAfterFirst);
    await advanceToQuiescence(running);
    expect(countType(running.events, 'quiescent')).toBe(
      quiescentAfterFirst + 1
    );
    expect(resultEvents(running.events)).toHaveLength(1);
  });

  it('coalesces a watch-event storm into one tail per quiet interval', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);
    const resultDelivered = running.waitForEvent(
      event => event.type === 'result' && recordKeys(event).includes('a9')
    );
    const waitingAfterStorm = running.waitForCycle(
      cycle => cycle.type === 'waiting'
    );
    let previousId = 'a1';
    for (const id of ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) {
      await appendFile(file, messageLine(id, previousId, id));
      previousId = id;
    }
    // Drive the injected coalesce/poll clock; do not wait for fs.watch delivery.
    running.clock.advanceBy(POLL_MS);
    await resultDelivered;
    await waitingAfterStorm;
    await flushCoalesceHints(running);

    const results = resultEvents(running.events);
    expect(results).toHaveLength(1);
    expect(recordKeys(results[0])).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
      'a7',
      'a8',
      'a9',
    ]);
    expect(requireResult(results[0]).reset).toBe(false);

    await advanceToQuiescence(running);
    expect(countType(running.events, 'quiescent')).toBe(1);
    expect(resultEvents(running.events)).toHaveLength(1);
  });

  it('abort acknowledges filesystem watcher close completion', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);

    running.controller.abort();
    const closed = await running.closed;
    await running.done;
    expect(closed).toEqual({ type: 'closed' });
  });

  it('keeps the checkpoint across deletion and resets a same-inode replacement', async () => {
    const file = await makeTemporaryFile();
    const replacement = `${file}.replacement`;
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    await link(file, replacement);
    const running = await startWatch(file);
    expect(recordKeys(running.events[0])).toEqual(['a1']);

    const filesystemWake = running.waitForCycle(
      cycle => cycle.type === 'filesystem-wake-received'
    );
    const wakeConsumed = running.waitForCycle(
      cycle => cycle.type === 'wake-consumed' && cycle.reason === 'change'
    );
    const missingReconciled = running.waitForCycle(
      cycle => cycle.type === 'reconciled' && cycle.source === 'missing'
    );
    const waiting = running.waitForCycle(cycle => cycle.type === 'waiting');
    await rm(file);
    await filesystemWake;
    running.clock.advanceBy(COALESCE_MS);
    await wakeConsumed;
    await missingReconciled;
    await waiting;
    expect(resultEvents(running.events)).toHaveLength(0);

    await advanceToQuiescence(running);
    expect(countType(running.events, 'quiescent')).toBe(1);
    expect(resultEvents(running.events)).toHaveLength(0);

    const resetDelivered = running.waitForEvent(
      event => event.type === 'result'
    );
    await reconcileEdit(running, async () => {
      await link(replacement, file);
      await appendFile(file, messageLine('a2', 'a1', 'second'));
    });
    await resetDelivered;

    const results = resultEvents(running.events);
    expect(results).toHaveLength(1);
    expect(requireResult(results[0]).reset).toBe(true);
    expect(recordKeys(results[0])).toEqual(['a1', 'a2']);
    expect(requireResult(results[0]).generation).toBe(1);
  });

  it('survives automatic checkpoint failure and keeps iterating', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const file = await makeTemporaryFile();
    const markerDir = join(dirname(file), 'markers');
    await mkdir(markerDir, { recursive: true });
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file, {
      markerDir,
      allowedMarkerRoots: [dirname(file)],
    });
    expect(running.events[0]?.type).toBe('ready');
    const ready = running.events[0];
    if (ready?.type !== 'ready' || ready.result === null) {
      throw new Error('expected an initial ready result');
    }
    expect(ready.result.checkpointStatus).toEqual({ status: 'committed' });

    await chmod(markerDir, 0o555);
    try {
      const resultDelivered = running.waitForEvent(
        event => event.type === 'result'
      );
      await reconcileEdit(running, () =>
        appendFile(file, messageLine('a2', 'a1', 'second'))
      );
      await resultDelivered;
      const results = resultEvents(running.events);
      expect(results).toHaveLength(1);
      expect(requireResult(results[0]).checkpointStatus.status).toBe('failed');
      expect(recordKeys(results[0])).toEqual(['a1', 'a2']);
      await advanceToQuiescence(running);
      expect(countType(running.events, 'quiescent')).toBe(1);
    } finally {
      await chmod(markerDir, 0o700);
    }
  });

  it('does not match missing sources by message prefix', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/senpi/processing/watch.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('MISSING_SOURCE_PREFIX');
    expect(source).toContain('SenpiMissingSessionSourceError');
    expect(source).toContain('instanceof');
  });

  it('propagates a non-missing-source reconcile error and ends iteration', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const controller = new AbortController();
    const clock = createManualClock();
    const iterator = watchSenpiSession(file, {
      signal: controller.signal,
      clock,
      pollMs: POLL_MS,
      quiescenceMs: QUIESCENCE_MS,
      coalesceMs: COALESCE_MS,
    });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('ready');
    await chmod(file, 0o000);
    try {
      const next = iterator.next();
      clock.advanceBy(POLL_MS);
      await expect(next).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(file, 0o600);
      controller.abort();
      await iterator.next().catch(() => undefined);
    }
  });
});
