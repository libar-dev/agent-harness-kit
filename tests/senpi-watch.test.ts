import { watch as watchFs } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenpiSessionTailResult } from '../src/senpi/processing/tail.js';
import {
  watchSenpiSession,
  type SenpiSessionWatchEvent,
  type SenpiWatchClock,
} from '../src/senpi/processing/watch.js';

const QUIESCENCE_MS = 1_000;
const COALESCE_MS = 5;
const HEADER_ID = 'cccccccc-dddd-4eee-afff-000000000001';

const temporaryRoots: string[] = [];
const controllers: AbortController[] = [];
const pumps: { readonly done: Promise<void> }[] = [];

beforeEach(() => {
  // Guardrail: any accidental global-timer usage fails loudly instead of
  // leaking real sleeps. All watch timing flows through the injected clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(pumps.splice(0).map(pump => pump.done));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(root => rm(root, { recursive: true, force: true }))
  );
  vi.useRealTimers();
});

interface ManualClock extends SenpiWatchClock {
  /** Move virtual time forward, firing due handlers in order. */
  readonly advanceBy: (ms: number) => Promise<void>;
}

/**
 * Fully deterministic injected clock: virtual time moves only when
 * `advanceBy` says so, and each fired handler drains the event loop so the
 * watch generator finishes its real-I/O reconciliation before time moves on.
 */
function createManualClock(): ManualClock {
  let current = 0;
  let sequence = 0;
  const scheduled = new Map<
    NodeJS.Timeout | number,
    { readonly at: number; readonly handler: () => void }
  >();

  const drainTurns = async (): Promise<void> => {
    for (let index = 0; index < 200; index += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

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
    advanceBy: async ms => {
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
        current = Math.max(current, dueAt);
        timer?.handler();
        await drainTurns();
      }
      current = target;
    },
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

/**
 * Apply one filesystem mutation and wait until the kernel confirmed delivery
 * of the matching watch event, so clock advancement never races the operating
 * system's event latency.
 */
async function fsEdit(
  file: string,
  action: () => Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const delivered = new Promise<void>((resolve, reject) => {
    const watcher = watchFs(
      dirname(file),
      { signal: controller.signal },
      (_eventType, filename) => {
        if (filename !== null && filename.toString() === basename(file)) {
          resolve();
        }
      }
    );
    watcher.on('error', reject);
  });
  try {
    await action();
    await delivered;
  } finally {
    controller.abort();
  }
}

/** Drain the event loop so delivered hints reach the watcher callbacks. */
async function drainIo(turns = 32): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Bounded event-loop wait; never a fixed sleep. */
async function waitForPredicate(
  predicate: () => boolean,
  label: string
): Promise<void> {
  for (let index = 0; index < 5_000 && !predicate(); index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

interface RunningWatch {
  readonly controller: AbortController;
  readonly clock: ManualClock;
  readonly events: SenpiSessionWatchEvent[];
  readonly done: Promise<void>;
}

async function startWatch(
  file: string,
  quiescenceMs: number = QUIESCENCE_MS
): Promise<RunningWatch> {
  const controller = new AbortController();
  const clock = createManualClock();
  const iterator = watchSenpiSession(file, {
    signal: controller.signal,
    quiescenceMs,
    coalesceMs: COALESCE_MS,
    clock,
  });
  const events: SenpiSessionWatchEvent[] = [];
  const done = (async () => {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) return;
      events.push(step.value);
    }
  })();
  controllers.push(controller);
  pumps.push({ done });
  return { controller, clock, events, done };
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

function fsEventWrapCount(): number {
  return process.getActiveResourcesInfo().filter(name => name === 'FSEventWrap')
    .length;
}

describe('watchSenpiSession', () => {
  it('wakes on append and yields the reconciled result', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);

    await waitForPredicate(
      () => running.events.length >= 1,
      'initial readiness yield'
    );
    const ready = running.events[0];
    expect(ready?.type).toBe('ready');
    expect(recordKeys(ready)).toEqual(['a1']);

    await fsEdit(file, () =>
      appendFile(file, messageLine('a2', 'a1', 'second'))
    );
    await drainIo();
    await running.clock.advanceBy(COALESCE_MS * 2);
    await waitForPredicate(
      () => resultEvents(running.events).length >= 1,
      'appended record result'
    );

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

    await waitForPredicate(
      () => running.events.length >= 1,
      'initial readiness yield'
    );
    await fsEdit(file, () =>
      appendFile(file, messageLine('a2', 'a1', 'second'))
    );
    await drainIo();
    await running.clock.advanceBy(COALESCE_MS * 2);
    await waitForPredicate(
      () => resultEvents(running.events).length >= 1,
      'appended record result'
    );

    // Sub-window silence emits nothing.
    const beforeSubWindow = running.events.length;
    await running.clock.advanceBy(COALESCE_MS * 4);
    expect(running.events.length).toBe(beforeSubWindow);

    // Exactly one full stable-cursor window yields exactly one quiescent.
    await running.clock.advanceBy(QUIESCENCE_MS);
    expect(countType(running.events, 'quiescent')).toBe(1);
    expect(resultEvents(running.events)).toHaveLength(1);

    // The next full window yields exactly one more; sub-window silence again
    // emits nothing.
    await running.clock.advanceBy(COALESCE_MS * 4);
    expect(countType(running.events, 'quiescent')).toBe(1);
    await running.clock.advanceBy(QUIESCENCE_MS);
    expect(countType(running.events, 'quiescent')).toBe(2);
    expect(resultEvents(running.events)).toHaveLength(1);
  });

  it('coalesces a watch-event storm into one tail per quiet interval', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);

    await waitForPredicate(
      () => running.events.length >= 1,
      'initial readiness yield'
    );

    let previousId = 'a1';
    for (const id of ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) {
      await fsEdit(file, () =>
        appendFile(file, messageLine(id, previousId, id))
      );
      previousId = id;
    }
    await drainIo();
    await running.clock.advanceBy(COALESCE_MS * 2);
    await waitForPredicate(
      () => resultEvents(running.events).length >= 1,
      'storm result'
    );

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

    await running.clock.advanceBy(QUIESCENCE_MS);
    expect(countType(running.events, 'quiescent')).toBe(1);
    expect(resultEvents(running.events)).toHaveLength(1);
  });

  it('abort cleans the filesystem watcher without leaks', async () => {
    await drainIo();
    const baseline = fsEventWrapCount();

    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);

    await waitForPredicate(
      () => running.events.length >= 1,
      'initial readiness yield'
    );
    expect(fsEventWrapCount()).toBe(baseline + 1);

    running.controller.abort();
    await waitForPredicate(
      () => fsEventWrapCount() === baseline,
      'watcher release'
    );
    await running.done;
    expect(fsEventWrapCount()).toBe(baseline);
  });

  it('keeps the checkpoint across deletion and resets only after replacement', async () => {
    const file = await makeTemporaryFile();
    await writeFile(file, `${headerLine()}${messageLine('a1', null, 'first')}`);
    const running = await startWatch(file);

    await waitForPredicate(
      () => running.events.length >= 1,
      'initial readiness yield'
    );
    expect(recordKeys(running.events[0])).toEqual(['a1']);

    await fsEdit(file, () => rm(file));
    await drainIo();
    await running.clock.advanceBy(COALESCE_MS * 2);
    await running.clock.advanceBy(QUIESCENCE_MS);
    expect(resultEvents(running.events)).toHaveLength(0);

    await fsEdit(file, () =>
      writeFile(
        file,
        `${headerLine()}${messageLine('a1', null, 'first')}${messageLine('a2', 'a1', 'second')}`
      )
    );
    await drainIo();
    await running.clock.advanceBy(COALESCE_MS * 2);
    await waitForPredicate(
      () => resultEvents(running.events).length >= 1,
      'replacement reset result'
    );

    const results = resultEvents(running.events);
    expect(results).toHaveLength(1);
    expect(requireResult(results[0]).reset).toBe(true);
    expect(recordKeys(results[0])).toEqual(['a1', 'a2']);
    expect(requireResult(results[0]).generation).toBe(1);
  });
});
