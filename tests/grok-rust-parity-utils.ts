// Test-only Zod parity probes against mechanical Rust field/enum descriptors.

import { parseNestedDtoDescriptors } from './grok-rust-graph-utils.js';
import {
  type FieldDescriptor,
  type MachineWireType,
} from './grok-rust-parse-utils.js';
import { payloadDescriptorsByWireEvent } from './grok-rust-wire-utils.js';

export type Branch = {
  safeParse: (value: unknown) => { success: boolean };
  shape: Record<string, unknown>;
};

export type ObjectBranch = {
  safeParse: (value: unknown) => { success: boolean };
  shape: Record<string, unknown>;
};

export function sample(
  t: MachineWireType,
  dtos: ReadonlyMap<string, FieldDescriptor[]>
): unknown {
  if (t.kind === 'string') return 'sample';
  if (t.kind === 'boolean') return true;
  if (t.kind === 'unsigned_integer') return 0;
  if (t.kind === 'signed_integer') return -1;
  if (t.kind === 'unknown_json') return { ok: true };
  if (t.kind === 'enum') return t.values[0];
  if (t.kind === 'object') {
    const fields = dtos.get(t.name) ?? [];
    return Object.fromEntries(fields.map(f => [f.wire, sample(f.type, dtos)]));
  }
  return [sample(t.element, dtos)];
}

export function rejectProbes(t: MachineWireType): unknown[] {
  if (t.kind === 'string') return [true];
  if (t.kind === 'boolean') return ['x'];
  if (t.kind === 'unsigned_integer') {
    return [-1, 0.5, 'x', Number.NaN, Number.POSITIVE_INFINITY];
  }
  if (t.kind === 'signed_integer') {
    return [0.5, 'x', Number.NaN, Number.POSITIVE_INFINITY];
  }
  if (t.kind === 'enum') return ['__nope__'];
  if (t.kind === 'unknown_json') return [undefined];
  return ['x'];
}

function assertIntegerSemantics(
  label: string,
  wire: string,
  kind: 'unsigned_integer' | 'signed_integer',
  run: (value: unknown) => boolean
): void {
  if (kind === 'unsigned_integer' && run(-1)) {
    throw new Error(`${label}.${wire}: unsigned accepts negative`);
  }
  if (kind === 'signed_integer' && !run(-1)) {
    throw new Error(`${label}.${wire}: signed rejects negative`);
  }
  if (run(0.5)) {
    throw new Error(`${label}.${wire}: integer accepts fraction`);
  }
}

function assertFieldsAgainstBranch(
  label: string,
  fields: readonly FieldDescriptor[],
  branch: ObjectBranch,
  dtos: ReadonlyMap<string, FieldDescriptor[]>,
  base: Record<string, unknown>,
  skip: ReadonlySet<string>
): void {
  if (!branch.safeParse(base).success) {
    throw new Error(`${label}: zod rejects rust-declared sample object`);
  }
  for (const field of fields) {
    const run = (value: unknown) =>
      branch.safeParse({ ...base, [field.wire]: value }).success;
    const omitted = { ...base };
    delete omitted[field.wire];
    const optional = branch.safeParse(omitted).success;
    const nullable = run(null);
    if (optional !== field.optional) {
      throw new Error(
        `${label}.${field.wire}: optionality rust=${field.optional} zod=${optional}`
      );
    }
    if (nullable !== field.nullable) {
      throw new Error(
        `${label}.${field.wire}: nullability rust=${field.nullable} zod=${nullable}`
      );
    }
    if (!run(sample(field.type, dtos))) {
      throw new Error(`${label}.${field.wire}: zod rejects declared type`);
    }
    if (
      field.type.kind === 'unsigned_integer' ||
      field.type.kind === 'signed_integer'
    ) {
      assertIntegerSemantics(label, field.wire, field.type.kind, run);
    }
    for (const bad of rejectProbes(field.type)) {
      if (field.type.kind === 'unknown_json') continue;
      if (run(bad)) {
        throw new Error(
          `${label}.${field.wire}: zod accepts reject-probe ${String(bad)}`
        );
      }
    }
    if (field.type.kind === 'enum') {
      for (const value of field.type.values) {
        if (!run(value)) {
          throw new Error(`${label}.${field.wire}: zod rejects enum ${value}`);
        }
      }
    }
  }
  const zodKeys = new Set(Object.keys(branch.shape).filter(k => !skip.has(k)));
  const rustKeys = new Set(fields.map(f => f.wire));
  for (const key of zodKeys) {
    if (!rustKeys.has(key)) throw new Error(`${label}: schema extra ${key}`);
  }
  for (const key of rustKeys) {
    if (!zodKeys.has(key)) throw new Error(`${label}: schema missing ${key}`);
  }
}

export function assertDtoParity(
  label: string,
  fields: readonly FieldDescriptor[],
  branch: ObjectBranch,
  dtos: ReadonlyMap<string, FieldDescriptor[]> = new Map()
): void {
  const base: Record<string, unknown> = Object.fromEntries(
    fields.map(f => [f.wire, sample(f.type, dtos)])
  );
  assertFieldsAgainstBranch(label, fields, branch, dtos, base, new Set());
}

export function assertEnumParity(
  label: string,
  rustValues: readonly string[],
  zodValues: readonly string[]
): void {
  const rust = [...rustValues].sort();
  const zod = [...zodValues].sort();
  if (rust.length !== zod.length || rust.some((v, i) => v !== zod[i])) {
    throw new Error(
      `${label}: enum mismatch rust=[${rust.join(',')}] zod=[${zod.join(',')}]`
    );
  }
}

export function assertHookParity(
  source: string,
  branches: ReadonlyMap<string, Branch>,
  env: Record<string, unknown>,
  skip: ReadonlySet<string>
): void {
  const byWire = payloadDescriptorsByWireEvent(source);
  const dtos = parseNestedDtoDescriptors(source);
  for (const [event, fields] of byWire) {
    const branch = branches.get(event);
    if (branch === undefined) throw new Error(`Schema missing ${event}`);
    const base: Record<string, unknown> = {
      ...env,
      hookEventName: event,
      ...Object.fromEntries(fields.map(f => [f.wire, sample(f.type, dtos)])),
    };
    assertFieldsAgainstBranch(event, fields, branch, dtos, base, skip);
  }
  for (const event of branches.keys()) {
    if (!byWire.has(event)) throw new Error(`Vendored missing ${event}`);
  }
}

export function assertNestedDtoRegistryParity(
  source: string,
  registry: ReadonlyMap<string, ObjectBranch>
): void {
  const dtos = parseNestedDtoDescriptors(source);
  for (const [name, fields] of dtos) {
    const branch = registry.get(name);
    if (branch === undefined) {
      throw new Error(`DTO schema registry missing ${name}`);
    }
    assertDtoParity(name, fields, branch, dtos);
  }
  for (const name of registry.keys()) {
    if (!dtos.has(name)) throw new Error(`Vendored DTO missing ${name}`);
  }
}
