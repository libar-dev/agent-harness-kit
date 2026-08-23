import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tailGrokSession } from '../src/grok/processing/tail.js';
import { tailSenpiSession } from '../src/senpi/processing/tail.js';

const fixtureRoot = join(process.cwd(), 'tests/fixtures');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(root => rm(root, { recursive: true, force: true }))
  );
});

async function expectedFixture(path: string): Promise<string> {
  return readFile(join(fixtureRoot, path), 'utf8');
}

describe('adapter semantic fixture characterization', () => {
  it('keeps normalized Grok fixture output byte-for-byte stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-semantic-fixture-'));
    temporaryRoots.push(root);
    const session = join(root, 'session');
    await mkdir(session);
    await Promise.all([
      copyFile(
        join(fixtureRoot, 'grok/updates.sample.jsonl'),
        join(session, 'updates.jsonl')
      ),
      copyFile(
        join(fixtureRoot, 'grok/events.sample.jsonl'),
        join(session, 'events.jsonl')
      ),
    ]);

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
    });
    const normalized = {
      records: result.records,
      changes: result.changes,
      activities: result.activities,
      diagnostics: result.diagnostics,
      sources: result.sources.map(
        ({ sourcePath: _sourcePath, ...source }) => source
      ),
      resets: result.resets,
    };

    expect(`${JSON.stringify(normalized, null, 2)}\n`).toBe(
      await expectedFixture('grok/normalized-processing.json')
    );
  });

  it('keeps normalized Senpi fixture output byte-for-byte stable', async () => {
    const result = await tailSenpiSession(
      join(fixtureRoot, 'senpi/synthetic-branch-switch.jsonl'),
      {
        fromStart: true,
        checkpointMode: 'manual',
        includeOffPath: true,
      }
    );
    const normalized = {
      records: result.records,
      mutations: result.mutations.map(
        ({ baseRevision: _baseRevision, revision: _revision, ...mutation }) =>
          mutation
      ),
      changes: result.changes,
      offPath: result.offPath,
      diagnostics: result.diagnostics,
      leaf: result.leaf,
      previousByteOffset: result.previousByteOffset,
      nextByteOffset: result.nextByteOffset,
      fileSize: result.fileSize,
      generation: result.generation,
      reset: result.reset,
    };

    expect(`${JSON.stringify(normalized, null, 2)}\n`).toBe(
      await expectedFixture('senpi/normalized-processing.json')
    );
  });
});
