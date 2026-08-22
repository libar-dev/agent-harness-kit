import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readBoundedLines } from '../src/senpi/processing/bounded-lines.js';
import {
  encodeSenpiCwdDirname,
  getSenpiSessionsRoot,
} from '../src/senpi/processing/discovery.js';
import { listSenpiSessions } from '../src/senpi/processing/listing.js';

const HEADER_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 16 * 1024 * 1024;
const createdStores: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdStores.map(store => rm(store, { recursive: true, force: true }))
  );
});

async function makeStore(): Promise<string> {
  const store = await mkdtemp(join(tmpdir(), 'senpi-listing-lines-'));
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

function unknownEntry(id: string): Record<string, unknown> {
  return {
    type: 'future_entry',
    id,
    parentId: null,
    timestamp: '2026-08-20T10:00:01.000Z',
  };
}

function jsonAtByteLength(
  value: Readonly<Record<string, unknown>>,
  targetBytes: number
): string {
  const emptyPadding = JSON.stringify({ ...value, padding: '' });
  const paddingBytes = targetBytes - Buffer.byteLength(emptyPadding);
  if (paddingBytes < 0) {
    throw new RangeError('targetBytes is smaller than the JSON fixture');
  }
  const line = JSON.stringify({ ...value, padding: 'a'.repeat(paddingBytes) });
  if (Buffer.byteLength(line) !== targetBytes) {
    throw new Error('generated JSON line did not match its byte target');
  }
  return line;
}

interface CandidateSpec {
  readonly agentHome: string;
  readonly cwd: string;
  readonly file: string;
  readonly contents: string;
}

async function writeCandidate(spec: CandidateSpec): Promise<string> {
  const dir = join(
    getSenpiSessionsRoot(spec.agentHome),
    encodeSenpiCwdDirname(spec.cwd)
  );
  await mkdir(dir, { recursive: true });
  const path = join(dir, spec.file);
  await writeFile(path, spec.contents);
  return path;
}

describe('senpi listing byte boundaries', () => {
  it('accepts a 64 KiB header and rejects a 64 KiB plus one-byte header', async () => {
    // Given: valid loose-object headers exactly at and one byte over the limit.
    const agentHome = await makeStore();
    const cwd = '/work/header-boundary';
    const exactPath = await writeCandidate({
      agentHome,
      cwd,
      file: 'a-exact.jsonl',
      contents: `${jsonAtByteLength(sessionHeader(cwd, 'header-exact'), HEADER_MAX_BYTES)}\n`,
    });
    const oversizedPath = await writeCandidate({
      agentHome,
      cwd,
      file: 'b-oversized.jsonl',
      contents: `${jsonAtByteLength(sessionHeader(cwd, 'header-oversized'), HEADER_MAX_BYTES + 1)}\n`,
    });

    // When: listing scans both candidates.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: equality is accepted and only the extra byte is diagnosed.
    expect(listings).toMatchObject([
      { kind: 'valid', info: { path: exactPath, id: 'header-exact' } },
      {
        kind: 'invalid',
        path: oversizedPath,
        error: {
          code: 'header-line-too-large',
          maxLineBytes: HEADER_MAX_BYTES,
        },
      },
    ]);
  });

  it('accepts a 16 MiB record and rejects a 16 MiB plus one-byte record', async () => {
    // Given: independently listed sessions with valid unknown records at each boundary.
    const agentHome = await makeStore();
    const exactCwd = '/work/record-exact';
    const exactPath = await writeCandidate({
      agentHome,
      cwd: exactCwd,
      file: 'exact.jsonl',
      contents: `${JSON.stringify(sessionHeader(exactCwd, 'record-exact'))}\n${jsonAtByteLength(unknownEntry('exact-entry'), RECORD_MAX_BYTES)}\n`,
    });
    const oversizedCwd = '/work/record-oversized';
    const oversizedPath = await writeCandidate({
      agentHome,
      cwd: oversizedCwd,
      file: 'oversized.jsonl',
      contents: `${JSON.stringify(sessionHeader(oversizedCwd, 'record-oversized'))}\n${jsonAtByteLength(unknownEntry('oversized-entry'), RECORD_MAX_BYTES + 1)}\n`,
    });

    // When: each project is listed through the public boundary.
    const exact = await listSenpiSessions(exactCwd, { agentHome });
    const oversized = await listSenpiSessions(oversizedCwd, { agentHome });

    // Then: equality remains valid and only the extra byte is rejected.
    expect(exact).toMatchObject([
      { kind: 'valid', info: { path: exactPath, id: 'record-exact' } },
    ]);
    expect(oversized).toMatchObject([
      {
        kind: 'invalid',
        path: oversizedPath,
        error: {
          code: 'record-line-too-large',
          maxLineBytes: RECORD_MAX_BYTES,
        },
      },
    ]);
  });

  it('counts UTF-8 bytes rather than JavaScript string code units', async () => {
    // Given: a valid header shorter than 64 KiB in code units but larger in UTF-8 bytes.
    const agentHome = await makeStore();
    const cwd = '/work/multibyte';
    const base = JSON.stringify({
      ...sessionHeader(cwd, 'multibyte'),
      padding: '',
    });
    const padding = 'é'.repeat(
      Math.floor((HEADER_MAX_BYTES - Buffer.byteLength(base)) / 2) + 1
    );
    const line = JSON.stringify({
      ...sessionHeader(cwd, 'multibyte'),
      padding,
    });
    expect(line.length).toBeLessThan(HEADER_MAX_BYTES);
    expect(Buffer.byteLength(line)).toBeGreaterThan(HEADER_MAX_BYTES);
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'multibyte.jsonl',
      contents: `${line}\n`,
    });

    // When: listing scans the header.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: its encoded byte size triggers the header diagnostic.
    expect(listings).toMatchObject([
      {
        kind: 'invalid',
        path,
        error: { code: 'header-line-too-large' },
      },
    ]);
  });

  it('recognizes a newline at the first byte after a read-chunk boundary', async () => {
    // Given: one exact-chunk line whose newline begins the next filesystem read.
    const agentHome = await makeStore();
    const path = join(agentHome, 'chunk-boundary.jsonl');
    await writeFile(path, `${'a'.repeat(HEADER_MAX_BYTES)}\nsecond\n`);

    // When: the bounded reader streams both lines.
    const lines = [];
    for await (const line of readBoundedLines(path, HEADER_MAX_BYTES)) {
      lines.push(line);
    }

    // Then: neither line is merged, dropped, nor marked oversized.
    expect(lines).toEqual([
      {
        kind: 'line',
        lineNumber: 1,
        value: 'a'.repeat(HEADER_MAX_BYTES),
      },
      { kind: 'line', lineNumber: 2, value: 'second' },
    ]);
  });

  it('streams a valid total session larger than 16 MiB when every record is bounded', async () => {
    // Given: seventeen reusable 1 MiB records, each independently below the line cap.
    const agentHome = await makeStore();
    const cwd = '/work/large-session';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'large-session.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'large-session'))}\n`,
    });
    const record = `${jsonAtByteLength(unknownEntry('large-entry'), 1024 * 1024)}\n`;
    const file = await open(path, 'a');
    try {
      for (let index = 0; index < 17; index += 1) {
        await file.write(record);
      }
    } finally {
      await file.close();
    }
    expect((await stat(path)).size).toBeGreaterThan(RECORD_MAX_BYTES);

    // When: listing streams the complete file.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: total size is uncapped and the bounded records remain valid.
    expect(listings).toMatchObject([
      { kind: 'valid', info: { path, id: 'large-session' } },
    ]);
  });
});
