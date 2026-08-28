/**
 * Test-only parsers for vendored senpi TypeScript declarations (.d.ts).
 */

export type FieldContract = {
  readonly name: string;
  readonly required: boolean;
  readonly type: string;
};

export function bracedBodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  let depth = 1;
  const bodyStart = start + marker.length;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }
  throw new Error(`Unclosed body: ${marker}`);
}

export function extractTypeObjectFields(
  source: string,
  typeName: string
): FieldContract[] {
  const aliases = new Map<string, string>();
  for (const m of source.matchAll(
    /(?:export )?type ([A-Z][A-Za-z0-9]*) = ((?:"[^"]+"\s*\|\s*)*"[^"]+");/g
  )) {
    if (m[1] && m[2]) aliases.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  let body: string | undefined;
  for (const marker of [
    `export type ${typeName} = {`,
    `\ntype ${typeName} = {`,
  ]) {
    if (source.includes(marker)) {
      body = bracedBodyAfter(source, marker);
      break;
    }
  }
  if (!body) throw new Error(`Type object not found: ${typeName}`);
  const fields: FieldContract[] = [];
  for (const m of body.matchAll(
    /(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)(\?)?: ([^;]+);/g
  )) {
    const name = m[1];
    const typeText = m[3]?.trim() ?? '';
    if (!name || !typeText) throw new Error(`Malformed field in ${typeName}`);
    fields.push({
      name,
      required: m[2] !== '?',
      type: aliases.get(typeText) ?? typeText,
    });
  }
  if (fields.length === 0) throw new Error(`${typeName} has no fields`);
  return fields;
}

export function extractStringUnion(source: string, typeName: string): string[] {
  for (const marker of [`export type ${typeName} = `, `type ${typeName} = `]) {
    const at = source.indexOf(marker);
    if (at < 0) continue;
    const end = source.indexOf(';', at + marker.length);
    if (end < 0) throw new Error(`Unterminated union ${typeName}`);
    const values = [
      ...source.slice(at + marker.length, end).matchAll(/"([^"]+)"/g),
    ].map(e => e[1] ?? '');
    if (values.length === 0) throw new Error(`Empty union ${typeName}`);
    return values;
  }
  throw new Error(`Union not found: ${typeName}`);
}

export function normalizeUnionType(typeText: string): string {
  const parts = [...typeText.matchAll(/"([^"]+)"/g)].map(e => e[1] ?? '');
  if (parts.length === 0) return typeText.replace(/\s+/g, ' ').trim();
  return parts
    .sort()
    .map(p => `"${p}"`)
    .join(' | ');
}

export function assertFieldContractsEqual(
  left: readonly FieldContract[],
  right: readonly FieldContract[],
  label: string
): void {
  const key = (f: FieldContract): string =>
    `${f.name}${f.required ? '' : '?'}:${normalizeUnionType(f.type)}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  if (a.join('\0') !== b.join('\0')) {
    throw new Error(
      `${label} drift:\n  left=${a.join(', ')}\n  right=${b.join(', ')}`
    );
  }
}

export function assertWireSubsetOfKit(
  wire: readonly FieldContract[],
  kit: readonly FieldContract[]
): void {
  const byName = new Map(kit.map(f => [f.name, f]));
  for (const field of wire) {
    const kitField = byName.get(field.name);
    if (!kitField) throw new Error(`HookOutputWire.${field.name} missing`);
    if (field.required !== kitField.required) {
      throw new Error(`HookOutputWire.${field.name} optionality drift`);
    }
    if (field.name === 'decision') {
      for (const v of field.type.matchAll(/"([^"]+)"/g)) {
        if (!kitField.type.includes(`"${v[1]}"`)) {
          throw new Error(`HookOutputWire.decision "${v[1]}" missing`);
        }
      }
      continue;
    }
    if (normalizeUnionType(field.type) !== normalizeUnionType(kitField.type)) {
      throw new Error(
        `HookOutputWire.${field.name} type drift: wire=${field.type} kit=${kitField.type}`
      );
    }
  }
}

/** Kit output contracts via public safeParse — no Zod internals. */
export function inferKitOutputContracts(
  parse: (value: unknown) => { success: boolean },
  fieldNames: readonly string[],
  decisionValues: readonly string[]
): FieldContract[] {
  const ok = (value: unknown): boolean => parse(value).success;
  return fieldNames.map(name => {
    if (name === 'decision') {
      const accepted = decisionValues.filter(v => ok({ [name]: v }));
      if (accepted.length === 0) throw new Error('kit decision empty');
      return {
        name,
        required: false,
        type: accepted
          .slice()
          .sort()
          .map(v => `"${v}"`)
          .join(' | '),
      };
    }
    if (ok({ [name]: true }) && ok({ [name]: false }) && !ok({ [name]: 'x' })) {
      return { name, required: false, type: 'boolean' };
    }
    if (ok({ [name]: 't' }) && !ok({ [name]: 1 }) && !ok({ [name]: true })) {
      return { name, required: false, type: 'string' };
    }
    if (ok({ [name]: 1 }) && ok({ [name]: null }) && ok({ [name]: {} })) {
      return { name, required: false, type: 'unknown' };
    }
    throw new Error(`Could not classify kit field ${name}`);
  });
}
