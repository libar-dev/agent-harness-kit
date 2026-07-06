import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  writeFile,
  appendFile,
  readFile,
  rm,
  stat,
  chmod,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  tailBlocks,
  tailRawTranscriptRecords,
  watchRawTranscriptRecords,
  readRawSessionFiles,
  extractBlocks,
  type RawTranscriptRecord,
  type RawTranscriptTailResult,
} from '../src/processing/index.js';
import {
  readMarker,
  getMarkerPath,
  writeMarker,
  parseSessionContent,
} from '../src/processing/internal.js';
import { must } from './test-utils.js';

const execFileAsync = promisify(execFile);

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object, got ${String(parsed)}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  script: string,
  args: readonly string[]
): Promise<CliResult> {
  try {
    const result = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', script, ...args],
      {
        env: process.env,
      }
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const execError = getExecError(err);
    return {
      code: execError.code ?? 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message ?? '',
    };
  }
}

function getExecError(err: unknown): {
  code?: number;
  stdout?: string;
  stderr?: string;
  message?: string;
} {
  if (!isRecord(err)) return {};
  return {
    ...(typeof err['code'] === 'number' ? { code: err['code'] } : {}),
    ...(typeof err['stdout'] === 'string' ? { stdout: err['stdout'] } : {}),
    ...(typeof err['stderr'] === 'string' ? { stderr: err['stderr'] } : {}),
    ...(typeof err['message'] === 'string' ? { message: err['message'] } : {}),
  };
}

function expectYielded<T>(result: IteratorResult<T, void>): T {
  if (result.done) {
    throw new Error('expected iterator to yield a value');
  }
  return result.value;
}

function makeAssistantToolUseLine(
  uuid: string,
  toolUseId: string,
  ts: string
): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command: 'echo hi' },
        },
      ],
    },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeUserToolResultLine(
  uuid: string,
  toolUseId: string,
  content: string,
  ts: string
): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeUserTextLine(uuid: string, text: string, ts: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeAssistantImageLine(
  uuid: string,
  mediaType: string,
  data: string,
  ts: string
): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        },
      ],
    },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeUnknownLine(
  type: string,
  uuid: string | undefined,
  ts: string
): string {
  return `${JSON.stringify({
    type,
    operation: 'enqueue',
    sessionId: 's1',
    timestamp: ts,
    ...(uuid !== undefined ? { uuid } : {}),
    nested: { keep: true },
  })}\n`;
}

function makeInvalidKnownHistoryLine(uuid: string, ts: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 123, content: 'bad' }],
    },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeInvalidToolUseMissingIdLine(uuid: string, ts: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }],
    },
    sessionId: 's1',
    timestamp: ts,
    uuid,
  })}\n`;
}

function makeUnknownWithoutOptionalMetadataLine(type: string): string {
  return `${JSON.stringify({
    type,
    nested: { keep: true },
  })}\n`;
}

function makeNonObjectLine(value: string | number | boolean | null): string {
  return `${JSON.stringify(value)}\n`;
}

describe('Tail mode', () => {
  let tmp: string;
  let jsonlPath: string;
  let originalMarkerRoots: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tail-test-'));
    jsonlPath = join(tmp, 'session.jsonl');
    originalMarkerRoots = process.env['CLAUDE_TAIL_MARKER_ROOTS'];
    delete process.env['CLAUDE_TAIL_MARKER_ROOTS'];
  });

  afterEach(async () => {
    if (originalMarkerRoots === undefined) {
      delete process.env['CLAUDE_TAIL_MARKER_ROOTS'];
    } else {
      process.env['CLAUDE_TAIL_MARKER_ROOTS'] = originalMarkerRoots;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('first call emits all blocks and writes a marker', async () => {
    const initial =
      makeUserTextLine('u-1', 'hello', '2026-02-16T20:00:00.000Z') +
      makeAssistantToolUseLine('a-1', 'tu-1', '2026-02-16T20:00:01.000Z') +
      makeUserToolResultLine('u-2', 'tu-1', 'hi\n', '2026-02-16T20:00:02.000Z');
    await writeFile(jsonlPath, initial);

    const result = await tailBlocks(jsonlPath);
    expect(result.blocks).toHaveLength(3);
    expect(result.previousByteOffset).toBe(0);
    expect(result.newByteOffset).toBe(initial.length);

    const toolResult = result.blocks.find(
      block => block.type === 'tool_result'
    );
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toContain('hi\n');
    }

    const marker = await readMarker(getMarkerPath(jsonlPath));
    expect(marker?.byteOffset).toBe(initial.length);
  });

  it('returns no blocks and does not write a marker for an empty JSONL file', async () => {
    await writeFile(jsonlPath, '');

    const result = await tailBlocks(jsonlPath);

    expect(result.blocks).toEqual([]);
    expect(result.previousByteOffset).toBe(0);
    expect(result.newByteOffset).toBe(0);
    expect(result.fileSize).toBe(0);
    expect(result.fileRotated).toBe(false);
    expect(result.invalidJsonLineCount).toBe(0);
    expect(result.invalidShapeLineCount).toBe(0);
    expect(result.skippedLineCount).toBe(0);
    expect(await readMarker(getMarkerPath(jsonlPath))).toBeNull();
  });

  it('surfaces non-existent JSONL files as read errors', async () => {
    await expect(
      tailBlocks(join(tmp, 'missing-session.jsonl'))
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('parses a BOM-prefixed JSONL file from tail mode', async () => {
    const content = `\uFEFF${makeUserTextLine(
      'u-bom',
      'hello after bom',
      '2026-02-16T20:00:00.000Z'
    )}`;
    await writeFile(jsonlPath, content);

    const result = await tailBlocks(jsonlPath);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      id: 'u-bom:0',
      type: 'user_text',
      content: 'hello after bom',
    });
    expect(result.invalidJsonLineCount).toBe(0);
    expect(result.newByteOffset).toBe(Buffer.byteLength(content));
  });

  it('emits image transcript lines as structured tail blocks', async () => {
    const content = makeAssistantImageLine(
      'a-image',
      'image/png',
      'raw-base64-image-data',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, content);

    const result = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0]).toMatchObject({
      id: 'a-image:0',
      type: 'assistant_text',
      content: '[Image: image/png]',
    });
    expect(JSON.stringify(result.blocks)).not.toContain(
      'raw-base64-image-data'
    );
    expect(result.invalidShapeLineCount).toBe(0);
  });

  it('emits image transcript lines in raw record tail mode', async () => {
    const content = makeAssistantImageLine(
      'a-image-raw',
      'image/png',
      'raw-base64-image-data',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, content);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]).toMatchObject({
      id: 's1:main:a-image-raw',
      type: 'assistant',
    });
    expect(result.invalidShapeLineCount).toBe(0);
  });

  it('redacts structured tail tool_result content and keeps replay output byte-identical', async () => {
    const content =
      makeAssistantToolUseLine('a-1', 'tu-1', '2026-02-16T20:00:00.000Z') +
      makeUserToolResultLine(
        'u-1',
        'tu-1',
        'Authorization: Bearer top-secret-token\napi_key=super-secret-value\nsafe',
        '2026-02-16T20:00:01.000Z'
      );
    await writeFile(jsonlPath, content);

    const first = await tailBlocks(jsonlPath, { dryRun: true });
    const replay = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(first.newByteOffset).toBe(content.length);
    expect(first.newByteOffset).toBe(replay.newByteOffset);
    expect(first.blocks).toEqual(replay.blocks);

    const toolResult = first.blocks.find(block => block.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toContain(
        'Authorization: [REDACTED:AUTHORIZATION]'
      );
      expect(toolResult.content).toContain('api_key=[REDACTED:API_KEY]');
      expect(toolResult.content).toContain('safe');
      expect(toolResult.content).not.toContain('top-secret-token');
      expect(toolResult.content).not.toContain('super-secret-value');
    }
  });

  it('redacts raw record payloads by default while keeping IDs and marker byte offsets stable', async () => {
    const assistantLine = makeAssistantToolUseLine(
      'a-redact',
      'tu-redact',
      '2026-02-16T20:00:00.000Z'
    );
    const secretResultLine = makeUserToolResultLine(
      'u-redact',
      'tu-redact',
      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv\nAuthorization: Bearer top-secret-token',
      '2026-02-16T20:00:01.000Z'
    );
    const content = assistantLine + secretResultLine;
    await writeFile(jsonlPath, content);

    const blocks = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });
    const raw = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });
    const committed = await tailBlocks(jsonlPath);

    const resultBlock = blocks.blocks.find(
      block => block.type === 'tool_result'
    );
    expect(resultBlock).toBeDefined();
    if (resultBlock?.type === 'tool_result') {
      expect(resultBlock.id).toBe('u-redact:0');
      expect(resultBlock.content).toContain(
        'OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]'
      );
      expect(resultBlock.content).toContain(
        'Authorization: [REDACTED:AUTHORIZATION]'
      );
      expect(resultBlock.content).not.toContain(
        'sk-1234567890abcdefghijklmnopqrstuv'
      );
      expect(resultBlock.content).not.toContain('top-secret-token');
    }

    expect(raw.records.map(record => record.id)).toEqual([
      's1:main:a-redact',
      's1:main:u-redact',
    ]);
    expect(raw.records[1]).toMatchObject({
      rawLine: '[REDACTED:RAW_TRANSCRIPT_LINE]',
      byteStart: Buffer.byteLength(assistantLine),
      byteEnd: Buffer.byteLength(content),
    });
    expect(JSON.stringify(raw.records[1]?.payload)).toContain(
      '[REDACTED:RAW_TRANSCRIPT_VALUE]'
    );
    expect(JSON.stringify(raw.records[1]?.payload)).not.toContain(
      'sk-1234567890abcdefghijklmnopqrstuv'
    );
    expect(JSON.stringify(raw.records[1]?.payload)).not.toContain(
      'top-secret-token'
    );
    expect(blocks.newByteOffset).toBe(Buffer.byteLength(content));
    expect(raw.newByteOffset).toBe(Buffer.byteLength(content));
    expect(committed.newByteOffset).toBe(Buffer.byteLength(content));
    expect((await readMarker(getMarkerPath(jsonlPath)))?.byteOffset).toBe(
      Buffer.byteLength(content)
    );
  });

  it('subsequent call emits only new blocks', async () => {
    const initial = makeUserTextLine(
      'u-1',
      'first',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, initial);
    const first = await tailBlocks(jsonlPath);
    expect(first.blocks).toHaveLength(1);

    const appended = makeUserTextLine(
      'u-2',
      'second',
      '2026-02-16T20:01:00.000Z'
    );
    await appendFile(jsonlPath, appended);

    const second = await tailBlocks(jsonlPath);
    expect(second.blocks).toHaveLength(1);
    expect(must(second.blocks[0]).id).toBe('u-2:0');
    expect(second.previousByteOffset).toBe(initial.length);
    expect(second.newByteOffset).toBe(initial.length + appended.length);
  });

  it('returns no blocks when file is unchanged', async () => {
    const content = makeUserTextLine('u-1', 'x', '2026-02-16T20:00:00.000Z');
    await writeFile(jsonlPath, content);
    await tailBlocks(jsonlPath);

    const second = await tailBlocks(jsonlPath);
    expect(second.blocks).toHaveLength(0);
    expect(second.previousByteOffset).toBe(second.newByteOffset);
  });

  it('resolves toolName on tool_result added in a later tail call', async () => {
    const initial = makeAssistantToolUseLine(
      'a-1',
      'tu-X',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, initial);
    const first = await tailBlocks(jsonlPath);
    expect(first.blocks).toHaveLength(1);

    const appended = makeUserToolResultLine(
      'u-1',
      'tu-X',
      'output line',
      '2026-02-16T20:00:01.000Z'
    );
    await appendFile(jsonlPath, appended);

    const second = await tailBlocks(jsonlPath);
    expect(second.blocks).toHaveLength(1);
    const block = must(second.blocks[0]);
    if (block.type === 'tool_result') {
      expect(block.toolName).toBe('Bash');
      expect(block.content).toBe('output line');
    } else {
      throw new Error(`expected tool_result, got ${block.type}`);
    }
  });

  it('skips a partial trailing line written without newline', async () => {
    const complete = makeUserTextLine(
      'u-1',
      'done',
      '2026-02-16T20:00:00.000Z'
    );
    const partial = `{"type":"user","message":{"role":"user","content":"part`;
    await writeFile(jsonlPath, complete + partial);

    const result = await tailBlocks(jsonlPath);
    expect(result.blocks).toHaveLength(1);
    expect(must(result.blocks[0]).id).toBe('u-1:0');
    expect(result.invalidJsonLineCount).toBe(0);
    expect(result.invalidShapeLineCount).toBe(0);
    expect(result.skippedLineCount).toBe(0);
  });

  it('emits a previously partial trailing line once the write is completed', async () => {
    const complete = makeUserTextLine(
      'u-1',
      'done',
      '2026-02-16T20:00:00.000Z'
    );
    const partialPrefix =
      '{"type":"user","message":{"role":"user","content":"part';
    await writeFile(jsonlPath, complete + partialPrefix);

    const firstPass = await tailBlocks(jsonlPath);
    expect(firstPass.blocks).toHaveLength(1);
    expect(must(firstPass.blocks[0]).id).toBe('u-1:0');

    const completion =
      ' two"},"sessionId":"s1","timestamp":"2026-02-16T20:00:01.000Z","uuid":"u-2"}\n';
    await appendFile(jsonlPath, completion);

    const secondPass = await tailBlocks(jsonlPath);
    expect(secondPass.blocks).toHaveLength(1);
    expect(secondPass.previousByteOffset).toBe(firstPass.newByteOffset);
    expect(secondPass.newByteOffset).toBe(
      (complete + partialPrefix + completion).length
    );
    expect(secondPass.blocks[0]).toMatchObject({
      id: 'u-2:0',
      type: 'user_text',
      content: 'part two',
    });
    expect(secondPass.invalidJsonLineCount).toBe(0);
    expect(secondPass.invalidShapeLineCount).toBe(0);
    expect(secondPass.skippedLineCount).toBe(0);
  });

  it('counts malformed, invalid-shape, and raw-only complete lines without feeding them into block decomposition', async () => {
    const validUserLine = makeUserTextLine(
      'u-1',
      'safe',
      '2026-02-16T20:00:00.000Z'
    );
    const unknownFutureLine = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:01.000Z'
    );
    const invalidKnownLine = makeInvalidKnownHistoryLine(
      'bad-1',
      '2026-02-16T20:00:02.000Z'
    );
    const malformedJsonLine = '{"type":"user"\n';
    const nonObjectLine = makeNonObjectLine('scalar payload');
    await writeFile(
      jsonlPath,
      validUserLine +
        unknownFutureLine +
        invalidKnownLine +
        malformedJsonLine +
        nonObjectLine
    );

    const result = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ id: 'u-1:0', type: 'user_text' });
    expect(result.invalidJsonLineCount).toBe(1);
    expect(result.invalidShapeLineCount).toBe(1);
    expect(result.skippedLineCount).toBe(2);
    expect(result.newByteOffset).toBe(
      Buffer.byteLength(
        validUserLine +
          unknownFutureLine +
          invalidKnownLine +
          malformedJsonLine +
          nonObjectLine
      )
    );
  });

  it('preserves unknown future object raw records while counting invalid-shape and non-object raw lines', async () => {
    const unknownFutureLine = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:00.000Z'
    );
    const invalidKnownLine = makeInvalidKnownHistoryLine(
      'bad-1',
      '2026-02-16T20:00:01.000Z'
    );
    const malformedJsonLine = '{"type":"assistant"\n';
    const nonObjectLine = makeNonObjectLine(false);
    const partialPrefix =
      '{"type":"user","message":{"role":"user","content":"partial';
    await writeFile(
      jsonlPath,
      unknownFutureLine +
        invalidKnownLine +
        malformedJsonLine +
        nonObjectLine +
        partialPrefix
    );

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: 's1:main:q-1',
      type: 'queue-operation',
    });
    // Known-type line failing strict typed validation is still counted under
    // invalidShapeLineCount but preserved as a raw record for raw consumers.
    expect(result.records[1]).toMatchObject({
      id: 's1:main:bad-1',
      type: 'user',
    });
    expect(result.invalidJsonLineCount).toBe(1);
    expect(result.invalidShapeLineCount).toBe(1);
    expect(result.skippedLineCount).toBe(1);
    expect(result.newByteOffset).toBe(
      Buffer.byteLength(
        unknownFutureLine + invalidKnownLine + malformedJsonLine + nonObjectLine
      )
    );
  });

  it('preserves modern file-history-snapshot lines without top-level metadata as raw records', async () => {
    // Claude Code moved timestamp/uuid/sessionId off the top level of
    // file-history-snapshot lines; the strict typed schema rejects them but
    // raw consumers must still receive the record.
    const snapshotLine = `${JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'msg-1',
      snapshot: {
        messageId: 'msg-1',
        trackedFileBackups: {},
        timestamp: '2026-02-16T20:00:00.000Z',
      },
      isSnapshotUpdate: false,
    })}\n`;
    await writeFile(jsonlPath, snapshotLine);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      type: 'file-history-snapshot',
      payload: { messageId: 'msg-1' },
    });
    expect(result.invalidShapeLineCount).toBe(1);

    const blocksResult = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });
    expect(blocksResult.blocks).toHaveLength(0);
    expect(blocksResult.invalidShapeLineCount).toBe(1);
    expect(blocksResult.skippedLineCount).toBe(0);
  });

  it('advances past invalid typed lines so they are not replayed after restart', async () => {
    const invalidKnownLine = makeInvalidKnownHistoryLine(
      'bad-1',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, invalidKnownLine);

    const first = await runCli('src/cli/tail-session.ts', [jsonlPath]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(JSON.parse(first.stderr.trim())).toMatchObject({
      blockCount: 0,
      markerAdvanced: true,
      invalidShapeLineCount: 1,
    });

    const second = await runCli('src/cli/tail-session.ts', [jsonlPath]);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
    expect(JSON.parse(second.stderr.trim())).toMatchObject({
      blockCount: 0,
      previousByteOffset: Buffer.byteLength(invalidKnownLine),
      newByteOffset: Buffer.byteLength(invalidKnownLine),
      markerAdvanced: true,
    });
  });

  it('advances once past mixed diagnostic-only complete lines after CLI restart', async () => {
    const unknownFutureLine = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:00.000Z'
    );
    const invalidToolUseLine = makeInvalidToolUseMissingIdLine(
      'bad-tool-use',
      '2026-02-16T20:00:01.000Z'
    );
    const malformedJsonLine = '{"type":"user"\n';
    const nonObjectLine = makeNonObjectLine(123);
    const content =
      unknownFutureLine +
      invalidToolUseLine +
      malformedJsonLine +
      nonObjectLine;
    await writeFile(jsonlPath, content);

    const first = await runCli('src/cli/tail-session.ts', [jsonlPath]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(JSON.parse(first.stderr.trim())).toMatchObject({
      blockCount: 0,
      previousByteOffset: 0,
      newByteOffset: Buffer.byteLength(content),
      markerAdvanced: true,
      invalidJsonLineCount: 1,
      invalidShapeLineCount: 1,
      skippedLineCount: 2,
    });

    const second = await runCli('src/cli/tail-session.ts', [jsonlPath]);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
    expect(JSON.parse(second.stderr.trim())).toEqual({
      blockCount: 0,
      previousByteOffset: Buffer.byteLength(content),
      newByteOffset: Buffer.byteLength(content),
      fileSize: Buffer.byteLength(content),
      fileRotated: false,
      markerAdvanced: true,
    });
  });

  it('surfaces raw-tail skip counts in CLI summaries and replays a held-back trailing line after restart', async () => {
    const unknownFutureLine = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:00.000Z'
    );
    const malformedJsonLine = '{"type":"assistant"\n';
    const nonObjectLine = makeNonObjectLine('scalar payload');
    const partialPrefix =
      '{"type":"user","message":{"role":"user","content":"part';
    await writeFile(
      jsonlPath,
      unknownFutureLine + malformedJsonLine + nonObjectLine + partialPrefix
    );

    const first = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--format',
      'raw-records',
      '--unsafe-raw-unredacted',
    ]);
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split('\n')).toHaveLength(1);
    const firstSummary = parseJsonObject(first.stderr.trim());
    expect(firstSummary).toMatchObject({
      recordCount: 1,
      invalidJsonLineCount: 1,
      skippedLineCount: 1,
    });
    expect(firstSummary['newByteOffset']).toBe(
      Buffer.byteLength(unknownFutureLine + malformedJsonLine + nonObjectLine)
    );

    const completion =
      ' two"},"sessionId":"s1","timestamp":"2026-02-16T20:00:01.000Z","uuid":"u-2"}\n';
    await appendFile(jsonlPath, completion);

    const second = await runCli('src/cli/tail-session.ts', [
      jsonlPath,
      '--format',
      'raw-records',
      '--unsafe-raw-unredacted',
    ]);
    expect(second.code).toBe(0);
    const emitted = second.stdout
      .trim()
      .split('\n')
      .map(line => {
        const parsed: unknown = JSON.parse(line);
        return parsed;
      });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ id: 's1:main:u-2', type: 'user' });
    expect(JSON.parse(second.stderr.trim())).toMatchObject({
      recordCount: 1,
      previousByteOffset: firstSummary['newByteOffset'],
      markerAdvanced: true,
    });
  });

  it('detects file rotation (size shrank) and re-scans from start', async () => {
    const big =
      makeUserTextLine('u-1', 'a', '2026-02-16T20:00:00.000Z') +
      makeUserTextLine('u-2', 'b', '2026-02-16T20:00:01.000Z') +
      makeUserTextLine('u-3', 'c', '2026-02-16T20:00:02.000Z');
    await writeFile(jsonlPath, big);
    await tailBlocks(jsonlPath);

    const shorter = makeUserTextLine(
      'u-new',
      'fresh',
      '2026-02-16T21:00:00.000Z'
    );
    await writeFile(jsonlPath, shorter);

    const result = await tailBlocks(jsonlPath);
    expect(result.fileRotated).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(must(result.blocks[0]).id).toBe('u-new:0');
  });

  it('dryRun does not advance the marker', async () => {
    const content = makeUserTextLine('u-1', 'x', '2026-02-16T20:00:00.000Z');
    await writeFile(jsonlPath, content);

    const result = await tailBlocks(jsonlPath, { dryRun: true });
    expect(result.blocks).toHaveLength(1);

    const marker = await readMarker(getMarkerPath(jsonlPath));
    expect(marker).toBeNull();
  });

  it('fromStart re-emits all blocks even when marker exists', async () => {
    const content =
      makeUserTextLine('u-1', 'a', '2026-02-16T20:00:00.000Z') +
      makeUserTextLine('u-2', 'b', '2026-02-16T20:00:01.000Z');
    await writeFile(jsonlPath, content);
    await tailBlocks(jsonlPath);

    const second = await tailBlocks(jsonlPath, { fromStart: true });
    expect(second.blocks).toHaveLength(2);
  });

  it('honors custom markerDir', async () => {
    const customDir = join(tmp, 'consumer-state');
    process.env['CLAUDE_TAIL_MARKER_ROOTS'] = tmp;
    const content = makeUserTextLine('u-1', 'hi', '2026-02-16T20:00:00.000Z');
    await writeFile(jsonlPath, content);

    await tailBlocks(jsonlPath, { markerDir: customDir });

    const expected = getMarkerPath(jsonlPath, customDir);
    const stats = await stat(expected);
    expect(stats.isFile()).toBe(true);

    const defaultMarker = await readMarker(getMarkerPath(jsonlPath));
    expect(defaultMarker).toBeNull();
  });

  it('rejects custom markerDir outside CLAUDE_TAIL_MARKER_ROOTS', async () => {
    const content = makeUserTextLine('u-1', 'hi', '2026-02-16T20:00:00.000Z');
    await writeFile(jsonlPath, content);
    const allowedRoot = join(tmp, 'allowed');
    const rejectedRoot = join(tmp, 'rejected');
    process.env['CLAUDE_TAIL_MARKER_ROOTS'] = allowedRoot;

    await expect(
      tailBlocks(jsonlPath, { markerDir: rejectedRoot })
    ).rejects.toThrow(/outside allowed marker roots/);
  });

  it('allows custom markerDir inside CLAUDE_TAIL_MARKER_ROOTS', async () => {
    const content = makeUserTextLine('u-1', 'hi', '2026-02-16T20:00:00.000Z');
    await writeFile(jsonlPath, content);
    const allowedRoot = join(tmp, 'allowed');
    const markerDir = join(allowedRoot, 'markers');
    process.env['CLAUDE_TAIL_MARKER_ROOTS'] = allowedRoot;

    await tailBlocks(jsonlPath, { markerDir });

    const marker = await readMarker(getMarkerPath(jsonlPath, markerDir));
    expect(marker?.byteOffset).toBe(content.length);
  });

  it('sanitizes marker filenames so session basenames cannot escape marker dir', () => {
    const markerDir = join(tmp, 'markers');
    process.env['CLAUDE_TAIL_MARKER_ROOTS'] = tmp;
    const markerPath = getMarkerPath(
      join(tmp, '..evil/session:name.jsonl'),
      markerDir
    );

    expect(dirname(markerPath)).toBe(markerDir);
    expect(basename(markerPath)).toBe('session-name.json');
  });

  it('writes marker directories and files with private permissions', async () => {
    const markerPath = join(tmp, 'state', 'session.json');

    await writeMarker(markerPath, {
      byteOffset: 42,
      lastTailAt: '2026-02-16T20:00:00.000Z',
      fileSize: 42,
    });

    const dirMode = (await stat(dirname(markerPath))).mode & 0o777;
    const fileMode = (await stat(markerPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('recovers from corrupted marker contents', async () => {
    const markerPath = join(tmp, 'state', 'session.json');
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, '{"byteOffset":');
    await chmod(markerPath, 0o600);

    const marker = await readMarker(markerPath);

    expect(marker).toBeNull();
  });

  it('recovers from marker files containing valid JSON with the wrong shape', async () => {
    const content = makeUserTextLine(
      'u-1',
      'recovered',
      '2026-02-16T20:00:00.000Z'
    );
    const markerPath = getMarkerPath(jsonlPath);
    await writeFile(jsonlPath, content);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({ byteOffset: 'not-a-number', fileSize: content.length })
    );
    await chmod(markerPath, 0o600);

    expect(await readMarker(markerPath)).toBeNull();

    const result = await tailBlocks(jsonlPath);
    expect(result.blocks).toHaveLength(1);
    expect(result.previousByteOffset).toBe(0);
    expect(result.newByteOffset).toBe(Buffer.byteLength(content));
    expect(await readMarker(markerPath)).toMatchObject({
      byteOffset: Buffer.byteLength(content),
      fileSize: Buffer.byteLength(content),
    });
  });

  it('block IDs are stable across separate tail calls (idempotent for upsert)', async () => {
    const content =
      makeUserTextLine('u-1', 'a', '2026-02-16T20:00:00.000Z') +
      makeAssistantToolUseLine('a-1', 'tu-1', '2026-02-16T20:00:01.000Z');
    await writeFile(jsonlPath, content);

    const r1 = await tailBlocks(jsonlPath, { dryRun: true });
    const r2 = await tailBlocks(jsonlPath, { dryRun: true, fromStart: true });

    expect(r1.blocks.map(b => b.id)).toEqual(r2.blocks.map(b => b.id));
  });

  it('emits exact raw transcript records with source and byte metadata only with explicit unsafe opt-in', async () => {
    const unknownLine = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:00.000Z'
    );
    const userLine = makeUserTextLine(
      'u-1',
      'hello',
      '2026-02-16T20:00:01.000Z'
    );
    await writeFile(jsonlPath, unknownLine + userLine);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: 's1:main:q-1',
      sessionId: 's1',
      sourceKind: 'main',
      sourceId: 'main',
      lineNumber: 1,
      byteStart: 0,
      byteEnd: Buffer.byteLength(unknownLine),
      type: 'queue-operation',
      uuid: 'q-1',
    });
    expect(result.records[0]?.payload).toMatchObject({
      type: 'queue-operation',
      nested: { keep: true },
    });
    expect(result.records[1]).toMatchObject({
      id: 's1:main:u-1',
      lineNumber: 2,
      byteStart: Buffer.byteLength(unknownLine),
      byteEnd: Buffer.byteLength(unknownLine + userLine),
      type: 'user',
    });
  });

  it('keeps raw transcript records exact and unredacted only with explicit unsafe opt-in', async () => {
    const rawSecret = makeUserToolResultLine(
      'u-secret',
      'tu-raw',
      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv',
      '2026-02-16T20:00:02.000Z'
    );
    await writeFile(jsonlPath, rawSecret);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.rawLine).toContain(
      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuv'
    );
    expect(JSON.stringify(result.records[0]?.payload)).toContain(
      'sk-1234567890abcdefghijklmnopqrstuv'
    );
  });

  it('uses a byte-range hash id for raw records without uuid', async () => {
    const raw = `${JSON.stringify({
      type: 'custom-title',
      sessionId: 's1',
      timestamp: '2026-02-16T20:00:00.000Z',
      title: 'No uuid here',
    })}\n`;
    await writeFile(jsonlPath, raw);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.id).toMatch(/^s1:main:0:\d+:[a-f0-9]{64}$/);
    expect(result.records[0]?.rawLine).toBe(raw.trim());
  });

  it('omits absent raw metadata and falls back to source session for raw record IDs', async () => {
    const raw = makeUnknownWithoutOptionalMetadataLine('queue-operation');
    await writeFile(jsonlPath, raw);

    const result = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(result.records).toHaveLength(1);
    const record = must(result.records[0]);
    expect(record.id).toMatch(/^session:main:0:\d+:[a-f0-9]{64}$/);
    expect(record.sessionId).toBe('session');
    expect(record.type).toBe('queue-operation');
    expect(record.uuid).toBeUndefined();
    expect(record.timestamp).toBeUndefined();
    expect(record.byteStart).toBe(0);
    expect(record.byteEnd).toBe(Buffer.byteLength(raw));
    expect(record.rawLine).toBe(raw.trim());
    expect(result.invalidJsonLineCount).toBe(0);
    expect(result.invalidShapeLineCount).toBe(0);
    expect(result.skippedLineCount).toBe(0);
  });

  it('keeps incremental raw metadata aligned with physical JSONL lines', async () => {
    const initialUnknown = makeUnknownLine(
      'queue-operation',
      'q-1',
      '2026-02-16T20:00:00.000Z'
    );
    const initialHistory = makeUserTextLine(
      'u-1',
      'hello',
      '2026-02-16T20:00:01.000Z'
    );
    await writeFile(jsonlPath, initialUnknown + initialHistory);

    const first = await tailRawTranscriptRecords(jsonlPath);
    expect(first.records).toHaveLength(2);

    const appendedUnknown = makeUnknownLine(
      'custom-title',
      undefined,
      '2026-02-16T20:00:02.000Z'
    );
    const appendedHistory = makeUserTextLine(
      'u-2',
      'again',
      '2026-02-16T20:00:03.000Z'
    );
    await appendFile(jsonlPath, appendedUnknown + appendedHistory);

    const second = await tailRawTranscriptRecords(jsonlPath);
    const full = await tailRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(second.records).toEqual(full.records.slice(2));
    expect(second.records.map(record => record.lineNumber)).toEqual([3, 4]);
    expect(second.records[0]).toMatchObject({
      byteStart: Buffer.byteLength(initialUnknown + initialHistory),
      byteEnd: Buffer.byteLength(
        initialUnknown + initialHistory + appendedUnknown
      ),
    });
  });

  it('emits large appended batches of unknown raw records in one pass', async () => {
    const initial = makeUserTextLine(
      'u-1',
      'start',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, initial);
    await tailRawTranscriptRecords(jsonlPath);

    const appended = Array.from({ length: 1100 }, (_, index) =>
      makeUnknownLine(
        'queue-operation',
        `q-${String(index)}`,
        `2026-02-16T20:${String(index % 60).padStart(2, '0')}:01.000Z`
      )
    ).join('');
    await appendFile(jsonlPath, appended);

    const result = await tailRawTranscriptRecords(jsonlPath);

    expect(result.records).toHaveLength(1100);
    expect(result.records[0]?.lineNumber).toBe(2);
    expect(result.records.at(-1)?.lineNumber).toBe(1101);
    expect(result.newByteOffset).toBe(Buffer.byteLength(initial + appended));
  });

  it('watches raw transcript records and stops after abort', async () => {
    await writeFile(
      jsonlPath,
      makeUserTextLine('u-1', 'first', '2026-02-16T20:00:00.000Z')
    );
    const controller = new AbortController();
    const iterator: AsyncGenerator<RawTranscriptTailResult, void, unknown> =
      watchRawTranscriptRecords(jsonlPath, {
        pollMs: 1,
        signal: controller.signal,
      });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    const firstRecords: readonly RawTranscriptRecord[] =
      expectYielded(first).records;
    expect(firstRecords.map(record => record.uuid)).toEqual(['u-1']);

    await appendFile(
      jsonlPath,
      makeUserTextLine('u-2', 'second', '2026-02-16T20:00:01.000Z')
    );
    const second = await iterator.next();
    expect(second.done).toBe(false);
    const secondRecords: readonly RawTranscriptRecord[] =
      expectYielded(second).records;
    expect(secondRecords.map(record => record.uuid)).toEqual(['u-2']);

    await appendFile(jsonlPath, makeNonObjectLine('skip me'));
    const third = await iterator.next();
    expect(third.done).toBe(false);
    const thirdResult = expectYielded(third);
    expect(thirdResult.records).toHaveLength(0);
    expect(thirdResult.invalidJsonLineCount).toBe(0);
    expect(thirdResult.invalidShapeLineCount).toBe(0);
    expect(thirdResult.skippedLineCount).toBe(1);

    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('watches exact raw transcript payloads only with explicit unsafe opt-in', async () => {
    const rawSecret = makeUserToolResultLine(
      'u-watch-secret',
      'tu-watch-raw',
      'OPENAI_API_KEY=sk-watch-secret-1234567890abcdefghijklmnop',
      '2026-02-16T20:00:00.000Z'
    );
    await writeFile(jsonlPath, rawSecret);

    const safeController = new AbortController();
    const safeIterator = watchRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      pollMs: 1,
      signal: safeController.signal,
    });
    const safeFirst = expectYielded(await safeIterator.next());
    safeController.abort();
    expect(safeFirst.records[0]?.rawLine).toBe(
      '[REDACTED:RAW_TRANSCRIPT_LINE]'
    );
    expect(JSON.stringify(safeFirst.records[0]?.payload)).toContain(
      '[REDACTED:RAW_TRANSCRIPT_VALUE]'
    );
    expect(JSON.stringify(safeFirst.records[0]?.payload)).not.toContain(
      'sk-watch-secret-1234567890abcdefghijklmnop'
    );
    await expect(safeIterator.next()).resolves.toMatchObject({ done: true });

    const unsafeController = new AbortController();
    const unsafeIterator = watchRawTranscriptRecords(jsonlPath, {
      dryRun: true,
      fromStart: true,
      pollMs: 1,
      signal: unsafeController.signal,
      rawRedactionMode: 'unsafe-unredacted',
    });
    const unsafeFirst = expectYielded(await unsafeIterator.next());
    unsafeController.abort();
    expect(unsafeFirst.records[0]?.rawLine).toContain(
      'OPENAI_API_KEY=sk-watch-secret-1234567890abcdefghijklmnop'
    );
    expect(JSON.stringify(unsafeFirst.records[0]?.payload)).toContain(
      'sk-watch-secret-1234567890abcdefghijklmnop'
    );
    await expect(unsafeIterator.next()).resolves.toMatchObject({ done: true });
  });

  it('reads raw main and subagent session files safely by default and still avoids advancing markers', async () => {
    const sessionId = 'session-raw';
    const projectDir = tmp;
    const mainPath = join(projectDir, `${sessionId}.jsonl`);
    const subagentDir = join(projectDir, sessionId, 'subagents');
    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      mainPath,
      makeUserToolResultLine(
        'u-main',
        'tu-main',
        'OPENAI_API_KEY=sk-main-secret-1234567890abcdefghijklmnop',
        '2026-02-16T20:00:00.000Z'
      )
    );
    await writeFile(
      join(subagentDir, 'agent-a.jsonl'),
      makeUserToolResultLine(
        'u-agent',
        'tu-agent',
        'Authorization: Bearer agent-secret-token',
        '2026-02-16T20:00:01.000Z'
      )
    );

    const session = await readRawSessionFiles(projectDir, sessionId);

    expect(session.records.map(record => record.sourceKind)).toEqual([
      'main',
      'subagent',
    ]);
    expect(session.records[1]).toMatchObject({
      sourceId: 'agent-a',
      id: 's1:agent-a:u-agent',
    });
    expect(session.records[0]?.rawLine).toBe('[REDACTED:RAW_TRANSCRIPT_LINE]');
    expect(JSON.stringify(session.records[0]?.payload)).toContain(
      '[REDACTED:RAW_TRANSCRIPT_VALUE]'
    );
    expect(JSON.stringify(session.records[0]?.payload)).not.toContain(
      'sk-main-secret-1234567890abcdefghijklmnop'
    );
    expect(await readMarker(getMarkerPath(mainPath))).toBeNull();
  });

  it('reads exact raw session payloads only with explicit unsafe opt-in', async () => {
    const sessionId = 'session-raw-unsafe';
    const projectDir = tmp;
    const mainPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(
      mainPath,
      makeUserToolResultLine(
        'u-main',
        'tu-main',
        'OPENAI_API_KEY=sk-main-secret-unsafe-1234567890abcdefghijklmnop',
        '2026-02-16T20:00:00.000Z'
      )
    );

    const session = await readRawSessionFiles(projectDir, sessionId, {
      rawRedactionMode: 'unsafe-unredacted',
    });

    expect(session.records).toHaveLength(1);
    expect(session.records[0]?.rawLine).toContain(
      'OPENAI_API_KEY=sk-main-secret-unsafe-1234567890abcdefghijklmnop'
    );
    expect(JSON.stringify(session.records[0]?.payload)).toContain(
      'sk-main-secret-unsafe-1234567890abcdefghijklmnop'
    );
    expect(await readMarker(getMarkerPath(mainPath))).toBeNull();
  });

  it('reads raw sessions when the subagent directory is absent', async () => {
    const sessionId = 'session-no-subagents';
    const mainPath = join(tmp, `${sessionId}.jsonl`);
    await writeFile(
      mainPath,
      makeUserTextLine('u-main', 'main', '2026-02-16T20:00:00.000Z')
    );

    const session = await readRawSessionFiles(tmp, sessionId);

    expect(session.records).toHaveLength(1);
    expect(session.records[0]).toMatchObject({
      sourceKind: 'main',
      uuid: 'u-main',
    });
  });

  it('surfaces subagent read errors instead of dropping data silently', async () => {
    const sessionId = 'session-bad-subagent';
    const mainPath = join(tmp, `${sessionId}.jsonl`);
    const subagentDir = join(tmp, sessionId, 'subagents');
    await mkdir(join(subagentDir, 'bad.jsonl'), { recursive: true });
    await writeFile(
      mainPath,
      makeUserTextLine('u-main', 'main', '2026-02-16T20:00:00.000Z')
    );

    await expect(readRawSessionFiles(tmp, sessionId)).rejects.toThrow();
  });

  it('matches extractBlocks for the same main-session input', async () => {
    const session =
      makeUserTextLine('u-1', 'hello', '2026-02-16T20:00:00.000Z') +
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'inspect the repo' },
            { type: 'text', text: 'Looking now.' },
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'Read',
              input: { file_path: '/repo/src/index.ts' },
            },
          ],
        },
        sessionId: 's1',
        timestamp: '2026-02-16T20:00:01.000Z',
        uuid: 'a-1',
      })}\n` +
      makeUserToolResultLine(
        'u-2',
        'tu-1',
        'export const x = 1;\n',
        '2026-02-16T20:00:02.000Z'
      );
    await writeFile(jsonlPath, session);

    const extracted = extractBlocks(parseSessionContent('s1', session));
    const tailed = await tailBlocks(jsonlPath, {
      dryRun: true,
      fromStart: true,
    });

    expect(tailed.blocks).toEqual(extracted);
  });

  it('output preserves chronological order even when appended out of order', async () => {
    // Real Claude Code only appends in time order, but defensively verify sort
    const earlier = makeUserTextLine(
      'u-1',
      'first',
      '2026-02-16T20:00:00.000Z'
    );
    const later = makeUserTextLine('u-2', 'second', '2026-02-16T20:00:05.000Z');
    await writeFile(jsonlPath, later + earlier);

    const result = await tailBlocks(jsonlPath);
    expect(result.blocks).toHaveLength(2);
    expect(must(result.blocks[0]).timestamp).toBe('2026-02-16T20:00:00.000Z');
    expect(must(result.blocks[1]).timestamp).toBe('2026-02-16T20:00:05.000Z');
  });

  it('end-to-end: simulates a live-ingest consumer incremental ingest pattern', async () => {
    await writeFile(
      jsonlPath,
      makeUserTextLine('u-1', 'analyze repo', '2026-02-16T20:00:00.000Z')
    );
    const round1 = await tailBlocks(jsonlPath);
    expect(round1.blocks).toHaveLength(1);

    await appendFile(
      jsonlPath,
      makeAssistantToolUseLine('a-1', 'tu-1', '2026-02-16T20:00:01.000Z')
    );
    const round2 = await tailBlocks(jsonlPath);
    expect(round2.blocks).toHaveLength(1);
    expect(must(round2.blocks[0]).type).toBe('tool_use');

    await appendFile(
      jsonlPath,
      makeUserToolResultLine(
        'u-2',
        'tu-1',
        'result',
        '2026-02-16T20:00:02.000Z'
      )
    );
    const round3 = await tailBlocks(jsonlPath);
    expect(round3.blocks).toHaveLength(1);
    const tr = must(round3.blocks[0]);
    if (tr.type === 'tool_result') {
      expect(tr.toolName).toBe('Bash');
    }

    const allIds = [...round1.blocks, ...round2.blocks, ...round3.blocks].map(
      b => b.id
    );
    expect(new Set(allIds).size).toBe(allIds.length);

    const finalSize = (await readFile(jsonlPath)).length;
    const marker = must(await readMarker(getMarkerPath(jsonlPath)));
    expect(marker.byteOffset).toBe(finalSize);
  });
});
