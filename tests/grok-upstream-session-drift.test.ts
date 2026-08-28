import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grokEventSchema } from '../src/grok/processing/events.js';
import {
  grokXaiSessionUpdateSchema,
  parseGrokSessionUpdate,
} from '../src/grok/processing/updates.js';
import { toSnakeCase } from './grok-rust-parse-utils.js';
import {
  catchAllFallbackKind,
  parseEventTags,
  parseSessionUpdateContract,
} from './grok-rust-wire-utils.js';

async function upstream(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), 'utf8');
}

describe('Grok event schema upstream drift', () => {
  it('matches Event tags and honors serde rename', async () => {
    const source = await upstream('docs/upstream/grok/session-events-types.rs');
    const rust = [...parseEventTags(source)].sort();
    const schema = [
      ...grokEventSchema.options.map(o => o.shape.type.value),
    ].sort();
    expect(schema).toEqual(rust);
    expect(parseEventTags(source).has('mcp_oauth_discovery_timeout')).toBe(
      true
    );
    expect(parseEventTags(source).has('mcp_o_auth_discovery_timeout')).toBe(
      false
    );
  });
});

describe('Grok SessionUpdate upstream drift', () => {
  it('matches tags and relates #[serde(other)] to production fallback kind', async () => {
    const source = await upstream('docs/upstream/grok/session-update-enum.txt');
    const c = parseSessionUpdateContract(source);
    const schema = [
      ...grokXaiSessionUpdateSchema.options.map(
        o => o.shape.sessionUpdate.value
      ),
    ].sort();
    expect([...c.concreteTags].sort()).toEqual(schema);
    const expectedKind = catchAllFallbackKind(c.catchAllVariant);
    expect(expectedKind).toBe(toSnakeCase(c.catchAllVariant));
    expect(expectedKind.length).toBeGreaterThan(0);
    const parsed = parseGrokSessionUpdate({
      timestamp: 1,
      method: '_x.ai/session/update',
      params: {
        sessionId: 's',
        update: { sessionUpdate: 'future_unknown_tag_xyz' },
      },
    });
    expect(parsed.kind).toBe(expectedKind);
  });
});
