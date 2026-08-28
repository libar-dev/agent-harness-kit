import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectedMarker, sampleCheckpoint } from './senpi-checkpoint-utils.js';

import {
  SENPI_MARKER_VERSION,
  commitSenpiSessionCheckpoint,
  evaluateSenpiCheckpointInvalidation,
  getSenpiSessionMarkerPath,
  readSenpiSessionMarker,
} from '../src/senpi/processing/checkpoint.js';
import { parseSenpiSessionMarkerInternal as parseSenpiSessionMarker } from '../src/internal/senpi-checkpoint-test-seam.js';

describe('Senpi checkpoint markers', () => {
  let tmp: string;
  let sessionPath: string;
  let markerDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'senpi-checkpoint-'));
    sessionPath = join(tmp, 'sessions', 'proj', 'sess-1.jsonl');
    markerDir = join(tmp, 'consumer-state');
    await mkdir(join(tmp, 'sessions', 'proj'), { recursive: true });
    await writeFile(sessionPath, '{"type":"session"}\n');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('commit+reread equality preserves every marker field', async () => {
    const checkpoint = sampleCheckpoint(sessionPath);
    await commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });

    const reread = await readSenpiSessionMarker(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });

    const { pending: _pending, ...visibleMarker } = expectedMarker(
      checkpoint,
      1
    );
    expect(reread).toEqual({ kind: 'valid', marker: visibleMarker });
    expect(
      getSenpiSessionMarkerPath(sessionPath, {
        markerDir,
        allowedMarkerRoots: [tmp],
      })
    ).toMatch(/senpi-sess-1-[0-9a-f]{16}\.json$/);
  });

  it('tampered marker reports invalid without throw', async () => {
    const checkpoint = sampleCheckpoint(sessionPath);
    await commitSenpiSessionCheckpoint(sessionPath, checkpoint, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    const markerPath = getSenpiSessionMarkerPath(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    const tampered = {
      ...expectedMarker(checkpoint, 1),
      inode: 12,
    };
    await writeFile(markerPath, JSON.stringify(tampered));

    const read = await readSenpiSessionMarker(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    expect(read.kind).toBe('invalid');

    const invalidation = evaluateSenpiCheckpointInvalidation(tampered, {
      device: checkpoint.device,
      inode: checkpoint.inode,
      fileSize: checkpoint.offset,
      headDigest: checkpoint.headDigest,
      boundaryDigest: checkpoint.boundaryDigest,
      offsetAtLineBoundary: true,
    });
    expect(invalidation).toEqual({
      invalidate: true,
      reason: 'malformed_marker',
    });
  });

  it('malformed JSON marker reports invalid without throw', async () => {
    const markerPath = getSenpiSessionMarkerPath(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    await mkdir(markerDir, { recursive: true });
    await writeFile(markerPath, '{not-json');

    const read = await readSenpiSessionMarker(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    expect(read).toEqual({
      kind: 'invalid',
      error: 'marker JSON is malformed',
    });

    const invalidation = evaluateSenpiCheckpointInvalidation('{not-json', {
      device: '1',
      inode: '2',
      fileSize: 10,
      headDigest: 'aa',
      boundaryDigest: 'bb',
      offsetAtLineBoundary: true,
    });
    expect(invalidation).toEqual({
      invalidate: true,
      reason: 'malformed_marker',
    });
  });

  it('custom markerDir outside allowed roots is rejected', () => {
    expect(() =>
      getSenpiSessionMarkerPath(sessionPath, {
        markerDir: join(tmp, 'rejected'),
        allowedMarkerRoots: [join(tmp, 'allowed')],
      })
    ).toThrow(/outside allowed marker roots/);
  });

  it('offset-not-at-line-boundary forces invalidate=true', () => {
    const marker = expectedMarker(sampleCheckpoint(sessionPath), 1);
    const invalidation = evaluateSenpiCheckpointInvalidation(marker, {
      device: marker.device,
      inode: marker.inode,
      fileSize: marker.offset + 8,
      headDigest: marker.headDigest,
      boundaryDigest: marker.boundaryDigest,
      offsetAtLineBoundary: false,
    });
    expect(invalidation).toEqual({
      invalidate: true,
      reason: 'offset_not_at_line_boundary',
    });
  });

  it('head digest change forces invalidate=true', () => {
    const marker = expectedMarker(sampleCheckpoint(sessionPath), 1);
    const invalidation = evaluateSenpiCheckpointInvalidation(marker, {
      device: marker.device,
      inode: marker.inode,
      fileSize: marker.offset,
      headDigest: 'changed-head',
      boundaryDigest: marker.boundaryDigest,
      offsetAtLineBoundary: true,
    });
    expect(invalidation).toEqual({
      invalidate: true,
      reason: 'head_digest_changed',
    });
  });

  it('boundary digest change forces invalidate=true', () => {
    const marker = expectedMarker(sampleCheckpoint(sessionPath), 1);
    const invalidation = evaluateSenpiCheckpointInvalidation(marker, {
      device: marker.device,
      inode: marker.inode,
      fileSize: marker.offset,
      headDigest: marker.headDigest,
      boundaryDigest: 'changed-boundary',
      offsetAtLineBoundary: true,
    });
    expect(invalidation).toEqual({
      invalidate: true,
      reason: 'boundary_digest_changed',
    });
  });

  it('inode change and size below offset force invalidate=true', () => {
    const marker = expectedMarker(sampleCheckpoint(sessionPath), 1);
    expect(
      evaluateSenpiCheckpointInvalidation(marker, {
        device: marker.device,
        inode: 'other-inode',
        fileSize: marker.offset,
        headDigest: marker.headDigest,
        boundaryDigest: marker.boundaryDigest,
        offsetAtLineBoundary: true,
      })
    ).toEqual({ invalidate: true, reason: 'inode_changed' });
    expect(
      evaluateSenpiCheckpointInvalidation(marker, {
        device: marker.device,
        inode: marker.inode,
        fileSize: marker.offset - 1,
        headDigest: marker.headDigest,
        boundaryDigest: marker.boundaryDigest,
        offsetAtLineBoundary: true,
      })
    ).toEqual({ invalidate: true, reason: 'size_below_offset' });
  });

  it('atomic write leaves no temp litter on failure path', async () => {
    const markerPath = getSenpiSessionMarkerPath(sessionPath, {
      markerDir,
      allowedMarkerRoots: [tmp],
    });
    await mkdir(markerPath, { recursive: true });

    await expect(
      commitSenpiSessionCheckpoint(sessionPath, sampleCheckpoint(sessionPath), {
        markerDir,
        allowedMarkerRoots: [tmp],
      })
    ).rejects.toThrow();

    const leftover = await readdir(markerDir);
    expect(leftover.filter(name => name.includes('.tmp'))).toEqual([]);
    expect(leftover.filter(name => name.endsWith('.lock'))).toEqual([]);
  });

  it('parseSenpiSessionMarker never throws on corrupt input', () => {
    expect(parseSenpiSessionMarker(null).kind).toBe('invalid');
    expect(parseSenpiSessionMarker([]).kind).toBe('invalid');
    expect(parseSenpiSessionMarker({ markerVersion: 99 }).kind).toBe('invalid');
    expect(SENPI_MARKER_VERSION).toBe(1);
  });

  it('normalizes a missing pending field to null and rejects a malformed pending object', () => {
    const checkpoint = sampleCheckpoint(sessionPath);
    const legacy = expectedMarker(checkpoint, 1);
    const { pending: _pending, ...withoutPending } = legacy;
    const parsed = parseSenpiSessionMarker(withoutPending);
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') throw new Error('expected valid marker');
    expect(parsed.marker.pending).toBeNull();
    expect(
      parseSenpiSessionMarker({
        ...legacy,
        pending: { kind: 'discarding_oversized' },
      }).kind
    ).toBe('invalid');
  });
});
