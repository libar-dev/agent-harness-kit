import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GrokHookEventName } from '../src/grok/types.js';
import {
  grokHookInputSchema,
  grokStopBackgroundTaskSchema,
  grokStopFailureKindSchema,
  grokStopSessionCronSchema,
  grokSubagentStopInputSchema,
} from '../src/grok/validation.js';
import {
  parseEnumValues,
  toSnakeCase,
  type FieldDescriptor,
} from './grok-rust-parse-utils.js';
import {
  collectReferencedEnumNames,
  parseNestedDtoDescriptors,
} from './grok-rust-graph-utils.js';
import { assertAliasReuse } from './grok-rust-alias-utils.js';
import {
  assertEnumParity,
  assertHookParity,
  assertNestedDtoRegistryParity,
  type Branch,
  type ObjectBranch,
} from './grok-rust-parity-utils.js';
import {
  parseCanonicalAliases,
  parseHookEvents,
  payloadDescriptorsByWireEvent,
} from './grok-rust-wire-utils.js';

const SKIP = new Set([
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
const ENV = {
  sessionId: 's',
  cwd: '/c',
  workspaceRoot: '/w',
  timestamp: 't',
} as const;

async function upstream(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), 'utf8');
}

function branches(): Map<string, Branch> {
  return new Map(
    grokHookInputSchema.options.map(o => [o.shape.hookEventName.value, o])
  );
}

function dtoRegistry(): Map<string, ObjectBranch> {
  return new Map<string, ObjectBranch>([
    ['StopBackgroundTask', grokStopBackgroundTaskSchema],
    ['StopSessionCron', grokStopSessionCronSchema],
  ]);
}

function productionEnumValues(name: string): readonly string[] {
  if (name === 'BackgroundTaskType') {
    return grokStopBackgroundTaskSchema.shape.type.options;
  }
  if (name === 'StopFailureKind') return grokStopFailureKindSchema.options;
  if (name === 'SubagentStopPhase') {
    return grokSubagentStopInputSchema.shape.phase.options;
  }
  throw new Error(`No production enum mapping for ${name}`);
}

function firstAlias(source: string): {
  aliasWire: string;
  targetWire: string;
  fields: FieldDescriptor[];
} {
  const aliases = parseCanonicalAliases(source);
  const entry = [...aliases.entries()][0];
  if (entry === undefined) throw new Error('no alias');
  const [alias, target] = entry;
  const targetWire = toSnakeCase(target);
  const fields = payloadDescriptorsByWireEvent(source).get(targetWire);
  if (fields === undefined) throw new Error('alias target payload missing');
  return { aliasWire: toSnakeCase(alias), targetWire, fields };
}

function overlayField(
  base: Branch,
  wire: string,
  fieldSchema: z.ZodType
): Branch {
  return {
    shape: { ...base.shape, [wire]: fieldSchema },
    safeParse(value: unknown) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return base.safeParse(value);
      }
      const rec: Record<string, unknown> = { ...value };
      if (!Object.hasOwn(rec, wire)) {
        if (!fieldSchema.safeParse(undefined).success) {
          return { success: false };
        }
        return base.safeParse(value);
      }
      if (!fieldSchema.safeParse(rec[wire]).success) {
        return { success: false };
      }
      return base.safeParse({ ...rec, [wire]: 0 });
    },
  };
}

describe('Grok hook upstream drift', () => {
  it('matches serde wire events from hook_events!', async () => {
    const events = parseHookEvents(
      await upstream('docs/upstream/grok/event.rs')
    );
    expect(events.map(e => e.wireName)).toEqual([...GrokHookEventName]);
  });

  it('pins canonical alias payload reuse from registries', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    expect(() => assertAliasReuse(source, branches(), ENV)).not.toThrow();
  });

  it('fails when alias schema reuse drifts by keys', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    const { aliasWire } = firstAlias(source);
    const map = branches();
    map.set(
      aliasWire,
      z.looseObject({
        sessionId: z.string(),
        cwd: z.string(),
        workspaceRoot: z.string(),
        timestamp: z.string(),
        hookEventName: z.literal(aliasWire),
        unrelatedOnly: z.string(),
      })
    );
    expect(() => assertAliasReuse(source, map, ENV)).toThrow(
      /schema identity\/reuse mismatch|payload key set mismatch/
    );
  });

  it('fails when alias schema enum field drifts to boolean', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    const { aliasWire, fields } = firstAlias(source);
    const enumField = fields.find(f => f.type.kind === 'enum');
    if (enumField === undefined) throw new Error('alias payload has no enum');
    const map = branches();
    const current = map.get(aliasWire);
    if (current === undefined) throw new Error('alias schema missing');
    map.set(aliasWire, overlayField(current, enumField.wire, z.boolean()));
    expect(() => assertAliasReuse(source, map, ENV)).toThrow(
      /schema identity\/reuse mismatch/
    );
  });

  it('matches HookPayload descriptors via Zod parse behavior', async () => {
    assertHookParity(
      await upstream('docs/upstream/grok/event.rs'),
      branches(),
      ENV,
      SKIP
    );
  });

  it('matches nested DTO descriptors both ways via Zod', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    assertNestedDtoRegistryParity(source, dtoRegistry());
    expect(parseNestedDtoDescriptors(source).size).toBeGreaterThan(0);
  });

  it('matches referenced enums bidirectionally', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    const names = collectReferencedEnumNames(source);
    expect(names).toContain('BackgroundTaskType');
    for (const name of names) {
      const rust = parseEnumValues(source, name);
      const zod = productionEnumValues(name);
      assertEnumParity(name, rust, zod);
      assertEnumParity(`${name}-reverse`, zod, rust);
    }
  });

  it('fails when unsigned schema drops int() (fraction accepted)', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    const byWire = payloadDescriptorsByWireEvent(source);
    let event: string | undefined;
    let field: FieldDescriptor | undefined;
    for (const [wire, fields] of byWire) {
      const u = fields.find(f => f.type.kind === 'unsigned_integer');
      if (u !== undefined) {
        event = wire;
        field = u;
        break;
      }
    }
    if (event === undefined || field === undefined) {
      throw new Error('no unsigned_integer field in payloads');
    }
    const map = branches();
    const current = map.get(event);
    if (current === undefined) throw new Error('schema missing');
    const drifted = field.optional
      ? z.number().nonnegative().optional()
      : z.number().nonnegative();
    map.set(event, overlayField(current, field.wire, drifted));
    expect(() => assertHookParity(source, map, ENV, SKIP)).toThrow(
      /integer accepts fraction/
    );
  });

  it('fails when schema source is z.boolean', async () => {
    const source = await upstream('docs/upstream/grok/event.rs');
    const fake = z.looseObject({
      sessionId: z.string(),
      cwd: z.string(),
      workspaceRoot: z.string(),
      timestamp: z.string(),
      hookEventName: z.literal('session_start'),
      source: z.boolean(),
      modelId: z.string().optional(),
      agentType: z.string().optional(),
    });
    const map = branches();
    map.set('session_start', fake);
    expect(() => assertHookParity(source, map, ENV, SKIP)).toThrow(
      /session_start/
    );
  });
});
