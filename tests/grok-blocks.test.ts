import { describe, expect, it } from 'vitest';
import {
  foldGrokBlockChanges,
  reduceGrokRecords,
  type GrokNormalizedRecord,
  type GrokRecordOrigin,
} from '../src/grok/processing/blocks.js';
import { parseGrokSessionUpdate } from '../src/grok/processing/updates.js';
import { parseGrokEvent } from '../src/grok/processing/events.js';

function origin(
  stream: GrokRecordOrigin['stream'],
  nativeType: string,
  byteStart: number
): GrokRecordOrigin {
  return {
    harness: 'grok',
    stream,
    sourceId: stream === 'conversation' ? 'updates' : 'events',
    nativeType,
    generation: 0,
    byteStart,
    byteEnd: byteStart + 1,
  };
}

function updateRecord(
  update: Record<string, unknown>,
  byteStart: number,
  meta: Record<string, unknown> = {}
): GrokNormalizedRecord {
  const tag = update['sessionUpdate'];
  const raw = {
    timestamp: byteStart,
    method:
      tag === 'rewind_marker' || tag === 'turn_completed'
        ? '_x.ai/session/update'
        : 'session/update',
    params: { sessionId: 'session-1', update, _meta: meta },
  };
  const parsed = parseGrokSessionUpdate(raw);
  if (parsed.kind !== 'known') {
    throw new Error(`invalid test update: ${JSON.stringify(parsed)}`);
  }
  return {
    kind: 'update',
    envelope: parsed.envelope,
    origin: origin('conversation', String(tag), byteStart),
  };
}

function eventRecord(
  raw: Record<string, unknown>,
  byteStart: number
): GrokNormalizedRecord {
  const parsed = parseGrokEvent(raw);
  if (parsed.kind !== 'known') {
    throw new Error(`invalid test event: ${JSON.stringify(parsed)}`);
  }
  return {
    kind: 'event',
    event: parsed.event,
    origin: origin('activity', String(raw['type']), byteStart),
  };
}

function promptRecords(count: number): GrokNormalizedRecord[] {
  const records: GrokNormalizedRecord[] = [];
  for (let promptIndex = 0; promptIndex < count; promptIndex += 1) {
    records.push(
      updateRecord(
        {
          sessionUpdate: 'user_message_chunk',
          messageId: `user-${String(promptIndex)}`,
          content: { type: 'text', text: `P${String(promptIndex)}` },
          _meta: { promptIndex },
        },
        promptIndex * 2 + 1
      ),
      updateRecord(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: `agent-${String(promptIndex)}`,
          content: { type: 'text', text: `A${String(promptIndex)}` },
        },
        promptIndex * 2 + 2
      )
    );
  }
  return records;
}

function rewindRecord(
  targetPromptIndex: number,
  byteStart: number
): GrokNormalizedRecord {
  return updateRecord(
    {
      sessionUpdate: 'rewind_marker',
      target_prompt_index: targetPromptIndex,
      created_at: '2026-08-13T00:00:00Z',
    },
    byteStart
  );
}

describe('reduceGrokRecords', () => {
  it('accumulates chunks into one upserted block per message', () => {
    const records = [
      updateRecord(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'hello ' },
        },
        1,
        { promptId: 'prompt-1' }
      ),
      updateRecord(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'world' },
        },
        2,
        { promptId: 'prompt-1' }
      ),
    ];

    const result = reduceGrokRecords(records);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      type: 'upsert',
      block: {
        id: 'session-1:assistant_text:message-1',
        type: 'assistant_text',
        content: 'hello world',
      },
    });
    expect(foldGrokBlockChanges(result.changes)).toHaveLength(1);
  });

  it('deletes only blocks strictly after a rewind target', () => {
    const records = promptRecords(3);
    records.push(rewindRecord(1, 7));

    const result = reduceGrokRecords(records);
    const deletes = result.changes.filter(change => change.type === 'delete');

    expect(deletes.map(change => change.id).sort()).toEqual([
      'session-1:assistant_text:agent-2',
      'session-1:user_text:user-2',
    ]);
    expect(
      foldGrokBlockChanges(result.changes)
        .map(block => block.id)
        .sort()
    ).toEqual([
      'session-1:assistant_text:agent-0',
      'session-1:assistant_text:agent-1',
      'session-1:user_text:user-0',
      'session-1:user_text:user-1',
    ]);
  });

  it('keeps prompt zero when rewinding to target zero', () => {
    const records = promptRecords(3);
    records.push(rewindRecord(0, 7));

    const result = reduceGrokRecords(records);
    const deletes = result.changes.filter(change => change.type === 'delete');

    expect(deletes.map(change => change.id).sort()).toEqual([
      'session-1:assistant_text:agent-1',
      'session-1:assistant_text:agent-2',
      'session-1:user_text:user-1',
      'session-1:user_text:user-2',
    ]);
    expect(
      foldGrokBlockChanges(result.changes)
        .map(block => block.id)
        .sort()
    ).toEqual([
      'session-1:assistant_text:agent-0',
      'session-1:user_text:user-0',
    ]);
  });

  it('attaches unlabeled records after rewind to the kept target prompt', () => {
    const records = [
      ...promptRecords(3),
      rewindRecord(1, 7),
      updateRecord(
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'after-rewind-assistant',
          content: { type: 'text', text: 'after' },
        },
        8
      ),
      updateRecord(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'after-rewind-tool',
          title: 'Read',
          kind: 'read',
          status: 'in_progress',
        },
        9
      ),
      updateRecord(
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'after-rewind-thought',
          content: { type: 'text', text: 'hmm' },
        },
        10
      ),
    ];

    const result = reduceGrokRecords(records);
    const blocks = foldGrokBlockChanges(result.changes);
    const ids = blocks.map(block => block.id);

    expect(ids).not.toContain('session-1:user_text:user-2');
    expect(ids).not.toContain('session-1:assistant_text:agent-2');
    expect(ids).toEqual(
      expect.arrayContaining([
        'session-1:user_text:user-1',
        'session-1:assistant_text:agent-1',
      ])
    );
    expect(
      blocks.find(
        block => block.id === 'session-1:assistant_text:after-rewind-assistant'
      )
    ).toMatchObject({ promptIndex: 1 });
    expect(
      blocks.find(block => block.id === 'session-1:tool_use:after-rewind-tool')
    ).toMatchObject({ promptIndex: 1 });
    expect(
      blocks.find(
        block => block.id === 'session-1:thinking:after-rewind-thought'
      )
    ).toMatchObject({ promptIndex: 1 });
  });

  it('skips unknown records without changing the reduction', () => {
    const known = updateRecord(
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-0',
        content: { type: 'text', text: 'P0' },
        _meta: { promptIndex: 0 },
      },
      1
    );
    const unknown: GrokNormalizedRecord = {
      kind: 'unknown',
      tag: 'future_session_update',
      raw: { sessionUpdate: 'future_session_update' },
      origin: origin('conversation', 'future_session_update', 2),
    };

    expect(reduceGrokRecords([known, unknown])).toEqual(
      reduceGrokRecords([known])
    );
  });

  it('emits no deletes when the rewind target is beyond the last prompt', () => {
    const records = promptRecords(3);
    records.push(rewindRecord(99, 7));

    const result = reduceGrokRecords(records);

    expect(result.changes.filter(change => change.type === 'delete')).toEqual(
      []
    );
    expect(foldGrokBlockChanges(result.changes)).toHaveLength(6);
  });

  it('coalesces a phase stream to current state per correlation id', () => {
    const records = [
      eventRecord(
        {
          type: 'turn_started',
          ts: '2026-08-13T00:00:00Z',
          session_id: 'session-1',
          turn_number: 2,
          model_id: 'model-1',
          yolo_mode: false,
          conversation_message_count: 1,
          session_relationship: 'primary',
          schema_version: '1.0',
        },
        1
      ),
      eventRecord(
        {
          type: 'phase_changed',
          ts: '2026-08-13T00:00:01Z',
          phase: 'waiting_for_model',
        },
        2
      ),
      eventRecord(
        {
          type: 'phase_changed',
          ts: '2026-08-13T00:00:02Z',
          phase: 'streaming_text',
        },
        3
      ),
      eventRecord(
        {
          type: 'phase_changed',
          ts: '2026-08-13T00:00:03Z',
          phase: 'tool_execution',
        },
        4
      ),
    ];

    const phases = reduceGrokRecords(records).activities.filter(
      activity => activity.category === 'phase'
    );

    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      correlationId: 'session-1:turn:2',
      state: 'tool_execution',
    });
  });

  it('merges a terminal status-only update and emits its result', () => {
    const result = reduceGrokRecords([
      updateRecord(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Search',
          kind: 'search',
          status: 'in_progress',
        },
        1
      ),
      updateRecord(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
        },
        2
      ),
    ]);
    const blocks = foldGrokBlockChanges(result.changes);

    expect(blocks).toEqual([
      expect.objectContaining({
        id: 'session-1:tool_use:tool-1',
        type: 'tool_use',
        toolUseId: 'tool-1',
        title: 'Search',
        kind: 'search',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'session-1:tool_result:tool-1',
        type: 'tool_result',
        toolUseId: 'tool-1',
        status: 'completed',
      }),
    ]);
  });

  it('merges a kind-only update while preserving tool status', () => {
    const result = reduceGrokRecords([
      updateRecord(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Inspect',
          status: 'in_progress',
        },
        1
      ),
      updateRecord(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          kind: 'read',
        },
        2
      ),
    ]);

    expect(foldGrokBlockChanges(result.changes)).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        title: 'Inspect',
        kind: 'read',
        status: 'in_progress',
      }),
    ]);
  });

  it('leaves a tool block unchanged for an empty non-terminal update', () => {
    const toolCall = updateRecord(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Inspect',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'one' },
      },
      1
    );
    const before = reduceGrokRecords([toolCall]);
    const after = reduceGrokRecords([
      toolCall,
      updateRecord(
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1' },
        2
      ),
    ]);

    expect(after.changes).toEqual(before.changes);
  });

  it('preserves title and input merge behavior', () => {
    const result = reduceGrokRecords([
      updateRecord(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Search',
          kind: 'search',
          status: 'in_progress',
          rawInput: { query: 'one' },
        },
        1
      ),
      updateRecord(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Search files',
          rawInput: { query: 'two' },
        },
        2
      ),
    ]);

    expect(foldGrokBlockChanges(result.changes)).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        title: 'Search files',
        kind: 'search',
        status: 'in_progress',
        input: { query: 'two' },
      }),
    ]);
  });

  it('makes duplicate tool updates idempotent', () => {
    const toolCall = updateRecord(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Search',
        rawInput: { query: 'one' },
      },
      1,
      { promptId: 'prompt-1' }
    );
    const toolUpdate = updateRecord(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Search files',
        rawInput: { query: 'one' },
      },
      2,
      { promptId: 'prompt-1' }
    );

    const once = reduceGrokRecords([toolCall, toolUpdate]);
    const twice = reduceGrokRecords([toolCall, toolUpdate, toolUpdate]);

    expect(twice.changes).toEqual(once.changes);
    expect(foldGrokBlockChanges(twice.changes)).toHaveLength(1);
  });

  it('emits no negative deletes when rewinding beyond accumulated prompts', () => {
    const result = reduceGrokRecords([
      updateRecord(
        {
          sessionUpdate: 'rewind_marker',
          target_prompt_index: 99,
          created_at: '2026-08-13T00:00:00Z',
        },
        1
      ),
    ]);

    expect(result.changes).toEqual([]);
  });

  it('maps turn_completed to activity only', () => {
    const result = reduceGrokRecords([
      updateRecord(
        {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          stop_reason: 'end_turn',
          agent_result: null,
        },
        1
      ),
    ]);

    expect(result.changes).toEqual([]);
    expect(result.activities).toEqual([
      expect.objectContaining({
        category: 'turn',
        correlationId: 'prompt-1',
        state: 'end_turn',
      }),
    ]);
  });
});
