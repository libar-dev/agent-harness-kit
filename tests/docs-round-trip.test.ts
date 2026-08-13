import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  hookEventNameSchema,
  hookOutputSchemas,
  validateHookInput,
  validateHooksConfig,
} from '../src/validation/index.js';

const DOC_FILES = [
  'docs/upstream/hooks-reference.md',
  'docs/upstream/hooks-guide.md',
] as const;

const SETTINGS_DOC = 'docs/upstream/settings.md';

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

const EXPECTED_INPUT_VALIDATION_SKIPS: SkipRule[] = [
  {
    description:
      'Generic PreToolUse example omits tool_use_id, while the PreToolUse section documents it as required.',
    matches: source =>
      source.includes('"hook_event_name": "PreToolUse"') &&
      !source.includes('"tool_use_id"'),
  },
];

const EXPECTED_SETTINGS_VALIDATION_SKIPS: SkipRule[] = [
  {
    description:
      'Bare settings snippets only list HTTP restriction fields without a hooks map.',
    matches: source =>
      !source.includes('"hooks"') &&
      (source.includes('"allowedHttpHookUrls"') ||
        source.includes('"httpHookAllowedEnvVars"') ||
        source.includes('"allowManagedHooksOnly"') ||
        source.includes('"disableAllHooks"')),
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

function collectJsonBlocks(files: readonly string[]): {
  parsedBlocks: ParsedJsonBlock[];
  parseSkips: JsonBlock[];
} {
  const parsedBlocks: ParsedJsonBlock[] = [];
  const parseSkips: JsonBlock[] = [];

  for (const filePath of files) {
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

function extractLifecycleEvents(markdown: string): string[] {
  const sectionMatch = markdown.match(
    /## Hook lifecycle[\s\S]*?(?=## |\n---\n)/
  );
  if (!sectionMatch) {
    return [];
  }

  return [
    ...sectionMatch[0].matchAll(/^\| `([A-Za-z][A-Za-z0-9]+)`\s*\|/gm),
  ].map(match => match[1] ?? '');
}

function extractHookSpecificOutputExamples(
  blocks: readonly ParsedJsonBlock[]
): ParsedJsonBlock[] {
  return blocks.filter(block => {
    if (!isRecord(block.value)) {
      return false;
    }

    const specific = block.value['hookSpecificOutput'];
    return isRecord(specific) && typeof specific['hookEventName'] === 'string';
  });
}

function extractHookRelatedSettings(
  blocks: readonly ParsedJsonBlock[]
): ParsedJsonBlock[] {
  return blocks.filter(block => {
    if (!isRecord(block.value)) {
      return false;
    }

    return (
      'hooks' in block.value ||
      'disableAllHooks' in block.value ||
      'allowManagedHooksOnly' in block.value ||
      'allowedHttpHookUrls' in block.value ||
      'httpHookAllowedEnvVars' in block.value
    );
  });
}

const { parsedBlocks, parseSkips } = collectJsonBlocks(DOC_FILES);
const settingsCollection = collectJsonBlocks([SETTINGS_DOC]);

const classifiedParseSkips = parseSkips.flatMap(block => {
  const description = classifyBlock(block.source, EXPECTED_PARSE_SKIPS);
  return description ? [{ ...block, description }] : [];
});

const unexpectedParseSkips = parseSkips.filter(
  block => !classifyBlock(block.source, EXPECTED_PARSE_SKIPS)
);

const inputCandidates = parsedBlocks.filter(
  (block): block is ParsedJsonBlock & { value: Record<string, unknown> } =>
    isRecord(block.value) && 'hook_event_name' in block.value
);

const configCandidates = parsedBlocks.filter(
  (block): block is ParsedJsonBlock & { value: Record<string, unknown> } =>
    isRecord(block.value) && 'hooks' in block.value
);

const classifiedInputSkips: ClassifiedJsonBlock[] = inputCandidates.flatMap(
  block => {
    const description = classifyBlock(
      block.source,
      EXPECTED_INPUT_VALIDATION_SKIPS
    );
    return description ? [{ ...block, description }] : [];
  }
);

const inputBlocks = inputCandidates.filter(
  block => !classifyBlock(block.source, EXPECTED_INPUT_VALIDATION_SKIPS)
);

const outputBlocks = extractHookSpecificOutputExamples(parsedBlocks);

const settingsCandidates = extractHookRelatedSettings(
  settingsCollection.parsedBlocks
);

const classifiedSettingsSkips: ClassifiedJsonBlock[] =
  settingsCandidates.flatMap(block => {
    const description = classifyBlock(
      block.source,
      EXPECTED_SETTINGS_VALIDATION_SKIPS
    );
    return description ? [{ ...block, description }] : [];
  });

const settingsBlocks = settingsCandidates.filter(
  block => !classifyBlock(block.source, EXPECTED_SETTINGS_VALIDATION_SKIPS)
);

const referenceMarkdown = readFileSync(
  'docs/upstream/hooks-reference.md',
  'utf8'
);
const lifecycleEvents = extractLifecycleEvents(referenceMarkdown);

describe('official docs JSON examples', () => {
  it('only skips known non-JSON documentation snippets', () => {
    expect(unexpectedParseSkips).toEqual([]);
    expect(classifiedParseSkips.map(block => block.description).sort()).toEqual(
      EXPECTED_PARSE_SKIPS.map(rule => rule.description).sort()
    );
  });

  it('only skips known schema-inconsistent input snippets', () => {
    expect(classifiedInputSkips.map(block => block.description).sort()).toEqual(
      EXPECTED_INPUT_VALIDATION_SKIPS.map(rule => rule.description).sort()
    );
  });

  it('covers the official lifecycle event inventory', () => {
    expect(lifecycleEvents.length).toBeGreaterThan(0);
    expect([...lifecycleEvents].sort()).toEqual(
      [...hookEventNameSchema.options].sort()
    );
  });

  it.each(inputBlocks)('validates hook input example $key', block => {
    expect(() => validateHookInput(block.value)).not.toThrow();
  });

  it.each(configCandidates)('validates hooks config example $key', block => {
    expect(() => validateHooksConfig(block.value)).not.toThrow();
  });

  it.each(outputBlocks)(
    'validates hook-specific output example $key',
    block => {
      if (!isRecord(block.value)) {
        throw new Error(`Expected object output for ${block.key}`);
      }

      const specific = block.value['hookSpecificOutput'];
      if (
        !isRecord(specific) ||
        typeof specific['hookEventName'] !== 'string'
      ) {
        throw new Error(`Missing hookEventName for ${block.key}`);
      }

      const eventName = specific['hookEventName'];
      const schemaEntry = Object.entries(hookOutputSchemas).find(
        ([name]) => name === eventName
      );
      if (!schemaEntry) {
        throw new Error(`No output schema registered for ${eventName}`);
      }
      const [, schema] = schemaEntry;
      expect(schema.safeParse(block.value).success).toBe(true);
    }
  );

  it('classifies bare hook-related settings snippets as intentional skips', () => {
    const usedSkipDescriptions = [
      ...new Set(classifiedSettingsSkips.map(block => block.description)),
    ].sort();
    expect(usedSkipDescriptions).toEqual(
      EXPECTED_SETTINGS_VALIDATION_SKIPS.map(rule => rule.description).sort()
    );
    expect(classifiedSettingsSkips.length).toBeGreaterThan(0);
  });

  it('validates remaining hook-related settings examples when present', () => {
    for (const block of settingsBlocks) {
      expect(() => validateHooksConfig(block.value)).not.toThrow();
    }
  });
});
