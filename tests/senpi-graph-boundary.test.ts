import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SENPI_GRAPH_MAX_BYTES,
  SENPI_KEYS_MAX_BYTES,
  encodeAcceptedEntries,
  parseProjectedRecordKeys,
  utf8JsonSize,
} from '../src/senpi/processing/accepted-graph.js';
import {
  getSenpiSessionMarkerPath,
  parseSenpiSessionMarkerInternal,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(path => rm(path, { recursive: true, force: true }))
  );
});

function entry(
  id: string,
  parentId: string | null,
  text = id
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1,
    },
  };
}

function session(id: string): Record<string, unknown> {
  return {
    type: 'session',
    id,
    version: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
  };
}

describe('Senpi accepted-graph boundaries', () => {
  it('enforces graph and key byte caps over UTF-8 bytes, not code points', () => {
    const multibyte = '😀';
    const graph = [
      { id: multibyte.repeat(SENPI_GRAPH_MAX_BYTES / 4), p: null },
    ];
    const keys = [multibyte.repeat(SENPI_KEYS_MAX_BYTES / 4)];
    expect(graph[0]?.id.length).toBeLessThan(SENPI_GRAPH_MAX_BYTES);
    expect(utf8JsonSize(graph)).toBeGreaterThan(SENPI_GRAPH_MAX_BYTES);
    expect(encodeAcceptedEntries(graph)).toBeNull();
    expect(keys[0]?.length).toBeLessThan(SENPI_KEYS_MAX_BYTES);
    expect(utf8JsonSize(keys)).toBeGreaterThan(SENPI_KEYS_MAX_BYTES);
    expect(parseProjectedRecordKeys(keys)).toEqual({
      keys: [],
      overflow: true,
    });
  });

  it('rejects duplicate and out-of-order graphs even when leaf membership is consistent', () => {
    const marker = {
      markerVersion: 1,
      sessionPathDigest: 'digest',
      sessionId: 'session',
      device: '1',
      inode: '2',
      generation: 0,
      offset: 10,
      lineNumber: 2,
      headDigest: 'head',
      boundaryDigest: 'boundary',
      revision: 1,
      leafId: 'leaf',
      projectedRecordKeys: ['leaf'],
      pending: null,
    };
    const duplicate = parseSenpiSessionMarkerInternal({
      ...marker,
      acceptedEntries: [
        { id: 'root', p: null },
        { id: 'leaf', p: 'root' },
        { id: 'leaf', p: 'root' },
      ],
    });
    expect(duplicate.kind).toBe('valid');
    if (duplicate.kind !== 'valid') throw new Error('expected valid marker');
    expect(duplicate.marker.acceptedEntries).toBeUndefined();

    const outOfOrder = parseSenpiSessionMarkerInternal({
      ...marker,
      acceptedEntries: [
        { id: 'root', p: null },
        { id: 'leaf', p: 'later' },
        { id: 'later', p: 'root' },
      ],
    });
    expect(outOfOrder.kind).toBe('valid');
    if (outOfOrder.kind !== 'valid') throw new Error('expected valid marker');
    expect(outOfOrder.marker.acceptedEntries).toBeUndefined();
  });

  it('rejects a valid-shaped 2MiB marker before parsing ignored fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'senpi-valid-oversize-marker-'));
    roots.push(root);
    const markerDir = join(root, 'markers');
    await mkdir(markerDir);
    const sessionPath = join(root, 'session.jsonl');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await writeFile(
      sessionPath,
      [session('s'), entry('a', null)]
        .map(value => JSON.stringify(value))
        .join('\n') + '\n'
    );
    await tailSenpiSession(sessionPath, options);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
    const decoded: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(decoded)) throw new Error('expected marker object');
    decoded['ignoredPadding'] = 'x'.repeat(2 * 1024 * 1024);
    await writeFile(markerPath, `${JSON.stringify(decoded)}\n`);
    const bounded = await readSenpiSessionMarker(sessionPath, options);
    expect(bounded).toEqual({
      kind: 'invalid',
      error: 'marker file exceeds 1MiB read bound',
    });
  });

  it('ignores an invalid stale graph and rebuilds before advancing its marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'senpi-stale-graph-'));
    roots.push(root);
    const markerDir = join(root, 'markers');
    await mkdir(markerDir);
    const sessionPath = join(root, 'session.jsonl');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await writeFile(
      sessionPath,
      [session('s'), entry('a', null), entry('b', 'a')]
        .map(value => JSON.stringify(value))
        .join('\n') + '\n'
    );
    await tailSenpiSession(sessionPath, options);
    const markerPath = getSenpiSessionMarkerPath(sessionPath, options);
    const decoded: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(decoded)) throw new Error('expected marker object');
    decoded['acceptedEntries'] = [
      { id: 'session:s', p: null },
      { id: 'stale-child', p: 'missing-parent' },
    ];
    await writeFile(markerPath, `${JSON.stringify(decoded, null, 2)}\n`);
    const parsed = await readSenpiSessionMarker(sessionPath, options);
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid marker');
    expect(parsed.marker.acceptedEntries).toBeUndefined();
    const heldOffset = parsed.marker.offset;

    await writeFile(
      sessionPath,
      [session('s'), entry('a', null), entry('b', 'a'), entry('branch', 'a')]
        .map(value => JSON.stringify(value))
        .join('\n') + '\n'
    );
    const result = await tailSenpiSession(sessionPath, options);
    expect(result.nextByteOffset).toBeGreaterThan(heldOffset);
    expect(result.records.map(record => record.entryId)).toEqual([
      'a',
      'branch',
    ]);
    expect(
      result.diagnostics.some(item => item.code === 'missing_parent')
    ).toBe(false);
    const committed = await readSenpiSessionMarker(sessionPath, options);
    expect(committed.kind).toBe('valid');
    if (committed.kind !== 'valid') throw new Error('expected rebuilt marker');
    expect(committed.marker.offset).toBe(result.nextByteOffset);
    expect(
      committed.marker.acceptedEntries?.some(item => item.id === 'branch')
    ).toBe(true);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
