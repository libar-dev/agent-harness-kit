import { describe, expect, it } from 'vitest';

import {
  EMPTY_SENPI_BLOCK_REDUCTION_STATE,
  foldSenpiBlockChanges,
  reduceSenpiProjection,
  type SenpiBlockChange,
  type SenpiMetadataBlock,
  type SenpiMessageBlock,
  type SenpiSessionBlock,
} from '../src/senpi/processing/blocks.js';
import {
  computeProjectionMutation,
  projectSenpiBranch,
  resolveSenpiLeaf,
  type SenpiProjectionInput,
} from '../src/senpi/processing/projection.js';
import {
  parseSenpiEntry,
  type SenpiEntryParseResult,
} from '../src/senpi/processing/parse.js';
import type {
  SenpiAssistantMessage,
  SenpiCustomEntry,
  SenpiMessageEntry,
} from '../src/senpi/types.js';

const ISO = '2026-02-01T00:00:00.000Z';
const MSG_TS = 1770000000000;

const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: {
    input: 0.01,
    output: 0.02,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.03,
  },
};

/**
 * Routes every synthetic fixture through the real parse policy so tests
 * exercise the same known/unknown/invalid boundary production uses.
 */
function input(raw: unknown): SenpiProjectionInput {
  return parseSenpiEntry(raw);
}

/** Narrows a block-map lookup to metadata blocks without an assertion. */
function metadataBlock(
  blocks: ReadonlyMap<string, SenpiSessionBlock>,
  id: string
): SenpiMetadataBlock | undefined {
  const block = blocks.get(id);
  return block?.type === 'metadata' ? block : undefined;
}

function projectLatest(
  entries: readonly SenpiProjectionInput[]
): ReturnType<typeof projectSenpiBranch> {
  return projectSenpiBranch(entries, resolveSenpiLeaf(entries).leafId);
}

function parsed(raw: unknown): SenpiEntryParseResult {
  return parseSenpiEntry(raw);
}

function userEntry(
  id: string,
  parentId: string | null,
  text: string
): SenpiMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ISO,
    message: { role: 'user', content: text, timestamp: MSG_TS },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  content: SenpiAssistantMessage['content']
): SenpiMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ISO,
    message: {
      role: 'assistant',
      content,
      api: 'responses',
      provider: 'test-provider',
      model: 'test-model',
      usage: USAGE,
      stopReason: 'stop',
      timestamp: MSG_TS,
    },
  };
}

function todoStateEntry(id: string, parentId: string | null): SenpiCustomEntry {
  return {
    type: 'custom',
    id,
    parentId,
    timestamp: ISO,
    customType: 'senpi.todo-state',
    data: { todos: [{ label: `task for ${id}`, done: false }] },
  };
}

describe('reduceSenpiProjection - branch splice', () => {
  it('deletes exactly the removed record keys and emits the golden change sequence', () => {
    const before = [
      userEntry('A', null, 'hi'),
      assistantEntry('B', 'A', [{ type: 'text', text: 'hello' }]),
      userEntry('C', 'B', 'continue'),
    ];
    const branched = [
      userEntry('A', null, 'hi'),
      assistantEntry('B', 'A', [{ type: 'text', text: 'hello' }]),
      // Sibling branch replaces C -> D under the same parent B.
      userEntry('D', 'B', 'retry'),
    ];

    const projectionBefore = projectLatest(before.map(input));
    const step1 = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectionBefore
    );

    const projectionAfter = projectLatest(branched.map(input));
    const mutation = computeProjectionMutation(
      step1.state.recordKeys,
      projectionAfter.records
    );
    expect(mutation).not.toBeNull();
    expect(mutation?.index).toBe(2);
    expect(mutation?.deleteCount).toBe(1);

    const step2 = reduceSenpiProjection(step1.state, projectionAfter);

    // Golden: deletes precede upserts; exactly one delete, one upsert.
    expect(step2.changes).toEqual([
      { type: 'delete', id: 'C' },
      {
        type: 'upsert',
        block: {
          id: 'D',
          type: 'message',
          role: 'user',
          entryId: 'D',
          parentId: 'B',
          origin: 'entry',
          branch: 'active',
          entryType: 'message',
          entryTimestamp: ISO,
          messageTimestamp: MSG_TS,
          usage: undefined,
          isError: undefined,
          customType: undefined,
          content: [{ type: 'text', text: 'retry' }],
        },
      },
    ]);

    // Upsert+delete sets match removedRecordKeys exactly, via the state's
    // record-key -> block-id mapping.
    const removedKeys = mutation?.removedRecordKeys ?? [];
    expect(removedKeys).toEqual(['C']);
    const expectedDeletedIds = removedKeys.flatMap(
      key => step1.state.blockIdsByRecordKey.get(key) ?? []
    );
    const actualDeletedIds = step2.changes
      .filter(
        (change): change is Extract<SenpiBlockChange, { type: 'delete' }> =>
          change.type === 'delete'
      )
      .map(change => change.id);
    expect(actualDeletedIds).toEqual(expectedDeletedIds);

    // Folding the accumulated stream reproduces the successor state exactly.
    const folded = foldSenpiBlockChanges([...step1.changes, ...step2.changes]);
    expect(folded).toEqual([...step2.state.blocks.values()]);
    expect(folded.map(block => block.id)).toEqual(['A', 'B', 'D']);
  });

  it('clears every block when the tree becomes structurally invalid', () => {
    const before = projectLatest([userEntry('A', null, 'hi')]);
    const step1 = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      before
    );
    expect(step1.state.blocks.size).toBe(1);

    // Duplicate id makes the whole projection invalid; records empty out.
    const corrupt = projectLatest(
      [
        {
          ...userEntry('A', null, 'hi'),
          timestamp: '2026-02-02T00:00:00.000Z',
        },
        userEntry('A', null, 'duplicate'),
      ].map(input)
    );
    expect(corrupt.kind).toBe('invalid');
    const step2 = reduceSenpiProjection(step1.state, corrupt);
    expect(step2.state.blocks.size).toBe(0);
    expect(step2.changes).toEqual([{ type: 'delete', id: 'A' }]);
  });
});

describe('foldSenpiBlockChanges - idempotence', () => {
  const before = projectLatest([
    userEntry('A', null, 'hi'),
    userEntry('B', 'A', 'again'),
  ]);
  const after = projectLatest([
    userEntry('A', null, 'hi'),
    userEntry('C', 'A', 'spliced in'),
  ]);
  const step1 = reduceSenpiProjection(
    EMPTY_SENPI_BLOCK_REDUCTION_STATE,
    before
  );
  const step2 = reduceSenpiProjection(step1.state, after);
  const changes: readonly SenpiBlockChange[] = [
    ...step1.changes,
    ...step2.changes,
  ];

  it('fold(x) equals fold([...x, ...x])', () => {
    const once = foldSenpiBlockChanges(changes);
    const twice = foldSenpiBlockChanges([...changes, ...changes]);
    expect(twice).toEqual(once);
  });

  it('refolding upserts reconstructed from a folded list reproduces the list', () => {
    const once = foldSenpiBlockChanges(changes);
    const refolded = foldSenpiBlockChanges(
      once.map(block => ({ type: 'upsert' as const, block }))
    );
    expect(refolded).toEqual(once);
  });

  it('re-reducing an unchanged projection emits no changes', () => {
    const repeat = reduceSenpiProjection(step2.state, after);
    expect(repeat.changes).toEqual([]);
    expect([...repeat.state.blocks.values()]).toEqual([
      ...step2.state.blocks.values(),
    ]);
  });
});

describe('dense custom stream - neutral O(n) handling', () => {
  it('folds 1000 senpi.todo-state entries linearly with metadata passthrough', () => {
    const count = 1000;
    const entries = Array.from({ length: count }, (_, index) =>
      todoStateEntry(
        `todo-${String(index)}`,
        index === 0 ? null : `todo-${String(index - 1)}`
      )
    );

    const projection = projectLatest(entries.map(input));
    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projection
    );

    const start = performance.now();
    const folded = foldSenpiBlockChanges(reduction.changes);
    const elapsedMs = performance.now() - start;

    expect(folded).toHaveLength(count);
    // Quadratic folding of 1000 entries would blow this generous bound;
    // linear folding finishes in low single-digit milliseconds.
    expect(elapsedMs).toBeLessThan(1000);

    const first = folded[0];
    const last = folded[count - 1];
    expect(first?.type).toBe('metadata');
    expect(last?.type).toBe('metadata');
    expect(first?.customType).toBe('senpi.todo-state');
    expect(last?.customType).toBe('senpi.todo-state');
    const firstMetadata = first?.type === 'metadata' ? first : undefined;
    expect(firstMetadata?.entryType).toBe('custom');
    expect(firstMetadata?.payload).toEqual({
      todos: [{ label: 'task for todo-0', done: false }],
    });
  });
});

describe('entry splitting - stable composite ids', () => {
  it('splits multi-block messages into entryId:<index> ids deterministically', () => {
    const entry = assistantEntry('ASST', 'ROOT', [
      { type: 'text', text: 'part one' },
      { type: 'thinking', thinking: 'pondering' },
      { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} },
    ]);
    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectLatest([userEntry('ROOT', null, 'go'), entry])
    );

    const messageBlocks = [...reduction.state.blocks.values()].filter(
      (block): block is SenpiMessageBlock => block.type === 'message'
    );
    expect(messageBlocks.map(block => block.id)).toEqual([
      'ROOT',
      'ASST:0',
      'ASST:1',
      'ASST:2',
    ]);
    expect(messageBlocks[1]?.content).toEqual([
      { type: 'text', text: 'part one' },
    ]);
    expect(messageBlocks[2]?.content).toEqual([
      { type: 'thinking', thinking: 'pondering' },
    ]);
    expect(messageBlocks[3]?.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} },
    ]);
    expect(messageBlocks[1]?.usage).toEqual(USAGE);
    for (const block of messageBlocks) {
      expect(block.entryId).toBe(block.id.startsWith('ASST') ? 'ASST' : 'ROOT');
    }

    // Stability: reducing the same projection from scratch yields identical ids.
    const again = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectLatest([userEntry('ROOT', null, 'go'), entry])
    );
    expect([...again.state.blocks.keys()]).toEqual([
      ...reduction.state.blocks.keys(),
    ]);
  });

  it('keeps toolResult error flags and usage on the block', () => {
    const result: SenpiMessageEntry = {
      type: 'message',
      id: 'TR',
      parentId: 'ROOT',
      timestamp: ISO,
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
        usage: USAGE,
        timestamp: MSG_TS,
      },
    };
    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectLatest([userEntry('ROOT', null, 'go'), result])
    );
    const block = reduction.state.blocks.get('TR');
    expect(block?.type).toBe('message');
    expect(block?.isError).toBe(true);
    expect(block?.role).toBe('toolResult');
    expect(block?.usage).toEqual(USAGE);
  });
});

describe('malformed input tolerance', () => {
  it('keeps unknown tags as verbatim metadata without throwing', () => {
    const unknown = parsed({
      type: 'future-widget',
      id: 'W1',
      parentId: null,
      timestamp: ISO,
      config: { mode: 'turbo' },
    });
    expect(unknown.kind).toBe('unknown');

    const projection = projectLatest([unknown]);
    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projection
    );
    const block = metadataBlock(reduction.state.blocks, 'W1');
    expect(block?.entryType).toBe('future-widget');
    expect(block?.customType).toBeUndefined();
    expect(block?.payload).toEqual({
      type: 'future-widget',
      id: 'W1',
      parentId: null,
      timestamp: ISO,
      config: { mode: 'turbo' },
    });
  });

  it('skips malformed known-tag lines with a warning, never throwing', () => {
    const invalid = parsed({ type: 'custom_message', id: 'BAD' });
    expect(invalid.kind).toBe('invalid');

    const projection = projectLatest([invalid]);
    expect(projection.warnings.some(w => w.code === 'invalid_entry')).toBe(
      true
    );
    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projection
    );
    expect(reduction.state.blocks.size).toBe(0);
  });
});

describe('compaction retained tail and custom passthrough', () => {
  it('materializes retained-tail messages with synthetic stable ids', () => {
    const compaction = {
      type: 'compaction',
      id: 'COMP',
      parentId: null,
      timestamp: ISO,
      summary: 'context compacted',
      tokensBefore: 1234,
      usage: USAGE,
      retainedTail: [
        { role: 'user', content: 'kept context', timestamp: MSG_TS },
      ],
    };
    const post = userEntry('POST', 'COMP', 'after compaction');

    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectLatest([compaction, post].map(input))
    );

    const ids = [...reduction.state.blocks.keys()];
    expect(ids).toEqual(['COMP', 'COMP:retained:0', 'POST']);

    const compBlock = metadataBlock(reduction.state.blocks, 'COMP');
    expect(compBlock?.entryType).toBe('compaction');
    expect(compBlock?.usage).toEqual(USAGE);
    expect(compBlock?.payload).toEqual({
      summary: 'context compacted',
      tokensBefore: 1234,
    });

    const retained = reduction.state.blocks.get('COMP:retained:0');
    expect(retained?.origin).toBe('retained_tail');
    expect(retained?.entryId).toBe('COMP');
    expect(retained?.entryTimestamp).toBeUndefined();
    expect(retained?.messageTimestamp).toBe(MSG_TS);
    expect(retained?.branch).toBe('active');
  });

  it('passes customType through for custom and custom_message metadata', () => {
    const customMessage = {
      type: 'custom_message',
      id: 'CM',
      parentId: null,
      timestamp: ISO,
      customType: 'omo-senpi:wake',
      content: 'wake up',
      display: true,
      details: { reason: 'idle' },
    };

    const reduction = reduceSenpiProjection(
      EMPTY_SENPI_BLOCK_REDUCTION_STATE,
      projectLatest([customMessage].map(input))
    );
    const block = metadataBlock(reduction.state.blocks, 'CM');
    expect(block?.customType).toBe('omo-senpi:wake');
    expect(block?.payload).toEqual({
      content: 'wake up',
      display: true,
      details: { reason: 'idle' },
    });
  });
});
