import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  computeProjectionMutation,
  projectSenpiBranch,
  resolveSenpiLeaf,
  type SenpiProjectionInput,
  type SenpiProjectionRecord,
} from '../src/senpi/processing/projection.js';
import { parseSenpiEntry } from '../src/senpi/processing/parse.js';

const ISO = '2026-02-01T00:00:00.000Z';
const FIXTURES = fileURLToPath(new URL('./fixtures/senpi/', import.meta.url));

async function fixture(name: string): Promise<readonly SenpiProjectionInput[]> {
  const text = await readFile(`${FIXTURES}${name}`, 'utf8');
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const raw: unknown = JSON.parse(line);
      return parseSenpiEntry(raw);
    });
}

function parsed(raw: unknown): SenpiProjectionInput {
  return parseSenpiEntry(raw);
}

function custom(
  id: string,
  parentId: string | null,
  timestamp = ISO
): SenpiProjectionInput {
  return parsed({
    type: 'custom',
    id,
    parentId,
    timestamp,
    customType: 'projection-test',
  });
}

function compaction(
  id: string,
  parentId: string | null,
  extra: Readonly<Record<string, unknown>> = {}
): SenpiProjectionInput {
  return parsed({
    type: 'compaction',
    id,
    parentId,
    timestamp: ISO,
    summary: `summary-${id}`,
    tokensBefore: 100,
    ...extra,
  });
}

function keys(records: readonly SenpiProjectionRecord[]): readonly string[] {
  return records.map(record => record.key);
}

function warningCodes(
  result: ReturnType<typeof projectSenpiBranch>
): readonly string[] {
  return result.warnings.map(warning => warning.code);
}

describe('Senpi tree indexing and leaf resolution', () => {
  it('1: empty input has an empty, complete projection', () => {
    const result = projectSenpiBranch([], null);
    expect(result).toMatchObject({
      kind: 'empty',
      leafId: null,
      complete: true,
    });
    expect(result.records).toEqual([]);
  });

  it('2: a header-only fixture does not become a tree leaf', async () => {
    const entries = await fixture('synthetic-header-only.jsonl');
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved).toMatchObject({ kind: 'empty', leafId: null });
    expect(resolved.index.appendOrder).toEqual([]);
  });

  it('3: golden branch-switch history follows the expected persisted leaf path', async () => {
    const entries = await fixture('synthetic-branch-switch.jsonl');
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved.kind).toBe('resolved');
    const result = projectSenpiBranch(entries, resolved.leafId);
    expect(
      result.records.map(record => ({
        key: record.key,
        origin: record.origin,
        type:
          record.origin === 'entry' ? record.entry.type : record.message.role,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "key": "a1000001",
          "origin": "entry",
          "type": "message",
        },
        {
          "key": "a1000002",
          "origin": "entry",
          "type": "message",
        },
        {
          "key": "a1000005",
          "origin": "entry",
          "type": "branch_summary",
        },
        {
          "key": "a1000006",
          "origin": "entry",
          "type": "message",
        },
        {
          "key": "a1000007",
          "origin": "entry",
          "type": "label",
        },
      ]
    `);
  });

  it('4: an explicit older branch leaf projects that branch', async () => {
    const entries = await fixture('synthetic-branch-switch.jsonl');
    const result = projectSenpiBranch(entries, 'a1000003');
    expect(keys(result.records)).toEqual(['a1000001', 'a1000002', 'a1000003']);
  });

  it('5: accepted entries on alternate branches are off_branch', async () => {
    const entries = await fixture('synthetic-branch-switch.jsonl');
    const result = projectSenpiBranch(entries, 'a1000007');
    expect(
      result.offPath.map(record => [record.key, record.disposition])
    ).toEqual([
      ['a1000003', 'off_branch'],
      ['a1000004', 'off_branch'],
    ]);
  });

  it('6: physical order, not timestamp order, selects the leaf', () => {
    const entries = [
      custom('time-root', null, '2099-01-01T00:00:00.000Z'),
      custom('time-last', 'time-root', '2000-01-01T00:00:00.000Z'),
    ];
    expect(resolveSenpiLeaf(entries)).toMatchObject({
      kind: 'resolved',
      leafId: 'time-last',
    });
  });

  it('7: duplicate ids never overwrite and make the graph invalid', async () => {
    const entries = await fixture('synthetic-duplicate-id.jsonl');
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved.kind).toBe('invalid');
    expect(resolved.index.byId.get('d1000001')).toMatchObject({
      parentId: null,
      message: { content: [{ text: 'first occurrence' }] },
    });
    expect(resolved.warnings.map(warning => warning.code)).toContain(
      'duplicate_id'
    );
  });

  it('8: an orphan is rejected while a later child of an indexed parent is accepted', async () => {
    const entries = await fixture('synthetic-orphan-parent.jsonl');
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved).toMatchObject({ kind: 'resolved', leafId: 'e1000003' });
    expect(resolved.index.appendOrder).toEqual(['e1000001', 'e1000003']);
    expect(resolved.warnings.map(warning => warning.code)).toContain(
      'missing_parent'
    );
  });

  it('9: multiple roots are permitted and the final accepted root tree wins', async () => {
    const entries = await fixture('synthetic-multi-root.jsonl');
    const result = projectSenpiBranch(entries, 'f1000004');
    expect(keys(result.records)).toEqual(['f1000003', 'f1000004']);
    expect(result.kind).toBe('projected');
  });

  it('10: structuralLeaves report every accepted childless entry', async () => {
    const entries = await fixture('synthetic-multi-root.jsonl');
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved.index.structuralLeaves).toEqual(['f1000002', 'f1000004']);
  });

  it('11: metadata entries advance the physical leaf', async () => {
    const entries = await fixture('synthetic-unicode-cwd.jsonl');
    expect(resolveSenpiLeaf(entries)).toMatchObject({ leafId: 'h1000003' });
  });

  it('12: unicode ids, names, and labels survive indexing byte-for-byte', () => {
    const entries = [
      custom('根-🌿', null),
      parsed({
        type: 'session_info',
        id: '名前',
        parentId: '根-🌿',
        timestamp: ISO,
        name: '会話 café',
      }),
      parsed({
        type: 'label',
        id: '标签',
        parentId: '名前',
        timestamp: ISO,
        targetId: '根-🌿',
        label: 'αβγ',
      }),
    ];
    const resolved = resolveSenpiLeaf(entries);
    expect(resolved.index.sessionName).toBe('会話 café');
    expect(resolved.index.labelsByTargetId.get('根-🌿')).toBe('αβγ');
    expect(resolved.index.appendOrder).toEqual(['根-🌿', '名前', '标签']);
  });

  it('13: an unknown valid-base tag joins the tree and can become leaf', () => {
    const entries = [
      custom('known-root', null),
      parsed({
        type: 'future_type',
        id: 'future-leaf',
        parentId: 'known-root',
        timestamp: ISO,
        payload: true,
      }),
    ];
    expect(resolveSenpiLeaf(entries)).toMatchObject({ leafId: 'future-leaf' });
    expect(keys(projectSenpiBranch(entries, 'future-leaf').records)).toEqual([
      'known-root',
      'future-leaf',
    ]);
  });

  it('14: a missing explicit leaf is invalid rather than silently falling back', () => {
    const result = projectSenpiBranch([custom('root', null)], 'absent');
    expect(result.kind).toBe('invalid');
    expect(warningCodes(result)).toContain('missing_leaf');
  });

  it('15: dangling label and branch-summary references are diagnosed', () => {
    const entries = [
      custom('root', null),
      parsed({
        type: 'branch_summary',
        id: 'branch-summary',
        parentId: 'root',
        timestamp: ISO,
        fromId: 'missing-branch',
        summary: 'summary',
      }),
      parsed({
        type: 'label',
        id: 'label',
        parentId: 'branch-summary',
        timestamp: ISO,
        targetId: 'missing-target',
        label: 'dangling',
      }),
    ];
    const result = projectSenpiBranch(entries, 'label');
    expect(warningCodes(result)).toEqual([
      'dangling_branch_reference',
      'dangling_label_reference',
    ]);
  });
});

describe('Senpi compaction projection', () => {
  it('16: retainedTail materializes synthetic stable keys after the compaction', async () => {
    const entries = await fixture('synthetic-retained-tail-compaction.jsonl');
    const result = projectSenpiBranch(entries, 'b1000006');
    expect(keys(result.records)).toEqual([
      'b1000005',
      'retained:b1000005:0',
      'retained:b1000005:1',
      'b1000006',
    ]);
  });

  it('17: retainedTail:[] is authoritative even when firstKeptEntryId exists', () => {
    const entries = [
      custom('old', null),
      compaction('compact', 'old', {
        retainedTail: [],
        firstKeptEntryId: 'old',
      }),
      custom('post', 'compact'),
    ];
    const result = projectSenpiBranch(entries, 'post');
    expect(keys(result.records)).toEqual(['compact', 'post']);
    expect(warningCodes(result)).not.toContain('missing_first_kept');
  });

  it('18: retained compaction classifies every omitted active ancestor as summarized', async () => {
    const entries = await fixture('synthetic-retained-tail-compaction.jsonl');
    const result = projectSenpiBranch(entries, 'b1000006');
    expect(
      result.offPath.map(record => [record.key, record.disposition])
    ).toEqual([
      ['b1000001', 'summarized'],
      ['b1000002', 'summarized'],
      ['b1000003', 'summarized'],
      ['b1000004', 'summarized'],
    ]);
  });

  it('19: legacy compaction emits compaction, kept range, then post entries', async () => {
    const entries = await fixture(
      'synthetic-legacy-first-kept-compaction.jsonl'
    );
    const result = projectSenpiBranch(entries, 'c1000006');
    expect(keys(result.records)).toEqual([
      'c1000005',
      'c1000003',
      'c1000004',
      'c1000006',
    ]);
    expect(result.complete).toBe(true);
  });

  it('20: nested legacy compaction excludes older compactions from the kept range', () => {
    const entries = [
      custom('root', null),
      compaction('older-compaction', 'root', { firstKeptEntryId: 'root' }),
      custom('between', 'older-compaction'),
      compaction('latest-compaction', 'between', { firstKeptEntryId: 'root' }),
      custom('post', 'latest-compaction'),
    ];
    const result = projectSenpiBranch(entries, 'post');
    expect(keys(result.records)).toEqual([
      'latest-compaction',
      'root',
      'between',
      'post',
    ]);
    expect(result.offPath).toContainEqual(
      expect.objectContaining({
        key: 'older-compaction',
        disposition: 'summarized',
      })
    );
  });

  it('21: missing firstKeptEntryId warns and marks projection incomplete', () => {
    const entries = [custom('root', null), compaction('compact', 'root')];
    const result = projectSenpiBranch(entries, 'compact');
    expect(keys(result.records)).toEqual(['compact']);
    expect(result.complete).toBe(false);
    expect(warningCodes(result)).toContain('missing_first_kept');
  });

  it('22: off-path firstKeptEntryId warns and marks projection incomplete', () => {
    const entries = [
      custom('root', null),
      custom('alternate', 'root'),
      custom('active', 'root'),
      compaction('compact', 'active', { firstKeptEntryId: 'alternate' }),
    ];
    const result = projectSenpiBranch(entries, 'compact');
    expect(keys(result.records)).toEqual(['compact']);
    expect(result.complete).toBe(false);
    expect(warningCodes(result)).toContain('missing_first_kept');
  });

  it('23: only the latest compaction controls projection', () => {
    const entries = [
      custom('root', null),
      compaction('old-compact', 'root', { retainedTail: [] }),
      custom('middle', 'old-compact'),
      compaction('new-compact', 'middle', { retainedTail: [] }),
      custom('leaf', 'new-compact'),
    ];
    const result = projectSenpiBranch(entries, 'leaf');
    expect(keys(result.records)).toEqual(['new-compact', 'leaf']);
    expect(result.offPath.map(record => record.key)).toEqual([
      'root',
      'old-compact',
      'middle',
    ]);
  });

  it('24: dangling tool results preserve order and emit a diagnostic', () => {
    const toolResult = parsed({
      type: 'message',
      id: 'tool-result',
      parentId: 'root',
      timestamp: ISO,
      message: {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'read',
        content: [{ type: 'text', text: 'output' }],
        isError: false,
        timestamp: 1,
      },
    });
    const result = projectSenpiBranch(
      [custom('root', null), toolResult],
      'tool-result'
    );
    expect(keys(result.records)).toEqual(['root', 'tool-result']);
    expect(warningCodes(result)).toContain('dangling_tool_reference');
  });
});

describe('Senpi corruption guards and projection mutation', () => {
  it('25: parent cycle returns invalid with a cycle diagnostic and cannot hang', () => {
    const entries = [
      custom('cycle-a', 'cycle-b'),
      custom('cycle-b', 'cycle-a'),
    ];
    const result = projectSenpiBranch(entries, 'cycle-b');
    expect({
      kind: result.kind,
      leafId: result.leafId,
      records: keys(result.records),
      warnings: result.warnings.map(warning => ({
        code: warning.code,
        entryId: warning.entryId,
      })),
    }).toMatchInlineSnapshot(`
      {
        "kind": "invalid",
        "leafId": "cycle-b",
        "records": [],
        "warnings": [
          {
            "code": "cycle",
            "entryId": "cycle-a",
          },
          {
            "code": "cycle",
            "entryId": "cycle-b",
          },
          {
            "code": "missing_leaf",
            "entryId": undefined,
          },
        ],
      }
    `);
  });

  it('26: append-only sequences produce null or an insertion at the old end', () => {
    const entries = [custom('a', null), custom('b', 'a'), custom('c', 'b')];
    for (let length = 1; length <= entries.length; length += 1) {
      const current = projectSenpiBranch(
        entries.slice(0, length),
        entries[length - 1] === undefined
          ? null
          : String.fromCharCode(96 + length)
      );
      const currentKeys = keys(current.records);
      expect(
        computeProjectionMutation(currentKeys, current.records)
      ).toBeNull();
      if (length < entries.length) {
        const next = projectSenpiBranch(
          entries.slice(0, length + 1),
          String.fromCharCode(97 + length)
        );
        expect(
          computeProjectionMutation(currentKeys, next.records)
        ).toMatchObject({
          index: currentKeys.length,
          deleteCount: 0,
          removedRecordKeys: [],
        });
      }
    }
  });

  it('27: branch splice reports the exact suffix deletion and removed keys', async () => {
    const entries = await fixture('synthetic-branch-switch.jsonl');
    const previous = projectSenpiBranch(entries, 'a1000003');
    const next = projectSenpiBranch(entries, 'a1000007');
    const mutation = computeProjectionMutation(
      keys(previous.records),
      next.records
    );
    expect(mutation).toEqual({
      index: 2,
      deleteCount: 1,
      records: next.records.slice(2),
      removedRecordKeys: ['a1000003'],
    });
  });

  it('28: includeOffPath false omits metadata without changing active records', async () => {
    const entries = await fixture('synthetic-branch-switch.jsonl');
    const withOffPath = projectSenpiBranch(entries, 'a1000007');
    const withoutOffPath = projectSenpiBranch(entries, 'a1000007', {
      includeOffPath: false,
    });
    expect(withoutOffPath.offPath).toEqual([]);
    expect(keys(withoutOffPath.records)).toEqual(keys(withOffPath.records));
  });
});
