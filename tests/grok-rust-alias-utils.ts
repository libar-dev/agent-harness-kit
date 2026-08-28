// Test-only mechanical alias reuse pins (full schema descriptor identity).

import { parseNestedDtoDescriptors } from './grok-rust-graph-utils.js';
import { rejectProbes, sample, type Branch } from './grok-rust-parity-utils.js';
import {
  parseHookPayloadDescriptors,
  toSnakeCase,
  type FieldDescriptor,
} from './grok-rust-parse-utils.js';
import {
  parseCanonicalAliases,
  payloadDescriptorsByWireEvent,
} from './grok-rust-wire-utils.js';

const ENVELOPE_SKIP = new Set([
  'hookEventName',
  'sessionId',
  'cwd',
  'workspaceRoot',
  'timestamp',
  'transcriptPath',
  'clientIdentifier',
  'promptId',
  'permissionMode',
]);

function schemaDescriptorFingerprint(
  label: string,
  fields: readonly FieldDescriptor[],
  branch: Branch,
  dtos: ReadonlyMap<string, FieldDescriptor[]>,
  env: Record<string, unknown>,
  event: string
): string {
  const base: Record<string, unknown> = {
    ...env,
    hookEventName: event,
    ...Object.fromEntries(fields.map(f => [f.wire, sample(f.type, dtos)])),
  };
  const parts: string[] = [];
  for (const field of fields) {
    const run = (value: unknown) =>
      branch.safeParse({ ...base, [field.wire]: value }).success;
    const omitted = { ...base };
    delete omitted[field.wire];
    const probes = [
      `opt=${branch.safeParse(omitted).success}`,
      `null=${run(null)}`,
      `sample=${run(sample(field.type, dtos))}`,
      ...rejectProbes(field.type).map((p, i) => `rej${i}=${run(p)}`),
    ];
    if (
      field.type.kind === 'unsigned_integer' ||
      field.type.kind === 'signed_integer'
    ) {
      probes.push(`neg=${run(-1)}`, `frac=${run(0.5)}`);
    }
    if (field.type.kind === 'enum') {
      for (const v of field.type.values) probes.push(`enum:${v}=${run(v)}`);
    }
    parts.push(`${field.wire}|${probes.join('|')}`);
  }
  const zodPayload = Object.keys(branch.shape)
    .filter(k => !ENVELOPE_SKIP.has(k))
    .sort();
  const rustPayload = fields.map(f => f.wire).sort();
  if (zodPayload.join() !== rustPayload.join()) {
    throw new Error(`${label}: payload key set mismatch`);
  }
  return parts.sort().join(';;');
}

export function assertAliasReuse(
  source: string,
  schemaBranches: ReadonlyMap<string, Branch>,
  env: Record<string, unknown> = {
    sessionId: 's',
    cwd: '/c',
    workspaceRoot: '/w',
    timestamp: 't',
  }
): void {
  const aliases = parseCanonicalAliases(source);
  if (aliases.size === 0) throw new Error('canonical aliases empty');
  const payloads = parseHookPayloadDescriptors(source);
  const byWire = payloadDescriptorsByWireEvent(source);
  const dtos = parseNestedDtoDescriptors(source);
  for (const [alias, target] of aliases) {
    if (payloads.has(alias)) throw new Error(`alias ${alias} has payload`);
    if (!payloads.has(target)) throw new Error(`target ${target} missing`);
    const aliasWire = toSnakeCase(alias);
    const targetWire = toSnakeCase(target);
    const shared = byWire.get(targetWire);
    const aliasFields = byWire.get(aliasWire);
    if (shared === undefined || aliasFields === undefined) {
      throw new Error(`wire payload missing ${aliasWire}/${targetWire}`);
    }
    if (JSON.stringify(aliasFields) !== JSON.stringify(shared)) {
      throw new Error(`wire payload reuse mismatch ${aliasWire}/${targetWire}`);
    }
    const ab = schemaBranches.get(aliasWire);
    const tb = schemaBranches.get(targetWire);
    if (ab === undefined || tb === undefined) {
      throw new Error('schema missing alias wires');
    }
    const af = schemaDescriptorFingerprint(
      aliasWire,
      shared,
      ab,
      dtos,
      env,
      aliasWire
    );
    const tf = schemaDescriptorFingerprint(
      targetWire,
      shared,
      tb,
      dtos,
      env,
      targetWire
    );
    if (af !== tf) {
      throw new Error(
        `schema identity/reuse mismatch ${aliasWire}/${targetWire}`
      );
    }
  }
}
