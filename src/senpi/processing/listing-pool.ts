import type { SenpiSessionListing } from './listing.js';

const DEFAULT_SCAN_CONCURRENCY = 4;

/** Internal scanner inputs; intentionally absent from the package barrel. */
export interface SenpiCandidateScanOptions {
  readonly read: (path: string) => Promise<SenpiSessionListing | null>;
  /** Test-only synchronization runs inside an acquired worker slot. */
  readonly beforeScan?: ((path: string) => Promise<void>) | undefined;
}

interface IndexedListing {
  readonly index: number;
  readonly value: SenpiSessionListing | null;
}

/**
 * Scan deterministically ordered candidate paths through the listing pool.
 *
 * This domain-specific helper is internal to listing and its deterministic
 * tests. It is not exported from any package barrel.
 */
export async function scanSenpiCandidates(
  paths: readonly string[],
  options: SenpiCandidateScanOptions
): Promise<(SenpiSessionListing | null)[]> {
  const entries = paths.entries();
  const workerCount = Math.min(DEFAULT_SCAN_CONCURRENCY, paths.length);
  const workers = Array.from({ length: workerCount }, async () => {
    const completed: IndexedListing[] = [];
    for (;;) {
      const next = entries.next();
      if (next.done) return completed;
      const [index, path] = next.value;
      await options.beforeScan?.(path);
      completed.push({ index, value: await options.read(path) });
    }
  });
  const completed = (await Promise.all(workers)).flat();
  completed.sort((left, right) => left.index - right.index);
  return completed.map(result => result.value);
}
