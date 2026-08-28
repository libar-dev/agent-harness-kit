import { describe, expect, it } from 'vitest';

import {
  senpiHookOutputSchema,
  type SenpiHookOutput,
} from '../src/senpi/hook-wire.js';
import { SenpiHookOutputBuilder } from '../src/senpi/output-builder.js';

interface FactoryCase {
  readonly factory: string;
  readonly output: SenpiHookOutput;
  readonly expected: SenpiHookOutput;
}

const FACTORY_TABLE: readonly FactoryCase[] = [
  {
    factory: 'approve',
    output: SenpiHookOutputBuilder.approve(),
    expected: { decision: 'approve' },
  },
  {
    factory: 'block',
    output: SenpiHookOutputBuilder.block('writes are not allowed'),
    expected: { decision: 'block', reason: 'writes are not allowed' },
  },
  {
    factory: 'block',
    output: SenpiHookOutputBuilder.block(),
    expected: { decision: 'block' },
  },
  {
    factory: 'block',
    output: SenpiHookOutputBuilder.block(''),
    expected: { decision: 'block' },
  },
  {
    factory: 'block',
    output: SenpiHookOutputBuilder.block(undefined),
    expected: { decision: 'block' },
  },
  {
    factory: 'deny',
    output: SenpiHookOutputBuilder.deny('secret files'),
    expected: { decision: 'deny', reason: 'secret files' },
  },
  {
    factory: 'deny',
    output: SenpiHookOutputBuilder.deny(),
    expected: { decision: 'deny' },
  },
  {
    factory: 'deny',
    output: SenpiHookOutputBuilder.deny(''),
    expected: { decision: 'deny' },
  },
  {
    factory: 'deny',
    output: SenpiHookOutputBuilder.deny('   \n\t '),
    expected: { decision: 'deny' },
  },
  {
    factory: 'deny',
    output: SenpiHookOutputBuilder.deny(undefined),
    expected: { decision: 'deny' },
  },
  {
    factory: 'ask',
    output: SenpiHookOutputBuilder.ask('confirm overwrite'),
    expected: { decision: 'ask', reason: 'confirm overwrite' },
  },
  {
    factory: 'ask',
    output: SenpiHookOutputBuilder.ask(),
    expected: { decision: 'ask' },
  },
  {
    factory: 'ask',
    output: SenpiHookOutputBuilder.ask('  '),
    expected: { decision: 'ask' },
  },
  {
    factory: 'context',
    output: SenpiHookOutputBuilder.context('remember the failing test'),
    expected: { additionalContext: 'remember the failing test' },
  },
  {
    factory: 'context',
    output: SenpiHookOutputBuilder.context(''),
    expected: {},
  },
  {
    factory: 'context',
    output: SenpiHookOutputBuilder.context('   '),
    expected: {},
  },
  {
    factory: 'updatedInput',
    output: SenpiHookOutputBuilder.updatedInput({ path: '/tmp/x' }),
    expected: { updatedInput: { path: '/tmp/x' } },
  },
  {
    factory: 'updatedInput',
    output: SenpiHookOutputBuilder.updatedInput(null),
    expected: { updatedInput: null },
  },
  {
    factory: 'updatedInput',
    output: SenpiHookOutputBuilder.updatedInput(undefined),
    expected: {},
  },
  {
    factory: 'updatedToolOutput',
    output: SenpiHookOutputBuilder.updatedToolOutput({ ok: true }),
    expected: { updatedToolOutput: { ok: true } },
  },
  {
    factory: 'updatedToolOutput',
    output: SenpiHookOutputBuilder.updatedToolOutput(null),
    expected: { updatedToolOutput: null },
  },
  {
    factory: 'updatedToolOutput',
    output: SenpiHookOutputBuilder.updatedToolOutput(undefined),
    expected: {},
  },
  {
    factory: 'forceStop',
    output: SenpiHookOutputBuilder.forceStop('user interrupted'),
    expected: { continue: false, stopReason: 'user interrupted' },
  },
  {
    factory: 'forceStop',
    output: SenpiHookOutputBuilder.forceStop(),
    expected: { continue: false },
  },
  {
    factory: 'forceStop',
    output: SenpiHookOutputBuilder.forceStop(''),
    expected: { continue: false },
  },
  {
    factory: 'forceStop',
    output: SenpiHookOutputBuilder.forceStop(undefined),
    expected: { continue: false },
  },
  {
    factory: 'systemMessage',
    output: SenpiHookOutputBuilder.systemMessage('hook note'),
    expected: { systemMessage: 'hook note' },
  },
  {
    factory: 'systemMessage',
    output: SenpiHookOutputBuilder.systemMessage(''),
    expected: {},
  },
  {
    factory: 'success',
    output: SenpiHookOutputBuilder.success(),
    expected: {},
  },
  {
    factory: 'success',
    output: SenpiHookOutputBuilder.success('hook ran fine'),
    expected: {},
  },
  {
    factory: 'error',
    output: SenpiHookOutputBuilder.error('hook backend unreachable'),
    expected: { continue: false, stopReason: 'hook backend unreachable' },
  },
  {
    factory: 'error',
    output: SenpiHookOutputBuilder.error(''),
    expected: { continue: false },
  },
];

describe('SenpiHookOutputBuilder surface', () => {
  it('exposes exactly the documented factories', () => {
    expect(Object.keys(SenpiHookOutputBuilder).sort()).toEqual([
      'approve',
      'ask',
      'block',
      'context',
      'deny',
      'error',
      'forceStop',
      'success',
      'systemMessage',
      'updatedInput',
      'updatedToolOutput',
    ]);
  });
});

describe('SenpiHookOutputBuilder factory/schema round-trip table', () => {
  it.each(FACTORY_TABLE)(
    '$factory -> $expected',
    ({ factory, output, expected }) => {
      expect(factory.length).toBeGreaterThan(0);
      expect(output).toEqual(expected);
      const parsed = senpiHookOutputSchema.parse(output);
      expect(parsed).toEqual(expected);
      const serialized: unknown = JSON.parse(JSON.stringify(output));
      expect(senpiHookOutputSchema.parse(serialized)).toEqual(expected);
    }
  );

  it('covers every factory name in the table', () => {
    const named = new Set(FACTORY_TABLE.map(row => row.factory));
    expect([...named].sort()).toEqual([
      'approve',
      'ask',
      'block',
      'context',
      'deny',
      'error',
      'forceStop',
      'success',
      'systemMessage',
      'updatedInput',
      'updatedToolOutput',
    ]);
  });

  it('empty deny reason is omitted (parser text() fallback, no default message)', () => {
    const omitted = SenpiHookOutputBuilder.deny();
    const empty = SenpiHookOutputBuilder.deny('');
    const blank = SenpiHookOutputBuilder.deny('   ');
    expect(omitted).toEqual({ decision: 'deny' });
    expect(empty).toEqual({ decision: 'deny' });
    expect(blank).toEqual({ decision: 'deny' });
    expect('reason' in omitted).toBe(false);
    expect('reason' in empty).toBe(false);
    expect('reason' in blank).toBe(false);
    expect(senpiHookOutputSchema.parse(empty)).toEqual({ decision: 'deny' });
  });
});
