import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GrokHookOutputBuilder,
  type GrokGateOutput,
  type GrokStopOutput,
} from '../src/grok/output-builder.js';
import {
  grokGateOutputSchema,
  grokStopOutputSchema,
} from '../src/grok/validation.js';

function roundTripGate(output: GrokGateOutput): GrokGateOutput {
  const serialized: unknown = JSON.parse(JSON.stringify(output));
  return grokGateOutputSchema.parse(serialized);
}

function roundTripStop(output: GrokStopOutput): GrokStopOutput {
  const serialized: unknown = JSON.parse(JSON.stringify(output));
  return grokStopOutputSchema.parse(serialized);
}

describe('GrokHookOutputBuilder surface', () => {
  it('exposes exactly the gate, stop, and universal factories', () => {
    expect(Object.keys(GrokHookOutputBuilder).sort()).toEqual([
      'error',
      'gateAllow',
      'gateDeny',
      'stopApprove',
      'stopBlock',
      'stopContext',
      'stopForce',
      'success',
    ]);
  });

  it('exposes schema-inferred output types', () => {
    const gate: GrokGateOutput = GrokHookOutputBuilder.gateAllow();
    const stop: GrokStopOutput = GrokHookOutputBuilder.stopApprove();
    expect(gate.decision).toBe('allow');
    expect(stop.decision).toBe('approve');
  });
});

describe('GrokHookOutputBuilder gate outputs', () => {
  it('gateAllow emits an allow decision that round-trips the gate schema', () => {
    const output = GrokHookOutputBuilder.gateAllow();
    expect(output).toEqual({ decision: 'allow' });
    expect(roundTripGate(output)).toEqual(output);
  });

  it('gateDeny emits a nonblank reason verbatim', () => {
    const output = GrokHookOutputBuilder.gateDeny('writes are not allowed');
    expect(output).toEqual({
      decision: 'deny',
      reason: 'writes are not allowed',
    });
    expect(roundTripGate(output)).toEqual(output);
  });

  it('gateDeny without a reason emits the decision only', () => {
    const output = GrokHookOutputBuilder.gateDeny();
    expect(output).toEqual({ decision: 'deny' });
    expect(roundTripGate(output)).toEqual(output);
  });

  it('gateDeny omits a blank reason (upstream falls back to stderr/default)', () => {
    expect(GrokHookOutputBuilder.gateDeny('')).toEqual({ decision: 'deny' });
    expect(GrokHookOutputBuilder.gateDeny('   \n ')).toEqual({
      decision: 'deny',
    });
    expect(roundTripGate(GrokHookOutputBuilder.gateDeny('  '))).toEqual({
      decision: 'deny',
    });
  });
});

describe('GrokHookOutputBuilder stop outputs', () => {
  it('stopBlock emits a block decision with a nonblank reason', () => {
    const output = GrokHookOutputBuilder.stopBlock('finish the tests first');
    expect(output).toEqual({
      decision: 'block',
      reason: 'finish the tests first',
    });
    expect(roundTripStop(output)).toEqual(output);
  });

  it('stopBlock omits an omitted or blank reason (upstream default message)', () => {
    expect(GrokHookOutputBuilder.stopBlock()).toEqual({ decision: 'block' });
    expect(GrokHookOutputBuilder.stopBlock('  ')).toEqual({
      decision: 'block',
    });
    expect(roundTripStop(GrokHookOutputBuilder.stopBlock())).toEqual({
      decision: 'block',
    });
  });

  it('stopApprove emits an approve decision', () => {
    const output = GrokHookOutputBuilder.stopApprove();
    expect(output).toEqual({ decision: 'approve' });
    expect(roundTripStop(output)).toEqual(output);
  });

  it('stopForce emits continue:false with an optional stopReason', () => {
    expect(GrokHookOutputBuilder.stopForce()).toEqual({ continue: false });
    expect(GrokHookOutputBuilder.stopForce('user interrupted')).toEqual({
      continue: false,
      stopReason: 'user interrupted',
    });
    expect(roundTripStop(GrokHookOutputBuilder.stopForce('done'))).toEqual({
      continue: false,
      stopReason: 'done',
    });
  });

  it('stopForce serializes a blank stopReason verbatim (no upstream filter)', () => {
    const output = GrokHookOutputBuilder.stopForce('');
    expect(output).toEqual({ continue: false, stopReason: '' });
    expect(roundTripStop(output)).toEqual(output);
  });

  it('stopContext nests nonblank context under hookSpecificOutput', () => {
    const output = GrokHookOutputBuilder.stopContext(
      '3 tests still fail in tail.test.ts'
    );
    expect(output).toEqual({
      hookSpecificOutput: {
        additionalContext: '3 tests still fail in tail.test.ts',
      },
    });
    expect(roundTripStop(output)).toEqual(output);
  });

  it('stopContext omits blank context, matching the upstream nonblank rule', () => {
    expect(GrokHookOutputBuilder.stopContext('')).toEqual({});
    expect(GrokHookOutputBuilder.stopContext('  \n\t ')).toEqual({});
    expect(roundTripStop(GrokHookOutputBuilder.stopContext(''))).toEqual({});
  });
});

describe('GrokHookOutputBuilder universal helpers', () => {
  it('success emits an empty output and never serializes the message', () => {
    expect(GrokHookOutputBuilder.success()).toEqual({});
    expect(GrokHookOutputBuilder.success('hook ran fine')).toEqual({});
    expect(JSON.stringify(GrokHookOutputBuilder.success('hook ran fine'))).toBe(
      '{}'
    );
    expect(
      roundTripStop(GrokHookOutputBuilder.success('hook ran fine'))
    ).toEqual({});
  });

  it('error emits a force-stop carrying the reason', () => {
    const output = GrokHookOutputBuilder.error('hook backend unreachable');
    expect(output).toEqual({
      continue: false,
      stopReason: 'hook backend unreachable',
    });
    expect(roundTripStop(output)).toEqual(output);
  });
});

describe('Grok output schema authority', () => {
  it('rejects an unknown gate decision literal', () => {
    expect(() => grokGateOutputSchema.parse({ decision: 'maybe' })).toThrow(
      z.ZodError
    );
  });

  it('rejects stop-vocabulary decisions in the gate schema', () => {
    expect(() => grokGateOutputSchema.parse({ decision: 'block' })).toThrow(
      z.ZodError
    );
  });

  it('rejects gate-vocabulary decisions in the stop schema', () => {
    expect(() => grokStopOutputSchema.parse({ decision: 'deny' })).toThrow(
      z.ZodError
    );
  });

  it('requires a decision in gate output', () => {
    expect(() => grokGateOutputSchema.parse({})).toThrow(z.ZodError);
    expect(() => grokGateOutputSchema.parse({ reason: 'x' })).toThrow(
      z.ZodError
    );
  });

  it('rejects non-string reasons and mistyped stop fields', () => {
    expect(() =>
      grokGateOutputSchema.parse({ decision: 'deny', reason: 42 })
    ).toThrow(z.ZodError);
    expect(() => grokStopOutputSchema.parse({ continue: 'false' })).toThrow(
      z.ZodError
    );
    expect(() => grokStopOutputSchema.parse({ stopReason: 7 })).toThrow(
      z.ZodError
    );
    expect(() =>
      grokStopOutputSchema.parse({ hookSpecificOutput: 'nope' })
    ).toThrow(z.ZodError);
  });

  it('accepts a fully combined stop output (all StopHookJson fields)', () => {
    const combined = {
      decision: 'block',
      reason: 'keep going',
      continue: false,
      stopReason: 'user asked to halt',
      hookSpecificOutput: { additionalContext: 'remember the failing test' },
    };
    expect(grokStopOutputSchema.parse(combined)).toEqual(combined);
  });

  it('tolerates unknown extra fields like the upstream serde structs', () => {
    expect(
      grokGateOutputSchema.parse({ decision: 'allow', futureField: true })
    ).toMatchObject({ decision: 'allow' });
    expect(
      grokStopOutputSchema.parse({ futureField: { nested: 1 } })
    ).toMatchObject({});
  });
});
