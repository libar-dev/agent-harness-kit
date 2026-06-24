import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  validateHookInput,
  validateHooksConfig,
} from '../src/validation/index.js';

const DOC_FILES = [
  'docs/upstream/hooks-reference.md',
  'docs/upstream/hooks-guide.md',
] as const;

const EXPECTED_PARSE_SKIPS = new Map<string, string>([
  [
    'docs/upstream/hooks-reference.md#1',
    'Abbreviated JSON example uses ellipsis.',
  ],
  [
    'docs/upstream/hooks-reference.md#62',
    'Prompt hook response schema documents a boolean union using prose syntax.',
  ],
  [
    'docs/upstream/hooks-guide.md#13',
    'Annotated JSON example includes comments.',
  ],
]);

const EXPECTED_VALIDATION_SKIPS = new Map<string, string>([
  [
    'docs/upstream/hooks-reference.md#9',
    'Generic PreToolUse example omits tool_use_id, while the PreToolUse section documents it as required.',
  ],
]);

interface JsonBlock {
  key: string;
  source: string;
}

interface ParsedJsonBlock extends JsonBlock {
  value: unknown;
}

function extractJsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map(
    match => match[1]?.trim() ?? ''
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectJsonBlocks(): {
  parsedBlocks: ParsedJsonBlock[];
  parseSkips: JsonBlock[];
} {
  const parsedBlocks: ParsedJsonBlock[] = [];
  const parseSkips: JsonBlock[] = [];

  for (const filePath of DOC_FILES) {
    const markdown = readFileSync(filePath, 'utf8');
    const jsonBlocks = extractJsonBlocks(markdown);

    jsonBlocks.forEach((source, index) => {
      const key = `${filePath}#${index}`;

      try {
        parsedBlocks.push({
          key,
          source,
          value: JSON.parse(source) as unknown,
        });
      } catch {
        parseSkips.push({ key, source });
      }
    });
  }

  return { parsedBlocks, parseSkips };
}

const { parsedBlocks, parseSkips } = collectJsonBlocks();

const validationCandidates = parsedBlocks.filter(block => {
  if (!isRecord(block.value)) {
    return false;
  }

  return 'hook_event_name' in block.value || 'hooks' in block.value;
});

const validationSkips = validationCandidates.filter(block =>
  EXPECTED_VALIDATION_SKIPS.has(block.key)
);

const validationBlocks = validationCandidates.filter(
  block => !EXPECTED_VALIDATION_SKIPS.has(block.key)
);

describe('official docs JSON examples', () => {
  it('only skips known non-JSON documentation snippets', () => {
    expect(parseSkips.map(block => block.key).sort()).toEqual(
      [...EXPECTED_PARSE_SKIPS.keys()].sort()
    );
  });

  it('only skips known schema-inconsistent snippets', () => {
    expect(validationSkips.map(block => block.key).sort()).toEqual(
      [...EXPECTED_VALIDATION_SKIPS.keys()].sort()
    );
  });

  it.each(validationBlocks)(
    'validates hook input or config example $key',
    block => {
      expect(isRecord(block.value)).toBe(true);

      if (!isRecord(block.value)) {
        throw new Error(`Expected ${block.key} to parse to an object`);
      }

      if ('hook_event_name' in block.value) {
        expect(() => validateHookInput(block.value)).not.toThrow();
        return;
      }

      expect(() => validateHooksConfig(block.value)).not.toThrow();
    }
  );
});
