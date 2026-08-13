import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GrokHookEventName,
  type GrokPreToolUseInput,
} from '../src/grok/types.js';
import { validateGrokHookInput } from '../src/grok/validation.js';
import { createGrokHookEnvelope } from './grok-test-utils.js';

const fixtureDirectory = path.join(
  process.cwd(),
  'tests/fixtures/grok/hook-envelopes'
);

describe('validateGrokHookInput', () => {
  it('validates one hand-authored upstream envelope fixture per wire event', async () => {
    const fixtureNames = (await readdir(fixtureDirectory))
      .filter(name => name.endsWith('.json'))
      .sort();
    const validatedNames: string[] = [];

    for (const fixtureName of fixtureNames) {
      const raw = await readFile(
        path.join(fixtureDirectory, fixtureName),
        'utf8'
      );
      const parsed: unknown = JSON.parse(raw);
      validatedNames.push(validateGrokHookInput(parsed).hookEventName);
    }

    expect(fixtureNames).toHaveLength(GrokHookEventName.length);
    expect(validatedNames.sort()).toEqual([...GrokHookEventName].sort());
  });

  it('returns the event-specific inferred type', () => {
    const input = createGrokHookEnvelope('pre_tool_use', {
      toolName: 'run_terminal_command',
      toolUseId: 'tool-001',
      toolInput: { command: 'pnpm test' },
      toolInputTruncated: false,
    });

    const validated = validateGrokHookInput(input);
    expect(validated.hookEventName).toBe('pre_tool_use');
    if (validated.hookEventName === 'pre_tool_use') {
      const typed: GrokPreToolUseInput = validated;
      expect(typed.toolInput).toEqual({ command: 'pnpm test' });
    }
  });

  it('rejects a PascalCase stdin event name', () => {
    const input = createGrokHookEnvelope('PreToolUse', {
      toolName: 'run_terminal_command',
      toolUseId: 'tool-001',
      toolInput: {},
      toolInputTruncated: false,
    });

    expect(() => validateGrokHookInput(input)).toThrow(z.ZodError);
  });

  it('rejects pre_tool_use without toolInputTruncated', () => {
    const input = createGrokHookEnvelope('pre_tool_use', {
      toolName: 'run_terminal_command',
      toolUseId: 'tool-001',
      toolInput: {},
    });

    expect(() => validateGrokHookInput(input)).toThrow(z.ZodError);
  });

  it('rejects an unknown event name', () => {
    const input = createGrokHookEnvelope('future_event', {});

    expect(() => validateGrokHookInput(input)).toThrow(z.ZodError);
  });

  it('accepts and preserves extra envelope fields', () => {
    const input = createGrokHookEnvelope('user_prompt_submit', {
      prompt: 'hello',
      futureWireField: { enabled: true },
    });

    expect(validateGrokHookInput(input)).toMatchObject({
      hookEventName: 'user_prompt_submit',
      futureWireField: { enabled: true },
    });
  });

  it('surfaces truncated JSON before envelope validation', () => {
    expect(() => {
      JSON.parse('{"hookEventName":"pre_tool_use"');
    }).toThrow(SyntaxError);
  });
});
