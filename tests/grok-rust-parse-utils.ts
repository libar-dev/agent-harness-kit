// Test-only mechanical parsers for vendored Grok Rust DTO/enum contracts.

export type MachineWireType =
  | { kind: 'string' }
  | { kind: 'boolean' }
  | { kind: 'unsigned_integer' }
  | { kind: 'signed_integer' }
  | { kind: 'unknown_json' }
  | { kind: 'enum'; name: string; values: readonly string[] }
  | { kind: 'array'; element: MachineWireType }
  | { kind: 'object'; name: string };

export type FieldDescriptor = {
  wire: string;
  optional: boolean;
  nullable: boolean;
  type: MachineWireType;
};

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function bodyOf(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found`);
  let depth = 1;
  for (let i = start + marker.length; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start + marker.length, i);
  }
  throw new Error(`${marker} unclosed`);
}

export function serdeArgs(attr: string): Record<string, string | true> {
  const raw = attr.match(/#\[serde\(([\s\S]*)\)\]/)?.[1] ?? attr;
  const out: Record<string, string | true> = {};
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const kv = p.match(/^(\w+)\s*=\s*"([^"]*)"$/);
    if (kv?.[1] !== undefined && kv[2] !== undefined) out[kv[1]] = kv[2];
    else if (/^\w+$/.test(p)) out[p] = true;
  }
  return out;
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

// Leading #[...] attrs from preceding declaration boundary (not a char window).
function leadingSerde(source: string, keyword: string, name: string): string {
  const m = new RegExp(`pub\\s+${keyword}\\s+${name}\\b`).exec(source);
  if (m?.index === undefined) {
    throw new Error(`${keyword} ${name} not found`);
  }
  const lines = source.slice(0, m.index).split('\n');
  const attrs: string[] = [];
  let pending = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('//')) {
      if (pending === '') continue;
      pending = `${t}${pending}`;
      continue;
    }
    if (pending !== '') {
      pending = `${t}${pending}`;
      if (t.startsWith('#[')) {
        attrs.unshift(pending);
        pending = '';
      }
      continue;
    }
    if (t.startsWith('#[')) {
      attrs.unshift(t);
      continue;
    }
    if (t.endsWith(']') && !t.startsWith('#[')) {
      pending = t;
      continue;
    }
    break;
  }
  return attrs.join('\n');
}

export function parseEnumValues(source: string, name: string): string[] {
  const renameAll = serdeArgs(leadingSerde(source, 'enum', name))['rename_all'];
  const values: string[] = [];
  for (const line of bodyOf(source, `pub enum ${name} {`).split('\n')) {
    const vm = line.trim().match(/^([A-Z]\w*)\s*,?\s*$/);
    if (vm?.[1] !== undefined) {
      values.push(
        renameAll === 'lowercase' ? vm[1].toLowerCase() : toSnakeCase(vm[1])
      );
    }
  }
  return values;
}

function fd(
  optional: boolean,
  nullable: boolean,
  type: MachineWireType
): Omit<FieldDescriptor, 'wire'> {
  return { optional, nullable, type };
}

export function classify(
  source: string,
  typeText: string
): Omit<FieldDescriptor, 'wire'> {
  const t = typeText.replace(/,$/, '').trim();
  const opt = t.match(/^Option\s*<\s*([\s\S]+)\s*>$/);
  if (opt?.[1] !== undefined) {
    return fd(true, false, classify(source, opt[1].trim()).type);
  }
  const vec = t.match(/^Vec\s*<\s*([\w:]+)\s*>$/);
  if (vec?.[1] !== undefined) {
    return fd(false, false, {
      kind: 'array',
      element: classify(source, vec[1]).type,
    });
  }
  if (t === 'serde_json::Value') {
    return fd(false, true, { kind: 'unknown_json' });
  }
  if (t === 'String') return fd(false, false, { kind: 'string' });
  if (t === 'bool') return fd(false, false, { kind: 'boolean' });
  if (/^(u\d+|usize)$/.test(t)) {
    return fd(false, false, { kind: 'unsigned_integer' });
  }
  if (/^(i\d+|isize)$/.test(t)) {
    return fd(false, false, { kind: 'signed_integer' });
  }
  if (/^[A-Za-z]\w*$/.test(t)) {
    if (source.includes(`pub enum ${t}`)) {
      return fd(false, false, {
        kind: 'enum',
        name: t,
        values: parseEnumValues(source, t),
      });
    }
    if (source.includes(`pub struct ${t}`)) {
      return fd(false, false, { kind: 'object', name: t });
    }
  }
  throw new Error(`Unsupported Rust type: ${t}`);
}

function parseFieldBlock(
  source: string,
  block: string,
  renameAll: string | true | undefined
): FieldDescriptor[] {
  const fields: FieldDescriptor[] = [];
  let attrs = '';
  for (const raw of block.split('\n')) {
    const t = raw.trim();
    if (t.startsWith('#[')) {
      attrs = t;
      continue;
    }
    if (attrs !== '' && !attrs.endsWith(']')) {
      attrs += t;
      continue;
    }
    const f = t.match(/^(?:pub\s+)?(?:r#)?([a-z]\w*)\s*:\s*(.+?),?\s*$/);
    if (f?.[1] !== undefined && f[2] !== undefined) {
      const rename = serdeArgs(attrs)['rename'];
      const wire =
        typeof rename === 'string'
          ? rename
          : renameAll === 'camelCase' || renameAll === undefined
            ? toCamel(f[1])
            : toCamel(f[1]);
      fields.push({ wire, ...classify(source, f[2]) });
      attrs = '';
    } else if (t !== '' && !t.startsWith('//')) {
      attrs = '';
    }
  }
  return fields;
}

export function parseStructDescriptors(
  source: string,
  name: string
): FieldDescriptor[] {
  const renameAll = serdeArgs(leadingSerde(source, 'struct', name))[
    'rename_all'
  ];
  return parseFieldBlock(
    source,
    bodyOf(source, `pub struct ${name} {`),
    renameAll
  );
}

export function parseHookPayloadDescriptors(
  source: string
): Map<string, FieldDescriptor[]> {
  const shapes = new Map<string, FieldDescriptor[]>();
  for (const m of bodyOf(source, 'pub enum HookPayload {').matchAll(
    /([A-Z]\w*)\s*\{([^}]*)\}/g
  )) {
    const variant = m[1];
    const block = m[2];
    if (variant === undefined || block === undefined) continue;
    shapes.set(variant, parseFieldBlock(source, block, 'camelCase'));
  }
  if (shapes.size === 0) throw new Error('HookPayload empty');
  return shapes;
}
