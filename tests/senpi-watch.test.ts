import { appendFile, link, rm, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  COALESCE_MS,
  POLL_MS,
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
});
