import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grokEventSchema } from '../src/grok/processing/events.js';

const upstreamSource = readFileSync(
  new URL('../docs/upstream/grok/session-events-types.rs', import.meta.url),
  'utf8'
);

function snakeCaseVariant(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
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
        tags.add(explicitRename ?? snakeCaseVariant(variant[1]));
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

describe('Grok event schema upstream drift', () => {
  it('matches every vendored Event variant in both directions', () => {
    assertTagParity(upstreamSource);
  });

  it('detects a renamed variant in a mutated upstream source', () => {
    const mutated = upstreamSource.replace(
      '    FirstToken,',
      '    FirstTokenRenamed,'
    );
    expect(mutated).not.toBe(upstreamSource);
    expect(() => assertTagParity(mutated)).toThrow();
  });

  it('honors explicit serde variant renames', () => {
    expect(parseEventTags(upstreamSource)).toContain(
      'mcp_oauth_discovery_timeout'
    );
    expect(parseEventTags(upstreamSource)).not.toContain(
      'mcp_o_auth_discovery_timeout'
    );
  });
});
