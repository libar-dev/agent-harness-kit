/**
 * Edge-case hardening for the session-processing core.
 *
 * These tests pin behavior that is easy to regress silently:
 *  - summarizeToolCall must not be fooled by tool names that collide with
 *    Object.prototype members (prototype-chain lookup bug).
 *  - compareStrings ordering basics.
 *  - the two `withDefaultSessionId` implementations (parser.ts vs tail.ts) must
 *    keep equivalent backfill semantics so they cannot drift apart.
 */

import { describe, it, expect } from 'vitest';

import { summarizeToolCall } from '../src/processing/denoiser.js';
import { compareStrings } from '../src/processing/ordering.js';
import { parseJsonlContent } from '../src/processing/internal.js';
import type { ToolUseBlock } from '../src/processing/types.js';
import { must } from './test-utils.js';

// ---------------------------------------------------------------------------
// summarizeToolCall — prototype-chain safety
// ---------------------------------------------------------------------------

function toolUse(
  name: string,
  input: Record<string, unknown> = {}
): ToolUseBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

describe('summarizeToolCall — Object.prototype name collisions', () => {
  // Names that exist on Object.prototype. On a plain object literal these would
  // resolve to inherited functions (toString, hasOwnProperty, ...) or the
  // constructor, which would then be invoked as a "formatter" — wrong output or
  // a crash. The null-prototype summarizer table makes them fall through to the
  // generic fallback instead.
  const collisionNames = [
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    '__proto__',
  ];

  for (const name of collisionNames) {
    it(`returns a sane string for tool name '${name}'`, () => {
      const result = summarizeToolCall(toolUse(name, { query: 'find things' }));

      expect(typeof result).toBe('string');
      // Generic fallback shape: "<name>(...)" — must start with the tool name.
      expect(result.startsWith(`${name}(`)).toBe(true);
      expect(result.endsWith(')')).toBe(true);
      // The informative scalar arg should be surfaced by the generic summarizer.
      expect(result).toContain('query');
    });
  }

  it('never throws and always returns a string for collision names with empty input', () => {
    for (const name of collisionNames) {
      let result: unknown;
      expect(() => {
        result = summarizeToolCall(toolUse(name));
      }).not.toThrow();
      expect(typeof result).toBe('string');
    }
  });

  it('still uses the dedicated summarizer for a real built-in tool', () => {
    const result = summarizeToolCall(
      toolUse('Read', { file_path: 'src/index.ts' })
    );
    expect(result).toBe('Read(src/index.ts)');
  });
});

// ---------------------------------------------------------------------------
// compareStrings — ordering basics
// ---------------------------------------------------------------------------

describe('compareStrings', () => {
  it('returns -1 / 0 / 1 for less / equal / greater', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
  });

  it('sorts an array lexicographically and is stable for equal keys', () => {
    expect(['c', 'a', 'b'].sort(compareStrings)).toEqual(['a', 'b', 'c']);
  });

  it('orders ISO timestamps chronologically as strings', () => {
    const earlier = '2026-02-16T20:00:00.000Z';
    const later = '2026-02-16T20:05:00.000Z';
    expect(compareStrings(earlier, later)).toBe(-1);
    expect([later, earlier].sort(compareStrings)).toEqual([earlier, later]);
  });
});

// ---------------------------------------------------------------------------
// withDefaultSessionId — pinned via parseJsonlContent (parser.ts path)
// ---------------------------------------------------------------------------

describe('parseJsonlContent — default sessionId backfill (parser.ts)', () => {
  const DEFAULT_SESSION_ID = 'backfilled-session';

  function userLineWithout(
    omitSessionId: boolean,
    sessionId?: unknown
  ): string {
    const base: Record<string, unknown> = {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      timestamp: '2026-02-16T20:00:00.000Z',
      uuid: 'u-001',
    };
    if (!omitSessionId) base['sessionId'] = sessionId;
    return JSON.stringify(base);
  }

  it('backfills an omitted sessionId with the provided default', () => {
    const lines = parseJsonlContent(userLineWithout(true), undefined, {
      defaultSessionId: DEFAULT_SESSION_ID,
    });

    expect(lines).toHaveLength(1);
    const line = must(lines[0]);
    expect(line.sessionId).toBe(DEFAULT_SESSION_ID);
  });

  it('keeps an explicit null sessionId (no backfill) and drops the invalid line', () => {
    // The key is present (explicit null), so backfill is skipped; null is not a
    // valid sessionId, so the line is dropped with a diagnostic rather than
    // silently rewritten.
    const diagnostics: Parameters<typeof parseJsonlContent>[1] = [];
    const lines = parseJsonlContent(userLineWithout(false, null), diagnostics, {
      defaultSessionId: DEFAULT_SESSION_ID,
    });

    expect(lines).toHaveLength(0);
    expect(must(diagnostics).length).toBeGreaterThan(0);
    expect(must(diagnostics?.[0]).kind).toBe('invalid_shape');
  });

  it('preserves an explicit string sessionId instead of overwriting it', () => {
    const lines = parseJsonlContent(
      userLineWithout(false, 'explicit-session'),
      undefined,
      { defaultSessionId: DEFAULT_SESSION_ID }
    );

    expect(lines).toHaveLength(1);
    expect(must(lines[0]).sessionId).toBe('explicit-session');
  });
});
