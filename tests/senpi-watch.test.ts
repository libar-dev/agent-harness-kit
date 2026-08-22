// allow: SIZE_OK — one deterministic fixture covers the watcher lifecycle.
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenpiSessionTailResult } from '../src/senpi/processing/tail.js';
import {
  watchSenpiSession,
  type SenpiSessionWatchEvent,
  type SenpiWatchClock,
  type SenpiWatchCycle,
} from '../src/senpi/processing/watch.js';

const QUIESCENCE_MS = 1_000;
const COALESCE_MS = 5;
const POLL_MS = 20;
const HEADER_ID = 'cccccccc-dddd-4eee-afff-000000000001';

const temporaryRoots: string[] = [];
const runningWatches: RunningWatch[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  const watches = runningWatches.splice(0);
  for (const running of watches) running.controller.abort();
  try {
    await Promise.all(
      watches.map(running => Promise.all([running.done, running.closed]))
    );
  } finally {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map(root => rm(root, { recursive: true, force: true }))
    );
    vi.useRealTimers();
  }
});

interface ManualClock extends SenpiWatchClock {
  readonly advanceBy: (ms: number) => void;
}

function createManualClock(): ManualClock {
  let current = 0;
  let sequence = 0;
  const scheduled = new Map<
    NodeJS.Timeout | number,
    { readonly at: number; readonly handler: () => void }
  >();

  return {
    now: () => current,
    setTimeout: (handler, delayMs) => {
      sequence += 1;
      scheduled.set(sequence, { at: current + delayMs, handler });
      return sequence;
    },
    clearTimeout: handle => {
      scheduled.delete(handle);
    },
    advanceBy: ms => {
      const target = current + ms;
      for (;;) {
        let dueId: NodeJS.Timeout | number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of scheduled) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === undefined) break;
        const timer = scheduled.get(dueId);
        scheduled.delete(dueId);
        current = dueAt;
        timer?.handler();
      }
      current = target;
    },
  };
}

interface Signal<T> {
  readonly emit: (value: T) => void;
  readonly waitFor: (predicate: (value: T) => boolean) => Promise<T>;
}

function createSignal<T>(): Signal<T> {
  const waiters: Array<{
    readonly predicate: (value: T) => boolean;
    readonly resolve: (value: T) => void;
  }> = [];
  return {
    emit: value => {
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter?.predicate(value) === true) {
          waiters.splice(index, 1);
          waiter.resolve(value);
        }
      }
    },
    waitFor: predicate =>
      new Promise(resolve => {
        waiters.push({ predicate, resolve });
      }),
  };
}

function headerLine(): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: HEADER_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/Users/fixture-user/projects/watch-demo',
  })}\n`;
}

function messageLine(
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

async function makeTemporaryFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'senpi-watch-'));
  temporaryRoots.push(root);
  return join(root, 'session.jsonl');
}

interface RunningWatch {
  readonly controller: AbortController;
  readonly clock: ManualClock;
  readonly events: SenpiSessionWatchEvent[];
  readonly cycles: SenpiWatchCycle[];
  readonly waitForEvent: Signal<SenpiSessionWatchEvent>['waitFor'];
  readonly waitForCycle: Signal<SenpiWatchCycle>['waitFor'];
  readonly done: Promise<void>;
  readonly closed: Promise<SenpiWatchCycle>;
}

async function startWatch(file: string): Promise<RunningWatch> {
  const controller = new AbortController();
  const clock = createManualClock();
  const eventSignal = createSignal<SenpiSessionWatchEvent>();
  const cycleSignal = createSignal<SenpiWatchCycle>();
  const events: SenpiSessionWatchEvent[] = [];
  const cycles: SenpiWatchCycle[] = [];
  const closed = cycleSignal.waitFor(cycle => cycle.type === 'closed');
  const ready = eventSignal.waitFor(event => event.type === 'ready');
  const waiting = cycleSignal.waitFor(cycle => cycle.type === 'waiting');
  const iterator = watchSenpiSession(file, {
    signal: controller.signal,
    quiescenceMs: QUIESCENCE_MS,
    coalesceMs: COALESCE_MS,
    pollMs: POLL_MS,
    clock,
    onCycle: cycle => {
      cycles.push(cycle);
      cycleSignal.emit(cycle);
    },
  });
  const done = (async () => {
    for await (const event of iterator) {
      events.push(event);
      eventSignal.emit(event);
    }
  })();
  const running = {
    controller,
    clock,
    events,
    cycles,
    waitForEvent: eventSignal.waitFor,
    waitForCycle: cycleSignal.waitFor,
    done,
    closed,
  } satisfies RunningWatch;
  runningWatches.push(running);
  await ready;
  await waiting;
  return running;
}

async function reconcileEdit(
  running: RunningWatch,
  action: () => Promise<void>
): Promise<void> {
  const filesystemWake = running.waitForCycle(
    cycle => cycle.type === 'filesystem-wake-received'
  );
  const wakeConsumed = running.waitForCycle(
    cycle => cycle.type === 'wake-consumed' && cycle.reason === 'change'
  );
  const reconciled = running.waitForCycle(
    cycle => cycle.type === 'reconciled' && cycle.source === 'present'
  );
  const waiting = running.waitForCycle(cycle => cycle.type === 'waiting');

  await action();
  await filesystemWake;
  running.clock.advanceBy(COALESCE_MS);
  await wakeConsumed;
  await reconciled;
  await waiting;
}

async function advanceToQuiescence(
  running: RunningWatch
): Promise<SenpiSessionWatchEvent> {
  const wakeConsumed = running.waitForCycle(
    cycle => cycle.type === 'wake-consumed' && cycle.reason === 'quiet'
  );
  const delivered = running.waitForEvent(event => event.type === 'quiescent');
  const waiting = running.waitForCycle(cycle => cycle.type === 'waiting');

  running.clock.advanceBy(QUIESCENCE_MS);
  await wakeConsumed;
  const event = await delivered;
  await waiting;
  return event;
}

async function advancePastPolls(
  running: RunningWatch,
  durationMs: number
): Promise<void> {
  const wakeConsumed = running.waitForCycle(
    cycle => cycle.type === 'wake-consumed' && cycle.reason === 'poll'
  );
  const waiting = running.waitForCycle(cycle => cycle.type === 'waiting');
  running.clock.advanceBy(durationMs);
  await wakeConsumed;
  await waiting;
}

function recordKeys(
  event: SenpiSessionWatchEvent | undefined
): readonly string[] {
  const result =
    event?.type === 'result' || event?.type === 'ready' ? event.result : null;
  return result === null ? [] : result.records.map(record => record.key);
}

function resultEvents(
  events: readonly SenpiSessionWatchEvent[]
): SenpiSessionWatchEvent[] {
  return events.filter(event => event.type === 'result');
}

function countType(
  events: readonly SenpiSessionWatchEvent[],
  type: SenpiSessionWatchEvent['type']
): number {
  return events.filter(event => event.type === type).length;
}

function requireResult(
  event: SenpiSessionWatchEvent | undefined
): SenpiSessionTailResult {
  if (event?.type !== 'result') throw new Error('expected a result event');
  return event.result;
}

function processingCycles(
  cycles: readonly SenpiWatchCycle[]
): readonly SenpiWatchCycle[] {
  return cycles.filter(cycle => cycle.type !== 'filesystem-wake-received');
}

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
      event => event.type === 'result'
    );
    await reconcileEdit(running, async () => {
      let previousId = 'a1';
      for (const id of ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) {
        await appendFile(file, messageLine(id, previousId, id));
        previousId = id;
      }
    });
    await resultDelivered;

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

  it('keeps the checkpoint across deletion and resets only after replacement', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
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
    await reconcileEdit(running, () =>
      writeFile(
        file,
        `${headerLine()}${messageLine('a1', null, 'first')}${messageLine('a2', 'a1', 'second')}`
      )
    );
    await resetDelivered;

    const results = resultEvents(running.events);
    expect(results).toHaveLength(1);
    expect(requireResult(results[0]).reset).toBe(true);
    expect(recordKeys(results[0])).toEqual(['a1', 'a2']);
    expect(requireResult(results[0]).generation).toBe(1);
  });
});
