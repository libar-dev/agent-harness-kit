import { watch } from 'node:fs';
import { resolve } from 'node:path';

import {
  createFileWatchScheduler,
  type FileWatchScheduler,
} from '../../internal/watch-scheduler.js';
import { isObservableGrokResult } from './tail-result.js';
import { tailGrokSession } from './tail-run.js';
import {
  GROK_SOURCE_FILENAMES,
  type GrokSessionTailOptions,
  type GrokSessionTailResult,
  type GrokSessionWatchOptions,
  type GrokWatchClock,
} from './tail-types.js';

const defaultClock: GrokWatchClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: handle => clearTimeout(handle),
};

/**
 * Watch both Grok JSONL sources and yield observable reconciled batches.
 *
 * Filesystem events are wake-up hints only. A null `filename` still wakes
 * reconcile; only a non-null name that is neither `updates.jsonl` nor
 * `events.jsonl` is ignored. An optional `pollMs` backstop reconciles on
 * the injected clock even when filesystem hints are delayed or lost.
 *
 * @param sessionDir - Directory containing both sources.
 * @param options - Tail options, cancellation signal, and optional poll backstop.
 * @returns Initial readiness result followed by changed batches.
 */
export async function* watchGrokSession(
  sessionDir: string,
  options: GrokSessionWatchOptions = {}
): AsyncGenerator<GrokSessionTailResult, void, unknown> {
  const resolvedSessionDir = resolve(sessionDir);
  const {
    signal,
    pollMs: _pollMs,
    clock: optionsClock,
    ...initialTailOptions
  } = options;
  const clock = optionsClock ?? defaultClock;
  const pollIntervalMs = options.pollMs ?? 0;
  let tailOptions: GrokSessionTailOptions = initialTailOptions;
  let changed = false;
  let aborted = false;
  let wake: (() => void) | undefined;
  let watchError: Error | undefined;
  let pollHandle: NodeJS.Timeout | number | null = null;
  const flushWake = (): void => {
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  };
  const wakeScheduler: FileWatchScheduler =
    optionsClock === undefined
      ? createFileWatchScheduler(flushWake, {
          schedule(handler): undefined {
            queueMicrotask(handler);
            return undefined;
          },
        })
      : createFileWatchScheduler(flushWake, {
          schedule: handler => clock.setTimeout(handler, 0),
          cancel: handle => clock.clearTimeout(handle),
        });
  const requestWake = (): void => {
    changed = true;
    if (wake !== undefined) wakeScheduler.request();
  };
  const disarmPoll = (): void => {
    if (pollHandle !== null) {
      clock.clearTimeout(pollHandle);
      pollHandle = null;
    }
  };
  const armPoll = (): void => {
    if (pollIntervalMs <= 0 || aborted || pollHandle !== null) return;
    pollHandle = clock.setTimeout(() => {
      pollHandle = null;
      requestWake();
      armPoll();
    }, pollIntervalMs);
  };
  const watcher = watch(resolvedSessionDir, (_eventType, filename) => {
    if (filename !== null && filename !== undefined) {
      const name = filename.toString();
      if (
        name !== GROK_SOURCE_FILENAMES.updates &&
        name !== GROK_SOURCE_FILENAMES.events
      )
        return;
    }
    requestWake();
  });
  watcher.on('error', error => {
    watchError = error;
    changed = true;
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  });
  const abort = (): void => {
    aborted = true;
    watcher.close();
    disarmPoll();
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted === true) abort();
  armPoll();
  try {
    const initialResult = await tailGrokSession(
      resolvedSessionDir,
      tailOptions
    );
    const {
      fromStart: _fromStart,
      checkpoint: _checkpoint,
      ...remainingOptions
    } = tailOptions;
    tailOptions = { ...remainingOptions, checkpoint: initialResult.checkpoint };
    yield initialResult;
    while (signal?.aborted !== true && !aborted) {
      if (!changed) {
        await new Promise<void>(resolveWake => {
          wake = resolveWake;
          if (changed || isAborted(signal) || aborted) {
            wake = undefined;
            resolveWake();
          }
        });
      }
      if (isAborted(signal) || aborted) return;
      if (watchError !== undefined) throw watchError;
      changed = false;
      const result = await tailGrokSession(resolvedSessionDir, tailOptions);
      tailOptions = { ...tailOptions, checkpoint: result.checkpoint };
      if (isObservableGrokResult(result)) yield result;
    }
  } finally {
    aborted = true;
    signal?.removeEventListener('abort', abort);
    disarmPoll();
    wakeScheduler.cancel();
    watcher.close();
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
