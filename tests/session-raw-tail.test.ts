import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  STALE_CHECKPOINT_CONFLICT_CODE,
  commitRawTranscriptSessionCheckpoint,
  getRawTranscriptSessionMarkerPath,
  isStaleCheckpointConflict,
  tailRawTranscriptSessionRecords,
  watchRawTranscriptSessionRecords,
  type RawTranscriptSessionTailOptions,
  type RawTranscriptSessionTailResult,
  type RawTranscriptSessionWatchOptions,
  type RawTranscriptSessionCheckpoint,
  type RawTranscriptSourceTailResult,
} from '../src/processing/index.js';
import { withRawTranscriptSessionMarkerLock } from '../src/processing/tail.js';
import { must } from './test-utils.js';

const execFileAsync = promisify(execFile);

function recordLine(args: {
  sessionId: string;
  uuid?: string;
  timestamp?: string;
  type?: string;
  value?: string;
}): string {
  return `${JSON.stringify({
    type: args.type ?? 'queue-operation',
    sessionId: args.sessionId,
    ...(args.uuid !== undefined ? { uuid: args.uuid } : {}),
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
    value: args.value ?? args.uuid ?? 'value',
  })}\n`;
}

function toolUseLine(args: {
  sessionId: string;
  uuid: string;
  timestamp: string;
  toolUseId: string;
  toolName: string;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: args.sessionId,
    uuid: args.uuid,
    timestamp: args.timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: args.toolUseId,
          name: args.toolName,
          input: { command: 'echo preserved' },
        },
      ],
    },
  })}\n`;
}

function degradedHistoryLine(sessionId: string, uuid: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid,
    timestamp: '2026-07-12T10:00:03.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: {} }],
    },
  })}\n`;
}

async function createSession(
  projectDir: string,
  sessionId: string,
  mainContent: string,
  subagents: Readonly<Record<string, string>> = {}
): Promise<{ mainPath: string; subagentDir: string }> {
  const mainPath = join(projectDir, `${sessionId}.jsonl`);
  const subagentDir = join(projectDir, sessionId, 'subagents');
  await writeFile(mainPath, mainContent);
  if (Object.keys(subagents).length > 0) {
    await mkdir(subagentDir, { recursive: true });
    await Promise.all(
      Object.entries(subagents).map(([sourceId, content]) =>
        writeFile(join(subagentDir, `${sourceId}.jsonl`), content)
      )
    );
  }
  return { mainPath, subagentDir };
}

function unsafeOptions(
  markerDir: string,
  allowedRoot: string
): RawTranscriptSessionTailOptions {
  return {
    markerDir,
    allowedMarkerRoots: [allowedRoot],
    rawRedactionMode: 'unsafe-unredacted',
  };
}

function yielded(
  result: IteratorResult<RawTranscriptSessionTailResult, void>
): RawTranscriptSessionTailResult {
  if (result.done) throw new Error('Expected watch iterator to yield');
  return result.value;
}

interface StoredSessionMarker {
  readonly version: number;
  readonly sessionId: string;
  readonly mainPathDigest: string;
  readonly revision: number;
  readonly sources: Readonly<
    Record<
      string,
      {
        readonly byteOffset: number;
        readonly fileSize: number;
        readonly generation: number;
      }
    >
  >;
}

function parseStoredSessionMarker(raw: string): StoredSessionMarker {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed['version'] !== 'number' ||
    typeof parsed['sessionId'] !== 'string' ||
    typeof parsed['mainPathDigest'] !== 'string' ||
    typeof parsed['revision'] !== 'number' ||
    !isRecord(parsed['sources'])
  ) {
    throw new Error('Invalid stored session marker');
  }

  const sources: Record<
    string,
    {
      readonly byteOffset: number;
      readonly fileSize: number;
      readonly generation: number;
    }
  > = {};
  for (const [sourceKey, marker] of Object.entries(parsed['sources'])) {
    if (
      !isRecord(marker) ||
      typeof marker['byteOffset'] !== 'number' ||
      typeof marker['fileSize'] !== 'number' ||
      typeof marker['generation'] !== 'number'
    ) {
      throw new Error('Invalid source marker');
    }
    sources[sourceKey] = {
      byteOffset: marker['byteOffset'],
      fileSize: marker['fileSize'],
      generation: marker['generation'],
    };
  }
  return {
    version: parsed['version'],
    sessionId: parsed['sessionId'],
    mainPathDigest: parsed['mainPathDigest'],
    revision: parsed['revision'],
    sources,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function runCheckpointCommitProcess(args: {
  mainPath: string;
  markerDir: string;
  allowedRoot: string;
  checkpointPath: string;
}): Promise<number> {
  try {
    await execFileAsync(
      'pnpm',
      [
        'exec',
        'tsx',
        'tests/fixtures/commit-session-checkpoint.ts',
        args.mainPath,
        args.markerDir,
        args.allowedRoot,
        args.checkpointPath,
      ],
      { cwd: process.cwd(), env: process.env }
    );
    return 0;
  } catch (error) {
    if (isRecord(error) && typeof error['code'] === 'number') {
      return error['code'];
    }
    throw error;
  }
}

describe('session-level raw transcript tail', () => {
  let tmp: string;
  let markerRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'session-raw-tail-'));
    markerRoot = join(tmp, 'consumer-state');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('tails main-only sessions without changing single-file API semantics', async () => {
    const sessionId = 'main-only';
    const main = recordLine({
      sessionId,
      uuid: 'main-1',
      timestamp: '2026-07-12T10:00:00.000Z',
    });
    const { mainPath } = await createSession(tmp, sessionId, main);
    const options = unsafeOptions(markerRoot, tmp);

    const first = await tailRawTranscriptSessionRecords(mainPath, options);
    const second = await tailRawTranscriptSessionRecords(mainPath, options);

    expect(first.sessionId).toBe(sessionId);
    expect(first.records.map(record => record.uuid)).toEqual(['main-1']);
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]).toMatchObject({
      sourceKind: 'main',
      sourceId: 'main',
      previousByteOffset: 0,
      newByteOffset: Buffer.byteLength(main),
      recordCount: 1,
    });
    expect(second.records).toEqual([]);
    expect(second.sources[0]).toMatchObject({
      previousByteOffset: Buffer.byteLength(main),
      newByteOffset: Buffer.byteLength(main),
    });
  });

  it('merges historical main and multiple subagents chronologically with stable provenance', async () => {
    const sessionId = 'historical';
    const main = recordLine({
      sessionId,
      uuid: 'main-late',
      timestamp: '2026-07-12T10:00:03.000Z',
    });
    const agentA = recordLine({
      sessionId,
      uuid: 'agent-a-early',
      timestamp: '2026-07-12T10:00:01.000Z',
    });
    const agentB = recordLine({
      sessionId,
      uuid: 'agent-b-middle',
      timestamp: '2026-07-12T10:00:02.000Z',
    });
    const { mainPath } = await createSession(tmp, sessionId, main, {
      'agent-b': agentB,
      'agent-a': agentA,
    });

    const first = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });
    const replay = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });

    expect(first.records.map(record => record.uuid)).toEqual([
      'agent-a-early',
      'agent-b-middle',
      'main-late',
    ]);
    expect(first.records.map(record => record.sourceId)).toEqual([
      'agent-a',
      'agent-b',
      'main',
    ]);
    expect(first.sources.map(source => source.sourceId)).toEqual([
      'main',
      'agent-a',
      'agent-b',
    ]);
    expect(replay.records.map(record => record.id)).toEqual(
      first.records.map(record => record.id)
    );
  });

  it('tails concurrent appends from main and multiple subagents in one pass', async () => {
    const sessionId = 'concurrent';
    const initial = recordLine({
      sessionId,
      uuid: 'initial',
      timestamp: '2026-07-12T10:00:00.000Z',
    });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      initial,
      { 'agent-a': initial, 'agent-b': initial }
    );
    const options = unsafeOptions(markerRoot, tmp);
    await tailRawTranscriptSessionRecords(mainPath, options);

    await Promise.all([
      appendFile(
        mainPath,
        recordLine({
          sessionId,
          uuid: 'main-next',
          timestamp: '2026-07-12T10:00:03.000Z',
        })
      ),
      appendFile(
        join(subagentDir, 'agent-a.jsonl'),
        recordLine({
          sessionId,
          uuid: 'agent-a-next',
          timestamp: '2026-07-12T10:00:01.000Z',
        })
      ),
      appendFile(
        join(subagentDir, 'agent-b.jsonl'),
        recordLine({
          sessionId,
          uuid: 'agent-b-next',
          timestamp: '2026-07-12T10:00:02.000Z',
        })
      ),
    ]);

    const result = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(result.records.map(record => record.uuid)).toEqual([
      'agent-a-next',
      'agent-b-next',
      'main-next',
    ]);
    expect(result.sources.map(source => source.recordCount)).toEqual([1, 1, 1]);
  });

  it('detects a subagent file created after watch observation starts', async () => {
    const sessionId = 'late-agent';
    const main = recordLine({
      sessionId,
      uuid: 'main-first',
      timestamp: '2026-07-12T10:00:00.000Z',
    });
    const { mainPath, subagentDir } = await createSession(tmp, sessionId, main);
    const controller = new AbortController();
    const watchOptions: RawTranscriptSessionWatchOptions = {
      ...unsafeOptions(markerRoot, tmp),
      pollMs: 1,
      signal: controller.signal,
    };
    const iterator = watchRawTranscriptSessionRecords(mainPath, watchOptions);

    const first = yielded(await iterator.next());
    expect(first.sources.map(source => source.sourceId)).toEqual(['main']);

    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      join(subagentDir, 'agent-late.jsonl'),
      recordLine({
        sessionId,
        uuid: 'late-record',
        timestamp: '2026-07-12T10:00:01.000Z',
      })
    );
    const second = yielded(await iterator.next());
    expect(second.records.map(record => record.uuid)).toEqual(['late-record']);
    expect(second.sources.map(source => source.sourceId)).toEqual([
      'main',
      'agent-late',
    ]);

    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('emits subagent-only writes while the main offset remains unchanged', async () => {
    const sessionId = 'agent-only';
    const initial = recordLine({
      sessionId,
      uuid: 'initial',
      timestamp: '2026-07-12T10:00:00.000Z',
    });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      initial,
      { 'agent-a': initial }
    );
    const options = unsafeOptions(markerRoot, tmp);
    const first = await tailRawTranscriptSessionRecords(mainPath, options);
    const mainOffset = must(first.sources[0]).newByteOffset;
    await appendFile(
      join(subagentDir, 'agent-a.jsonl'),
      recordLine({
        sessionId,
        uuid: 'agent-only-write',
        timestamp: '2026-07-12T10:00:01.000Z',
      })
    );

    const second = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(second.records.map(record => record.uuid)).toEqual([
      'agent-only-write',
    ]);
    expect(second.sources[0]).toMatchObject({
      previousByteOffset: mainOffset,
      newByteOffset: mainOffset,
      recordCount: 0,
    });
  });

  it('handles truncation independently for each source', async () => {
    const sessionId = 'rotation';
    const longMain = recordLine({
      sessionId,
      uuid: 'main-before-rotation-with-a-long-id',
      timestamp: '2026-07-12T10:00:00.000Z',
    });
    const longAgent = recordLine({
      sessionId,
      uuid: 'agent-before-rotation-with-a-long-id',
      timestamp: '2026-07-12T10:00:01.000Z',
    });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      longMain,
      { 'agent-a': longAgent }
    );
    const options = unsafeOptions(markerRoot, tmp);
    await tailRawTranscriptSessionRecords(mainPath, options);

    const replacement = recordLine({
      sessionId,
      uuid: 'a',
      timestamp: '2026-07-12T10:00:02.000Z',
    });
    const mainAppend = recordLine({
      sessionId,
      uuid: 'main-after',
      timestamp: '2026-07-12T10:00:03.000Z',
    });
    await Promise.all([
      writeFile(join(subagentDir, 'agent-a.jsonl'), replacement),
      appendFile(mainPath, mainAppend),
    ]);

    const result = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(result.records.map(record => record.uuid)).toEqual([
      'a',
      'main-after',
    ]);
    expect(result.sources[0]).toMatchObject({
      sourceId: 'main',
      fileRotated: false,
      recordCount: 1,
    });
    expect(result.sources[1]).toMatchObject({
      sourceId: 'agent-a',
      fileRotated: true,
      previousByteOffset: 0,
      recordCount: 1,
    });
  });

  it('merges source-local auxiliary records by their inherited timestamps', async () => {
    const sessionId = 'ordering';
    const t1 = '2026-07-12T10:00:00.000Z';
    const middle = '2026-07-12T10:00:01.000Z';
    const t2 = '2026-07-12T10:00:02.000Z';
    const main =
      recordLine({ sessionId, uuid: 'main-leading-1' }) +
      recordLine({ sessionId, uuid: 'main-leading-2' }) +
      recordLine({ sessionId, uuid: 'main-t1', timestamp: t1 }) +
      recordLine({ sessionId, uuid: 'main-after-t1' }) +
      recordLine({ sessionId, uuid: 'main-t2', timestamp: t2 });
    const { mainPath } = await createSession(tmp, sessionId, main, {
      'agent-b':
        recordLine({ sessionId, uuid: 'agent-b-leading' }) +
        recordLine({ sessionId, uuid: 'agent-b-t1', timestamp: t1 }),
      'agent-a':
        recordLine({ sessionId, uuid: 'agent-a-leading' }) +
        recordLine({ sessionId, uuid: 'agent-a-t1', timestamp: t1 }) +
        recordLine({ sessionId, uuid: 'agent-a-after-t1' }) +
        recordLine({
          sessionId,
          uuid: 'agent-a-middle',
          timestamp: middle,
        }),
    });

    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    };
    const result = await tailRawTranscriptSessionRecords(mainPath, options);
    const replay = await tailRawTranscriptSessionRecords(mainPath, options);

    expect(result.records.map(record => record.uuid)).toEqual([
      'main-leading-1',
      'main-leading-2',
      'agent-a-leading',
      'agent-b-leading',
      'main-t1',
      'main-after-t1',
      'agent-a-t1',
      'agent-a-after-t1',
      'agent-b-t1',
      'agent-a-middle',
      'main-t2',
    ]);
    expect(
      must(result.records.find(record => record.uuid === 'main-after-t1'))
        .timestamp
    ).toBeUndefined();
    expect(replay.records.map(record => record.id)).toEqual(
      result.records.map(record => record.id)
    );
  });

  it('inherits source timestamps across incremental tail boundaries', async () => {
    const sessionId = 'incremental-ordering';
    const mainT5 = '2026-07-12T10:00:05.000Z';
    const mainT6 = '2026-07-12T10:00:06.000Z';
    const agentT4 = '2026-07-12T10:00:04.000Z';
    const agentMiddle = '2026-07-12T10:00:04.500Z';
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'main-t5', timestamp: mainT5 }),
      {
        'agent-a': recordLine({
          sessionId,
          uuid: 'agent-t4',
          timestamp: agentT4,
        }),
      }
    );
    const options = unsafeOptions(markerRoot, tmp);
    await tailRawTranscriptSessionRecords(mainPath, options);

    await Promise.all([
      appendFile(
        mainPath,
        recordLine({ sessionId, uuid: 'main-after-t5' }) +
          recordLine({ sessionId, uuid: 'main-t6', timestamp: mainT6 })
      ),
      appendFile(
        join(subagentDir, 'agent-a.jsonl'),
        recordLine({
          sessionId,
          uuid: 'agent-middle',
          timestamp: agentMiddle,
        })
      ),
    ]);

    const result = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(result.records.map(record => record.uuid)).toEqual([
      'agent-middle',
      'main-after-t5',
      'main-t6',
    ]);
    expect(result.records[1]?.timestamp).toBeUndefined();
  });

  it('isolates source offsets and sessions inside an allowed custom marker root', async () => {
    const sharedAgent = 'agent-shared';
    const firstId = 'marker-one';
    const secondId = 'marker-two';
    const first = await createSession(
      tmp,
      firstId,
      recordLine({ sessionId: firstId, uuid: 'main-one' }),
      { [sharedAgent]: recordLine({ sessionId: firstId, uuid: 'agent-one' }) }
    );
    const second = await createSession(
      tmp,
      secondId,
      recordLine({ sessionId: secondId, uuid: 'main-two' }),
      { [sharedAgent]: recordLine({ sessionId: secondId, uuid: 'agent-two' }) }
    );
    const options = unsafeOptions(markerRoot, tmp);

    await tailRawTranscriptSessionRecords(first.mainPath, options);
    await tailRawTranscriptSessionRecords(second.mainPath, options);
    const firstMarkerPath = getRawTranscriptSessionMarkerPath(
      first.mainPath,
      markerRoot,
      [tmp]
    );
    const secondMarkerPath = getRawTranscriptSessionMarkerPath(
      second.mainPath,
      markerRoot,
      [tmp]
    );
    const firstMarker = parseStoredSessionMarker(
      await readFile(firstMarkerPath, 'utf8')
    );

    expect(firstMarkerPath).not.toBe(secondMarkerPath);
    await expect(access(secondMarkerPath)).resolves.toBeUndefined();
    expect(Object.keys(firstMarker.sources).sort()).toEqual([
      'main:main',
      `subagent:${sharedAgent}`,
    ]);
    expect(firstMarker.sources['main:main']?.byteOffset).toBeGreaterThan(0);
    expect(
      firstMarker.sources[`subagent:${sharedAgent}`]?.byteOffset
    ).toBeGreaterThan(0);

    await expect(
      tailRawTranscriptSessionRecords(first.mainPath, {
        markerDir: markerRoot,
        allowedMarkerRoots: [],
      })
    ).rejects.toThrow(/requires allowedMarkerRoots/);
  });

  it('keeps full-history dry runs free of marker writes', async () => {
    const sessionId = 'dry-history';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'main' }),
      { 'agent-a': recordLine({ sessionId, uuid: 'agent' }) }
    );
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);

    const result = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });

    expect(result.records).toHaveLength(2);
    await expect(access(markerPath)).rejects.toThrow();
    await expect(access(join(tmp, '.tail-markers'))).rejects.toThrow();
    await expect(
      access(join(tmp, sessionId, 'subagents', '.tail-markers'))
    ).rejects.toThrow();
  });

  it('supports durable manual checkpoint commit for at-least-once delivery', async () => {
    const sessionId = 'manual-checkpoint';
    const initial = recordLine({ sessionId, uuid: 'persist-before-commit' });
    const appended = recordLine({ sessionId, uuid: 'after-commit' });
    const { mainPath } = await createSession(tmp, sessionId, initial);
    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);

    const first = await tailRawTranscriptSessionRecords(mainPath, options);
    await expect(access(markerPath)).rejects.toThrow();
    const replay = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(replay.records.map(record => record.id)).toEqual(
      first.records.map(record => record.id)
    );

    await commitRawTranscriptSessionCheckpoint(mainPath, first.checkpoint, {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    });
    await appendFile(mainPath, appended);
    const afterCommit = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    });
    expect(afterCommit.records.map(record => record.uuid)).toEqual([
      'after-commit',
    ]);
  });

  it('serializes sibling checkpoint races without marker regression', async () => {
    const sessionId = 'concurrent-checkpoints';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'race-initial' })
    );
    const tailOptions: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    const initial = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    await commitRawTranscriptSessionCheckpoint(
      mainPath,
      initial.checkpoint,
      commitOptions
    );
    let committedOffset = must(initial.checkpoint.sources[0]).byteOffset;

    for (let iteration = 0; iteration < 12; iteration++) {
      await appendFile(
        mainPath,
        recordLine({ sessionId, uuid: `race-${String(iteration)}-small` })
      );
      const smaller = await tailRawTranscriptSessionRecords(
        mainPath,
        tailOptions
      );
      await appendFile(
        mainPath,
        recordLine({ sessionId, uuid: `race-${String(iteration)}-large` })
      );
      const larger = await tailRawTranscriptSessionRecords(
        mainPath,
        tailOptions
      );
      expect(smaller.checkpoint.baseRevision).toBe(
        larger.checkpoint.baseRevision
      );

      const outcomes = await Promise.allSettled([
        commitRawTranscriptSessionCheckpoint(
          mainPath,
          smaller.checkpoint,
          commitOptions
        ),
        commitRawTranscriptSessionCheckpoint(
          mainPath,
          larger.checkpoint,
          commitOptions
        ),
      ]);
      expect(
        outcomes.filter(outcome => outcome.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        outcomes.filter(outcome => outcome.status === 'rejected')
      ).toHaveLength(1);

      const winnerIndex = outcomes.findIndex(
        outcome => outcome.status === 'fulfilled'
      );
      const winningCheckpoint = must([smaller, larger][winnerIndex]).checkpoint;
      const stored = parseStoredSessionMarker(
        await readFile(markerPath, 'utf8')
      );
      const storedOffset = must(stored.sources['main:main']).byteOffset;
      expect(storedOffset).toBe(must(winningCheckpoint.sources[0]).byteOffset);
      expect(storedOffset).toBeGreaterThanOrEqual(committedOffset);

      const catchUp = await tailRawTranscriptSessionRecords(
        mainPath,
        tailOptions
      );
      await commitRawTranscriptSessionCheckpoint(
        mainPath,
        catchUp.checkpoint,
        commitOptions
      );
      committedOffset = must(catchUp.checkpoint.sources[0]).byteOffset;
    }
  });

  it('serializes checkpoint commits across sibling processes', async () => {
    const sessionId = 'cross-process-checkpoints';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'cross-process-initial' })
    );
    const tailOptions: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const initial = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    await commitRawTranscriptSessionCheckpoint(
      mainPath,
      initial.checkpoint,
      commitOptions
    );
    await appendFile(
      mainPath,
      recordLine({ sessionId, uuid: 'cross-process-small' })
    );
    const smaller = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    await appendFile(
      mainPath,
      recordLine({ sessionId, uuid: 'cross-process-large' })
    );
    const larger = await tailRawTranscriptSessionRecords(mainPath, tailOptions);
    const smallerPath = join(tmp, 'smaller-checkpoint.json');
    const largerPath = join(tmp, 'larger-checkpoint.json');
    await Promise.all([
      writeFile(smallerPath, JSON.stringify(smaller.checkpoint)),
      writeFile(largerPath, JSON.stringify(larger.checkpoint)),
    ]);

    const exitCodes = await Promise.all([
      runCheckpointCommitProcess({
        mainPath,
        markerDir: markerRoot,
        allowedRoot: tmp,
        checkpointPath: smallerPath,
      }),
      runCheckpointCommitProcess({
        mainPath,
        markerDir: markerRoot,
        allowedRoot: tmp,
        checkpointPath: largerPath,
      }),
    ]);
    expect([...exitCodes].sort()).toEqual([0, 1]);

    const winner = exitCodes[0] === 0 ? smaller : larger;
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    const marker = parseStoredSessionMarker(await readFile(markerPath, 'utf8'));
    expect(marker.sources['main:main']?.byteOffset).toBe(
      winner.checkpoint.sources[0]?.byteOffset
    );
    expect(marker.sources['main:main']?.byteOffset).toBeGreaterThanOrEqual(
      initial.checkpoint.sources[0]?.byteOffset ?? 0
    );
    await expect(access(`${markerPath}.lock`)).rejects.toThrow();
  });

  it('makes concurrent automatic writers revision-safe', async () => {
    const sessionId = 'automatic-race';
    const content = recordLine({ sessionId, uuid: 'automatic-race-record' });
    const { mainPath } = await createSession(tmp, sessionId, content);
    const options = unsafeOptions(markerRoot, tmp);

    const [first, second] = await Promise.all([
      tailRawTranscriptSessionRecords(mainPath, options),
      tailRawTranscriptSessionRecords(mainPath, options),
    ]);
    expect([first, second].some(result => result.records.length === 1)).toBe(
      true
    );
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    const marker = parseStoredSessionMarker(await readFile(markerPath, 'utf8'));
    expect(marker).toMatchObject({ revision: 1 });
    expect(marker.sources['main:main']?.byteOffset).toBe(
      Buffer.byteLength(content)
    );
    await expect(access(`${markerPath}.lock`)).rejects.toThrow();

    const quiet = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(quiet.records).toEqual([]);
  });

  it('releases the marker lock after validation failure', async () => {
    const sessionId = 'lock-cleanup';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'lock-cleanup-record' })
    );
    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const batch = await tailRawTranscriptSessionRecords(mainPath, options);
    const invalid: RawTranscriptSessionCheckpoint = {
      ...batch.checkpoint,
      sources: batch.checkpoint.sources.map(source => ({
        ...source,
        generation: source.generation + 2,
      })),
    };
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);

    await expect(
      commitRawTranscriptSessionCheckpoint(mainPath, invalid, commitOptions)
    ).rejects.toThrow(/generation/);
    await expect(access(`${markerPath}.lock`)).rejects.toThrow();
    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        batch.checkpoint,
        commitOptions
      )
    ).resolves.toBeUndefined();
  });

  it('releases the marker lock and temp file after write failure', async () => {
    const sessionId = 'lock-write-failure';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'write-failure-record' })
    );
    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const batch = await tailRawTranscriptSessionRecords(mainPath, options);
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    await mkdir(markerPath, { recursive: true });

    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        batch.checkpoint,
        commitOptions
      )
    ).rejects.toThrow();
    await expect(access(`${markerPath}.lock`)).rejects.toThrow();
    expect(
      (await readdir(dirname(markerPath))).filter(entry =>
        entry.endsWith('.tmp')
      )
    ).toEqual([]);

    await rm(markerPath, { recursive: true, force: true });
    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        batch.checkpoint,
        commitOptions
      )
    ).resolves.toBeUndefined();
  });

  it('recovers a stale lock owned by a crashed process', async () => {
    const sessionId = 'stale-lock';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'stale-lock-record' })
    );
    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const batch = await tailRawTranscriptSessionRecords(mainPath, options);
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    const lockPath = `${markerPath}.lock`;
    await mkdir(lockPath, { recursive: true });
    const ownerPath = join(lockPath, 'owner.json');
    await writeFile(
      ownerPath,
      JSON.stringify({
        token: '00000000-0000-4000-8000-000000000001',
        pid: 2_147_483_647,
        createdAt: Date.now() - 60_000,
      })
    );
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(ownerPath, staleDate, staleDate);

    await expect(
      commitRawTranscriptSessionCheckpoint(mainPath, batch.checkpoint, {
        markerDir: markerRoot,
        allowedMarkerRoots: [tmp],
      })
    ).resolves.toBeUndefined();
    await expect(access(lockPath)).rejects.toThrow();
    expect(
      (await readdir(dirname(markerPath))).filter(entry =>
        entry.startsWith(`${basename(markerPath)}.lock.stale.`)
      )
    ).toHaveLength(0);
  });

  it('reclaims capturable legacy owners and fails closed on malformed fields without path use', async () => {
    const deadPid = 2_147_483_647;
    const oldTimestamp = Date.now() - 60_000;
    const cases = [
      {
        label: 'traversal-token',
        reclaimable: true,
        owner: {
          token: 'pivot/../../escaped',
          pid: deadPid,
          createdAt: oldTimestamp,
        },
      },
      {
        label: 'nested-token',
        reclaimable: true,
        owner: {
          token: 'nested/path',
          pid: deadPid,
          createdAt: oldTimestamp,
        },
      },
      {
        label: 'invalid-pid',
        reclaimable: false,
        owner: {
          token: '00000000-0000-4000-8000-000000000002',
          pid: 0,
          createdAt: oldTimestamp,
        },
      },
      {
        label: 'invalid-created-at',
        reclaimable: false,
        owner: {
          token: '00000000-0000-4000-8000-000000000003',
          pid: deadPid,
          createdAt: -1,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const sessionId = `malformed-owner-${testCase.label}`;
      const { mainPath } = await createSession(
        tmp,
        sessionId,
        recordLine({ sessionId, uuid: testCase.label })
      );
      const tailOptions: RawTranscriptSessionTailOptions = {
        ...unsafeOptions(markerRoot, tmp),
        checkpointMode: 'manual',
      };
      const commitOptions = {
        markerDir: markerRoot,
        allowedMarkerRoots: [tmp],
      } as const;
      const batch = await tailRawTranscriptSessionRecords(
        mainPath,
        tailOptions
      );
      const markerPath = getRawTranscriptSessionMarkerPath(
        mainPath,
        markerRoot,
        [tmp]
      );
      const lockPath = `${markerPath}.lock`;
      await mkdir(lockPath, { recursive: true });
      const ownerPath = join(lockPath, 'owner.json');
      const ownerContents = JSON.stringify(testCase.owner);
      await writeFile(ownerPath, ownerContents);
      const oldDate = new Date(oldTimestamp);
      await utimes(ownerPath, oldDate, oldDate);

      const escapedPath = resolve(
        `${lockPath}.stale.pivot`,
        '..',
        '..',
        'escaped'
      );
      if (testCase.label === 'traversal-token') {
        await mkdir(`${lockPath}.stale.pivot`, { recursive: true });
        await expect(access(escapedPath)).rejects.toThrow();
      }

      if (testCase.reclaimable) {
        await expect(
          commitRawTranscriptSessionCheckpoint(
            mainPath,
            batch.checkpoint,
            commitOptions
          )
        ).resolves.toBeUndefined();
        await expect(access(lockPath)).rejects.toThrow();
      } else {
        let entered = false;
        await expect(
          withRawTranscriptSessionMarkerLock(
            markerPath,
            async () => {
              entered = true;
            },
            { acquireTimeoutMs: 0, retryMs: 0, isProcessAlive: () => false }
          )
        ).rejects.toThrow('Timed out acquiring session marker lock');
        expect(entered).toBe(false);
        expect(await readFile(ownerPath, 'utf8')).toBe(ownerContents);
        await rm(lockPath, { recursive: true });
        await commitRawTranscriptSessionCheckpoint(
          mainPath,
          batch.checkpoint,
          commitOptions
        );
      }
      await expect(access(escapedPath)).rejects.toThrow();

      const tombstonePrefix = `${basename(markerPath)}.lock.stale.`;
      const tombstones = (await readdir(dirname(markerPath))).filter(entry => {
        if (!entry.startsWith(tombstonePrefix)) return false;
        return /^[a-f0-9]{64}$/.test(entry.slice(tombstonePrefix.length));
      });
      expect(tombstones).toHaveLength(0);

      const next = await tailRawTranscriptSessionRecords(mainPath, tailOptions);
      await expect(
        commitRawTranscriptSessionCheckpoint(
          mainPath,
          next.checkpoint,
          commitOptions
        )
      ).resolves.toBeUndefined();
    }
  });

  it('migrates a v1 marker by safely replaying once into v2', async () => {
    const sessionId = 'marker-migration';
    const content = recordLine({ sessionId, uuid: 'migration-record' });
    const { mainPath } = await createSession(tmp, sessionId, content);
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        sessionId,
        sources: {
          'main:main': {
            byteOffset: Buffer.byteLength(content),
            fileSize: Buffer.byteLength(content),
            lastTailAt: '2026-07-12T00:00:00.000Z',
          },
        },
      })
    );

    const first = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
    });
    const historical = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });
    expect(first.records.map(record => record.id)).toEqual(
      historical.records.map(record => record.id)
    );
    const migratedMarker = parseStoredSessionMarker(
      await readFile(markerPath, 'utf8')
    );
    expect(migratedMarker).toMatchObject({ version: 2, revision: 1 });

    const second = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
    });
    expect(second.records).toEqual([]);
  });

  it('binds manual checkpoints to the resolved main JSONL path', async () => {
    const sessionId = 'same-session-name';
    const projectA = join(tmp, 'project-a');
    const projectB = join(tmp, 'project-b');
    await Promise.all([
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
    ]);
    const first = await createSession(
      projectA,
      sessionId,
      recordLine({ sessionId, uuid: 'project-a-record' })
    );
    const second = await createSession(
      projectB,
      sessionId,
      recordLine({ sessionId, uuid: 'project-b-record' })
    );
    const options: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const firstBatch = await tailRawTranscriptSessionRecords(
      first.mainPath,
      options
    );

    await expect(
      commitRawTranscriptSessionCheckpoint(
        second.mainPath,
        firstBatch.checkpoint,
        { markerDir: markerRoot, allowedMarkerRoots: [tmp] }
      )
    ).rejects.toThrow(/does not match the main JSONL path/);

    const secondBatch = await tailRawTranscriptSessionRecords(
      second.mainPath,
      options
    );
    expect(secondBatch.records.map(record => record.uuid)).toEqual([
      'project-b-record',
    ]);
    expect(secondBatch.checkpoint.mainPathDigest).not.toBe(
      firstBatch.checkpoint.mainPathDigest
    );
  });

  it('commits shorter main and subagent generations after rotation', async () => {
    const sessionId = 'manual-rotation';
    const initialMain = recordLine({
      sessionId,
      uuid: 'main-before-rotation-with-long-content',
      value: 'long-main-value'.repeat(20),
    });
    const initialAgent = recordLine({
      sessionId,
      uuid: 'agent-before-rotation-with-long-content',
      value: 'long-agent-value'.repeat(20),
    });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      initialMain,
      { 'agent-a': initialAgent }
    );
    const tailOptions: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const first = await tailRawTranscriptSessionRecords(mainPath, tailOptions);
    await commitRawTranscriptSessionCheckpoint(
      mainPath,
      first.checkpoint,
      commitOptions
    );

    await Promise.all([
      writeFile(
        mainPath,
        recordLine({ sessionId, uuid: 'main-after-rotation' })
      ),
      writeFile(
        join(subagentDir, 'agent-a.jsonl'),
        recordLine({ sessionId, uuid: 'agent-after-rotation' })
      ),
    ]);
    const rotated = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );

    expect(rotated.sources.map(source => source.fileRotated)).toEqual([
      true,
      true,
    ]);
    expect(rotated.checkpoint.sources.map(source => source.generation)).toEqual(
      [1, 1]
    );
    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        rotated.checkpoint,
        commitOptions
      )
    ).resolves.toBeUndefined();
    const quiet = await tailRawTranscriptSessionRecords(mainPath, tailOptions);
    expect(quiet.records).toEqual([]);
  });

  it('commits source removal while rejecting stale and backward checkpoints', async () => {
    const sessionId = 'manual-source-removal';
    const initialMain = recordLine({ sessionId, uuid: 'main-before-removal' });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      initialMain,
      { 'agent-a': recordLine({ sessionId, uuid: 'agent-before-removal' }) }
    );
    const tailOptions: RawTranscriptSessionTailOptions = {
      ...unsafeOptions(markerRoot, tmp),
      checkpointMode: 'manual',
    };
    const commitOptions = {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
    } as const;
    const initial = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    await commitRawTranscriptSessionCheckpoint(
      mainPath,
      initial.checkpoint,
      commitOptions
    );

    await rm(join(subagentDir, 'agent-a.jsonl'));
    const removed = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    expect(removed.sources.map(source => source.sourceId)).toEqual(['main']);
    expect(removed.checkpoint.sources.map(source => source.sourceId)).toEqual([
      'main',
    ]);
    await commitRawTranscriptSessionCheckpoint(
      mainPath,
      removed.checkpoint,
      commitOptions
    );

    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        initial.checkpoint,
        commitOptions
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        isStaleCheckpointConflict(error) &&
        error.code === STALE_CHECKPOINT_CONFLICT_CODE &&
        error.expectedRevision === initial.checkpoint.baseRevision &&
        error.actualRevision === removed.checkpoint.baseRevision + 1
    );
    const quiet = await tailRawTranscriptSessionRecords(mainPath, tailOptions);
    const mainCheckpoint = must(
      quiet.checkpoint.sources.find(source => source.sourceKind === 'main')
    );
    const backwardCheckpoint: RawTranscriptSessionCheckpoint = {
      ...quiet.checkpoint,
      sources: [{ ...mainCheckpoint, byteOffset: 0 }],
    };
    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        backwardCheckpoint,
        commitOptions
      )
    ).rejects.toThrow(/backwards/);

    await appendFile(
      mainPath,
      recordLine({ sessionId, uuid: 'main-after-removal' })
    );
    const afterRemoval = await tailRawTranscriptSessionRecords(
      mainPath,
      tailOptions
    );
    expect(afterRemoval.records.map(record => record.uuid)).toEqual([
      'main-after-removal',
    ]);
    await expect(
      commitRawTranscriptSessionCheckpoint(
        mainPath,
        afterRemoval.checkpoint,
        commitOptions
      )
    ).resolves.toBeUndefined();
  });

  it('cancels before observation and while polling', async () => {
    const sessionId = 'cancel';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      recordLine({ sessionId, uuid: 'main' })
    );
    const before = new AbortController();
    before.abort();
    const beforeIterator = watchRawTranscriptSessionRecords(mainPath, {
      signal: before.signal,
      pollMs: 60_000,
    });
    await expect(beforeIterator.next()).resolves.toMatchObject({ done: true });

    const during = new AbortController();
    const duringIterator = watchRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      signal: during.signal,
      pollMs: 60_000,
    });
    expect(yielded(await duringIterator.next()).records).toHaveLength(1);
    during.abort();
    await expect(duringIterator.next()).resolves.toMatchObject({ done: true });
  });

  it('reports aggregate and per-source degradation without losing retained raw records', async () => {
    const sessionId = 'diagnostics';
    const unknownMain = recordLine({
      sessionId,
      uuid: 'unknown-main',
      type: 'future-main-record',
      timestamp: '2026-07-12T10:00:01.000Z',
      value: 'main-value',
    });
    const malformed = '{"type":"broken"\n';
    const degraded = degradedHistoryLine(sessionId, 'degraded-agent');
    const scalar = 'false\n';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      unknownMain + malformed,
      { 'agent-a': degraded + scalar }
    );

    const unsafe = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });
    const safe = await tailRawTranscriptSessionRecords(mainPath, {
      markerDir: markerRoot,
      allowedMarkerRoots: [tmp],
      dryRun: true,
      fromStart: true,
    });

    expect(unsafe.records.map(record => record.uuid)).toEqual([
      'unknown-main',
      'degraded-agent',
    ]);
    expect(unsafe.records[0]?.rawLine).toBe(unknownMain.trim());
    expect(unsafe.records[1]?.rawLine).toBe(degraded.trim());
    expect(unsafe).toMatchObject({
      invalidJsonLineCount: 1,
      invalidShapeLineCount: 1,
      skippedLineCount: 1,
      degradedHistoryLineCount: 1,
    });
    expect(unsafe.sources[0]).toMatchObject({
      sourceId: 'main',
      invalidJsonLineCount: 1,
      degradedHistoryLineCount: 0,
    });
    expect(unsafe.sources[1]).toMatchObject({
      sourceId: 'agent-a',
      invalidShapeLineCount: 1,
      skippedLineCount: 1,
      degradedHistoryLineCount: 1,
    });
    expect(safe.records[0]?.rawLine).toBe('[REDACTED:RAW_TRANSCRIPT_LINE]');
    expect(JSON.stringify(safe.records[0]?.payload)).toContain(
      '[REDACTED:RAW_TRANSCRIPT_VALUE]'
    );
    expect(safe.records.map(record => record.id)).toEqual(
      unsafe.records.map(record => record.id)
    );
  });

  it('preserves tool names and source provenance during the merge', async () => {
    const sessionId = 'tool-provenance';
    const timestamp = '2026-07-12T10:00:00.000Z';
    const { mainPath } = await createSession(
      tmp,
      sessionId,
      toolUseLine({
        sessionId,
        uuid: 'main-tool',
        timestamp,
        toolUseId: 'shared-tool-id',
        toolName: 'Read',
      }),
      {
        'agent-a': toolUseLine({
          sessionId,
          uuid: 'agent-tool',
          timestamp,
          toolUseId: 'shared-tool-id',
          toolName: 'Bash',
        }),
      }
    );

    const result = await tailRawTranscriptSessionRecords(mainPath, {
      ...unsafeOptions(markerRoot, tmp),
      dryRun: true,
      fromStart: true,
    });
    const mainPayload = must(result.records[0]).payload;
    const agentPayload = must(result.records[1]).payload;

    expect(result.records.map(record => record.sourceId)).toEqual([
      'main',
      'agent-a',
    ]);
    expect(JSON.stringify(mainPayload)).toContain('"name":"Read"');
    expect(JSON.stringify(agentPayload)).toContain('"name":"Bash"');
  });

  it('does not advance any source when another source fails to read', async () => {
    const sessionId = 'atomic-failure';
    const initial = recordLine({ sessionId, uuid: 'main-initial' });
    const appended = recordLine({ sessionId, uuid: 'main-retry' });
    const { mainPath, subagentDir } = await createSession(
      tmp,
      sessionId,
      initial
    );
    const options = unsafeOptions(markerRoot, tmp);
    const markerPath = getRawTranscriptSessionMarkerPath(mainPath, markerRoot, [
      tmp,
    ]);
    await tailRawTranscriptSessionRecords(mainPath, options);
    const markerBeforeFailure = await readFile(markerPath, 'utf8');
    await appendFile(mainPath, appended);
    await mkdir(join(subagentDir, 'bad.jsonl'), { recursive: true });

    await expect(
      tailRawTranscriptSessionRecords(mainPath, options)
    ).rejects.toThrow();
    expect(await readFile(markerPath, 'utf8')).toBe(markerBeforeFailure);

    await rm(join(subagentDir, 'bad.jsonl'), { recursive: true, force: true });
    const retry = await tailRawTranscriptSessionRecords(mainPath, options);
    expect(retry.records.map(record => record.uuid)).toEqual(['main-retry']);
  });

  it('keeps the public result and option contracts assignable', () => {
    const source: RawTranscriptSourceTailResult = {
      sourcePath: '/tmp/session.jsonl',
      sourceKind: 'main',
      sourceId: 'main',
      recordCount: 0,
      previousByteOffset: 0,
      newByteOffset: 0,
      fileSize: 0,
      fileRotated: false,
      degradedHistoryLineCount: 0,
      invalidJsonLineCount: 0,
      invalidShapeLineCount: 0,
      skippedLineCount: 0,
    };
    const result: RawTranscriptSessionTailResult = {
      sessionId: 'session',
      records: [],
      sources: [source],
      checkpoint: {
        sessionId: 'session',
        mainPathDigest: '0'.repeat(64),
        baseRevision: 0,
        sources: [
          {
            sourceKind: 'main',
            sourceId: 'main',
            generation: 0,
            byteOffset: 0,
            fileSize: 0,
          },
        ],
      },
      degradedHistoryLineCount: 0,
      invalidJsonLineCount: 0,
      invalidShapeLineCount: 0,
      skippedLineCount: 0,
    };
    const checkpoint: RawTranscriptSessionCheckpoint = result.checkpoint;

    expect(result.sources[0]?.sourceKind).toBe('main');
    expect(checkpoint.sources[0]?.byteOffset).toBe(0);
  });
});
