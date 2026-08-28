import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import type { SenpiSessionTailResult } from '../src/senpi/processing/tail.js';
import {
  watchSenpiSession,
  type SenpiSessionWatchEvent,
  type SenpiSessionWatchOptions,
  type SenpiWatchCycle,
} from '../src/senpi/processing/watch.js';

/** Test fixture contract consumed by event-driven watch regression cases. */
export const QUIESCENCE_MS = 1_000;
/** Test fixture contract consumed by event-driven watch regression cases. */
export const COALESCE_MS = 5;
/** Test fixture contract consumed by event-driven watch regression cases. */
export const POLL_MS = 20;
/** Test fixture contract consumed by event-driven watch regression cases. */
export const HEADER_ID = 'cccccccc-dddd-4eee-afff-000000000001';

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

import {
  boundedLifecycle,
  createManualClock,
  createSignal,
  type ManualClock,
  type Signal,
} from './senpi-watch-clock-utils.js';
import { emitFilesystemWake } from './senpi-watch-fake.js';
/** Build the canonical session header line. */
export function headerLine(): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: HEADER_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/Users/fixture-user/projects/watch-demo',
  })}\n`;
}

/** Build one canonical message line. */
export function messageLine(
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

/** Create and track one temporary session file. */
export async function makeTemporaryFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'senpi-watch-'));
  temporaryRoots.push(root);
  return join(root, 'session.jsonl');
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export interface RunningWatch {
  readonly controller: AbortController;
  readonly clock: ManualClock;
  readonly events: SenpiSessionWatchEvent[];
  readonly cycles: SenpiWatchCycle[];
  readonly waitForEvent: Signal<SenpiSessionWatchEvent>['waitFor'];
  readonly waitForCycle: Signal<SenpiWatchCycle>['waitFor'];
  readonly done: Promise<void>;
  readonly closed: Promise<SenpiWatchCycle>;
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export async function startWatch(
  file: string,
  extra: Omit<
    SenpiSessionWatchOptions,
    'signal' | 'clock' | 'onCycle' | 'quiescenceMs' | 'coalesceMs' | 'pollMs'
  > = {}
): Promise<RunningWatch> {
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
    ...extra,
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
  const done = boundedLifecycle(
    (async () => {
      for await (const event of iterator) {
        events.push(event);
        eventSignal.emit(event);
      }
    })()
  );
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

/** Test fixture contract consumed by event-driven watch regression cases. */
export async function reconcileEdit(
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
  emitFilesystemWake('session.jsonl');
  await filesystemWake;
  running.clock.advanceBy(COALESCE_MS);
  await wakeConsumed;
  await reconciled;
  await waiting;
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export async function flushCoalesceHints(running: RunningWatch): Promise<void> {
  const waiting = running.waitForCycle(cycle => cycle.type === 'waiting');
  if (running.clock.advanceBy(COALESCE_MS)) await waiting;
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export async function advanceToQuiescence(
  running: RunningWatch
): Promise<SenpiSessionWatchEvent> {
  await flushCoalesceHints(running);
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

/** Test fixture contract consumed by event-driven watch regression cases. */
export async function advancePastPolls(
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

/** Test fixture contract consumed by event-driven watch regression cases. */
export function recordKeys(
  event: SenpiSessionWatchEvent | undefined
): readonly string[] {
  const result =
    event?.type === 'result' || event?.type === 'ready' ? event.result : null;
  return result === null ? [] : result.records.map(record => record.key);
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export function resultEvents(
  events: readonly SenpiSessionWatchEvent[]
): SenpiSessionWatchEvent[] {
  return events.filter(event => event.type === 'result');
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export function countType(
  events: readonly SenpiSessionWatchEvent[],
  type: SenpiSessionWatchEvent['type']
): number {
  return events.filter(event => event.type === type).length;
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export function requireResult(
  event: SenpiSessionWatchEvent | undefined
): SenpiSessionTailResult {
  if (event?.type !== 'result') throw new Error('expected a result event');
  return event.result;
}

/** Test fixture contract consumed by event-driven watch regression cases. */
export function processingCycles(
  cycles: readonly SenpiWatchCycle[]
): readonly SenpiWatchCycle[] {
  return cycles.filter(cycle => cycle.type !== 'filesystem-wake-received');
}
