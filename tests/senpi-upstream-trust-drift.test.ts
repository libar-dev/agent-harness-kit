import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptySenpiHookTrustState,
  SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS,
  SENPI_HOOK_TRUST_STATE_VERSION,
  senpiHashCommandHook,
  senpiHookTrustId,
  type SenpiTrustCommandHookHandler,
} from '../src/senpi/trust.js';
import {
  extractStringUnion,
  extractTypeObjectFields,
} from './senpi-upstream-dts-utils.js';
import {
  extractDefaultTimeoutSeconds,
  extractFinalReturnObjectKeys,
  extractInputPropertyReads,
  extractScopeEqualityLiterals,
  extractTrustAlgorithm,
} from './senpi-upstream-runtime-utils.js';
import { productionAcceptedScopes } from './senpi-upstream-trust-probe-utils.js';

const ROOT = path.join(process.cwd(), 'docs/upstream/senpi');
const TYPES = path.join(ROOT, 'hooks/types.d.ts');
const TRUST_JS = path.join(ROOT, 'hooks/trust.js');
const SAFETY_DTS = path.join(ROOT, 'hooks/safety.d.ts');
const TRUST_TS = path.join(process.cwd(), 'src/senpi/trust.ts');
const read = (p: string): string => readFileSync(p, 'utf8');

function sampleHandler(): SenpiTrustCommandHookHandler {
  return {
    event: 'PreToolUse',
    groupIndex: 0,
    handlerIndex: 0,
    config: { type: 'command', command: 'echo trust-pin' },
    source: { scope: 'project', sourcePath: '/repo/.senpi/hooks.json' },
  };
}

describe('senpi hook trust runtime upstream drift', () => {
  it('matches parseHookTrustState return keys against production both ways', () => {
    const returnKeys = extractFinalReturnObjectKeys(
      read(TRUST_JS),
      'parseHookTrustState'
    );
    const productionKeys = Object.keys(emptySenpiHookTrustState()).sort();
    const dtsKeys = extractTypeObjectFields(read(TYPES), 'HookTrustState')
      .map(f => f.name)
      .sort();
    expect(returnKeys).toEqual(productionKeys);
    expect(productionKeys).toEqual(returnKeys);
    expect(dtsKeys).toEqual(returnKeys);
    expect(returnKeys).toEqual(dtsKeys);
    expect(emptySenpiHookTrustState().version).toBe(
      SENPI_HOOK_TRUST_STATE_VERSION
    );
  });

  it('matches parseHookTrustEntry field names vs types.d.ts both ways', () => {
    const jsFields = extractInputPropertyReads(
      read(TRUST_JS),
      'parseHookTrustEntry'
    );
    const dtsFields = extractTypeObjectFields(read(TYPES), 'HookTrustEntry')
      .map(f => f.name)
      .sort();
    expect(jsFields).toEqual(dtsFields);
    expect(dtsFields).toEqual(jsFields);
  });

  it('matches scopes bidirectionally across trust.js, trust.ts, types.d.ts, reader', () => {
    const upstream = extractScopeEqualityLiterals(read(TRUST_JS));
    const productionSource = extractScopeEqualityLiterals(read(TRUST_TS));
    const dts = extractStringUnion(read(TYPES), 'HookSourceScope').sort();
    const reader = productionAcceptedScopes([
      ...new Set([...upstream, ...productionSource, 'enterprise', 'user']),
    ]);
    expect(upstream).toEqual(productionSource);
    expect(productionSource).toEqual(upstream);
    expect(upstream).toEqual(dts);
    expect(dts).toEqual(upstream);
    expect(reader).toEqual(upstream);
    expect(upstream).toEqual(reader);
  });

  it('matches trust algorithm values against kit hash/id behavior', () => {
    const algorithm = extractTrustAlgorithm(read(TRUST_JS));
    const timeout = extractDefaultTimeoutSeconds(read(SAFETY_DTS));
    const handler = sampleHandler();
    const id = senpiHookTrustId(handler);
    const hash = senpiHashCommandHook(handler);
    expect(id.startsWith(algorithm.idPrefix)).toBe(true);
    expect(id.slice(algorithm.idPrefix.length).split('_')[0]?.length).toBe(
      algorithm.sourceKeyHashLength
    );
    expect(hash.startsWith(algorithm.hashPrefix)).toBe(true);
    expect(hash).toBe(
      senpiHashCommandHook({
        ...handler,
        config: {
          ...handler.config,
          timeout: SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS,
        },
      })
    );
    expect(SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS).toBe(timeout);
    expect(timeout).toBe(SENPI_DEFAULT_HOOK_TIMEOUT_SECONDS);
  });
});
