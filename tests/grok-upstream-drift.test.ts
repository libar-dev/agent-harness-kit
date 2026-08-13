import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GrokHookEventName } from '../src/grok/types.js';
import { grokEventSchema } from '../src/grok/processing/events.js';

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

function eventEnumBody(source: string): string {
  const marker = 'pub enum Event {';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Event enum not found');

  const bodyStart = start + marker.length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error('Event enum closing brace not found');
}

function parseEventTags(source: string): Set<string> {
  const tags = new Set<string>();
  const body = eventEnumBody(source);
  let depth = 0;
  let explicitRename: string | undefined;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (depth === 0) {
      const rename = trimmed.match(/^#\[serde\(rename = "([^"]+)"\)\]$/);
      if (rename?.[1] !== undefined) explicitRename = rename[1];

      const variant = trimmed.match(/^([A-Z][A-Za-z0-9_]*)(?:\s*\{|,)$/);
      if (variant?.[1] !== undefined) {
        tags.add(explicitRename ?? toSnakeCase(variant[1]));
        explicitRename = undefined;
      }
    }
    depth += [...line].filter(character => character === '{').length;
    depth -= [...line].filter(character => character === '}').length;
  }
  return tags;
}

function schemaTags(): Set<string> {
  return new Set(
    grokEventSchema.options.map(option => option.shape.type.value)
  );
}

function assertTagParity(source: string): void {
  expect([...schemaTags()].sort()).toEqual([...parseEventTags(source)].sort());
}

async function readSessionEventsSource(): Promise<string> {
  return readFile(
    path.join(process.cwd(), 'docs/upstream/grok/session-events-types.rs'),
    'utf8'
  );
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

describe('Grok event schema upstream drift', () => {
  it('matches every vendored Event variant in both directions', async () => {
    const source = await readSessionEventsSource();
    assertTagParity(source);
  });

  it('detects a renamed variant in a mutated upstream source', async () => {
    const source = await readSessionEventsSource();
    const mutated = source.replace('    FirstToken,', '    FirstTokenRenamed,');
    expect(mutated).not.toBe(source);
    expect(() => assertTagParity(mutated)).toThrow();
  });

  it('honors explicit serde variant renames', async () => {
    const source = await readSessionEventsSource();
    expect(parseEventTags(source)).toContain('mcp_oauth_discovery_timeout');
    expect(parseEventTags(source)).not.toContain(
      'mcp_o_auth_discovery_timeout'
    );
  });
});
