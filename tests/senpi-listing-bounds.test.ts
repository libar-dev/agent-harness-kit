import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  encodeSenpiCwdDirname,
  getSenpiSessionsRoot,
} from '../src/senpi/processing/discovery.js';
import { listSenpiSessions } from '../src/senpi/processing/listing.js';

const createdStores: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdStores.map(store => rm(store, { recursive: true, force: true }))
  );
});

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

async function makeStore(): Promise<string> {
  const store = await mkdtemp(join(tmpdir(), 'senpi-listing-bounds-'));
  createdStores.push(store);
  return store;
}

function sessionHeader(cwd: string, id: string): Record<string, unknown> {
  return {
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-08-20T10:00:00.000Z',
    cwd,
  };
}

interface CandidateSpec {
  readonly agentHome: string;
  readonly cwd: string;
  readonly file: string;
  readonly id: string;
}

async function writeCandidate(spec: CandidateSpec): Promise<string> {
  const dir = join(
    getSenpiSessionsRoot(spec.agentHome),
    encodeSenpiCwdDirname(spec.cwd)
  );
  await mkdir(dir, { recursive: true });
  const path = join(dir, spec.file);
  await writeFile(
    path,
    `${JSON.stringify(sessionHeader(spec.cwd, spec.id))}\n`
  );
  return path;
}

describe('bounded ordered session scans', () => {
  it('never starts more candidate scans than the conservative worker limit', async () => {
    // Given: nine real candidates with gates installed before listing starts.
    const agentHome = await makeStore();
    const cwd = '/work/concurrent';
    const paths = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        writeCandidate({
          agentHome,
          cwd,
          file: `candidate-${String(index).padStart(2, '0')}.jsonl`,
          id: `concurrent-${index}`,
        })
      )
    );
    const gates = paths.map(() => deferred());
    const started = paths.map(() => deferred());
    let active = 0;
    let maximumActive = 0;

    // When: the public listing parent begins scanning all candidates.
    const listing = listSenpiSessions(cwd, {
      agentHome,
      beforeCandidateScan: async path => {
        const index = paths.indexOf(path);
        if (index < 0) throw new Error(`unexpected candidate: ${path}`);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started[index]?.resolve();
        await gates[index]?.promise;
        active -= 1;
      },
    });
    await Promise.all(started.slice(0, 4).map(signal => signal.promise));

    // Then: only the four conservative worker slots have started.
    const observedMaximumBeforeRelease = maximumActive;
    for (const gate of gates) gate.resolve();
    await expect(listing).resolves.toHaveLength(paths.length);
    expect(observedMaximumBeforeRelease).toBe(4);
  });

  it('preserves candidate ordering when scans complete out of order', async () => {
    // Given: three real candidates with completion gates installed up front.
    const agentHome = await makeStore();
    const cwd = '/work/ordered';
    const paths = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        writeCandidate({
          agentHome,
          cwd,
          file: `ordered-${index}.jsonl`,
          id: `ordered-${index}`,
        })
      )
    );
    const gates = paths.map(() => deferred());
    const completed = paths.map(() => deferred());
    const listing = listSenpiSessions(cwd, {
      agentHome,
      beforeCandidateScan: async path => {
        const index = paths.indexOf(path);
        if (index < 0) throw new Error(`unexpected candidate: ${path}`);
        await gates[index]?.promise;
        completed[index]?.resolve();
      },
    });

    // When: scanner completion is deliberately released in reverse order.
    gates[2]?.resolve();
    await completed[2]?.promise;
    gates[1]?.resolve();
    await completed[1]?.promise;
    gates[0]?.resolve();
    await completed[0]?.promise;

    // Then: public listing outputs retain deterministic candidate order.
    await expect(listing).resolves.toMatchObject(
      paths.map((_, index) => ({
        kind: 'valid',
        info: { id: `ordered-${index}` },
      }))
    );
  });

  it('rejects an oversized first non-empty header line with a typed diagnostic', async () => {
    // Given: a candidate whose first line exceeds the 64 KiB header contract.
    const agentHome = await makeStore();
    const path = await writeCandidate({
      agentHome,
      cwd: '/work/hostile-header',
      file: 'huge-header.jsonl',
      id: 'placeholder',
    });
    await writeFile(path, `${'x'.repeat(64 * 1024 + 1)}\n`);

    // When: listing scans the candidate.
    const listings = await listSenpiSessions('/work/hostile-header', {
      agentHome,
    });

    // Then: the file is isolated with a machine-readable diagnostic.
    expect(listings).toMatchObject([
      {
        kind: 'invalid',
        path,
        error: {
          code: 'header-line-too-large',
          lineNumber: 1,
          maxLineBytes: 64 * 1024,
        },
      },
    ]);
  });

  it('rejects an oversized later record line with a typed diagnostic', async () => {
    // Given: a valid header followed by a record over the 16 MiB limit.
    const agentHome = await makeStore();
    const cwd = '/work/hostile-record';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'huge-record.jsonl',
      id: 'huge-record',
    });
    await writeFile(
      path,
      `${JSON.stringify(sessionHeader(cwd, 'huge-record'))}\n${'x'.repeat(16 * 1024 * 1024 + 1)}\n`
    );

    // When: listing scans the candidate summary.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: scanning stops with a bounded per-record diagnostic.
    expect(listings).toMatchObject([
      {
        kind: 'invalid',
        path,
        error: {
          code: 'record-line-too-large',
          lineNumber: 2,
          maxLineBytes: 16 * 1024 * 1024,
        },
      },
    ]);
  });
});
