import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  assertFieldContractsEqual,
  extractTypeObjectFields,
} from './senpi-upstream-dts-utils.js';
import { extractScopeEqualityLiterals } from './senpi-upstream-runtime-utils.js';
import {
  normalizeStateDts,
  productionEntryContracts,
  productionStateContracts,
} from './senpi-upstream-trust-probe-utils.js';

const ROOT = path.join(process.cwd(), 'docs/upstream/senpi');
const TYPES = path.join(ROOT, 'hooks/types.d.ts');
const TRUST_JS = path.join(ROOT, 'hooks/trust.js');
const read = (p: string): string => readFileSync(p, 'utf8');

function scopeUnion(): string {
  return extractScopeEqualityLiterals(read(TRUST_JS))
    .slice()
    .sort()
    .map(s => `"${s}"`)
    .join(' | ');
}

describe('senpi hook trust shape upstream drift', () => {
  it('matches HookTrustState field types/requiredness against production both ways', () => {
    const dts = normalizeStateDts(
      extractTypeObjectFields(read(TYPES), 'HookTrustState')
    );
    const production = productionStateContracts();
    assertFieldContractsEqual(dts, production, 'state dts→production');
    assertFieldContractsEqual(production, dts, 'state production→dts');
  });

  it('matches HookTrustEntry field types/requiredness against production both ways', () => {
    const dts = extractTypeObjectFields(read(TYPES), 'HookTrustEntry');
    const production = productionEntryContracts(scopeUnion());
    assertFieldContractsEqual(dts, production, 'entry dts→production');
    assertFieldContractsEqual(production, dts, 'entry production→dts');
  });
});
