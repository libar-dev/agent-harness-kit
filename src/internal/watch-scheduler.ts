/** Scheduling hooks used to coalesce filesystem wake hints. */
export interface WatchSchedule<Handle> {
  readonly schedule: (handler: () => void) => Handle;
  readonly cancel?: (handle: Handle) => void;
}

/** One cancellable, coalescing wake scheduler shared by file observers. */
export interface FileWatchScheduler {
  readonly request: () => void;
  readonly cancel: () => void;
  readonly pending: () => boolean;
}

/**
 * Coalesce repeated file-watch hints into one scheduled callback.
 *
 * The caller owns timing policy by supplying either a microtask scheduler or
 * an injected clock. This primitive owns only the identical single-pending
 * scheduling contract.
 */
export function createFileWatchScheduler<Handle>(
  callback: () => void,
  timing: WatchSchedule<Handle>
): FileWatchScheduler {
  let handle: Handle | undefined;
  let scheduled = false;

  return {
    request(): void {
      if (scheduled) return;
      scheduled = true;
      handle = timing.schedule(() => {
        scheduled = false;
        handle = undefined;
        callback();
      });
    },
    cancel(): void {
      if (!scheduled) return;
      scheduled = false;
      if (handle !== undefined) timing.cancel?.(handle);
      handle = undefined;
    },
    pending: () => scheduled,
  };
}
