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

interface SkipRule {
  description: string;
  matches: (source: string) => boolean;
}

const EXPECTED_PARSE_SKIPS: SkipRule[] = [
  {
    description: 'Abbreviated JSON example uses ellipsis.',
    matches: source => source.includes('...'),
  },
  {
    description:
      'Prompt hook response schema documents a boolean union using prose syntax.',
    matches: source => source.includes('true | false'),
  },
  {
    description: 'Annotated JSON example includes comments.',
    matches: source => source.includes('// unique ID for this session'),
  },
];

const EXPECTED_VALIDATION_SKIPS: SkipRule[] = [
  {
    description:
      'Generic PreToolUse example omits tool_use_id, while the PreToolUse section documents it as required.',
    matches: source =>
      source.includes('"hook_event_name": "PreToolUse"') &&
      !source.includes('"tool_use_id"'),
  },
  {
    description:
      'Setup example uses a hook event that is documented upstream but not implemented in this library yet.',
    matches: source => source.includes('"hook_event_name": "Setup"'),
  },
  {
    description:
      'MessageDisplay example uses a hook event that is documented upstream but not implemented in this library yet.',
    matches: source => source.includes('"hook_event_name": "MessageDisplay"'),
  },
];

interface JsonBlock {
  key: string;
  source: string;
}

interface ClassifiedJsonBlock extends JsonBlock {
  description: string;
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

function classifyBlock(
  source: string,
  rules: readonly SkipRule[]
): string | undefined {
  return rules.find(rule => rule.matches(source))?.description;
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

const classifiedParseSkips = parseSkips.flatMap(block => {
  const description = classifyBlock(block.source, EXPECTED_PARSE_SKIPS);

  return description ? [{ ...block, description }] : [];
});

const unexpectedParseSkips = parseSkips.filter(
  block => !classifyBlock(block.source, EXPECTED_PARSE_SKIPS)
);

const validationCandidates = parsedBlocks.filter(block => {
  if (!isRecord(block.value)) {
    return false;
  }

  return 'hook_event_name' in block.value || 'hooks' in block.value;
});

const classifiedValidationSkips: ClassifiedJsonBlock[] =
  validationCandidates.flatMap(block => {
    const description = classifyBlock(block.source, EXPECTED_VALIDATION_SKIPS);

    return description ? [{ ...block, description }] : [];
  });

const validationBlocks = validationCandidates.filter(
  block => !classifyBlock(block.source, EXPECTED_VALIDATION_SKIPS)
);

describe('official docs JSON examples', () => {
  it('only skips known non-JSON documentation snippets', () => {
    expect(unexpectedParseSkips).toEqual([]);
    expect(classifiedParseSkips.map(block => block.description).sort()).toEqual(
      EXPECTED_PARSE_SKIPS.map(rule => rule.description).sort()
    );
  });

  it('only skips known schema-inconsistent snippets', () => {
    expect(
      classifiedValidationSkips.map(block => block.description).sort()
    ).toEqual(EXPECTED_VALIDATION_SKIPS.map(rule => rule.description).sort());
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
