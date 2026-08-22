import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SenpiListingOptions } from '../src/senpi/processing/listing.js';
import { scanSenpiCandidates } from '../src/senpi/processing/listing-pool.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error('deferred resolver was not initialized synchronously');
  }
  return { promise, resolve: resolvePromise };
}

function invalidListing(path: string) {
  return { kind: 'invalid', path, error: new Error('test candidate') } as const;
}

describe('bounded ordered session scans', () => {
  it('keeps test synchronization out of the public listing options', () => {
    expectTypeOf<keyof SenpiListingOptions>().toEqualTypeOf<'agentHome'>();
  });

  it('never starts more candidate scans than the conservative worker limit', async () => {
    // Given: nine internal candidate scans held at preinstalled gates.
    const paths = Array.from(
      { length: 9 },
      (_, index) => `candidate-${String(index).padStart(2, '0')}.jsonl`
    );
    const gates = paths.map(() => deferred());
    const started = paths.map(() => deferred());
    let active = 0;
    let maximumActive = 0;

    // When: the listing pool begins scanning every candidate.
    const scanning = scanSenpiCandidates(paths, {
      beforeScan: async path => {
        const index = paths.indexOf(path);
        if (index < 0) throw new Error(`unexpected candidate: ${path}`);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started[index]?.resolve();
        await gates[index]?.promise;
        active -= 1;
      },
      read: async path => invalidListing(path),
    });
    await Promise.all(started.slice(0, 4).map(signal => signal.promise));

    // Then: only the four conservative worker slots have started.
    const observedMaximumBeforeRelease = maximumActive;
    for (const gate of gates) gate.resolve();
    await expect(scanning).resolves.toMatchObject(
      paths.map(path => ({ kind: 'invalid', path }))
    );
    expect(observedMaximumBeforeRelease).toBe(4);
  });

  it('preserves candidate ordering when scans complete out of order', async () => {
    // Given: three internal candidates with completion gates installed up front.
    const paths = ['first.jsonl', 'second.jsonl', 'third.jsonl'];
    const gates = paths.map(() => deferred());
    const completed = paths.map(() => deferred());
    const scanning = scanSenpiCandidates(paths, {
      beforeScan: async path => {
        const index = paths.indexOf(path);
        if (index < 0) throw new Error(`unexpected candidate: ${path}`);
        await gates[index]?.promise;
        completed[index]?.resolve();
      },
      read: async path => invalidListing(path),
    });

    // When: scanner completion is deliberately released in reverse order.
    gates[2]?.resolve();
    await completed[2]?.promise;
    gates[1]?.resolve();
    await completed[1]?.promise;
    gates[0]?.resolve();
    await completed[0]?.promise;

    // Then: outputs retain deterministic candidate order.
    await expect(scanning).resolves.toMatchObject(
      paths.map(path => ({ kind: 'invalid', path }))
    );
  });
});
