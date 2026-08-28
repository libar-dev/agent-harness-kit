import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readBoundedLines } from '../src/internal/bounded-lines.js';
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
    for await (const line of readBoundedLines(path, {
      maxLineBytes: HEADER_MAX_BYTES,
    })) {
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

describe('senpi listing EOF-tail semantics', () => {
  it('ignores a valid unterminated final entry so the session stays valid', async () => {
    // Given: a complete header plus a valid message whose trailing newline is absent.
    const agentHome = await makeStore();
    const cwd = '/work/eof-valid-tail';
    const userMessage = {
      type: 'message',
      id: 'msg-1',
      parentId: null,
      timestamp: '2026-08-20T10:00:01.000Z',
      message: { role: 'user', content: 'hello', timestamp: 1_724_155_201_000 },
    };
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-valid.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-valid'))}\n${JSON.stringify(userMessage)}`,
    });

    // When: listing scans the mid-append file.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: the unterminated final entry is deferred and the session stays valid.
    expect(listings).toMatchObject([
      {
        kind: 'valid',
        info: { path, id: 'eof-valid', messageCount: 0, firstMessage: null },
      },
    ]);
  });

  it('does not invalidate on an unterminated malformed final entry', async () => {
    // Given: a complete header plus a broken JSON fragment without a newline.
    const agentHome = await makeStore();
    const cwd = '/work/eof-malformed-tail';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-malformed.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-malformed'))}\n{"type":"message",`,
    });

    // When: listing scans the file mid-append.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: the unterminated garbage is ignored and the session stays valid.
    expect(listings).toMatchObject([
      { kind: 'valid', info: { path, id: 'eof-malformed' } },
    ]);
  });

  it('makes a previously deferred malformed tail invalid after the newline arrives', async () => {
    // Given: a valid session whose final malformed fragment later gains a newline.
    const agentHome = await makeStore();
    const cwd = '/work/eof-malformed-commit';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-commit.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-commit'))}\n{"type":"message",`,
    });
    const before = await listSenpiSessions(cwd, { agentHome });
    expect(before).toMatchObject([{ kind: 'valid', info: { path } }]);

    // When: the writer finishes the line with a newline.
    const file = await open(path, 'a');
    try {
      await file.write('\n');
    } finally {
      await file.close();
    }
    const after = await listSenpiSessions(cwd, { agentHome });

    // Then: the now-complete malformed line invalidates the session.
    expect(after).toMatchObject([{ kind: 'invalid', path }]);
    const invalid = after.find(listing => listing.kind === 'invalid');
    expect(invalid?.error.message).toMatch(/invalid JSON on line 2/i);
  });

  it('makes a previously deferred valid entry visible after the newline arrives', async () => {
    // Given: a valid message fragment waiting on its terminating newline.
    const agentHome = await makeStore();
    const cwd = '/work/eof-valid-commit';
    const userMessage = {
      type: 'message',
      id: 'msg-visible',
      parentId: null,
      timestamp: '2026-08-20T10:00:01.000Z',
      message: {
        role: 'user',
        content: 'visible-after-newline',
        timestamp: 1_724_155_201_000,
      },
    };
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-visible.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-visible'))}\n${JSON.stringify(userMessage)}`,
    });
    const before = await listSenpiSessions(cwd, { agentHome });
    expect(before).toMatchObject([
      { kind: 'valid', info: { path, messageCount: 0, firstMessage: null } },
    ]);

    // When: the writer appends the terminating newline.
    const file = await open(path, 'a');
    try {
      await file.write('\n');
    } finally {
      await file.close();
    }
    const after = await listSenpiSessions(cwd, { agentHome });

    // Then: the completed entry is counted on the next listing.
    expect(after).toMatchObject([
      {
        kind: 'valid',
        info: {
          path,
          messageCount: 1,
          firstMessage: 'visible-after-newline',
        },
      },
    ]);
  });

  it('treats complete blank lines and unterminated blank tails as harmless', async () => {
    // Given: newline-terminated blank lines plus a trailing unterminated blank fragment.
    const agentHome = await makeStore();
    const cwd = '/work/eof-blank';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-blank.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-blank'))}\n\n   `,
    });

    // When: listing scans the file.
    const listings = await listSenpiSessions(cwd, { agentHome });

    // Then: blanks never flip the session invalid.
    expect(listings).toMatchObject([
      { kind: 'valid', info: { path, id: 'eof-blank', messageCount: 0 } },
    ]);
  });

  it('emits no oversized diagnostic for an unterminated oversized EOF line until newline', async () => {
    // Given: a valid header followed by an oversized unterminated record body.
    const agentHome = await makeStore();
    const cwd = '/work/eof-oversized';
    const path = await writeCandidate({
      agentHome,
      cwd,
      file: 'eof-oversized.jsonl',
      contents: `${JSON.stringify(sessionHeader(cwd, 'eof-oversized'))}\n`,
    });
    const file = await open(path, 'a');
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let index = 0; index < 17; index += 1) {
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    expect((await stat(path)).size).toBeGreaterThan(RECORD_MAX_BYTES);

    // When: listing scans before the oversized line is terminated.
    const before = await listSenpiSessions(cwd, { agentHome });

    // Then: no diagnostic is emitted and the session stays valid.
    expect(before).toMatchObject([
      { kind: 'valid', info: { path, id: 'eof-oversized' } },
    ]);

    // When: the writer finally terminates the oversized line.
    const closer = await open(path, 'a');
    try {
      await closer.write('\n');
    } finally {
      await closer.close();
    }
    const after = await listSenpiSessions(cwd, { agentHome });

    // Then: the newline-terminated oversized line is diagnosed.
    expect(after).toMatchObject([
      {
        kind: 'invalid',
        path,
        error: {
          code: 'record-line-too-large',
          maxLineBytes: RECORD_MAX_BYTES,
        },
      },
    ]);
  });

  it('yields bounded-line and oversized entries only after observing 0x0a', async () => {
    // Given: a tiny ceiling and files whose final bytes lack a newline.
    const agentHome = await makeStore();
    const unterminatedPath = join(agentHome, 'unterminated.txt');
    const oversizedPath = join(agentHome, 'oversized-unterminated.txt');
    await writeFile(unterminatedPath, 'abc');
    await writeFile(oversizedPath, 'abcdef');

    // When: the bounded reader streams each file.
    const unterminated = [];
    for await (const line of readBoundedLines(unterminatedPath, {
      maxLineBytes: 4,
    })) {
      unterminated.push(line);
    }
    const oversizedBeforeNewline = [];
    for await (const line of readBoundedLines(oversizedPath, {
      maxLineBytes: 4,
    })) {
      oversizedBeforeNewline.push(line);
    }

    // Then: unterminated tails produce neither line nor oversized entries.
    expect(unterminated).toEqual([]);
    expect(oversizedBeforeNewline).toEqual([]);

    // When: a newline arrives on the oversized file.
    const file = await open(oversizedPath, 'a');
    try {
      await file.write('\n');
    } finally {
      await file.close();
    }
    const oversizedAfterNewline = [];
    for await (const line of readBoundedLines(oversizedPath, {
      maxLineBytes: 4,
    })) {
      oversizedAfterNewline.push(line);
    }

    // Then: the newline-terminated oversized line is diagnosed once.
    expect(oversizedAfterNewline).toEqual([
      { kind: 'oversized', lineNumber: 1 },
    ]);
  });

  it('still yields newline-terminated blank and exact-sized lines', async () => {
    // Given: a file with a blank line and a complete short line.
    const agentHome = await makeStore();
    const path = join(agentHome, 'complete-blank.txt');
    await writeFile(path, '\nok\n');

    // When: the bounded reader streams the file.
    const lines = [];
    for await (const line of readBoundedLines(path, { maxLineBytes: 16 })) {
      lines.push(line);
    }

    // Then: both newline-terminated lines are emitted, including the blank.
    expect(lines).toEqual([
      { kind: 'line', lineNumber: 1, value: '' },
      { kind: 'line', lineNumber: 2, value: 'ok' },
    ]);
  });
});
