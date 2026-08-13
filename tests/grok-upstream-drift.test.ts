import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GrokHookEventName } from '../src/grok/types.js';

type RustHookEvent = {
  variant: string;
  wireName: string;
};

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function parseHookEvents(source: string): RustHookEvent[] {
  const renameAllMatch = source.match(
    /#\[serde\(rename_all\s*=\s*"([^"]+)"\)\]\s*pub enum HookEventName/
  );
  if (renameAllMatch?.[1] !== 'snake_case') {
    throw new Error('HookEventName must use serde snake_case serialization');
  }

  const tableMatch = source.match(/\nhook_events!\s*\{([\s\S]*?)\n\}/);
  if (tableMatch?.[1] === undefined) {
    throw new Error('Could not find the hook_events! table');
  }

  const events: RustHookEvent[] = [];
  const rowPattern =
    /((?:\s*#\[[^\]]+\]\s*)*)([A-Z][A-Za-z0-9]*)\s*\{([\s\S]*?)\n\s*\},/g;
  for (const match of tableMatch[1].matchAll(rowPattern)) {
    const attributes = match[1] ?? '';
    const variant = match[2];
    if (variant === undefined) {
      throw new Error('Malformed hook_events! variant');
    }

    const explicitRename = attributes.match(
      /#\[serde\(rename\s*=\s*"([^"]+)"\)\]/
    )?.[1];
    events.push({
      variant,
      wireName: explicitRename ?? toSnakeCase(variant),
    });
  }

  if (events.length === 0) {
    throw new Error('The hook_events! table contained no variants');
  }
  return events;
}

describe('Grok hook upstream drift', () => {
  it('matches every serde wire event from the vendored hook_events! table', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'docs/upstream/grok/event.rs'),
      'utf8'
    );
    const rustEvents = parseHookEvents(source);
    const rustWireNames = rustEvents.map(event => event.wireName);

    expect(rustEvents.map(event => event.variant)).toHaveLength(
      GrokHookEventName.length
    );
    expect(rustWireNames).toEqual([...GrokHookEventName]);
    expect(new Set(rustWireNames)).toEqual(new Set(GrokHookEventName));
  });
});
