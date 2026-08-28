import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_DECISIONS } from '../src/senpi/hook-contract.js';
import { senpiHookOutputSchema } from '../src/senpi/hook-wire.js';
import {
  assertFieldContractsEqual,
  assertWireSubsetOfKit,
  extractStringUnion,
  extractTypeObjectFields,
  inferKitOutputContracts,
} from './senpi-upstream-dts-utils.js';
import { assertOutputBehaviorMatrix } from './senpi-upstream-output-matrix.js';

const ROOT = path.join(process.cwd(), 'docs/upstream/senpi');
const TYPES = path.join(ROOT, 'hooks/types.d.ts');
const PARSER_DTS = path.join(ROOT, 'hooks/output-parser.d.ts');
const PARSER_JS = path.join(ROOT, 'hooks/output-parser.js');
const PIN_JSON = path.join(ROOT, 'pin.json');
const read = (p: string): string => readFileSync(p, 'utf8');

function kitOutput() {
  const parser = extractTypeObjectFields(read(PARSER_DTS), 'MutableHookOutput');
  return {
    parser,
    kit: inferKitOutputContracts(
      v => senpiHookOutputSchema.safeParse(v),
      parser.map(f => f.name),
      HOOK_DECISIONS
    ),
  };
}

describe('senpi hook output wire upstream drift', () => {
  it('matches pinned output-parser.js sha256', () => {
    const pin: unknown = JSON.parse(read(PIN_JSON));
    if (typeof pin !== 'object' || pin === null) throw new Error('invalid pin');
    const files: unknown = Reflect.get(pin, 'files');
    if (typeof files !== 'object' || files === null) {
      throw new Error('missing pin files');
    }
    const parser: unknown = Reflect.get(files, 'hooks/output-parser.js');
    if (typeof parser !== 'object' || parser === null) {
      throw new Error('missing parser pin');
    }
    const expected: unknown = Reflect.get(parser, 'sha256');
    if (typeof expected !== 'string') throw new Error('missing parser sha');
    const actual = createHash('sha256')
      .update(readFileSync(PARSER_JS))
      .digest('hex');
    expect(actual).toBe(expected);
  });

  it('matches MutableHookOutput types against kit schema both ways', () => {
    const { parser, kit } = kitOutput();
    assertFieldContractsEqual(parser, kit, 'parser→kit');
    assertFieldContractsEqual(kit, parser, 'kit→parser');
  });

  it('matches HookOutputWire field types against overlapping kit fields', () => {
    assertWireSubsetOfKit(
      extractTypeObjectFields(read(TYPES), 'HookOutputWire'),
      kitOutput().kit
    );
  });

  it('matches HOOK_DECISIONS against parser HookDecision both ways', () => {
    const dts = extractStringUnion(read(PARSER_DTS), 'HookDecision').sort();
    const kit = [...HOOK_DECISIONS].sort();
    expect(dts).toEqual(kit);
    expect(kit).toEqual(dts);
  });

  it('keeps every MutableHookOutput field optional (production schema)', () => {
    const { parser, kit } = kitOutput();
    for (const field of parser) expect(field.required).toBe(false);
    for (const field of kit) expect(field.required).toBe(false);
    expect(senpiHookOutputSchema.safeParse({}).success).toBe(true);
  });

  it('executes vendored parser scenarios under 100% V8+AST branch coverage', () => {
    const receipt = assertOutputBehaviorMatrix();
    expect(receipt.scenarioCount).toBeGreaterThan(50);
    expect(receipt.reachableFunctionCount).toBeGreaterThan(10);
    expect(receipt.rangeCount).toBeGreaterThan(15);
    expect(receipt.branchCounterCount).toBeGreaterThan(20);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.instrumentedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.instrumentedSha256).not.toBe(receipt.sha256);
  });
});
