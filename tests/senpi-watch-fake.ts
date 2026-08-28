import { EventEmitter } from 'node:events';
import type { PathLike } from 'node:fs';

/** Callback shape used by the watch implementation under test. */
type WatchListener = (
  eventType: 'rename' | 'change',
  filename: string | Buffer | null
) => void;

class FakeFsWatcher extends EventEmitter {
  readonly listener: WatchListener;
  private closed = false;

  constructor(listener: WatchListener) {
    super();
    this.listener = listener;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    activeWatchers.delete(this);
    this.emit('close');
  }
}

const activeWatchers = new Set<FakeFsWatcher>();

/** Deterministic replacement for node:fs watch. */
export function fakeWatch(
  _filename: PathLike,
  listener: WatchListener
): FakeFsWatcher {
  const watcher = new FakeFsWatcher(listener);
  activeWatchers.add(watcher);
  return watcher;
}

/** Deliver one explicit filesystem wake to every active fake watcher. */
export function emitFilesystemWake(filename: string | null): void {
  for (const watcher of activeWatchers) {
    watcher.listener('change', filename);
  }
}

/** Deliver one explicit watcher error to every active fake watcher. */
export function emitWatcherError(error: Error): void {
  for (const watcher of activeWatchers) watcher.emit('error', error);
}
