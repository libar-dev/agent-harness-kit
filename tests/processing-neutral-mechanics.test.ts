import type { PathLike } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly path: string;
    readonly position: number;
    readonly bytesRead: number;
  }>,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: async (path: PathLike, flags: string): Promise<FileHandle> => {
      const handle = await actual.open(path, flags);
      if (flags !== 'r') return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (
              buffer: Uint8Array,
              offset: number,
              length: number,
              position: number
            ) => {
              const result = await target.read(
                buffer,
                offset,
                length,
                position
              );
              reads.calls.push({
                path: String(path),
                position,
                bytesRead: result.bytesRead,
              });
              return result;
            };
          }
          if (property === 'stat') return target.stat.bind(target);
          if (property === 'close') return target.close.bind(target);
          if (property === 'then') return undefined;
          throw new Error(`Unexpected FileHandle property ${String(property)}`);
        },
      });
    },
  };
});

import {
  tailGrokSession,
  type GrokSessionCheckpoint,
} from '../src/grok/processing/tail.js';
import {
  tailSenpiSession,
  type SenpiSessionTailResult,
} from '../src/senpi/processing/tail.js';

const roots: string[] = [];
const digestReadAllowance = 4 * 4096;

afterEach(async () => {
  reads.calls.length = 0;
  await Promise.all(
    roots
      .splice(0)
      .map(root => fsPromises.rm(root, { recursive: true, force: true }))
  );
});

function senpiHeader(): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'incremental-senpi',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/incremental',
  })}\n`;
}

function senpiMessage(
  id: string,
  parentId: string | null,
  text: string
): string {
  return `${JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1 },
  })}\n`;
}

function grokUpdate(id: string, text: string, timestamp: number): string {
  return `${JSON.stringify({
    timestamp,
    method: 'session/update',
    params: {
      sessionId: 'incremental-grok',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: id,
        content: { type: 'text', text },
        _meta: { promptIndex: timestamp },
      },
    },
  })}\n`;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fsPromises.mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function bytesReadFor(path: string): number {
  return reads.calls
    .filter(call => call.path === path)
    .reduce((total, call) => total + call.bytesRead, 0);
}

function expectDeltaScan(
  path: string,
  offset: number,
  appendedBytes: number
): void {
  const calls = reads.calls.filter(call => call.path === path);
  expect(calls.some(call => call.position === offset)).toBe(true);
  expect(bytesReadFor(path)).toBeLessThanOrEqual(
    appendedBytes + digestReadAllowance
  );
}

describe('neutral incremental processing mechanics', () => {
  it('reads and projects only the Senpi delta supplied after a checkpoint', async () => {
    const root = await temporaryRoot('senpi-incremental-');
    const path = join(root, 'session.jsonl');
    const lines = Array.from({ length: 600 }, (_, index) =>
      senpiMessage(
        `s${String(index)}`,
        index === 0 ? null : `s${String(index - 1)}`,
        `large fixture ${String(index)} ${'x'.repeat(80)}`
      )
    );
    await fsPromises.writeFile(path, `${senpiHeader()}${lines.join('')}`);
    const first = await tailSenpiSession(path, { checkpointMode: 'manual' });
    const offset = first.nextByteOffset;
    const appended = senpiMessage('s600', 's599', 'appended sentinel');
    await fsPromises.appendFile(path, appended);
    reads.calls.length = 0;

    const next = await tailSenpiSession(path, {
      checkpointMode: 'manual',
      checkpoint: first.checkpoint,
    });

    expectDeltaScan(path, offset, Buffer.byteLength(appended));
    expect(next.previousByteOffset).toBe(offset);
    expect(next.mutations).toHaveLength(1);
    expect(next.mutations[0]?.records.map(record => record.key)).toEqual([
      's600',
    ]);
  });

  it('returns unchanged Senpi input without rereading or reprojection mutations', async () => {
    const root = await temporaryRoot('senpi-unchanged-');
    const path = join(root, 'session.jsonl');
    await fsPromises.writeFile(
      path,
      `${senpiHeader()}${senpiMessage('s0', null, 'stable')}`
    );
    const first = await tailSenpiSession(path, { checkpointMode: 'manual' });
    reads.calls.length = 0;

    const unchanged = await tailSenpiSession(path, {
      checkpointMode: 'manual',
      checkpoint: first.checkpoint,
    });

    expect(unchanged.records).toEqual(first.records);
    expect(unchanged.mutations).toEqual([]);
    expect(unchanged.changes).toEqual([]);
    expect(unchanged.revision).toBe(first.revision);
    expect(bytesReadFor(path)).toBeLessThanOrEqual(digestReadAllowance);
  });

  it('reads only Grok appended bytes when supplied its two-source checkpoint', async () => {
    const root = await temporaryRoot('grok-incremental-');
    const session = join(root, 'session');
    await fsPromises.mkdir(session);
    const updatesPath = join(session, 'updates.jsonl');
    const eventsPath = join(session, 'events.jsonl');
    await fsPromises.writeFile(
      updatesPath,
      Array.from({ length: 600 }, (_, index) =>
        grokUpdate(
          `g${String(index)}`,
          `large fixture ${String(index)}`,
          index + 1
        )
      ).join('')
    );
    await fsPromises.writeFile(eventsPath, '');
    const first = await tailGrokSession(session, {
      checkpointMode: 'manual',
    });
    const updates = first.checkpoint.sources.find(
      source => source.sourceKind === 'updates'
    );
    if (updates?.cursor === null || updates === undefined) {
      throw new Error('updates checkpoint missing');
    }
    const appended = grokUpdate('g600', 'appended sentinel', 601);
    await fsPromises.appendFile(updatesPath, appended);
    reads.calls.length = 0;

    const next = await tailGrokSession(session, {
      checkpointMode: 'manual',
      checkpoint: first.checkpoint as GrokSessionCheckpoint,
    });

    expectDeltaScan(
      updatesPath,
      updates.cursor.offset,
      Buffer.byteLength(appended)
    );
    expect(next.records).toHaveLength(1);
    expect(next.changes).toHaveLength(1);

    reads.calls.length = 0;
    const unchanged = await tailGrokSession(session, {
      checkpointMode: 'manual',
      checkpoint: next.checkpoint,
    });
    expect(unchanged.records).toEqual([]);
    expect(unchanged.changes).toEqual([]);
    expect(unchanged.resets).toEqual([]);
    expect(bytesReadFor(updatesPath)).toBeLessThanOrEqual(digestReadAllowance);
  });

  it('replays replacement generations exactly once without stale checkpoint reuse', async () => {
    const root = await temporaryRoot('processing-reset-');
    const senpiPath = join(root, 'senpi.jsonl');
    await fsPromises.writeFile(
      senpiPath,
      `${senpiHeader()}${senpiMessage('old', null, 'old')}`
    );
    const initial: SenpiSessionTailResult = await tailSenpiSession(senpiPath, {
      checkpointMode: 'manual',
    });
    const replacement = join(root, 'replacement.jsonl');
    await fsPromises.writeFile(
      replacement,
      `${senpiHeader()}${senpiMessage('new', null, 'new')}`
    );
    await fsPromises.rename(replacement, senpiPath);

    const reset = await tailSenpiSession(senpiPath, {
      checkpointMode: 'manual',
      checkpoint: initial.checkpoint,
    });
    const quiet = await tailSenpiSession(senpiPath, {
      checkpointMode: 'manual',
      checkpoint: reset.checkpoint,
    });

    expect(reset.reset).toBe(true);
    expect(reset.generation).toBe(initial.generation + 1);
    expect(reset.mutations).toHaveLength(1);
    expect(quiet.reset).toBe(false);
    expect(quiet.mutations).toEqual([]);
    expect(quiet.generation).toBe(reset.generation);

    const grokSession = join(root, 'grok');
    await fsPromises.mkdir(grokSession);
    const updatesPath = join(grokSession, 'updates.jsonl');
    await fsPromises.writeFile(updatesPath, grokUpdate('old', 'old', 1));
    await fsPromises.writeFile(join(grokSession, 'events.jsonl'), '');
    const grokInitial = await tailGrokSession(grokSession, {
      checkpointMode: 'manual',
    });
    const grokReplacement = join(root, 'grok-replacement.jsonl');
    await fsPromises.writeFile(grokReplacement, grokUpdate('new', 'new', 2));
    await fsPromises.rename(grokReplacement, updatesPath);

    const grokReset = await tailGrokSession(grokSession, {
      checkpointMode: 'manual',
      checkpoint: grokInitial.checkpoint,
    });
    const grokQuiet = await tailGrokSession(grokSession, {
      checkpointMode: 'manual',
      checkpoint: grokReset.checkpoint,
    });

    expect(grokReset.resets).toEqual([
      { type: 'source_reset', sourceKind: 'updates', generation: 1 },
    ]);
    expect(grokReset.records).toHaveLength(1);
    expect(grokQuiet.resets).toEqual([]);
    expect(grokQuiet.records).toEqual([]);
  });
});
