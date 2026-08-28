import type { SenpiWatchClock } from '../src/senpi/processing/watch.js';

/** Deterministic watcher clock with explicit advancement. */
export interface ManualClock extends SenpiWatchClock {
  readonly advanceBy: (ms: number) => boolean;
}

/** Create a deterministic timeout scheduler for watcher tests. */
export function createManualClock(): ManualClock {
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
    clearTimeout: handle => scheduled.delete(handle),
    advanceBy: ms => {
      const target = current + ms;
      let fired = false;
      for (let turn = 0; turn < 10_000; turn += 1) {
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
        fired = true;
        timer?.handler();
      }
      current = target;
      return fired;
    },
  };
}

/** Exact predicate signal whose every subscription has a failure timeout. */
export interface Signal<T> {
  readonly emit: (value: T) => void;
  readonly waitFor: (
    predicate: (value: T) => boolean,
    timeoutMs?: number
  ) => Promise<T>;
}

/** Create an exact event signal with bounded, self-cleaning subscriptions. */
export function createSignal<T>(): Signal<T> {
  const waiters: Array<{
    readonly predicate: (value: T) => boolean;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
    readonly timeout: AbortSignal;
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
    waitFor: (predicate, timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const waiter = { predicate, resolve, reject, timeout };
        waiters.push(waiter);
        timeout.addEventListener(
          'abort',
          () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('Timed out waiting for exact test signal'));
          },
          { once: true }
        );
      }),
  };
}

/** Await one exact bounded signal subscription. */
export function waitForSignal<T>(
  signal: Signal<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  return signal.waitFor(predicate, timeoutMs);
}

/** Bound an existing lifecycle promise before exposing or awaiting it. */
export async function boundedLifecycle<T>(
  promise: Promise<T>,
  timeoutMs = 5_000
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout.addEventListener(
        'abort',
        () => reject(new Error('Timed out waiting for watcher lifecycle')),
        { once: true }
      );
    }),
  ]);
}
