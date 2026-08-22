import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getSenpiSessionMarkerPath,
  readSenpiSessionMarker,
} from '../src/senpi/processing/checkpoint.js';
import { tailSenpiSession } from '../src/senpi/processing/tail.js';

const fixturePath = join(
  process.cwd(),
  'tests/fixtures/senpi/synthetic-branch-switch.jsonl'
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true }))
  );
});

async function temporarySession(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'senpi-tail-'));
  temporaryRoots.push(root);
  const path = join(root, 'session.jsonl');
  await writeFile(path, content);
  return path;
}

async function fixtureLines(): Promise<readonly string[]> {
  return (await readFile(fixturePath, 'utf8')).trimEnd().split('\n');
}

function joined(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function keys(records: readonly { readonly key: string }[]): readonly string[] {
  return records.map(record => record.key);
}

function compaction(parentId: string): string {
  return JSON.stringify({
    type: 'compaction',
    id: 'a1000008',
    parentId,
    timestamp: '2026-01-01T00:00:08.000Z',
    summary: 'Compacted branch context.',
    tokensBefore: 100,
    retainedTail: [],
  });
}

describe('tailSenpiSession integration', () => {
  it('emits exact branch, compaction, and reset suffix splices', async () => {
    const lines = await fixtureLines();
    const path = await temporarySession(joined(lines.slice(0, 4)));

    const first = await tailSenpiSession(path);
    expect(keys(first.records)).toEqual(['a1000001', 'a1000002', 'a1000003']);
    expect(first.mutations).toHaveLength(1);
    expect(first.mutations[0]).toMatchObject({
      baseRevision: 0,
      revision: 1,
      index: 0,
      deleteCount: 0,
      removedRecordKeys: [],
    });
    expect(keys(first.mutations[0]?.records ?? [])).toEqual([
      'a1000001',
      'a1000002',
      'a1000003',
    ]);

    await appendFile(path, joined(lines.slice(4)));
    const switched = await tailSenpiSession(path);
    expect(keys(switched.records)).toEqual([
      'a1000001',
      'a1000002',
      'a1000005',
      'a1000006',
      'a1000007',
    ]);
    expect(switched.mutations).toHaveLength(1);
    expect(switched.mutations[0]).toMatchObject({
      baseRevision: 1,
      revision: 2,
      index: 2,
      deleteCount: 1,
      removedRecordKeys: ['a1000003'],
    });
    expect(keys(switched.mutations[0]?.records ?? [])).toEqual([
      'a1000005',
      'a1000006',
      'a1000007',
    ]);

    await appendFile(path, `${compaction('a1000007')}\n`);
    const compacted = await tailSenpiSession(path);
    expect(keys(compacted.records)).toEqual(['a1000008']);
    expect(compacted.mutations).toHaveLength(1);
    expect(compacted.mutations[0]).toMatchObject({
      baseRevision: 2,
      revision: 3,
      index: 0,
      deleteCount: 5,
      removedRecordKeys: [
        'a1000001',
        'a1000002',
        'a1000005',
        'a1000006',
        'a1000007',
      ],
    });
    expect(keys(compacted.mutations[0]?.records ?? [])).toEqual(['a1000008']);

    const replacement = `${path}.replacement`;
    await writeFile(replacement, joined(lines.slice(0, 4)));
    await rename(replacement, path);
    const reset = await tailSenpiSession(path);
    expect(reset.reset).toBe(true);
    expect(reset.previousByteOffset).toBe(0);
    expect(reset.mutations).toHaveLength(1);
    expect(reset.mutations[0]).toMatchObject({
      baseRevision: 3,
      revision: 4,
      index: 0,
      deleteCount: 0,
      removedRecordKeys: [],
    });
    expect(keys(reset.mutations[0]?.records ?? [])).toEqual([
      'a1000001',
      'a1000002',
      'a1000003',
    ]);
  });

  it('defers a truncated final line and rereads it without data loss', async () => {
    const lines = await fixtureLines();
    const complete = joined(lines.slice(0, 3));
    const finalLine = lines[3];
    if (finalLine === undefined) throw new Error('fixture line missing');
    const split = Math.floor(finalLine.length / 2);
    const path = await temporarySession(
      `${complete}${finalLine.slice(0, split)}`
    );

    const held = await tailSenpiSession(path);
    expect(keys(held.records)).toEqual(['a1000001', 'a1000002']);
    expect(held.nextByteOffset).toBe(Buffer.byteLength(complete));
    expect(held.fileSize).toBeGreaterThan(held.nextByteOffset);

    await appendFile(path, `${finalLine.slice(split)}\n`);
    const completed = await tailSenpiSession(path);
    expect(keys(completed.records)).toEqual([
      'a1000001',
      'a1000002',
      'a1000003',
    ]);
    expect(completed.mutations).toHaveLength(1);
    expect(completed.mutations[0]).toMatchObject({
      index: 2,
      deleteCount: 0,
      removedRecordKeys: [],
    });
    expect(keys(completed.mutations[0]?.records ?? [])).toEqual(['a1000003']);
  });

  it('returns an invalid leaf for a terminal malformed line without throwing', async () => {
    const lines = await fixtureLines();
    const path = await temporarySession(
      `${joined(lines.slice(0, 3))}{bad json\n`
    );

    const result = await tailSenpiSession(path, { checkpointMode: 'manual' });

    expect(result.leaf).toEqual({ kind: 'invalid', leafId: null });
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_json', lineNumber: 4 }),
      ])
    );
  });

  it('invalidates stale inode, shrink, digest, boundary, fromStart, and malformed markers', async () => {
    const lines = await fixtureLines();

    async function seeded(): Promise<string> {
      const path = await temporarySession(joined(lines.slice(0, 4)));
      await tailSenpiSession(path);
      return path;
    }

    const inodePath = await seeded();
    await writeFile(`${inodePath}.new`, joined(lines.slice(0, 4)));
    await rename(`${inodePath}.new`, inodePath);
    expect((await tailSenpiSession(inodePath)).reset).toBe(true);

    const shrinkPath = await seeded();
    await truncate(shrinkPath, Buffer.byteLength(joined(lines.slice(0, 2))));
    expect((await tailSenpiSession(shrinkPath)).reset).toBe(true);

    const digestPath = await seeded();
    const original = await readFile(digestPath);
    const changed = Buffer.from(original);
    const replacementIndex = changed.indexOf(Buffer.from('root user turn'));
    expect(replacementIndex).toBeGreaterThan(0);
    changed.set(Buffer.from('ROOT USER TURN'), replacementIndex);
    await writeFile(digestPath, changed);
    expect((await tailSenpiSession(digestPath)).reset).toBe(true);

    const boundaryPath = await seeded();
    const boundaryMarkerPath = getSenpiSessionMarkerPath(boundaryPath);
    const boundaryRead = await readSenpiSessionMarker(boundaryPath);
    if (boundaryRead.kind !== 'valid') throw new Error('marker missing');
    await writeFile(
      boundaryMarkerPath,
      JSON.stringify({
        ...boundaryRead.marker,
        boundaryDigest: '0'.repeat(64),
      })
    );
    expect((await tailSenpiSession(boundaryPath)).reset).toBe(true);

    const fromStartPath = await seeded();
    expect(
      (await tailSenpiSession(fromStartPath, { fromStart: true })).reset
    ).toBe(true);

    const malformedPath = await seeded();
    await writeFile(getSenpiSessionMarkerPath(malformedPath), '{broken');
    const malformed = await tailSenpiSession(malformedPath);
    expect(malformed.reset).toBe(true);
    expect(malformed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'checkpoint_invalid' }),
      ])
    );

    const offsetPath = await seeded();
    const offsetMarkerPath = getSenpiSessionMarkerPath(offsetPath);
    const offsetRead = await readSenpiSessionMarker(offsetPath);
    if (offsetRead.kind !== 'valid') throw new Error('marker missing');
    await writeFile(
      offsetMarkerPath,
      JSON.stringify({
        ...offsetRead.marker,
        offset: offsetRead.marker.offset - 1,
      })
    );
    expect((await tailSenpiSession(offsetPath)).reset).toBe(true);
  });

  it('captures the deterministic live-append golden sequence', async () => {
    const lines = await fixtureLines();
    const path = await temporarySession(joined(lines.slice(0, 4)));
    const first = await tailSenpiSession(path);
    await appendFile(path, joined(lines.slice(4)));
    const second = await tailSenpiSession(path);

    const golden = [first, second].map(result => ({
      revision: result.revision,
      reset: result.reset,
      offsets: [result.previousByteOffset, result.nextByteOffset],
      keys: keys(result.records),
      splice: result.mutations.map(mutation => ({
        index: mutation.index,
        deleteCount: mutation.deleteCount,
        removedRecordKeys: mutation.removedRecordKeys,
        keys: keys(mutation.records),
      })),
    }));
    console.log(`SENPI_LIVE_APPEND_GOLDEN ${JSON.stringify(golden)}`);

    expect(golden).toEqual([
      {
        revision: 1,
        reset: true,
        offsets: [0, Buffer.byteLength(joined(lines.slice(0, 4)))],
        keys: ['a1000001', 'a1000002', 'a1000003'],
        splice: [
          {
            index: 0,
            deleteCount: 0,
            removedRecordKeys: [],
            keys: ['a1000001', 'a1000002', 'a1000003'],
          },
        ],
      },
      {
        revision: 2,
        reset: false,
        offsets: [
          Buffer.byteLength(joined(lines.slice(0, 4))),
          Buffer.byteLength(joined(lines)),
        ],
        keys: ['a1000001', 'a1000002', 'a1000005', 'a1000006', 'a1000007'],
        splice: [
          {
            index: 2,
            deleteCount: 1,
            removedRecordKeys: ['a1000003'],
            keys: ['a1000005', 'a1000006', 'a1000007'],
          },
        ],
      },
    ]);
  });
});
