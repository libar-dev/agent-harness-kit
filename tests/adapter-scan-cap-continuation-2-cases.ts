import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commitGrokSessionCheckpoint,
  tailGrokSession,
  watchGrokSession,
} from '../src/grok/processing/tail.js';
import {
  SENPI_MARKER_VERSION,
  commitSenpiSessionCheckpointInternal as commitSenpiSessionCheckpoint,
  parseSenpiSessionMarkerInternal as parseSenpiSessionMarker,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';
import {
  LINE_CAP,
  grokSession,
  nextWithTimeout,
  senpiHeader,
  temporaryRoot,
  updateLine,
  waitForFsEvent,
  writeManyLines,
} from './adapter-scan-cap-utils.js';

describe('adapter scan-cap continuation', () => {
  it('advances Grok manual checkpoint continuation past the default line cap', async () => {
    const root = await temporaryRoot('grok-lines-manual-');
    const session = await grokSession(root, 'lines-manual');
    const markerDir = join(root, 'markers');
    const total = LINE_CAP + 2;
    await writeManyLines(join(session, 'updates.jsonl'), total, index =>
      updateLine(3_000 + index, `man-${String(index)}`, `mid-${String(index)}`)
    );
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    await writeFile(join(session, 'events.jsonl'), '');
    const first = await tailGrokSession(session, options);
    expect(
      first.records.filter(record => record.sourceKind === 'updates')
    ).toHaveLength(LINE_CAP);
    await commitGrokSessionCheckpoint(session, first.checkpoint, options);

    const second = await tailGrokSession(session, {
      ...options,
      checkpoint: first.checkpoint,
    });
    expect(second.records).toHaveLength(2);
    expect(second.changes.length).toBeGreaterThan(0);
  });

  it('advances Grok watch continuation checkpoint after every reconcile', async () => {
    const root = await temporaryRoot('grok-watch-cap-');
    const session = await grokSession(root, 'watch');
    const markerDir = join(root, 'markers');
    const total = LINE_CAP + 1;
    await writeManyLines(join(session, 'updates.jsonl'), total, index =>
      updateLine(4_000 + index, `w-${String(index)}`, `wid-${String(index)}`)
    );
    await writeFile(join(session, 'events.jsonl'), '');
    const controller = new AbortController();
    const iterator = watchGrokSession(session, {
      markerDir,
      allowedMarkerRoots: [root],
      signal: controller.signal,
    });
    const first = await nextWithTimeout(iterator);
    expect(
      first.value.records.filter(record => record.sourceKind === 'updates')
    ).toHaveLength(LINE_CAP);
    const firstOffset =
      first.value.checkpoint.sources.find(
        source => source.sourceKind === 'updates'
      )?.cursor?.offset ?? 0;

    const secondPromise = nextWithTimeout(iterator);
    await waitForFsEvent(join(session, 'updates.jsonl'), async () => {
      await appendFile(
        join(session, 'updates.jsonl'),
        updateLine(9_999, 'watch-append', 'watch-append')
      );
    });
    const second = await secondPromise;
    expect(second.value.records.length).toBeGreaterThan(0);
    expect(
      second.value.records.every(record => record.byteStart >= firstOffset)
    ).toBe(true);
    expect(second.value.records).toHaveLength(2);
    const secondOffset =
      second.value.checkpoint.sources.find(
        source => source.sourceKind === 'updates'
      )?.cursor?.offset ?? 0;
    expect(secondOffset).toBeGreaterThan(firstOffset);

    const thirdPromise = nextWithTimeout(iterator);
    await waitForFsEvent(join(session, 'updates.jsonl'), async () => {
      await appendFile(
        join(session, 'updates.jsonl'),
        updateLine(10_000, 'watch-third', 'watch-third')
      );
    });
    const third = await thirdPromise;
    expect(third.value.records).toHaveLength(1);
    expect(third.value.records[0]?.byteStart).toBe(secondOffset);

    controller.abort();
    await iterator.return?.();
  });

  it('preserves Senpi pending on markers without a version bump', async () => {
    const root = await temporaryRoot('senpi-pending-schema-');
    const sessionPath = join(root, 'session.jsonl');
    await writeFile(sessionPath, senpiHeader());
    const markerDir = join(root, 'markers');
    const first = await tailSenpiSession(sessionPath, {
      markerDir,
      allowedMarkerRoots: [root],
    });
    const withPending = {
      ...first.checkpoint,
      baseRevision: first.revision,
      pending: { kind: 'discarding_oversized' as const, byteStart: 0 },
    };
    await commitSenpiSessionCheckpoint(sessionPath, withPending, {
      markerDir,
      allowedMarkerRoots: [root],
    });
    const reread = await readSenpiSessionMarker(sessionPath, {
      markerDir,
      allowedMarkerRoots: [root],
    });
    expect(reread.kind).toBe('valid');
    if (reread.kind !== 'valid') throw new Error('expected valid marker');
    expect(reread.marker.markerVersion).toBe(SENPI_MARKER_VERSION);
    expect(reread.marker.pending).toEqual({
      kind: 'discarding_oversized',
      byteStart: 0,
    });

    const absent = parseSenpiSessionMarker({
      ...reread.marker,
    });
    const withoutField = parseSenpiSessionMarker(
      Object.fromEntries(
        Object.entries(reread.marker).filter(([key]) => key !== 'pending')
      )
    );
    expect(withoutField.kind).toBe('valid');
    if (withoutField.kind !== 'valid') throw new Error('expected valid');
    expect(withoutField.marker.pending).toBeNull();
    expect(absent.kind).toBe('valid');
  });
});
