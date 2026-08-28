// Test-only wire/event/session contract parsers for vendored Grok Rust.

import {
  bodyOf,
  parseHookPayloadDescriptors,
  serdeArgs,
  toSnakeCase,
  type FieldDescriptor,
} from './grok-rust-parse-utils.js';

export function parseCanonicalAliases(
  source: string
): ReadonlyMap<string, string> {
  const start = source.indexOf('pub fn canonical(self) -> Self {');
  if (start < 0) throw new Error('canonical missing');
  const matchBody = source
    .slice(start)
    .match(/match self \{([\s\S]*?)\n\s*\}/)?.[1];
  if (matchBody === undefined) throw new Error('canonical match missing');
  const aliases = new Map<string, string>();
  for (const m of matchBody.matchAll(
    /Self::([A-Z]\w*)\s*=>\s*Self::([A-Z]\w*)/g
  )) {
    if (m[1] !== undefined && m[2] !== undefined && m[1] !== m[2]) {
      aliases.set(m[1], m[2]);
    }
  }
  return aliases;
}

export function parseHookEvents(
  source: string
): { variant: string; wireName: string }[] {
  const args = serdeArgs(
    source.match(/#\[serde\(([^)]*)\)\]\s*pub enum HookEventName/)?.[1] ?? ''
  );
  if (args['rename_all'] !== 'snake_case') {
    throw new Error('HookEventName must use snake_case');
  }
  const table = source.match(/\nhook_events!\s*\{([\s\S]*?)\n\}/)?.[1];
  if (table === undefined) throw new Error('hook_events! missing');
  const events: { variant: string; wireName: string }[] = [];
  for (const m of table.matchAll(/([A-Z]\w*)\s*\{/g)) {
    if (m[1] !== undefined) {
      events.push({ variant: m[1], wireName: toSnakeCase(m[1]) });
    }
  }
  if (events.length === 0) throw new Error('hook_events! empty');
  return events;
}

export function walkTop(
  body: string,
  onVariant: (name: string, attrs: string) => void
): void {
  let depth = 0;
  let attrs = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (depth === 0) {
      if (t.startsWith('#[')) {
        attrs = t;
        continue;
      }
      if (attrs !== '' && !attrs.endsWith(']')) {
        attrs += t;
        continue;
      }
      const v = t.match(/^([A-Z]\w*)(?:\s*\{|,|\(|$)/);
      if (v?.[1] !== undefined) {
        onVariant(v[1], attrs);
        attrs = '';
      } else if (t !== '' && !t.startsWith('/')) {
        attrs = '';
      }
    }
    depth += line.split('{').length - 1;
    depth -= line.split('}').length - 1;
  }
}

export function parseEventTags(source: string): Set<string> {
  const tags = new Set<string>();
  walkTop(bodyOf(source, 'pub enum Event {'), (name, attrs) => {
    const ren = serdeArgs(attrs)['rename'];
    tags.add(typeof ren === 'string' ? ren : toSnakeCase(name));
  });
  return tags;
}

export function parseSessionUpdateContract(source: string): {
  concreteTags: ReadonlySet<string>;
  catchAllVariant: string;
} {
  const enumAttr = source.match(
    /#\[serde\(([^)]*)\)\]\s*pub enum SessionUpdate/
  )?.[1];
  if (enumAttr === undefined) throw new Error('SessionUpdate serde missing');
  const args = serdeArgs(enumAttr);
  if (args['rename_all'] !== 'snake_case' || args['tag'] !== 'sessionUpdate') {
    throw new Error('SessionUpdate serde shape invalid');
  }
  const concreteTags = new Set<string>();
  let catchAll: string | undefined;
  let otherCount = 0;
  walkTop(bodyOf(source, 'pub enum SessionUpdate {'), (name, attrs) => {
    const s = serdeArgs(attrs);
    if (s['other'] === true) {
      otherCount += 1;
      catchAll = name;
      return;
    }
    const ren = s['rename'];
    concreteTags.add(typeof ren === 'string' ? ren : toSnakeCase(name));
  });
  if (otherCount !== 1 || catchAll === undefined) {
    throw new Error(
      `SessionUpdate must declare exactly one #[serde(other)] catch-all (found ${otherCount})`
    );
  }
  return { concreteTags, catchAllVariant: catchAll };
}

/** Derive production fallback kind name from the catch-all variant. */
export function catchAllFallbackKind(catchAllVariant: string): string {
  return toSnakeCase(catchAllVariant);
}

export function payloadDescriptorsByWireEvent(
  source: string
): Map<string, FieldDescriptor[]> {
  const aliases = parseCanonicalAliases(source);
  const payloads = parseHookPayloadDescriptors(source);
  const byWire = new Map<string, FieldDescriptor[]>();
  for (const event of parseHookEvents(source)) {
    const variant = aliases.get(event.variant) ?? event.variant;
    const fields = payloads.get(variant);
    if (fields === undefined) {
      throw new Error(`No HookPayload for ${event.variant}/${variant}`);
    }
    byWire.set(event.wireName, fields);
  }
  return byWire;
}
