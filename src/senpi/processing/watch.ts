import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  tailSenpiSession,
  type SenpiSessionTailOptions,
  type SenpiSessionTailResult,
} from './tail.js';

/** Default stable-cursor window elapsed before quiescence, in milliseconds. */
const DEFAULT_QUIESCENCE_MS = 30_000;
/** Default window that coalesces filesystem wake-up storms, in milliseconds. */
const DEFAULT_COALESCE_MS = 10;
/**
 * Prefix of the error `tailSenpiSession` throws while the session file is
 * absent. A matching failure is absorbed by the watch loop instead of ending
 * iteration, so a deleted file never discards the retained checkpoint.
 */
const MISSING_SOURCE_PREFIX = 'Missing required Senpi session source';

/**
 * Injectable time source driving the quiescence and coalescing windows.
 *
 * Production callers omit this and receive real timers. Tests inject a clock
 * backed by fake timers so quiescence delays never appear as real sleeps.
 */
export interface SenpiWatchClock {
  /** Current time in milliseconds. */
  readonly now: () => number;
  /** Schedule `handler` after `delayMs`; returns a cancellable timer handle. */
  readonly setTimeout: (
    handler: () => void,
    delayMs: number
  ) => NodeJS.Timeout | number;
  /** Cancel a handle previously returned by `setTimeout`. */
  readonly clearTimeout: (handle: NodeJS.Timeout | number) => void;
}

const defaultClock: SenpiWatchClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: handle => clearTimeout(handle),
};

/** Options for {@link watchSenpiSession}. */
export interface SenpiSessionWatchOptions extends SenpiSessionTailOptions {
  /** Ends observation and releases the underlying filesystem watcher. */
  readonly signal?: AbortSignal;
  /**
   * Stable-cursor window in milliseconds; defaults to 30000. Quiescence is
   * reported once after this much time passes with no cursor movement.
   */
  readonly quiescenceMs?: number;
  /**
   * Window that coalesces filesystem wake-up storms into one tail pass, in
   * milliseconds; defaults to 10.
   */
  readonly coalesceMs?: number;
  /** Clock for the quiescence and coalescing windows; defaults to real timers. */
  readonly clock?: SenpiWatchClock;
  /**
   * Optional wake-up backstop interval in milliseconds on the injected clock.
   * When set, a repeating timer periodically triggers a reconcile so progress
   * never depends on filesystem event delivery latency or loss. Poll wakes
   * that observe no cursor movement emit nothing and leave the quiescence
   * window untouched. Omitted or zero disables polling.
   */
  readonly pollMs?: number;
}

/**
 * One event from a watched Senpi session file.
 *
 * - `ready`: initial handshake emitted once observation is active. The
 *   attached tail result is `null` when the file did not exist yet.
 * - `result`: a tail pass observed cursor movement - new records, a splice
 *   mutation, block changes, a reset, or a moved byte offset.
 * - `quiescent`: the stable-cursor window elapsed with no movement.
 */
export type SenpiSessionWatchEvent =
  | { readonly type: 'ready'; readonly result: SenpiSessionTailResult | null }
  | { readonly type: 'result'; readonly result: SenpiSessionTailResult }
  | { readonly type: 'quiescent' };

/**
 * Watch one Senpi session JSONL file and reconcile every wake through
 * `tailSenpiSession`.
 *
 * Filesystem events are wake-up hints only: they never carry payloads, and a
 * storm of them coalesces into a single tail pass per quiet interval. Every
 * wake (and every quiescence check) reconciles through `tailSenpiSession`, so
 * projection, checkpointing, and reset detection are never duplicated here.
 *
 * Quiescence contract: after each tail pass a stable-cursor window of
 * `quiescenceMs` (default 30000) starts on the injected clock. If the window
 * elapses without cursor movement, exactly one `quiescent` event is yielded
 * and a fresh window begins. Any observed activity cancels the pending
 * window, and the window restarts only after the resulting tail pass
 * completes. A tail pass counts as movement only when the session cursor or
 * checkpoint revision changed relative to the previous pass, so re-reads of
 * an unchanged file never suppress quiescence.
 *
 * Missing-file contract: while the file is absent the retained checkpoint is
 * kept untouched and nothing is yielded; a reset is emitted only after the
 * replacement file is actually observed by `tailSenpiSession` (its own
 * invalidation predicate decides). Aborting the signal or closing iteration
 * releases the filesystem watcher. An optional `pollMs` backstop reconciles
 * on the injected clock even when filesystem hints are delayed or lost.
 *
 * @param file - Senpi session JSONL file to watch.
 * @param options - Tail options plus signal, window sizes, and clock.
 * @returns An async sequence of ready, result, and quiescent events.
 */
export async function* watchSenpiSession(
  file: string,
  options: SenpiSessionWatchOptions = {}
): AsyncGenerator<SenpiSessionWatchEvent, void, unknown> {
  const sessionPath = resolve(file);
  const watchDirectory = dirname(sessionPath);
  const baseName = basename(sessionPath);
  const clock = options.clock ?? defaultClock;
  const quiescenceMs = options.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const {
    signal,
    quiescenceMs: _quiescenceMs,
    coalesceMs: _coalesceMs,
    pollMs: _pollMs,
    clock: _clock,
    ...tailOptions
  } = options;

  let aborted = false;
  const pollIntervalMs = options.pollMs ?? 0;
  let lastRevision: number | null = null;
  let lastByteOffset: number | null = null;
  let wakeReason: 'change' | 'quiet' | 'poll' | null = null;
  let resumeWait: (() => void) | undefined;
  let coalesceHandle: NodeJS.Timeout | number | null = null;
  let quiescenceHandle: NodeJS.Timeout | number | null = null;
  let pollHandle: NodeJS.Timeout | number | null = null;

  const wake = (): void => {
    const resume = resumeWait;
    resumeWait = undefined;
    resume?.();
  };

  /** Higher-priority reasons win: filesystem hints outrank quiet, quiet outranks polls. */
  const markWake = (reason: 'change' | 'quiet' | 'poll'): void => {
    if (wakeReason === 'change') return;
    if (wakeReason === 'quiet' && reason === 'poll') return;
    wakeReason = reason;
  };

  const disarmQuiescence = (): void => {
    if (quiescenceHandle !== null) {
      clock.clearTimeout(quiescenceHandle);
      quiescenceHandle = null;
    }
  };

  const armQuiescence = (): void => {
    disarmQuiescence();
    quiescenceHandle = clock.setTimeout(() => {
      quiescenceHandle = null;
      markWake('quiet');
      wake();
    }, quiescenceMs);
  };

  const disarmCoalesce = (): void => {
    if (coalesceHandle !== null) {
      clock.clearTimeout(coalesceHandle);
      coalesceHandle = null;
    }
  };

  const disarmPoll = (): void => {
    if (pollHandle !== null) {
      clock.clearTimeout(pollHandle);
      pollHandle = null;
    }
  };

  /** Self-rescheduling backstop; never disarms or restarts quiescence. */
  const armPoll = (): void => {
    if (pollIntervalMs <= 0 || aborted || pollHandle !== null) return;
    pollHandle = clock.setTimeout(() => {
      pollHandle = null;
      markWake('poll');
      wake();
      armPoll();
    }, pollIntervalMs);
  };

  const onActivity = (): void => {
    disarmQuiescence();
    if (coalesceHandle !== null) return;
    coalesceHandle = clock.setTimeout(() => {
      coalesceHandle = null;
      markWake('change');
      wake();
    }, coalesceMs);
  };

  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    watcher.close();
    wake();
  };

  const watcher = watch(watchDirectory, (_eventType, filename) => {
    if (filename !== null && filename !== baseName) return;
    onActivity();
  });
  watcher.on('error', onActivity);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  armPoll();

  const waitForEvent = (): Promise<void> =>
    new Promise<void>(resolve => {
      resumeWait = resolve;
      if (wakeReason !== null || aborted) wake();
    });

  const reconcile = async (): Promise<SenpiSessionTailResult | null> => {
    try {
      return await tailSenpiSession(sessionPath, tailOptions);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.startsWith(MISSING_SOURCE_PREFIX)
      ) {
        return null;
      }
      throw error;
    }
  };

  try {
    const initial = await reconcile();
    if (initial !== null) {
      lastRevision = initial.revision;
      lastByteOffset = initial.nextByteOffset;
    }
    yield { type: 'ready', result: initial };
    armQuiescence();

    while (!aborted) {
      await waitForEvent();
      if (aborted) return;
      const reason = wakeReason;
      wakeReason = null;
      disarmCoalesce();

      const result = await reconcile();
      if (aborted) return;
      const observed =
        result !== null &&
        (result.reset ||
          result.revision !== lastRevision ||
          result.nextByteOffset !== lastByteOffset);
      if (result !== null) {
        lastRevision = result.revision;
        lastByteOffset = result.nextByteOffset;
      }
      if (observed && result !== null) {
        yield { type: 'result', result };
        armQuiescence();
      } else if (reason === 'quiet') {
        yield { type: 'quiescent' };
        armQuiescence();
      } else if (reason === 'change') {
        // Activity happened but moved nothing observable; restart the window.
        armQuiescence();
      }
      // A poll wake with nothing observed leaves the pending quiescence
      // window running so polling can never suppress quiescence.
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    disarmCoalesce();
    disarmQuiescence();
    disarmPoll();
    watcher.close();
  }
}
