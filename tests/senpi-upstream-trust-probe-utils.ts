/**
 * Production trust reader probes for drift pins (test-only).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  emptySenpiHookTrustState,
  readSenpiHookTrustState,
  SENPI_HOOK_TRUST_STATE_VERSION,
} from '../src/senpi/trust.js';
import type { FieldContract } from './senpi-upstream-dts-utils.js';

export const ENTRY_BASE: Record<string, unknown> = {
  enabled: true,
  scope: 'project',
  sourcePath: '/x',
  commandPreview: 'echo',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function readEntry(
  entry: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
  const root = mkdtempSync(path.join(tmpdir(), 'senpi-entry-'));
  try {
    const fp = path.join(root, 's.json');
    writeFileSync(
      fp,
      `${JSON.stringify({
        version: SENPI_HOOK_TRUST_STATE_VERSION,
        hooks: { sample: entry },
      })}\n`
    );
    const result = readSenpiHookTrustState(fp);
    if (!result.ok) return undefined;
    const got = result.state.hooks['sample'];
    if (got === undefined) return undefined;
    return { ...got };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function readStateOk(state: Record<string, unknown>): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'senpi-state-'));
  try {
    const fp = path.join(root, 's.json');
    writeFileSync(fp, `${JSON.stringify(state)}\n`);
    return readSenpiHookTrustState(fp).ok;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Production entry field descriptors via reader accept/reject probes. */
export function productionEntryContracts(scopeUnion: string): FieldContract[] {
  const names = [
    'enabled',
    'trustedHash',
    'scope',
    'sourcePath',
    'matcher',
    'commandPreview',
    'updatedAt',
  ] as const;
  if (readEntry(ENTRY_BASE) === undefined) {
    throw new Error('base entry rejected');
  }
  return names.map(name => {
    const omitted: Record<string, unknown> = { ...ENTRY_BASE };
    delete omitted[name];
    const required = readEntry(omitted) === undefined;
    if (name === 'enabled') {
      if (readEntry({ ...ENTRY_BASE, enabled: 'x' }) !== undefined) {
        throw new Error('enabled accepted string');
      }
      return { name, required, type: 'boolean' };
    }
    if (name === 'scope') {
      // Primitive category: non-strings must be rejected (bidirectional with string-literal contract).
      for (const bad of [1, true, null, {}, []] as const) {
        if (readEntry({ ...ENTRY_BASE, scope: bad }) !== undefined) {
          throw new Error(`scope accepted non-string ${String(bad)}`);
        }
      }
      return { name, required, type: scopeUnion };
    }
    if (readEntry({ ...ENTRY_BASE, [name]: 1 }) !== undefined) {
      throw new Error(`${name} accepted number`);
    }
    return { name, required, type: 'string' };
  });
}

/** Production HookTrustState field descriptors via empty + reader omission probes. */
export function productionStateContracts(): FieldContract[] {
  const empty = emptySenpiHookTrustState();
  if (empty.version !== SENPI_HOOK_TRUST_STATE_VERSION) {
    throw new Error('empty state version mismatch');
  }
  if (!readStateOk({ version: SENPI_HOOK_TRUST_STATE_VERSION, hooks: {} })) {
    throw new Error('valid empty state rejected');
  }
  if (readStateOk({ version: SENPI_HOOK_TRUST_STATE_VERSION + 1, hooks: {} })) {
    throw new Error('wrong version accepted');
  }
  if (readStateOk({ version: SENPI_HOOK_TRUST_STATE_VERSION, hooks: 'x' })) {
    throw new Error('string hooks accepted');
  }
  // Requiredness from actual omission probes through the production reader.
  const versionRequired = !readStateOk({ hooks: {} });
  const hooksRequired = !readStateOk({
    version: SENPI_HOOK_TRUST_STATE_VERSION,
  });
  if (!versionRequired) throw new Error('missing version accepted');
  if (!hooksRequired) throw new Error('missing hooks accepted');
  return [
    {
      name: 'version',
      required: versionRequired,
      type: String(SENPI_HOOK_TRUST_STATE_VERSION),
    },
    { name: 'hooks', required: hooksRequired, type: 'object' },
  ];
}

export function normalizeStateDts(fields: FieldContract[]): FieldContract[] {
  return fields.map(f =>
    f.name === 'hooks' && /Record</.test(f.type)
      ? { name: f.name, required: f.required, type: 'object' }
      : f
  );
}

export function productionAcceptedScopes(
  probeScopes: readonly string[]
): string[] {
  const accepted = probeScopes.filter(
    scope => readEntry({ ...ENTRY_BASE, scope }) !== undefined
  );
  if (accepted.length === 0) {
    throw new Error('Production reader accepted no probe scopes');
  }
  return accepted.sort();
}
