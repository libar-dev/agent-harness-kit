import { describe, expect, it } from 'vitest';

import {
  parseSenpiEntry,
  type SenpiEntryParseResult,
} from '../src/senpi/processing/parse.js';
import { SENPI_ENTRY_TAGS } from '../src/senpi/types.js';

const ISO = '2024-12-03T14:00:00.000Z';

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const knownSamples: ReadonlyArray<{
  readonly name: string;
  readonly raw: unknown;
  readonly expectedType: string;
}> = [
  {
    name: 'known:session',
    expectedType: 'session',
    raw: {
      type: 'session',
      version: 3,
      id: 'uuid',
      timestamp: ISO,
      cwd: '/path/to/project',
    },
  },
  {
    name: 'known:message',
    expectedType: 'message',
    raw: {
      type: 'message',
      id: 'a1b2c3d4',
      parentId: 'prev1234',
      timestamp: '2024-12-03T14:00:01.000Z',
      message: {
        role: 'user',
        content: 'Hello',
        timestamp: 1733234401000,
      },
    },
  },
  {
    name: 'known:model_change',
    expectedType: 'model_change',
    raw: {
      type: 'model_change',
      id: 'd4e5f6g7',
      parentId: 'c3d4e5f6',
      timestamp: '2024-12-03T14:05:00.000Z',
      provider: 'openai',
      modelId: 'gpt-4o',
    },
  },
  {
    name: 'known:thinking_level_change',
    expectedType: 'thinking_level_change',
    raw: {
      type: 'thinking_level_change',
      id: 'e5f6g7h8',
      parentId: 'd4e5f6g7',
      timestamp: '2024-12-03T14:06:00.000Z',
      thinkingLevel: 'high',
    },
  },
  {
    name: 'known:compaction',
    expectedType: 'compaction',
    raw: {
      type: 'compaction',
      id: 'f6g7h8i9',
      parentId: 'e5f6g7h8',
      timestamp: '2024-12-03T14:10:00.000Z',
      summary: 'User discussed X, Y, Z...',
      tokensBefore: 50000,
      firstKeptEntryId: 'c3d4e5f6',
    },
  },
  {
    name: 'known:branch_summary',
    expectedType: 'branch_summary',
    raw: {
      type: 'branch_summary',
      id: 'g7h8i9j0',
      parentId: 'a1b2c3d4',
      timestamp: '2024-12-03T14:15:00.000Z',
      fromId: 'f6g7h8i9',
      summary: 'Branch explored approach A...',
    },
  },
  {
    name: 'known:custom',
    expectedType: 'custom',
    raw: {
      type: 'custom',
      id: 'h8i9j0k1',
      parentId: 'g7h8i9j0',
      timestamp: '2024-12-03T14:20:00.000Z',
      customType: 'my-extension',
      data: { count: 42 },
    },
  },
  {
    name: 'known:custom_message',
    expectedType: 'custom_message',
    raw: {
      type: 'custom_message',
      id: 'i9j0k1l2',
      parentId: 'h8i9j0k1',
      timestamp: '2024-12-03T14:25:00.000Z',
      customType: 'my-extension',
      content: 'Injected context...',
      display: true,
    },
  },
  {
    name: 'known:label',
    expectedType: 'label',
    raw: {
      type: 'label',
      id: 'j0k1l2m3',
      parentId: 'i9j0k1l2',
      timestamp: '2024-12-03T14:30:00.000Z',
      targetId: 'a1b2c3d4',
      label: 'checkpoint-1',
    },
  },
  {
    name: 'known:session_info',
    expectedType: 'session_info',
    raw: {
      type: 'session_info',
      id: 'k1l2m3n4',
      parentId: 'j0k1l2m3',
      timestamp: '2024-12-03T14:35:00.000Z',
      name: 'Refactor auth module',
    },
  },
];

const unknownJoinsTree = {
  type: 'future_entry',
  id: 'u1n2k3n4',
  parentId: 'a1b2c3d4',
  timestamp: '2024-12-03T14:40:00.000Z',
  payload: { next: true },
};

const malformedCompaction = {
  type: 'compaction',
  id: 'f6g7h8i9',
  parentId: 'e5f6g7h8',
  timestamp: '2024-12-03T14:10:00.000Z',
  tokensBefore: 50000,
};

const invalidSamples: ReadonlyArray<{
  readonly name: string;
  readonly raw: unknown;
  readonly errorIncludes: string;
}> = [
  {
    name: 'invalid:malformed-compaction-missing-summary',
    raw: malformedCompaction,
    errorIncludes: 'summary',
  },
  {
    name: 'invalid:malformed-message-missing-message',
    raw: {
      type: 'message',
      id: 'a1b2c3d4',
      parentId: null,
      timestamp: ISO,
    },
    errorIncludes: 'message',
  },
  {
    name: 'invalid:unknown-tag-missing-parentId',
    raw: {
      type: 'future_entry',
      id: 'u1n2k3n4',
      timestamp: ISO,
    },
    errorIncludes: 'parentId',
  },
  {
    name: 'invalid:unknown-tag-missing-id',
    raw: {
      type: 'future_entry',
      parentId: null,
      timestamp: ISO,
    },
    errorIncludes: 'id',
  },
  {
    name: 'invalid:missing-type',
    raw: { id: 'x', parentId: null, timestamp: ISO },
    errorIncludes: 'type',
  },
];

const hostileInputs: ReadonlyArray<{
  readonly name: string;
  readonly raw: unknown;
}> = [
  { name: 'hostile:null', raw: null },
  { name: 'hostile:undefined', raw: undefined },
  { name: 'hostile:array-empty', raw: [] },
  { name: 'hostile:array-tagged', raw: ['message'] },
  { name: 'hostile:string', raw: 'message' },
  { name: 'hostile:number', raw: 42 },
  { name: 'hostile:boolean', raw: true },
  { name: 'hostile:empty-object', raw: {} },
  { name: 'hostile:type-not-string', raw: { type: 123 } },
  {
    name: 'hostile:deep-garbage',
    raw: {
      type: { nested: ['x', { y: null, z: [1, 2, { w: false }] }] },
      id: { not: 'a-string' },
      extra: { a: [{ b: { c: 'd' } }] },
    },
  },
];

function parseSafely(raw: unknown): SenpiEntryParseResult | undefined {
  let result: SenpiEntryParseResult | undefined;
  expect(() => {
    result = parseSenpiEntry(raw);
  }).not.toThrow();
  return result;
}

describe('parseSenpiEntry truth table', () => {
  it('covers the session header plus every known non-header tag', () => {
    const covered = new Set(knownSamples.map(sample => sample.expectedType));
    expect(covered.has('session')).toBe(true);
    for (const tag of SENPI_ENTRY_TAGS) {
      expect(covered.has(tag), `missing known sample for ${tag}`).toBe(true);
    }
  });

  it.each(knownSamples)('$name', ({ raw, expectedType }) => {
    const result = parseSafely(raw);
    expect(result?.kind).toBe('known');
    if (result?.kind === 'known') {
      expect(result.entry.type).toBe(expectedType);
    }
  });

  it('unknown:future_entry-valid-base joins the tree with parsed entry', () => {
    const result = parseSafely(unknownJoinsTree);
    expect(result?.kind).toBe('unknown');
    if (result?.kind === 'unknown') {
      expect(result.tag).toBe('future_entry');
      expect(result.raw).toBe(unknownJoinsTree);
      expect(result.entry.type).toBe('future_entry');
      expect(result.entry.id).toBe('u1n2k3n4');
      expect(result.entry.parentId).toBe('a1b2c3d4');
      expect(result.entry.timestamp).toBe('2024-12-03T14:40:00.000Z');
      expect(result.entry).toMatchObject({ payload: { next: true } });
    }
  });

  it.each(invalidSamples)('$name', ({ raw, errorIncludes }) => {
    const result = parseSafely(raw);
    expect(result?.kind).toBe('invalid');
    if (result?.kind === 'invalid') {
      expect(result.error).toContain(errorIncludes);
      expect(result.raw).toBe(raw);
    }
  });

  it('known:compaction is not downgraded when summary is missing', () => {
    const result = parseSafely(malformedCompaction);
    expect(result?.kind).toBe('invalid');
    if (result?.kind === 'invalid') {
      expect(result.error).toContain('summary');
    }
  });

  it('known:message-assistant preserves extra fields', () => {
    const raw = {
      type: 'message',
      id: 'b2c3d4e5',
      parentId: 'a1b2c3d4',
      timestamp: '2024-12-03T14:00:02.000Z',
      futureVendorField: 7,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi!' }],
        api: 'anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage,
        stopReason: 'stop',
        timestamp: 1733234402000,
      },
    };
    const result = parseSafely(raw);
    expect(result?.kind).toBe('known');
    if (result?.kind === 'known') {
      expect(result.entry).toMatchObject({ futureVendorField: 7 });
    }
  });
});

describe('parseSenpiEntry hostile inputs never throw', () => {
  it.each(hostileInputs)('$name', ({ raw }) => {
    const result = parseSafely(raw);
    expect(result?.kind).toBe('invalid');
    if (result?.kind === 'invalid') {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.raw).toBe(raw);
    }
  });
});
