import { watch as watchFs } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  commitGrokSessionCheckpoint,
  tailGrokSession,
  watchGrokSession,
  type GrokSessionTailResult,
} from '../src/grok/processing/tail.js';

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'grok'
);

function updateLine(
  timestamp: number,
  text: string,
  messageId: string,
  promptIndex = 0
): string {
  return `${JSON.stringify({
    timestamp,
    method: 'session/update',
    params: {
      sessionId: 'session-tail',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId,
        content: { type: 'text', text },
        _meta: { promptIndex },
      },
    },
  })}\n`;
}

function eventLine(ts: string, type: 'first_token' | 'phase_changed'): string {
  return `${JSON.stringify(
    type === 'phase_changed'
      ? { ts, type, phase: 'streaming_text' }
      : { ts, type }
  )}\n`;
}

function rewindLine(timestamp: number, targetPromptIndex: number): string {
  return `${JSON.stringify({
    timestamp,
    method: '_x.ai/session/update',
    params: {
      sessionId: 'session-tail',
      update: {
        sessionUpdate: 'rewind_marker',
        target_prompt_index: targetPromptIndex,
        created_at: new Date(timestamp).toISOString(),
      },
    },
  })}\n`;
}

async function markerFile(markerDir: string): Promise<string> {
  const names = (await readdir(markerDir)).filter(name =>
    name.endsWith('.json')
  );
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) throw new Error('marker file was not created');
  return join(markerDir, name);
}

async function waitForFsEvent(
  path: string,
  action: () => Promise<void>
): Promise<void> {
  const event = new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(5_000);
    const watcher = watchFs(path, { signal }, () => {
      watcher.close();
      resolve();
    });
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
    watcher.on('error', reject);
  });
  await action();
  await event;
}

async function nextWithTimeout(
  iterator: AsyncIterator<GrokSessionTailResult>
): Promise<IteratorYieldResult<GrokSessionTailResult>> {
  const result = await new Promise<IteratorResult<GrokSessionTailResult, void>>(
    (resolve, reject) => {
      const signal = AbortSignal.timeout(5_000);
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      void iterator.next().then(resolve, reject);
    }
  );
  if (result.done) throw new Error('watch ended before yielding a batch');
  return result;
}

describe('Grok session tail', () => {
  let root: string;
  let fixtureSession: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'grok-tail-'));
    fixtureSession = join(root, 'fixture-session');
    await mkdir(fixtureSession);
    await Promise.all([
      copyFile(
        join(fixturesDir, 'updates.sample.jsonl'),
        join(fixtureSession, 'updates.jsonl')
      ),
      copyFile(
        join(fixturesDir, 'events.sample.jsonl'),
        join(fixtureSession, 'events.jsonl')
      ),
    ]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createSession(name: string): Promise<string> {
    const session = join(root, name);
    await mkdir(session);
    await Promise.all([
      copyFile(
        join(fixtureSession, 'updates.jsonl'),
        join(session, 'updates.jsonl')
      ),
      copyFile(
        join(fixtureSession, 'events.jsonl'),
        join(session, 'events.jsonl')
      ),
    ]);
    return session;
  }

  it('orders interleaved records by timestamp then source, generation, and byte offset', async () => {
    const session = await createSession('ordering');
    const sameTimestamp = '2026-08-13T03:22:48.889Z';
    await writeFile(
      join(session, 'updates.jsonl'),
      updateLine(Date.parse(sameTimestamp) / 1_000, 'first', 'message-1') +
        updateLine(Date.parse(sameTimestamp) / 1_000, 'second', 'message-2')
    );
    await writeFile(
      join(session, 'events.jsonl'),
      eventLine(sameTimestamp, 'first_token')
    );

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
    });

    expect(result.records.map(record => record.sourceKind)).toEqual([
      'updates',
      'updates',
      'events',
    ]);
    expect(result.records.map(record => record.byteStart)).toEqual([
      0,
      Buffer.byteLength(
        updateLine(Date.parse(sameTimestamp) / 1_000, 'first', 'message-1')
      ),
      0,
    ]);
  });

  it('resumes from an automatic checkpoint exactly once per appended record', async () => {
    const session = await createSession('resume');
    const markerDir = join(root, 'resume-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;

    const first = await tailGrokSession(session, {
      ...options,
      fromStart: true,
    });
    expect(first.records.length).toBeGreaterThan(0);
    expect((await tailGrokSession(session, options)).records).toEqual([]);

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(1_786_591_600, 'new', 'resume-new')
    );
    const resumed = await tailGrokSession(session, options);
    expect(resumed.records).toHaveLength(1);
    expect((await tailGrokSession(session, options)).records).toEqual([]);
  });

  it('defers marker persistence in manual checkpoint mode', async () => {
    const session = await createSession('manual');
    const markerDir = join(root, 'manual-markers');
    const options = {
      markerDir,
      allowedMarkerRoots: [root],
      checkpointMode: 'manual' as const,
    };

    const first = await tailGrokSession(session, {
      ...options,
      fromStart: true,
    });
    const replay = await tailGrokSession(session, options);
    expect(replay.records).toEqual(first.records);
    await commitGrokSessionCheckpoint(session, first.checkpoint, options);
    expect((await tailGrokSession(session, options)).records).toEqual([]);
  });

  it('surfaces rewind deletes as block changes', async () => {
    const session = await createSession('rewind');
    await writeFile(
      join(session, 'updates.jsonl'),
      updateLine(1_000, 'zero', 'zero', 0) +
        updateLine(2_000, 'one', 'one', 1) +
        rewindLine(3_000, 0)
    );
    await writeFile(join(session, 'events.jsonl'), '');

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
    });

    expect(
      result.changes
        .filter(change => change.type === 'delete')
        .map(change => change.id)
    ).toEqual(['session-tail:user_text:one']);
  });

  it('surfaces a per-source reset and rescans an inode replacement', async () => {
    const session = await createSession('rotation');
    const markerDir = join(root, 'rotation-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await tailGrokSession(session, { ...options, fromStart: true });

    const replacement = join(session, 'replacement.jsonl');
    await writeFile(
      replacement,
      updateLine(1_786_591_700, 'rotated', 'rotated')
    );
    await rename(replacement, join(session, 'updates.jsonl'));

    const result = await tailGrokSession(session, options);
    expect(result.resets).toEqual([
      { type: 'source_reset', sourceKind: 'updates', generation: 1 },
    ]);
    expect(result.records).toHaveLength(1);
    expect(
      result.sources.find(source => source.sourceKind === 'updates')
    ).toMatchObject({
      reset: true,
      generation: 1,
    });
  });

  it('commits fromStart after a source reset that already advanced generation', async () => {
    const session = await createSession('from-start-generation');
    const markerDir = join(root, 'from-start-generation-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;

    await tailGrokSession(session, { ...options, fromStart: true });

    const replacement = join(session, 'replacement.jsonl');
    await writeFile(replacement, updateLine(1_786_591_800, 'reset', 'reset'));
    await rename(replacement, join(session, 'updates.jsonl'));

    const reset = await tailGrokSession(session, options);
    expect(reset.checkpointStatus).toEqual({ status: 'committed' });
    expect(
      reset.sources.find(source => source.sourceKind === 'updates')
    ).toMatchObject({
      reset: true,
      generation: 1,
    });

    const fromStart = await tailGrokSession(session, {
      ...options,
      fromStart: true,
    });
    expect(fromStart.checkpointStatus).toEqual({ status: 'committed' });
    expect(
      fromStart.checkpoint.sources.find(
        source => source.sourceKind === 'updates'
      )?.cursor?.generation
    ).toBe(2);

    const manual = await tailGrokSession(session, {
      ...options,
      fromStart: true,
      checkpointMode: 'manual',
    });
    expect(manual.checkpointStatus).toEqual({ status: 'manual' });
    await expect(
      commitGrokSessionCheckpoint(session, manual.checkpoint, options)
    ).resolves.toBeUndefined();
  });

  it('preserves unknown sessionUpdate tags as native records', async () => {
    const session = await createSession('unknown-update');
    const unknown = {
      timestamp: 9_000,
      method: 'session/update',
      params: {
        sessionId: 'session-tail',
        update: {
          sessionUpdate: 'future_session_update',
          payload: { hello: 'world' },
        },
      },
    };
    await writeFile(
      join(session, 'updates.jsonl'),
      `${JSON.stringify(unknown)}\n`
    );
    await writeFile(join(session, 'events.jsonl'), '');

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
    });

    const unknownRecord = result.records.find(
      record => record.record.kind === 'unknown'
    );
    if (unknownRecord?.record.kind !== 'unknown') {
      throw new Error('expected an unknown native record');
    }
    expect(unknownRecord.record.tag).toBe('future_session_update');
    expect(unknownRecord.record.raw).toEqual(unknown);
  });

  it('recovers a stale marker lock and still commits', async () => {
    const session = await createSession('stale-lock');
    const markerDir = join(root, 'stale-lock-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await tailGrokSession(session, { ...options, fromStart: true });

    const markerPath = await markerFile(markerDir);
    const lockPath = `${markerPath}.lock`;
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 31_000);
    await utimes(lockPath, stale, stale);

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(1_786_591_900, 'after-stale-lock', 'after-stale-lock')
    );
    const result = await tailGrokSession(session, options);
    expect(result.checkpointStatus).toEqual({ status: 'committed' });
    expect(result.records).toHaveLength(1);
  });

  it('reports a missing events.jsonl without treating it as an error', async () => {
    const session = await createSession('missing-events');
    await rm(join(session, 'events.jsonl'));

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
    });

    expect(
      result.sources.find(source => source.sourceKind === 'events')
    ).toMatchObject({
      status: 'missing',
      recordCount: 0,
    });
  });

  it('holds a torn trailing update until a later pass completes it', async () => {
    const session = await createSession('partial');
    const markerDir = join(root, 'partial-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await writeFile(
      join(session, 'updates.jsonl'),
      updateLine(1_000, 'one', 'one') + '{"timestamp":'
    );
    await writeFile(join(session, 'events.jsonl'), '');

    const first = await tailGrokSession(session, options);
    expect(first.records).toHaveLength(1);
    const complete = `${JSON.stringify({
      timestamp: 2_000,
      method: 'session/update',
      params: {
        sessionId: 'session-tail',
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'two',
          content: { type: 'text', text: 'two' },
          _meta: { promptIndex: 1 },
        },
      },
    }).slice('{"timestamp":'.length)}\n`;
    await appendFile(join(session, 'updates.jsonl'), complete);

    expect((await tailGrokSession(session, options)).records).toHaveLength(1);
  });

  it('does not advance the marker when the second source read fails', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const session = await createSession('io-error');
    const markerDir = join(root, 'io-error-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await tailGrokSession(session, { ...options, fromStart: true });
    const markerPath = await markerFile(markerDir);
    const before = await readFile(markerPath, 'utf8');
    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(4_000, 'uncommitted', 'io')
    );
    await chmod(join(session, 'events.jsonl'), 0o000);

    try {
      await expect(tailGrokSession(session, options)).rejects.toThrow();
      expect(await readFile(markerPath, 'utf8')).toBe(before);
    } finally {
      await chmod(join(session, 'events.jsonl'), 0o600);
    }
  });

  it('returns records when automatic checkpoint persistence fails and keeps manual failure loud', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const session = await createSession('readonly-marker');
    const markerDir = join(root, 'readonly-markers');
    const options = { markerDir, allowedMarkerRoots: [root] } as const;
    await tailGrokSession(session, { ...options, fromStart: true });
    const markerPath = await markerFile(markerDir);
    const before = await readFile(markerPath, 'utf8');
    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(5_000, 'checkpoint-failure', 'checkpoint-failure')
    );
    await chmod(markerDir, 0o555);

    let result: GrokSessionTailResult;
    try {
      result = await tailGrokSession(session, options);
      expect(result.records).toHaveLength(1);
      expect(result.checkpointStatus.status).toBe('failed');
      if (result.checkpointStatus.status !== 'failed') {
        throw new Error('expected automatic checkpoint failure');
      }
      expect(result.checkpointStatus.error).toContain('EACCES');
      expect(await readFile(markerPath, 'utf8')).toBe(before);
      await expect(
        commitGrokSessionCheckpoint(session, result.checkpoint, options)
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(await readFile(markerPath, 'utf8')).toBe(before);
    } finally {
      await chmod(markerDir, 0o700);
    }

    const replay = await tailGrokSession(session, options);
    expect(replay.records).toEqual(result.records);
    expect(replay.checkpointStatus).toEqual({ status: 'committed' });
    expect(await readFile(markerPath, 'utf8')).not.toBe(before);
  });

  it('watches real filesystem events and cleans up when iteration stops', async () => {
    const session = await createSession('watch');
    const markerDir = join(root, 'watch-markers');
    await tailGrokSession(session, {
      markerDir,
      allowedMarkerRoots: [root],
      fromStart: true,
    });
    const controller = new AbortController();
    const iterator = watchGrokSession(session, {
      markerDir,
      allowedMarkerRoots: [root],
      signal: controller.signal,
    });
    const ready = await nextWithTimeout(iterator);
    expect(ready.value.records).toEqual([]);
    const next = nextWithTimeout(iterator);

    await waitForFsEvent(join(session, 'events.jsonl'), async () => {
      await appendFile(
        join(session, 'events.jsonl'),
        eventLine('2026-08-13T04:00:00.000Z', 'phase_changed')
      );
    });
    const yielded = await next;
    expect(yielded.done).toBe(false);
    expect(yielded.value.records).toHaveLength(1);

    controller.abort();
    await iterator.return?.();
  });

  it('surfaces scanStatus limited when a capped source stops at the line budget', async () => {
    const session = await createSession('scan-status-limited');
    await writeFile(
      join(session, 'updates.jsonl'),
      updateLine(1_000, 'first', 'first') +
        updateLine(2_000, 'second', 'second') +
        updateLine(3_000, 'third', 'third')
    );
    await writeFile(join(session, 'events.jsonl'), '');

    const result = await tailGrokSession(session, {
      fromStart: true,
      checkpointMode: 'manual',
      maxScanLines: 1,
    });

    expect(result.scanStatus).toEqual({ status: 'limited', reason: 'lines' });
    expect(result.records).toHaveLength(1);
    expect(
      result.sources.find(source => source.sourceKind === 'updates')
    ).toMatchObject({ recordCount: 1 });
    expect(
      result.sources.find(source => source.sourceKind === 'events')
    ).toMatchObject({ status: 'read', recordCount: 0 });
  });
});
