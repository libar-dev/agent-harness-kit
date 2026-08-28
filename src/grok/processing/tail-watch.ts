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
} from './tail-types.js';

/**
 * Watch both Grok JSONL sources and yield observable reconciled batches.
 *
 * @param sessionDir - Directory containing both sources.
 * @param options - Existing tail options and cancellation signal.
 * @returns Initial readiness result followed by changed batches.
 */
export async function* watchGrokSession(
  sessionDir: string,
  options: GrokSessionWatchOptions = {}
): AsyncGenerator<GrokSessionTailResult, void, unknown> {
  const resolvedSessionDir = resolve(sessionDir);
  const { signal, ...initialTailOptions } = options;
  let tailOptions: GrokSessionTailOptions = initialTailOptions;
  let changed = false;
  let wake: (() => void) | undefined;
  let watchError: Error | undefined;
  const wakeScheduler: FileWatchScheduler = createFileWatchScheduler(
    () => {
      const resolveWake = wake;
      wake = undefined;
      resolveWake?.();
    },
    {
      schedule(handler): undefined {
        queueMicrotask(handler);
        return undefined;
      },
    }
  );
  const watcher = watch(resolvedSessionDir, (_eventType, filename) => {
    const name = filename?.toString();
    if (
      name !== GROK_SOURCE_FILENAMES.updates &&
      name !== GROK_SOURCE_FILENAMES.events
    )
      return;
    changed = true;
    if (wake !== undefined) wakeScheduler.request();
  });
  watcher.on('error', error => {
    watchError = error;
    changed = true;
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  });
  const abort = (): void => {
    watcher.close();
    const resolveWake = wake;
    wake = undefined;
    resolveWake?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
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
    while (signal?.aborted !== true) {
      if (!changed) {
        await new Promise<void>(resolveWake => {
          wake = resolveWake;
          if (changed || isAborted(signal)) {
            wake = undefined;
            resolveWake();
          }
        });
      }
      if (isAborted(signal)) return;
      if (watchError !== undefined) throw watchError;
      changed = false;
      const result = await tailGrokSession(resolvedSessionDir, tailOptions);
      tailOptions = { ...tailOptions, checkpoint: result.checkpoint };
      if (isObservableGrokResult(result)) yield result;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    wakeScheduler.cancel();
    watcher.close();
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
