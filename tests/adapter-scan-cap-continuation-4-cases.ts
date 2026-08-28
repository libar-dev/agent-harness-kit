import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { internalCheckpoint } from './senpi-internal-state-utils.js';

import { byteCursorsEqual } from '../src/internal/incremental.js';
import {
  SENPI_MARKER_VERSION,
  commitSenpiSessionCheckpointInternal as commitSenpiSessionCheckpoint,
  readSenpiSessionMarkerInternal as readSenpiSessionMarker,
} from '../src/internal/senpi-checkpoint-test-seam.js';
import { tailSenpiSessionInternal as tailSenpiSession } from '../src/senpi/processing/tail-run.js';
import {
  EXACT_MIB_CHAIN,
  LINE_CAP,
  missingParentCodes,
  senpiHeader,
  senpiMessage,
  temporaryRoot,
  writeSenpiExactMiBChain,
} from './adapter-scan-cap-utils.js';

describe('adapter scan-cap continuation', () => {
  it('advances Senpi manual checkpoint continuation past the default line cap', async () => {
    const root = await temporaryRoot('senpi-lines-manual-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeFile(sessionPath, senpiHeader());
    const extras = LINE_CAP + 1;
    const { open } = await import('node:fs/promises');
    const handle = await open(sessionPath, 'a');
    try {
      let parent: string | null = null;
      for (let index = 0; index < extras; index += 1) {
        const id = `n${String(index).padStart(5, '0')}`;
        await handle.writeFile(senpiMessage(id, parent, `n-${String(index)}`));
        parent = id;
      }
    } finally {
      await handle.close();
    }
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    const first = await tailSenpiSession(sessionPath, options);
    const firstOffset = first.nextByteOffset;
    const second = await tailSenpiSession(sessionPath, {
      ...options,
      checkpoint: first.checkpoint,
    });
    expect(second.nextByteOffset).toBeGreaterThan(firstOffset);
    expect(second.records.map(record => record.key)).not.toEqual(
      first.records.map(record => record.key)
    );
  });

  it('returns all 40 unique Senpi records across automatic marker-only 1MiB passes', async () => {
    const root = await temporaryRoot('senpi-40mib-auto-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeSenpiExactMiBChain(sessionPath, EXACT_MIB_CHAIN);
    const options = { markerDir, allowedMarkerRoots: [root] };

    const uniqueKeys = new Set<string>();
    const recordCounts: number[] = [];
    const offsets: number[] = [];
    let previousOffset = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      const result = await tailSenpiSession(sessionPath, options);
      expect(missingParentCodes(result.diagnostics)).toEqual([]);
      expect(SENPI_MARKER_VERSION).toBe(1);
      const marker = await readSenpiSessionMarker(sessionPath, options);
      expect(marker.kind).toBe('valid');
      if (marker.kind !== 'valid') throw new Error('expected persisted marker');
      expect(marker.marker.markerVersion).toBe(SENPI_MARKER_VERSION);
      expect(marker.marker.offset).toBe(result.nextByteOffset);
      expect(marker.marker.offset).toBeGreaterThan(previousOffset);
      previousOffset = result.nextByteOffset;
      offsets.push(result.nextByteOffset);
      recordCounts.push(result.records.length);
      for (const record of result.records) uniqueKeys.add(record.key);
      if (
        result.nextByteOffset >= result.fileSize &&
        (internalCheckpoint(result.checkpoint).pending ?? null) === null
      ) {
        break;
      }
    }

    expect(uniqueKeys.size).toBe(EXACT_MIB_CHAIN);
    expect(recordCounts).toEqual([16, 16, 8]);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[1]).toBeGreaterThan(offsets[0] ?? 0);
    expect(offsets[2]).toBeGreaterThan(offsets[1] ?? 0);
  });

  it('returns cumulative 16/32/40 Senpi records across manual 1MiB checkpoint passes', async () => {
    const root = await temporaryRoot('senpi-40mib-manual-');
    const sessionPath = join(root, 'session.jsonl');
    const markerDir = join(root, 'markers');
    await writeSenpiExactMiBChain(sessionPath, EXACT_MIB_CHAIN);
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    const first = await tailSenpiSession(sessionPath, options);
    expect(missingParentCodes(first.diagnostics)).toEqual([]);
    expect(first.records).toHaveLength(16);
    await commitSenpiSessionCheckpoint(sessionPath, first.checkpoint, options);

    const second = await tailSenpiSession(sessionPath, {
      ...options,
      checkpoint: first.checkpoint,
    });
    expect(missingParentCodes(second.diagnostics)).toEqual([]);
    expect(second.records).toHaveLength(32);
    expect(second.nextByteOffset).toBeGreaterThan(first.nextByteOffset);

    const third = await tailSenpiSession(sessionPath, {
      ...options,
      checkpoint: second.checkpoint,
    });
    expect(missingParentCodes(third.diagnostics)).toEqual([]);
    expect(third.records).toHaveLength(40);
    expect(third.nextByteOffset).toBeGreaterThan(second.nextByteOffset);
    expect(new Set(third.records.map(record => record.key)).size).toBe(
      EXACT_MIB_CHAIN
    );
  });

  it('keeps pending in byteCursorsEqual for adapter checkpoint identity', () => {
    const base = {
      device: '1',
      inode: '2',
      offset: 32,
      lineNumber: 1,
      generation: 0,
      headDigest: 'h',
      boundaryDigest: 'b',
    };
    expect(
      byteCursorsEqual(
        { ...base, pending: null },
        {
          ...base,
          pending: { kind: 'discarding_oversized', byteStart: 0 },
        }
      )
    ).toBe(false);
  });
});
