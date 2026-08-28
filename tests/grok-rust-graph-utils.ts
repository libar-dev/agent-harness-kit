// Test-only nested DTO/enum graph discovery over parsed HookPayload descriptors.

import {
  parseHookPayloadDescriptors,
  parseStructDescriptors,
  type FieldDescriptor,
  type MachineWireType,
} from './grok-rust-parse-utils.js';

function collectObjectNames(fields: readonly FieldDescriptor[]): Set<string> {
  const names = new Set<string>();
  const walk = (t: MachineWireType): void => {
    if (t.kind === 'object') names.add(t.name);
    if (t.kind === 'array') walk(t.element);
  };
  for (const f of fields) walk(f.type);
  return names;
}

export function parseNestedDtoDescriptors(
  source: string
): Map<string, FieldDescriptor[]> {
  const pending = new Set<string>();
  for (const fields of parseHookPayloadDescriptors(source).values()) {
    for (const n of collectObjectNames(fields)) pending.add(n);
  }
  const out = new Map<string, FieldDescriptor[]>();
  while (pending.size > 0) {
    const name = [...pending][0];
    if (name === undefined) break;
    pending.delete(name);
    if (out.has(name)) continue;
    const fields = parseStructDescriptors(source, name);
    out.set(name, fields);
    for (const n of collectObjectNames(fields)) {
      if (!out.has(n)) pending.add(n);
    }
  }
  return out;
}

function collectEnumNames(fields: readonly FieldDescriptor[]): Set<string> {
  const names = new Set<string>();
  const walk = (t: MachineWireType): void => {
    if (t.kind === 'enum') names.add(t.name);
    if (t.kind === 'array') walk(t.element);
  };
  for (const f of fields) walk(f.type);
  return names;
}

export function collectReferencedEnumNames(source: string): string[] {
  const names = new Set<string>();
  for (const fields of parseHookPayloadDescriptors(source).values()) {
    for (const n of collectEnumNames(fields)) names.add(n);
  }
  for (const fields of parseNestedDtoDescriptors(source).values()) {
    for (const n of collectEnumNames(fields)) names.add(n);
  }
  return [...names].sort();
}
