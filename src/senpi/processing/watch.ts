import { watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { createFileWatchScheduler } from '../../internal/watch-scheduler.js';
import { publicTailResult } from './checkpoint-carrier.js';
import { SenpiMissingSessionSourceError } from './missing-session-source.js';
import { tailSenpiSessionInternal } from './tail-run.js';
import type { SenpiInternalSessionTailOptions } from './tail-run-support.js';
import type {
  SenpiSessionTailOptions,
  SenpiSessionTailResult,
  SenpiTailPosition,
} from './tail.js';

/** Default stable-cursor window elapsed before quiescence, in milliseconds. */
const DEFAULT_QUIESCENCE_MS = 30_000;
/** Default window that coalesces filesystem wake-up storms, in milliseconds. */
const DEFAULT_COALESCE_MS = 10;

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

/** Internal lifecycle acknowledgment exposed for deterministic observation. */
export type SenpiWatchCycle =
  | { readonly type: 'filesystem-wake-received' }
  | {
      readonly type: 'wake-consumed';
      readonly reason: 'change' | 'quiet' | 'poll';
    }
  | { readonly type: 'reconciled'; readonly source: 'present' | 'missing' }
  | { readonly type: 'waiting' }
  | { readonly type: 'closed' };

const defaultClock: SenpiWatchClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: handle => clearTimeout(handle),
};

function positionsEqual(
  left: SenpiTailPosition,
  right: SenpiTailPosition
): boolean {
  return (
    left.generation === right.generation &&
    left.offset === right.offset &&
    left.lineNumber === right.lineNumber &&
    left.pendingKind === right.pendingKind &&
    left.projectionRevision === right.projectionRevision
  );
}

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
  /** Optional observer for internal cycle acknowledgments. */
  readonly onCycle?: (cycle: SenpiWatchCycle) => void;
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
 * - `result`: a tail pass reached a different semantic cursor/projection
 *   position. Reset and checkpoint status alone are not movement.
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
 * Quiescence contract: a stable-cursor window of `quiescenceMs` (default
 * 30000) starts when observation begins and restarts only when the semantic
 * tail position moves. If the window elapses without movement, exactly one
 * `quiescent` event is yielded and a fresh reporting window begins. Filesystem
 * hints and tail passes at the same position never postpone quiescence.
 *
 * Missing-file contract: while the file is absent the retained checkpoint is
 * kept untouched and nothing is yielded. Only
 * {@link SenpiMissingSessionSourceError} is absorbed; every other reconcile
 * error rethrows and ends iteration. A reset is emitted only after the
 * replacement file is actually observed by `tailSenpiSession` (its own
 * invalidation predicate decides). Aborting the signal or closing iteration
 * releases the filesystem watcher. An optional `pollMs` backstop reconciles
 * on the injected clock even when filesystem hints are delayed or lost.
 *
 * @param file - Senpi session JSONL file to watch.
 * @param options - Tail options plus signal, window sizes, and clock.
 * @returns An async sequence of ready, result, and quiescent events.
 */
/** Private watch controls for bounded continuation integration tests. */
export type SenpiInternalSessionWatchOptions = Omit<
  SenpiSessionWatchOptions,
  'checkpoint'
> &
  SenpiInternalSessionTailOptions & {
    /** Observe every reconcile result, including publicly silent deferrals. */
    readonly onTailResult?: (result: SenpiSessionTailResult) => void;
  };

/** Run the watcher with private bounded-tail test controls. */
export async function* watchSenpiSessionInternal(
  file: string,
  options: SenpiInternalSessionWatchOptions = {}
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
    onCycle: _onCycle,
    onTailResult: _onTailResult,
    ...tailOptions
  } = options;

  let aborted = false;
  const pollIntervalMs = options.pollMs ?? 0;
  let lastObservedPosition: SenpiTailPosition | null = null;
  let stableSince = clock.now();
  let lastQuiescentAt: number | null = null;
  let quiescenceDue = false;
  let wakeReason: 'change' | 'quiet' | 'poll' | null = null;
  let resumeWait: (() => void) | undefined;
  let continuationCheckpoint = tailOptions.checkpoint;
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
    const dueAt = Math.max(
      stableSince + quiescenceMs,
      (lastQuiescentAt ?? stableSince) + quiescenceMs
    );
    quiescenceHandle = clock.setTimeout(
      () => {
        quiescenceHandle = null;
        quiescenceDue = true;
        markWake('quiet');
        wake();
      },
      Math.max(0, dueAt - clock.now())
    );
  };

  const coalescer = createFileWatchScheduler(
    () => {
      markWake('change');
      wake();
    },
    {
      schedule: handler => clock.setTimeout(handler, coalesceMs),
      cancel: handle => clock.clearTimeout(handle),
    }
  );

  const disarmCoalesce = (): void => coalescer.cancel();

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
    coalescer.request();
  };

  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    watcher.close();
    wake();
  };

  const watcher = watch(watchDirectory, (_eventType, filename) => {
    if (filename !== null && filename !== baseName) return;
    options.onCycle?.({ type: 'filesystem-wake-received' });
    onActivity();
  });
  watcher.on('error', onActivity);
  watcher.once('close', () => options.onCycle?.({ type: 'closed' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  armPoll();

  const waitForEvent = (): Promise<void> =>
    new Promise<void>(resolve => {
      resumeWait = resolve;
      options.onCycle?.({ type: 'waiting' });
      if (wakeReason !== null || aborted) wake();
    });

  const reconcile = async (): Promise<SenpiSessionTailResult | null> => {
    try {
      const result = await tailSenpiSessionInternal(sessionPath, {
        ...tailOptions,
        ...(continuationCheckpoint === undefined
          ? {}
          : { checkpoint: continuationCheckpoint }),
      });
      if (result.checkpointStatus.status !== 'failed') {
        continuationCheckpoint = result.checkpoint;
      }
      options.onTailResult?.(result);
      options.onCycle?.({ type: 'reconciled', source: 'present' });
      return result;
    } catch (error: unknown) {
      if (error instanceof SenpiMissingSessionSourceError) {
        options.onCycle?.({ type: 'reconciled', source: 'missing' });
        return null;
      }
      throw error;
    }
  };

  try {
    const initial = await reconcile();
    if (initial !== null) {
      lastObservedPosition = initial.nextPosition;
    }
    stableSince = clock.now();
    yield { type: 'ready', result: initial };
    armQuiescence();

    while (!aborted) {
      await waitForEvent();
      if (aborted) return;
      const reason = wakeReason;
      wakeReason = null;
      disarmCoalesce();
      if (reason !== null) {
        options.onCycle?.({ type: 'wake-consumed', reason });
      }

      const result = await reconcile();
      if (aborted) return;
      const observed =
        result !== null &&
        (lastObservedPosition === null ||
          !positionsEqual(result.nextPosition, lastObservedPosition));
      if (result !== null) {
        lastObservedPosition = result.nextPosition;
      }
      if (observed && result !== null) {
        stableSince = clock.now();
        lastQuiescentAt = null;
        quiescenceDue = false;
        yield { type: 'result', result };
        armQuiescence();
      } else if (quiescenceDue) {
        quiescenceDue = false;
        lastQuiescentAt = clock.now();
        yield { type: 'quiescent' };
        armQuiescence();
      }
      // Wakes with no semantic movement leave the stable window untouched.
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    disarmCoalesce();
    disarmQuiescence();
    disarmPoll();
    watcher.close();
  }
}

/** Watch one Senpi session using only the stable public option surface. */
export async function* watchSenpiSession(
  file: string,
  options: SenpiSessionWatchOptions = {}
): AsyncGenerator<SenpiSessionWatchEvent, void, unknown> {
  for await (const event of watchSenpiSessionInternal(file, options)) {
    if (event.type === 'quiescent') {
      yield event;
    } else if (event.type === 'ready') {
      yield {
        type: 'ready',
        result: event.result === null ? null : publicTailResult(event.result),
      };
    } else {
      yield { type: 'result', result: publicTailResult(event.result) };
    }
  }
}
