import { describe, expect, it } from 'vitest';

import {
  SENPI_GRAPH_MAX_BYTES,
  SENPI_GRAPH_MAX_ENTRIES,
  SENPI_KEYS_MAX_BYTES,
  SENPI_KEYS_MAX_ENTRIES,
  SENPI_MARKER_MAX_BYTES,
  boundProjectedRecordKeys,
  encodeAcceptedEntries,
  fitAutomaticExtras,
  graphLeafMember,
  isPureAppendDelta,
  parseAcceptedEntries,
  parseProjectedRecordCount,
  parseProjectedRecordKeys,
  utf8JsonSize,
} from '../src/senpi/processing/accepted-graph.js';
import { parseSenpiEntry } from '../src/senpi/processing/parse.js';

function message(
  id: string,
  parentId: string | null
): ReturnType<typeof parseSenpiEntry> {
  return parseSenpiEntry({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: id }],
      timestamp: 1,
    },
  });
}

function compaction(
  id: string,
  parentId: string | null
): ReturnType<typeof parseSenpiEntry> {
  return parseSenpiEntry({
    type: 'compaction',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: 'compacted',
    tokensBefore: 1,
    retainedTail: [],
  });
}

describe('accepted graph validation (mutation probes)', () => {
  it('treats invalid and oversize graphs as absent-state (skip-validation probe)', () => {
    expect(parseAcceptedEntries('nope')).toEqual({ kind: 'absent' });
    expect(parseAcceptedEntries([{ id: '', p: null }])).toEqual({
      kind: 'absent',
    });
    expect(
      parseAcceptedEntries([
        { id: 'a', p: null },
        { id: 'a', p: null },
      ])
    ).toEqual({ kind: 'absent' });
    expect(parseAcceptedEntries([{ id: 'child', p: 'missing' }])).toEqual({
      kind: 'absent',
    });
    expect(
      parseAcceptedEntries([
        { id: 'a', p: null },
        { id: 'b', p: 'later' },
        { id: 'later', p: 'a' },
      ])
    ).toEqual({ kind: 'absent' });
    const tooMany = Array.from(
      { length: SENPI_GRAPH_MAX_ENTRIES + 1 },
      (_, i) => ({
        id: `n${String(i)}`,
        p: i === 0 ? null : `n${String(i - 1)}`,
      })
    );
    expect(parseAcceptedEntries(tooMany)).toEqual({ kind: 'absent' });
    const huge = [{ id: 'x'.repeat(SENPI_GRAPH_MAX_BYTES), p: null }];
    expect(utf8JsonSize(huge)).toBeGreaterThan(SENPI_GRAPH_MAX_BYTES);
    expect(parseAcceptedEntries(huge)).toEqual({ kind: 'absent' });
  });

  it('accepts parentId or compact p and a compaction tag', () => {
    const parsed = parseAcceptedEntries([
      { id: 'root', parentId: null },
      { id: 'child', p: 'root', c: 1 },
    ]);
    expect(parsed).toEqual({
      kind: 'present',
      entries: [
        { id: 'root', p: null },
        { id: 'child', p: 'root', c: 1 },
      ],
    });
    expect(graphLeafMember(parsed, 'child')).toBe(true);
    expect(graphLeafMember(parsed, 'missing')).toBe(false);
  });

  it('omits over-cap graph and keys atomically (remove-caps probe)', () => {
    const overGraph = Array.from(
      { length: SENPI_GRAPH_MAX_ENTRIES + 1 },
      (_, i) => ({
        id: `g${String(i)}`,
        p: i === 0 ? null : `g${String(i - 1)}`,
      })
    );
    expect(encodeAcceptedEntries(overGraph)).toBeNull();
    const overKeys = Array.from(
      { length: SENPI_KEYS_MAX_ENTRIES + 1 },
      (_, i) => `k${String(i)}`
    );
    expect(boundProjectedRecordKeys(overKeys)).toEqual({
      keys: [],
      overflow: true,
    });
    const extras = fitAutomaticExtras(overKeys, overGraph, overKeys.length);
    expect(extras.acceptedEntries).toBeUndefined();
    expect(extras.projectedRecordKeys).toEqual([]);
    expect(extras.projectedRecordCount).toBe(overKeys.length);
    expect(utf8JsonSize(overKeys)).toBeGreaterThan(0);
    expect(SENPI_KEYS_MAX_BYTES).toBe(256 * 1024);
    expect(SENPI_MARKER_MAX_BYTES).toBe(1024 * 1024);
  });

  it('forces rebuild on branch, compaction, duplicate, and missing parent', () => {
    const graph = [
      { id: 'a', p: null },
      { id: 'b', p: 'a' },
    ];
    expect(isPureAppendDelta(graph, 'b', [message('c', 'b')])).toBe(true);
    expect(isPureAppendDelta(graph, 'b', [message('c', 'a')])).toBe(false);
    expect(isPureAppendDelta(graph, 'b', [compaction('z', 'b')])).toBe(false);
    expect(isPureAppendDelta(graph, 'b', [message('a', 'b')])).toBe(false);
    expect(isPureAppendDelta(graph, 'b', [message('c', 'missing')])).toBe(
      false
    );
  });

  it('keeps overflow keys as [] and exact count', () => {
    const keys = Array.from(
      { length: 8 },
      (_, i) => 'k'.repeat(40_000) + String(i)
    );
    expect(utf8JsonSize(keys)).toBeGreaterThan(SENPI_KEYS_MAX_BYTES);
    const parsed = parseProjectedRecordKeys(keys);
    expect(parsed).toEqual({ keys: [], overflow: true });
    expect(parseProjectedRecordCount(8)).toBe(8);
    expect(parseProjectedRecordCount(1.5)).toBeUndefined();
  });
});
