import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { internalCheckpoint } from './senpi-internal-state-utils.js';

import {
  commitSenpiSessionCheckpointInternal as commitSenpiSessionCheckpoint,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';
import {
  LINE_CAP,
  senpiHeader,
  senpiMessage,
  temporaryRoot,
  writeOversizedThenRecord,
} from './adapter-scan-cap-utils.js';

describe('adapter scan-cap continuation', () => {
  it('emits one Senpi oversized diagnostic across automatic marker-only passes', async () => {
    const root = await temporaryRoot('senpi-pending-auto-');
    const sessionPath = join(root, 'session.jsonl');
    const sneak = senpiMessage('sneak', null, 'should-not-parse');
    await writeOversizedThenRecord(sessionPath, sneak);
    const markerDir = join(root, 'markers');
    const options = { markerDir, allowedMarkerRoots: [root] };

    const first = await tailSenpiSession(sessionPath, options);
    expect(internalCheckpoint(first.checkpoint).pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });
    expect(
      first.diagnostics.filter(item => item.code === 'oversized_line')
    ).toEqual([]);
    expect(first.records).toEqual([]);
    const markerAfterFirst = await readSenpiSessionMarker(sessionPath, options);
    expect(markerAfterFirst.kind).toBe('valid');
    if (markerAfterFirst.kind !== 'valid') {
      throw new Error('expected persisted pending marker');
    }
    expect(markerAfterFirst.marker.pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });

    const second = await tailSenpiSession(sessionPath, options);
    const oversized = second.diagnostics.filter(
      item => item.code === 'oversized_line'
    );
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.byteStart).toBe(0);
    expect(second.records).toEqual([]);
    expect(internalCheckpoint(second.checkpoint).pending ?? null).toBeNull();
    expect(second.records.some(record => record.entryId === 'sneak')).toBe(
      false
    );

    const markerAfterSecond = await readSenpiSessionMarker(
      sessionPath,
      options
    );
    expect(markerAfterSecond.kind).toBe('valid');
    if (markerAfterSecond.kind !== 'valid') {
      throw new Error('expected persisted marker after oversized completion');
    }
    expect(markerAfterSecond.marker.pending).toBeNull();
    expect(markerAfterSecond.marker.offset).toBe(second.nextByteOffset);
    expect(markerAfterSecond.marker.offset).toBe(second.fileSize);
    expect(markerAfterSecond.marker.offset).toBeGreaterThan(
      first.nextByteOffset
    );

    const third = await tailSenpiSession(sessionPath, options);
    expect(
      third.diagnostics.filter(item => item.code === 'oversized_line')
    ).toHaveLength(0);
    expect(third.records).toEqual([]);
    expect(internalCheckpoint(third.checkpoint).pending ?? null).toBeNull();
    const markerAfterThird = await readSenpiSessionMarker(sessionPath, options);
    expect(markerAfterThird.kind).toBe('valid');
    if (markerAfterThird.kind !== 'valid') {
      throw new Error('expected current marker after third oversized pass');
    }
    expect(markerAfterThird.marker.offset).toBe(second.nextByteOffset);
    expect(markerAfterThird.marker.pending).toBeNull();
  });

  it('emits one Senpi oversized diagnostic across manual checkpoint continuation', async () => {
    const root = await temporaryRoot('senpi-pending-manual-');
    const sessionPath = join(root, 'session.jsonl');
    const sneak = senpiMessage('manual-sneak', null, 'should-not-parse');
    await writeOversizedThenRecord(sessionPath, sneak);
    const markerDir = join(root, 'markers');
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    const first = await tailSenpiSession(sessionPath, options);
    expect(internalCheckpoint(first.checkpoint).pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });
    await commitSenpiSessionCheckpoint(sessionPath, first.checkpoint, options);

    const fromMarker = await tailSenpiSession(sessionPath, options);
    expect(
      fromMarker.diagnostics.filter(item => item.code === 'oversized_line')
    ).toHaveLength(1);
    expect(fromMarker.records).toEqual([]);

    const fromHeld = await tailSenpiSession(sessionPath, {
      ...options,
      checkpoint: first.checkpoint,
    });
    expect(
      fromHeld.diagnostics.filter(item => item.code === 'oversized_line')
    ).toHaveLength(1);
    expect(fromHeld.records).toEqual([]);
  });

  it('advances Senpi automatic marker-only continuation past the default line cap', async () => {
    const root = await temporaryRoot('senpi-lines-auto-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(sessionPath, senpiHeader());
    const extras = LINE_CAP + 2;
    const { open } = await import('node:fs/promises');
    const handle = await open(sessionPath, 'a');
    try {
      let parent: string | null = null;
      const batch: string[] = [];
      for (let index = 0; index < extras; index += 1) {
        const id = `m${String(index).padStart(5, '0')}`;
        batch.push(senpiMessage(id, parent, `text-${String(index)}`));
        parent = id;
        if (batch.length === 250) {
          await handle.writeFile(batch.join(''));
          batch.length = 0;
        }
      }
      if (batch.length > 0) await handle.writeFile(batch.join(''));
    } finally {
      await handle.close();
    }
    const options = { markerDir, allowedMarkerRoots: [root] };

    const first = await tailSenpiSession(sessionPath, options);
    expect(first.nextByteOffset).toBeGreaterThan(0);
    const firstKeys = first.records.map(record => record.key);
    expect(firstKeys.length).toBeGreaterThan(0);
    expect(firstKeys.length).toBeLessThanOrEqual(LINE_CAP);

    const second = await tailSenpiSession(sessionPath, options);
    expect(second.nextByteOffset).toBeGreaterThan(first.nextByteOffset);
    expect(second.checkpoint.lineNumber).toBeGreaterThan(
      first.checkpoint.lineNumber
    );
    expect(firstKeys.length).toBeLessThanOrEqual(LINE_CAP);
  });
});
