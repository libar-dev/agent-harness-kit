import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import { afterAll, beforeAll, bench, describe } from 'vitest';

import { tailBlocks } from '../src/processing/index.js';

const TARGET_FIXTURE_BYTES = 10 * 1024 * 1024;
const INITIAL_FIXTURE_RATIO = 0.8;
const REPEATED_TAIL_PASSES = 8;
const FIXTURE_ROOT_PREFIX = 'tail-bench-';
const PASS_BUDGET_MIN_MS = 20;
const PASS_BUDGET_MAX_MS = 50;

interface BenchmarkFixture {
  readonly initialContent: string;
  readonly appendChunks: readonly string[];
  readonly totalBytes: number;
  readonly recordPairs: number;
}

interface BenchmarkBudgetReport {
  readonly fixtureName: string;
  readonly fixtureBytes: number;
  readonly recordPairs: number;
  readonly passesPerSample: number;
  readonly sampleCount: number;
  readonly meanTotalMs: number;
  readonly medianTotalMs: number;
  readonly meanPerPassMs: number;
  readonly medianPerPassMs: number;
  readonly budgetCheck: 'PASS' | 'OUTSIDE_TARGET';
}

let benchmarkRoot = '';
let safeFixture: BenchmarkFixture;
let redactedFixture: BenchmarkFixture;
const safeSampleDurationsMs: number[] = [];
const redactedSampleDurationsMs: number[] = [];

function mustString(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`missing benchmark fixture segment: ${label}`);
  }
  return value;
}

function mustNumber(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`missing benchmark fixture number: ${label}`);
  }
  return value;
}

function benchmarkTimestamp(index: number): string {
  const baseMs = Date.parse('2026-02-16T20:00:00.000Z');
  return new Date(baseMs + index * 1000).toISOString();
}

function benchmarkMean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function benchmarkMedian(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const middleValue = mustNumber(sorted[midpoint], 'median');

  if (sorted.length % 2 === 1) {
    return middleValue;
  }

  return (mustNumber(sorted[midpoint - 1], 'median-left') + middleValue) / 2;
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

function buildBudgetReport(
  fixtureName: string,
  fixture: BenchmarkFixture,
  sampleDurationsMs: readonly number[]
): BenchmarkBudgetReport {
  if (sampleDurationsMs.length === 0) {
    throw new Error(`benchmark did not record any samples for ${fixtureName}`);
  }

  const passesPerSample = fixture.appendChunks.length + 1;
  const meanTotalMs = benchmarkMean(sampleDurationsMs);
  const medianTotalMs = benchmarkMedian(sampleDurationsMs);
  const meanPerPassMs = meanTotalMs / passesPerSample;
  const medianPerPassMs = medianTotalMs / passesPerSample;
  const budgetCheck =
    meanPerPassMs >= PASS_BUDGET_MIN_MS && meanPerPassMs <= PASS_BUDGET_MAX_MS
      ? 'PASS'
      : 'OUTSIDE_TARGET';

  return {
    fixtureName,
    fixtureBytes: fixture.totalBytes,
    recordPairs: fixture.recordPairs,
    passesPerSample,
    sampleCount: sampleDurationsMs.length,
    meanTotalMs,
    medianTotalMs,
    meanPerPassMs,
    medianPerPassMs,
    budgetCheck,
  };
}

function emitBudgetReport(report: BenchmarkBudgetReport): void {
  console.info(
    `[tail-bench-budget] case=${report.fixtureName} fixtureBytes=${String(
      report.fixtureBytes
    )} recordPairs=${String(report.recordPairs)} passesPerSample=${String(
      report.passesPerSample
    )} samples=${String(report.sampleCount)} meanTotalMs=${formatMs(
      report.meanTotalMs
    )} medianTotalMs=${formatMs(report.medianTotalMs)} meanPerPassMs=${formatMs(
      report.meanPerPassMs
    )} medianPerPassMs=${formatMs(
      report.medianPerPassMs
    )} targetPerPassMs=${String(PASS_BUDGET_MIN_MS)}-${String(
      PASS_BUDGET_MAX_MS
    )} budgetCheck=${report.budgetCheck}`
  );
}

function makeAssistantToolUseLine(index: number): string {
  const pad = String(index).padStart(6, '0');
  return `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tu-${pad}`,
          name: 'Bash',
          input: { command: `printf '${pad}'` },
        },
      ],
    },
    sessionId: 'bench-session',
    timestamp: benchmarkTimestamp(index * 2),
    uuid: `a-${pad}`,
  })}\n`;
}

function makeToolResultPayload(index: number, redacted: boolean): string {
  const pad = String(index).padStart(6, '0');
  const filler = `${redacted ? 'redacted' : 'safe'}-payload-${pad}-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 `;
  const repeatedBody = filler.repeat(48);

  if (redacted) {
    // Deliberately fake credential-shaped strings that exercise redaction
    // without looking like real production secrets.
    return [
      `Authorization: Bearer benchmark-redaction-fixture-${pad}-not-real`,
      `OPENAI_API_KEY=sk-benchmark-redaction-fixture-${pad}-not-real`,
      `api_key=benchmark-redaction-fixture-${pad}-not-real`,
      `safe_line_${pad}`,
      repeatedBody,
    ].join('\n');
  }

  return [
    `command_status=ok-${pad}`,
    `stdout_path=/tmp/output-${pad}.txt`,
    `safe_line_${pad}`,
    repeatedBody,
  ].join('\n');
}

function makeUserToolResultLine(index: number, redacted: boolean): string {
  const pad = String(index).padStart(6, '0');
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tu-${pad}`,
          content: makeToolResultPayload(index, redacted),
        },
      ],
    },
    sessionId: 'bench-session',
    timestamp: benchmarkTimestamp(index * 2 + 1),
    uuid: `u-${pad}`,
  })}\n`;
}

function createBenchmarkFixture(redacted: boolean): BenchmarkFixture {
  const initialThreshold = Math.floor(
    TARGET_FIXTURE_BYTES * INITIAL_FIXTURE_RATIO
  );
  const appendThresholdStep = Math.floor(
    (TARGET_FIXTURE_BYTES - initialThreshold) / REPEATED_TAIL_PASSES
  );
  const segmentThresholds = [initialThreshold];

  for (let index = 1; index <= REPEATED_TAIL_PASSES; index += 1) {
    segmentThresholds.push(initialThreshold + appendThresholdStep * index);
  }
  segmentThresholds[segmentThresholds.length - 1] = TARGET_FIXTURE_BYTES;

  const segments = Array.from(
    { length: REPEATED_TAIL_PASSES + 1 },
    (): string => ''
  );

  let totalBytes = 0;
  let recordPairs = 0;
  let segmentIndex = 0;

  while (totalBytes < TARGET_FIXTURE_BYTES) {
    const pair =
      makeAssistantToolUseLine(recordPairs) +
      makeUserToolResultLine(recordPairs, redacted);
    const pairBytes = Buffer.byteLength(pair);
    segments[segmentIndex] += pair;
    totalBytes += pairBytes;
    recordPairs += 1;

    while (
      segmentIndex < segments.length - 1 &&
      totalBytes >= mustNumber(segmentThresholds[segmentIndex], 'threshold')
    ) {
      segmentIndex += 1;
    }
  }

  const initialContent = mustString(segments[0], 'initial');
  const appendChunks = segments
    .slice(1)
    .map((chunk, index) => mustString(chunk, `append-${String(index)}`));

  if (
    Buffer.byteLength(initialContent) === 0 ||
    appendChunks.some(chunk => Buffer.byteLength(chunk) === 0)
  ) {
    throw new Error('benchmark fixture generation produced an empty segment');
  }

  return {
    initialContent,
    appendChunks,
    totalBytes,
    recordPairs,
  };
}

async function runTailBenchmark(
  fixtureName: string,
  fixture: BenchmarkFixture
): Promise<number> {
  const runRoot = join(benchmarkRoot, fixtureName);
  const jsonlPath = join(runRoot, 'session.jsonl');
  let totalBlocks = 0;

  try {
    await rm(runRoot, { recursive: true, force: true });
    await mkdir(runRoot, { recursive: true });
    await writeFile(jsonlPath, fixture.initialContent);
    totalBlocks += (await tailBlocks(jsonlPath)).blocks.length;

    for (const chunk of fixture.appendChunks) {
      await appendFile(jsonlPath, chunk);
      totalBlocks += (await tailBlocks(jsonlPath)).blocks.length;
    }

    if (totalBlocks <= 0) {
      throw new Error('tailBlocks benchmark emitted no blocks');
    }

    return totalBlocks;
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  benchmarkRoot = await mkdtemp(join(tmpdir(), FIXTURE_ROOT_PREFIX));
  safeFixture = createBenchmarkFixture(false);
  redactedFixture = createBenchmarkFixture(true);

  if (safeFixture.totalBytes < TARGET_FIXTURE_BYTES) {
    throw new Error('safe benchmark fixture is smaller than the target size');
  }
  if (redactedFixture.totalBytes < TARGET_FIXTURE_BYTES) {
    throw new Error(
      'redacted benchmark fixture is smaller than the target size'
    );
  }
});

afterAll(async () => {
  emitBudgetReport(
    buildBudgetReport('safe', safeFixture, safeSampleDurationsMs)
  );
  emitBudgetReport(
    buildBudgetReport('redacted', redactedFixture, redactedSampleDurationsMs)
  );

  if (benchmarkRoot.length > 0) {
    await rm(benchmarkRoot, { recursive: true, force: true });
  }
});

describe('tailBlocks benchmark', () => {
  bench('tailBlocks repeated tail passes on ~10 MB safe fixture', async () => {
    const startedAt = performance.now();
    const totalBlocks = await runTailBenchmark('safe-run', safeFixture);
    safeSampleDurationsMs.push(performance.now() - startedAt);

    if (totalBlocks !== safeFixture.recordPairs * 2) {
      throw new Error('safe benchmark did not emit the expected block volume');
    }
  });

  bench(
    'tailBlocks repeated tail passes on ~10 MB redacted tool_result fixture',
    async () => {
      const startedAt = performance.now();
      const totalBlocks = await runTailBenchmark(
        'redacted-run',
        redactedFixture
      );
      redactedSampleDurationsMs.push(performance.now() - startedAt);

      if (totalBlocks !== redactedFixture.recordPairs * 2) {
        throw new Error(
          'redacted benchmark did not emit the expected block volume'
        );
      }
    }
  );
});
