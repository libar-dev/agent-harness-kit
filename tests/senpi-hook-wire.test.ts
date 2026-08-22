import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  HOOK_DECISIONS,
  HOOK_INPUT_BRANCHES,
  type SenpiHookWireField,
} from '../src/senpi/hook-contract.js';
import {
  SENPI_HOOK_INPUT_BRANCH_SCHEMAS,
  SENPI_HOOK_SYSTEM_MESSAGE_EVENTS,
  senpiEventSupportsSystemMessage,
  senpiHookInputSchema,
  senpiHookOutputSchema,
  validateSenpiHookInput,
  type SenpiHookInput,
} from '../src/senpi/hook-wire.js';
import {
  SENPI_HOOK_EVENT_NAMES,
  type SenpiHookEventName,
} from '../src/senpi/settings.js';

const FIXTURE_DIR = join(
  import.meta.dirname,
  'fixtures',
  'senpi',
  'hook-inputs'
);

const VENDORED_OUTPUT_PARSER = join(
  import.meta.dirname,
  '..',
  'docs',
  'upstream',
  'senpi',
  'hooks',
  'output-parser.js'
);

/** Fixture filename (sans extension) per canonical event name. */
const EVENT_FIXTURE_FILES: Record<SenpiHookEventName, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use',
  PreCompact: 'pre-compact',
  PostCompact: 'post-compact',
  Stop: 'stop',
};

function loadFixture(event: SenpiHookEventName): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      join(FIXTURE_DIR, `${EVENT_FIXTURE_FILES[event]}.json`),
      'utf8'
    )
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Fixture for ${event} is not a JSON object`);
  }
  const record: Record<string, unknown> = {};
  Object.assign(record, parsed);
  return record;
}

/**
 * Field name of the one required field whose removal must make an envelope
 * invalid for the event (the manifest's required asymmetry).
 */
const REQUIRED_ASYMMETRY_FIELD: Record<SenpiHookEventName, string> = {
  SessionStart: 'sessionId',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'toolInput',
  PostToolUse: 'toolOutput',
  PreCompact: 'reason',
  PostCompact: 'reason',
  Stop: 'cwd',
};

/**
 * Maps one JSON-Schema property (from z.toJSONSchema of a branch schema) to
 * its verbatim vendored TypeScript annotation text, mirroring how
 * tests/senpi-upstream-drift.test.ts reads the HookInputWire union out of
 * docs/upstream/senpi/hooks/types.d.ts.
 */
function wireFieldAnnotation(
  field: z.core.JSONSchema.BaseSchema | boolean
): string {
  if (typeof field === 'boolean') {
    // `true` is the empty (unknown) schema; `false` never occurs on our
    // branches. Required `unknown` fields serialize as `true`.
    return 'unknown';
  }
  if ('const' in field) {
    return JSON.stringify(field.const);
  }
  if (field.type === 'string') {
    return 'string';
  }
  if (field.type === 'boolean') {
    return 'boolean';
  }
  // Required `unknown` fields (toolInput/toolOutput) serialize as the empty
  // schema; their optionality is carried by the parent `required` array.
  return 'unknown';
}

/**
 * Re-derives the manifest shape of one branch from its Zod schema via the
 * public z.toJSONSchema API.
 */
function wireFieldsFromSchema(schema: z.ZodType): SenpiHookWireField[] {
  const json = z.toJSONSchema(schema);
  const required = new Set(json.required ?? []);
  const properties = json.properties ?? {};
  return Object.entries(properties)
    .map(([name, field]) => ({
      name,
      required: required.has(name),
      type: wireFieldAnnotation(field),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('senpi hook input fixtures', () => {
  for (const event of SENPI_HOOK_EVENT_NAMES) {
    it(`round-trips the ${event} fixture envelope`, () => {
      const raw = loadFixture(event);
      const result = senpiHookInputSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      const parsed: SenpiHookInput = result.data;
      expect(parsed.event).toBe(event);
      expect(parsed.cwd).toBe('/project');
    });
  }

  it('keeps unknown extra fields on the parsed envelope', () => {
    const result = senpiHookInputSchema.safeParse(loadFixture('PostToolUse'));
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data).toMatchObject({
      observerExtra: { note: 'unknown extras survive parsing' },
    });
  });
});

describe('senpi hook input alias normalization', () => {
  it('parses a PostToolUse tool_response alias into toolOutput', () => {
    const raw = loadFixture('PostToolUse');
    delete raw['toolOutput'];
    raw['tool_response'] = { content: 'alias payload' };

    const result = senpiHookInputSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.event).toBe('PostToolUse');
    expect(result.data).toMatchObject({
      toolOutput: { content: 'alias payload' },
    });
  });

  it('normalizes SessionStart session_id into the required sessionId', () => {
    const result = senpiHookInputSchema.safeParse({
      event: 'SessionStart',
      cwd: '/project',
      session_id: 'sess-from-alias',
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.sessionId).toBe('sess-from-alias');
  });

  it('normalizes PreToolUse tool_name and tool_input aliases', () => {
    const result = senpiHookInputSchema.safeParse({
      event: 'PreToolUse',
      cwd: '/project',
      tool_name: 'bash',
      tool_input: { command: 'echo hi' },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.toolName).toBe('bash');
    expect(result.data.toolInput).toEqual({ command: 'echo hi' });
  });

  it('accepts hook_event_name as the discriminator when event is absent', () => {
    const result = validateSenpiHookInput({
      hook_event_name: 'Stop',
      cwd: '/project',
    });
    expect(result.event).toBe('Stop');
  });

  it('lets an explicit camelCase primary win over its snake_case alias', () => {
    const result = validateSenpiHookInput({
      event: 'SessionStart',
      sessionId: 'primary-id',
      session_id: 'stale-alias-id',
      cwd: '/project',
    });
    expect(result.sessionId).toBe('primary-id');
  });

  it('does not mutate the caller-supplied envelope object', () => {
    const raw = {
      event: 'PreToolUse',
      cwd: '/project',
      tool_name: 'bash',
      tool_input: { command: 'ls' },
    };
    validateSenpiHookInput(raw);
    expect(Object.hasOwn(raw, 'toolName')).toBe(false);
    expect(Object.hasOwn(raw, 'toolInput')).toBe(false);
  });
});

describe('senpi hook input asymmetry rejections', () => {
  for (const event of SENPI_HOOK_EVENT_NAMES) {
    it(`rejects ${event} missing its required ${REQUIRED_ASYMMETRY_FIELD[event]} field`, () => {
      const raw = loadFixture(event);
      delete raw[REQUIRED_ASYMMETRY_FIELD[event]];
      const result = senpiHookInputSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });
  }

  it('returns a safeParse failure (never throws) on garbage input', () => {
    for (const garbage of [null, 42, 'envelope', [], true]) {
      const result = senpiHookInputSchema.safeParse(garbage);
      expect(result.success).toBe(false);
    }
  });
});

describe('senpi hook input drift against HOOK_INPUT_BRANCHES', () => {
  for (const event of SENPI_HOOK_EVENT_NAMES) {
    it(`schema fields for ${event} equal the HOOK_INPUT_BRANCHES manifest`, () => {
      const observed = wireFieldsFromSchema(
        SENPI_HOOK_INPUT_BRANCH_SCHEMAS[event]
      );
      const discriminator = observed.find(field => field.name === 'event');
      expect(discriminator).toBeDefined();
      expect(discriminator?.required).toBe(true);
      expect(discriminator?.type).toBe(JSON.stringify(event));

      const withoutDiscriminator = observed.filter(
        field => field.name !== 'event'
      );

      const expected = HOOK_INPUT_BRANCHES[event]
        .map(field => ({ ...field }))
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(withoutDiscriminator).toEqual(expected);
    });
  }
});

describe('senpi hook output schema', () => {
  it('accepts decision "allow" alongside the types.d.ts decisions', () => {
    for (const decision of HOOK_DECISIONS) {
      const result = senpiHookOutputSchema.safeParse({ decision });
      expect(result.success).toBe(true);
    }
  });

  it('round-trips every parser-level output field', () => {
    const raw = {
      decision: 'deny',
      reason: 'blocked by policy',
      additionalContext: 'use the linter first',
      updatedInput: { path: '/project/other.ts' },
      updatedToolOutput: { content: 'rewritten' },
      continue: false,
      stopReason: 'end_turn',
      suppressOutput: true,
      systemMessage: 'hook ran',
    };
    const result = senpiHookOutputSchema.safeParse(raw);
    expect(result.success).toBe(true);
    expect(result.success ? result.data : undefined).toEqual(raw);
  });

  it('passes hookSpecificOutput through as an unknown extra per the vendored parser', () => {
    // The vendored parser consumes hookSpecificOutput and never copies it
    // into ParsedHookOutput.output; looseObject keeps it as passthrough.
    const result = senpiHookOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(result.success).toBe(true);
    expect(
      result.success ? result.data['hookSpecificOutput'] : undefined
    ).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    });
  });

  it('rejects non-string reason and unknown decision values', () => {
    expect(senpiHookOutputSchema.safeParse({ reason: 7 }).success).toBe(false);
    expect(senpiHookOutputSchema.safeParse({ decision: 'maybe' }).success).toBe(
      false
    );
  });
});

describe('SYSTEM_MESSAGE_EVENTS gating parity', () => {
  /**
   * Extracts the SYSTEM_MESSAGE_EVENTS set from the vendored implementation
   * file - the gating authority - rather than from any .d.ts copy.
   */
  function extractVendoredSystemMessageEvents(): string[] {
    const source = readFileSync(VENDORED_OUTPUT_PARSER, 'utf8');
    const match = source.match(
      /const SYSTEM_MESSAGE_EVENTS = new Set\(\[([^\]]*)\]\)/
    );
    if (!match?.[1]) {
      throw new Error(
        'Could not locate SYSTEM_MESSAGE_EVENTS in vendored output-parser.js'
      );
    }
    return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1] ?? '');
  }

  it('matches the vendored output-parser.js set element-for-element', () => {
    expect([...SENPI_HOOK_SYSTEM_MESSAGE_EVENTS]).toEqual(
      extractVendoredSystemMessageEvents()
    );
  });

  it('gates PreToolUse in and PreCompact out', () => {
    expect(senpiEventSupportsSystemMessage('PreToolUse')).toBe(true);
    expect(senpiEventSupportsSystemMessage('PreCompact')).toBe(false);
  });
});
