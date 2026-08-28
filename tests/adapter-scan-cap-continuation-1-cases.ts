import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commitGrokSessionCheckpoint,
  tailGrokSession,
} from '../src/grok/processing/tail.js';
import {
  LINE_CAP,
  OVERSIZE_PREFIX_BYTES,
  grokSession,
  grokUpdatesPending,
  isRecord,
  markerFile,
  temporaryRoot,
  updateLine,
  writeManyLines,
  writeOversizedThenRecord,
} from './adapter-scan-cap-utils.js';

describe('adapter scan-cap continuation', () => {
  it('preserves Grok pending through automatic marker reread and emits one oversized diagnostic', async () => {
    const root = await temporaryRoot('grok-pending-auto-');
    const session = await grokSession(root, 'auto');
    const markerDir = join(root, 'markers');
    const sneak = updateLine(9_001, 'sneak-json', 'sneak-json');
    await writeOversizedThenRecord(join(session, 'updates.jsonl'), sneak);
    const options = { markerDir, allowedMarkerRoots: [root] };

    const first = await tailGrokSession(session, options);
    expect(grokUpdatesPending(first)).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });
    expect(
      first.records.some(record => record.byteStart >= OVERSIZE_PREFIX_BYTES)
    ).toBe(false);
    expect(
      first.diagnostics.filter(item => item.kind === 'oversized')
    ).toHaveLength(0);

    const markerPath = await markerFile(markerDir, '.grok-session.json');
    const raw: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(raw)) throw new Error('marker JSON is not an object');
    const sources = raw['sources'];
    if (!isRecord(sources)) throw new Error('marker sources missing');
    const updates = sources['updates'];
    if (!isRecord(updates)) throw new Error('updates cursor missing');
    expect(updates['pending']).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });

    const second = await tailGrokSession(session, options);
    const oversized = second.diagnostics.filter(
      item => item.kind === 'oversized'
    );
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.byteStart).toBe(0);
    expect(
      second.records.some(record => record.byteStart >= OVERSIZE_PREFIX_BYTES)
    ).toBe(false);
    expect(grokUpdatesPending(second)).toBeNull();
  });

  it('preserves Grok pending through manual checkpoint commit and marker reread', async () => {
    const root = await temporaryRoot('grok-pending-manual-');
    const session = await grokSession(root, 'manual');
    const markerDir = join(root, 'markers');
    const sneak = updateLine(9_002, 'manual-sneak', 'manual-sneak');
    await writeOversizedThenRecord(join(session, 'updates.jsonl'), sneak);
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    const first = await tailGrokSession(session, options);
    expect(grokUpdatesPending(first)).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });
    await commitGrokSessionCheckpoint(session, first.checkpoint, options);

    const reread = await tailGrokSession(session, options);
    const oversized = reread.diagnostics.filter(
      item => item.kind === 'oversized'
    );
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.byteStart).toBe(0);
    expect(
      reread.records.some(record => record.byteStart >= OVERSIZE_PREFIX_BYTES)
    ).toBe(false);

    const held = await tailGrokSession(session, {
      ...options,
      checkpoint: first.checkpoint,
    });
    expect(
      held.diagnostics.filter(item => item.kind === 'oversized')
    ).toHaveLength(1);
    expect(
      held.records.some(record => record.byteStart >= OVERSIZE_PREFIX_BYTES)
    ).toBe(false);
  });

  it('advances Grok automatic marker-only continuation past the default line cap', async () => {
    const root = await temporaryRoot('grok-lines-auto-');
    const session = await grokSession(root, 'lines');
    const markerDir = join(root, 'markers');
    const total = LINE_CAP + 3;
    await writeManyLines(join(session, 'updates.jsonl'), total, index =>
      updateLine(2_000 + index, `line-${String(index)}`, `id-${String(index)}`)
    );
    const options = { markerDir, allowedMarkerRoots: [root] };

    await writeFile(join(session, 'events.jsonl'), '');
    const first = await tailGrokSession(session, options);
    const firstUpdates = first.records.filter(
      record => record.sourceKind === 'updates'
    );
    expect(firstUpdates).toHaveLength(LINE_CAP);
    const firstOffset =
      first.checkpoint.sources.find(source => source.sourceKind === 'updates')
        ?.cursor?.offset ?? 0;
    expect(firstOffset).toBeGreaterThan(0);

    const second = await tailGrokSession(session, options);
    expect(second.records.length).toBeGreaterThan(0);
    expect(second.records.length).toBeLessThanOrEqual(3);
    const secondOffset =
      second.checkpoint.sources.find(source => source.sourceKind === 'updates')
        ?.cursor?.offset ?? 0;
    expect(secondOffset).toBeGreaterThan(firstOffset);
    expect(second.records[0]?.byteStart).toBe(firstOffset);
    expect(second.changes.length).toBeGreaterThan(0);
  });
});
