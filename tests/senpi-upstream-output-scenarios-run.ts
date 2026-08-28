/**
 * Run all output scenarios with lossless equality of output + full diagnostics.
 * Schema check uses string-key projection only; equality uses raw own keys.
 */

import { senpiHookOutputSchema } from '../src/senpi/hook-wire.js';
import { buildOutputScenariosA } from './senpi-upstream-output-scenarios-a.js';
import { buildOutputScenariosB } from './senpi-upstream-output-scenarios-b.js';
import { buildOutputScenariosC } from './senpi-upstream-output-scenarios-c.js';
import {
  PARSER_SOURCE,
  type ParseHookOutputFn,
  type Scenario,
} from './senpi-upstream-output-scenarios-types.js';
import { strictEqual } from './senpi-upstream-strict-eq.js';

function isOwnKeyed(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireOwnKeyed(
  value: unknown,
  label: string
): asserts value is Record<PropertyKey, unknown> {
  if (!isOwnKeyed(value)) throw new Error(`${label}: expected object`);
}

function stringKeyView(value: unknown): Record<string, unknown> {
  requireOwnKeyed(value, 'stringKeyView');
  const out: Record<string, unknown> = {};
  for (const k of Reflect.ownKeys(value)) {
    if (typeof k === 'string') out[k] = Reflect.get(value, k);
  }
  return out;
}

function scenarioInput(s: Scenario): {
  readonly event: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly source: typeof PARSER_SOURCE;
} {
  const exitCode = s.exitCode ?? 0;
  const stdout =
    exitCode === 2
      ? ''
      : s.body === undefined
        ? ''
        : typeof s.body === 'string'
          ? s.body
          : JSON.stringify(s.body);
  return {
    event: s.event,
    exitCode,
    stdout,
    stderr: s.stderr ?? '',
    source: PARSER_SOURCE,
  };
}

export function allOutputScenarios(): Scenario[] {
  return [
    ...buildOutputScenariosA(),
    ...buildOutputScenariosB(),
    ...buildOutputScenariosC(),
  ];
}

function runOne(parse: ParseHookOutputFn, s: Scenario): void {
  const result = parse(scenarioInput(s));
  requireOwnKeyed(result.output, s.id);
  if (!Array.isArray(result.diagnostics)) {
    throw new Error(`${s.id}: diagnostics not array`);
  }
  const checked = senpiHookOutputSchema.safeParse(stringKeyView(result.output));
  if (!checked.success) {
    throw new Error(`${s.id}: schema reject ${checked.error.message}`);
  }
  if (!strictEqual(result.output, s.expectOutput)) {
    throw new Error(`${s.id}: output mismatch`);
  }
  // Compare raw diagnostics arrays (preserve holes, '01', symbols, undefined).
  if (!strictEqual(result.diagnostics, s.expectDiagnostics ?? [])) {
    throw new Error(`${s.id}: diag mismatch`);
  }
}

export function runAllOutputScenarios(parse: ParseHookOutputFn): number {
  const scenarios = allOutputScenarios();
  for (const s of scenarios) runOne(parse, s);
  return scenarios.length;
}

/** Lossless parity between two parsers on the full scenario matrix. */
export function assertOutputParseParity(
  a: ParseHookOutputFn,
  b: ParseHookOutputFn
): void {
  for (const s of allOutputScenarios()) {
    const input = scenarioInput(s);
    const ra = a(input);
    const rb = b(input);
    if (!strictEqual(ra.output, rb.output)) {
      throw new Error(`${s.id}: instrumented output diverged`);
    }
    if (!strictEqual(ra.diagnostics, rb.diagnostics)) {
      throw new Error(`${s.id}: instrumented diagnostics diverged`);
    }
  }
}
