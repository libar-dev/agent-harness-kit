import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SENPI_ENTRY_TAGS,
  senpiSessionEntrySchema,
  type SenpiSessionEntry,
  type SenpiSessionHeader,
} from '../src/senpi/types.js';

const DOC_PATH = join(
  import.meta.dirname,
  '..',
  'docs',
  'upstream',
  'senpi',
  'session-format.md'
);

const JSON_FENCE_PATTERN = /```json\r?\n([\s\S]*?)```/g;

const ALL_KNOWN_TYPES = ['session', ...SENPI_ENTRY_TAGS] as const;

/**
 * One extractable wire sample. The documented format is JSONL, so each
 * non-empty line inside a ```json fence is an independent sample; this keeps
 * cleanly-parsing lines usable even when a sibling line in the same fence is
 * an ellipsis placeholder such as `"usage":{...}`.
 */
interface WireSample {
  readonly fenceIndex: number;
  readonly lineIndex: number;
  readonly body: string;
}

interface SampleOutcome {
  sample: WireSample;
  kind: 'parsed' | 'skipped';
  /** Why a skipped sample was not expected to parse (omitted when parsed). */
  readonly reason?: string;
  readonly entry?: SenpiSessionEntry;
}

interface SampleFailure {
  readonly sample: WireSample;
  readonly reason: string;
}

function extractWireSamples(source: string): WireSample[] {
  const samples: WireSample[] = [];
  JSON_FENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let fenceIndex = 0;
  while ((match = JSON_FENCE_PATTERN.exec(source)) !== null) {
    fenceIndex += 1;
    const body = match[1];
    if (body === undefined) {
      continue;
    }
    const lines = body.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]?.trim();
      if (line !== undefined && line !== '') {
        samples.push({ fenceIndex, lineIndex, body: line });
      }
    }
  }
  return samples;
}

/**
 * True when a schema rejection is exactly the documented abbreviation:
 * the doc's message JSON examples omit the required `message.timestamp`
 * field even though every message interface declares it required.
 */
function isAbbreviatedMessageSample(
  result: Extract<
    ReturnType<typeof senpiSessionEntrySchema.safeParse>,
    { success: false }
  >
): boolean {
  return (
    result.error.issues.length > 0 &&
    result.error.issues.every(
      issue =>
        issue.path.join('.') === 'message.timestamp' &&
        issue.message.includes('undefined')
    )
  );
}

function classifySamples(samples: readonly WireSample[]): {
  outcomes: SampleOutcome[];
  failures: SampleFailure[];
} {
  const outcomes: SampleOutcome[] = [];
  const failures: SampleFailure[] = [];

  for (const sample of samples) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(sample.body);
    } catch (error) {
      // Ellipsis placeholders such as `"usage":{...}` are intentionally
      // invalid documentation shorthand, not wire samples.
      if (sample.body.includes('...')) {
        outcomes.push({
          sample,
          kind: 'skipped',
          reason: 'ellipsis placeholder',
        });
        continue;
      }
      failures.push({
        sample,
        reason: `JSON.parse failed: ${String(error)}`,
      });
      continue;
    }

    const result = senpiSessionEntrySchema.safeParse(decoded);
    if (!result.success) {
      if (isAbbreviatedMessageSample(result)) {
        outcomes.push({
          sample,
          kind: 'skipped',
          reason: 'doc example omits required message.timestamp',
        });
        continue;
      }
      failures.push({
        sample,
        reason: `schema rejected: ${result.error.issues
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      });
      continue;
    }
    outcomes.push({ sample, kind: 'parsed', entry: result.data });
  }

  return { outcomes, failures };
}

const docSource = readFileSync(DOC_PATH, 'utf8');
const samples = extractWireSamples(docSource);
const { outcomes, failures } = classifySamples(samples);
const parsedOutcomes = outcomes.filter(outcome => outcome.kind === 'parsed');
const skippedOutcomes = outcomes.filter(outcome => outcome.kind === 'skipped');
const skippedUsagePlaceholders = skippedOutcomes.filter(outcome =>
  outcome.sample.body.includes('"usage":{...}')
);
const parsedTypes = new Set(
  parsedOutcomes.map(outcome => outcome.entry?.type).filter(Boolean)
);

describe('senpi session-format.md JSON fence samples', () => {
  it('attempts at least 10 wire samples so silent under-extraction fails', () => {
    expect(
      samples.length,
      `expected >=10 extracted samples, got ${samples.length}`
    ).toBeGreaterThanOrEqual(10);
  });

  it('parses at least 10 samples cleanly against the entry schemas', () => {
    expect(
      parsedOutcomes.length,
      `expected >=10 parsed samples, got ${parsedOutcomes.length} ` +
        `(attempted=${samples.length}, skipped=${skippedOutcomes.length}); ` +
        `failures: ${JSON.stringify(failures, null, 2)}`
    ).toBeGreaterThanOrEqual(10);
  });

  it('accounts for every attempted sample as parsed or explicitly skipped', () => {
    expect(parsedOutcomes.length + skippedOutcomes.length).toBe(samples.length);
    expect(failures).toEqual([]);
  });

  it('skips the two "usage":{...} ellipsis-placeholder lines', () => {
    expect(skippedUsagePlaceholders).toHaveLength(2);
    for (const outcome of skippedUsagePlaceholders) {
      expect(outcome.reason).toBe('ellipsis placeholder');
    }
  });

  it('skips the two message samples that abbreviate away message.timestamp', () => {
    const abbreviated = skippedOutcomes.filter(
      outcome => outcome.reason !== 'ellipsis placeholder'
    );
    expect(abbreviated).toHaveLength(2);
    for (const outcome of abbreviated) {
      expect(outcome.sample.body).toContain('"type":"message"');
      const messageObject = outcome.sample.body.slice(
        outcome.sample.body.indexOf('"message":')
      );
      expect(messageObject).not.toContain('"timestamp"');
    }
  });

  /*
   * Every non-message tag has a fully-specified doc sample; the doc's only
   * `message` samples abbreviate `message.timestamp` away, so the message
   * tag is exercised by restoring that required field below.
   */
  it('covers the session header and the other 8 known entry tags', () => {
    const docCoveredTypes = ALL_KNOWN_TYPES.filter(tag => tag !== 'message');
    for (const knownType of docCoveredTypes) {
      expect(
        parsedTypes.has(knownType),
        `no parsed sample exercised entry type "${knownType}"`
      ).toBe(true);
    }
  });

  it('covers the message tag once the abbreviated timestamp is restored', () => {
    const result = senpiSessionEntrySchema.safeParse({
      type: 'message',
      id: 'a1b2c3d4',
      parentId: 'prev1234',
      timestamp: '2024-12-03T14:00:01.000Z',
      message: {
        role: 'user',
        content: 'Hello',
        timestamp: 1733234401000,
      },
    });
    expect(result.success).toBe(true);
  });

  it('preserves unknown extra fields through a parse round-trip', () => {
    const header = parsedOutcomes
      .map(outcome => outcome.entry)
      .find((entry): entry is SenpiSessionHeader => entry?.type === 'session');
    if (header === undefined) {
      throw new Error('expected a parsed session header sample');
    }
    const headerWithExtra = { ...header, futureVendorField: { nested: true } };
    const headerResult = senpiSessionEntrySchema.safeParse(headerWithExtra);
    expect(headerResult.success).toBe(true);
    if (headerResult.success) {
      expect(headerResult.data).toMatchObject({
        futureVendorField: { nested: true },
      });
    }

    const messageResult = senpiSessionEntrySchema.safeParse({
      type: 'message',
      id: 'a1b2c3d4',
      parentId: 'prev1234',
      timestamp: '2024-12-03T14:00:01.000Z',
      message: {
        role: 'user',
        content: 'Hello',
        timestamp: 1733234401000,
      },
      newUpstreamKey: 42,
    });
    expect(messageResult.success).toBe(true);
    if (messageResult.success) {
      expect(messageResult.data).toMatchObject({ newUpstreamKey: 42 });
    }
  });
});

describe('senpi schema malformed-input handling', () => {
  it('rejects a compaction entry missing required summary via safeParse, never throwing', () => {
    const missingSummary = {
      type: 'compaction',
      id: 'f6g7h8i9',
      parentId: 'e5f6g7h8',
      timestamp: '2024-12-03T14:10:00.000Z',
      tokensBefore: 50000,
    };

    let result:
      | ReturnType<typeof senpiSessionEntrySchema.safeParse>
      | undefined;
    expect(() => {
      result = senpiSessionEntrySchema.safeParse(missingSummary);
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      const summaryIssue = result.error.issues.find(issue =>
        issue.path.includes('summary')
      );
      expect(summaryIssue).toBeDefined();
    }
  });

  it('returns an invalid result (never throws) for hostile non-object inputs', () => {
    const hostileInputs: readonly unknown[] = [
      null,
      undefined,
      [],
      ['message'],
      'message',
      42,
      true,
      {},
    ];

    for (const input of hostileInputs) {
      let result:
        | ReturnType<typeof senpiSessionEntrySchema.safeParse>
        | undefined;
      expect(
        () => {
          result = senpiSessionEntrySchema.safeParse(input);
        },
        `safeParse threw for input ${String(input)}`
      ).not.toThrow();
      expect(result?.success, `expected rejection for ${String(input)}`).toBe(
        false
      );
    }
  });
});
