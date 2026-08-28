import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as NodeFsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof NodeFsModule>();
  const { fakeWatch } = await import('./senpi-watch-fake.js');
  return { ...actual, watch: fakeWatch };
});

import {
  watchGrokSession,
  type GrokSessionTailResult,
} from '../src/grok/processing/tail.js';
import { createManualClock } from './senpi-watch-clock-utils.js';
import { emitFilesystemWake, emitWatcherError } from './senpi-watch-fake.js';

const POLL_MS = 20;

const runningControllers: AbortController[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  const controllers = runningControllers.splice(0);
  for (const controller of controllers) controller.abort();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(root => rm(root, { recursive: true, force: true }))
  );
});

function updateLine(
  timestamp: number,
  text: string,
  messageId: string
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
        _meta: { promptIndex: 0 },
      },
    },
  })}\n`;
}

async function makeSession(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'grok-watch-'));
  temporaryRoots.push(root);
  const session = join(root, name);
  await mkdir(session);
  await writeFile(
    join(session, 'updates.jsonl'),
    updateLine(1_000, 'seed', 'seed')
  );
  await writeFile(join(session, 'events.jsonl'), '');
  return session;
}

function track(controller: AbortController): AbortController {
  runningControllers.push(controller);
  return controller;
}

async function readNext(
  iterator: AsyncIterator<GrokSessionTailResult>
): Promise<GrokSessionTailResult> {
  const result = await iterator.next();
  if (result.done) throw new Error('watch ended before yielding a batch');
  return result.value;
}

describe('watchGrokSession null-wake and poll backstop', () => {
  it('reconciles when fs.watch reports a null filename after an append', async () => {
    const session = await makeSession('null-wake');
    const controller = track(new AbortController());
    const iterator = watchGrokSession(session, {
      checkpointMode: 'manual',
      signal: controller.signal,
    });
    const ready = await readNext(iterator);
    expect(ready.records).toHaveLength(1);

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(2_000, 'after-null', 'after-null')
    );
    const next = iterator.next();
    emitFilesystemWake(null);
    const yielded = await next;
    if (yielded.done) throw new Error('watch ended before the null-wake batch');
    expect(yielded.value.records.map(record => record.nativeType)).toEqual([
      'user_message_chunk',
    ]);
    expect(yielded.value.records).toHaveLength(1);

    await iterator.return?.();
  });

  it('delivers an appended batch from pollMs when no fs.watch events arrive', async () => {
    const session = await makeSession('poll-backstop');
    const controller = track(new AbortController());
    const clock = createManualClock();
    const iterator = watchGrokSession(session, {
      checkpointMode: 'manual',
      signal: controller.signal,
      pollMs: POLL_MS,
      clock,
    });
    const ready = await readNext(iterator);
    expect(ready.records).toHaveLength(1);
    const readyOffset =
      ready.checkpoint.sources.find(source => source.sourceKind === 'updates')
        ?.cursor?.offset ?? 0;

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(3_000, 'poll-one', 'poll-one')
    );
    const firstPoll = iterator.next();
    clock.advanceBy(POLL_MS);
    const first = await firstPoll;
    if (first.done) throw new Error('watch ended before the poll batch');
    expect(first.value.records).toHaveLength(1);
    expect(first.value.records[0]?.byteStart).toBe(readyOffset);

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(4_000, 'poll-two', 'poll-two')
    );
    const secondPoll = iterator.next();
    clock.advanceBy(POLL_MS);
    const second = await secondPoll;
    if (second.done) throw new Error('watch ended before the resume poll');
    expect(second.value.records).toHaveLength(1);
    expect(second.value.records[0]?.byteStart).toBeGreaterThan(readyOffset);
    expect(second.value.records[0]?.record).toMatchObject({
      kind: 'update',
    });

    await iterator.return?.();
  });

  it('does not poll when pollMs is unset', async () => {
    const session = await makeSession('no-poll');
    const controller = track(new AbortController());
    const clock = createManualClock();
    let scheduled = 0;
    const iterator = watchGrokSession(session, {
      checkpointMode: 'manual',
      signal: controller.signal,
      clock: {
        now: clock.now,
        setTimeout: (handler, delayMs) => {
          scheduled += 1;
          return clock.setTimeout(handler, delayMs);
        },
        clearTimeout: clock.clearTimeout,
      },
    });
    await readNext(iterator);
    expect(scheduled).toBe(0);

    await appendFile(
      join(session, 'updates.jsonl'),
      updateLine(5_000, 'unseen', 'unseen')
    );
    let yielded = false;
    const pending = iterator.next().then(result => {
      yielded = true;
      return result;
    });
    clock.advanceBy(10_000);
    await Promise.resolve();
    expect(scheduled).toBe(0);
    expect(yielded).toBe(false);

    emitFilesystemWake('updates.jsonl');
    clock.advanceBy(0);
    const late = await pending;
    if (late.done) throw new Error('watch ended before the filesystem batch');
    expect(late.value.records).toHaveLength(1);

    await iterator.return?.();
  });

  it('ends the generator when the watcher reports an error', async () => {
    const session = await makeSession('watch-error');
    const controller = track(new AbortController());
    const iterator = watchGrokSession(session, {
      checkpointMode: 'manual',
      signal: controller.signal,
    });
    await readNext(iterator);
    const next = iterator.next();
    emitWatcherError(
      Object.assign(new Error('watch failed'), { code: 'ERR_WATCH' })
    );
    await expect(next).rejects.toMatchObject({ message: 'watch failed' });
  });
});
