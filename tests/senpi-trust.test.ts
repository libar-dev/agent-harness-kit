import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  emptySenpiHookTrustState,
  isSenpiCommandHookTrusted,
  readSenpiHookTrustState,
  resolveSenpiHookTrustStatePath,
  SENPI_HOOKS_STATE_FILENAME,
  SENPI_PROJECT_CONFIG_DIR,
  senpiHashCommandHook,
  senpiHookTrustId,
  type SenpiHookTrustState,
  type SenpiTrustCommandHookHandler,
} from '../src/senpi/trust.js';

/**
 * Fixed fixture handler for golden hash parity.
 *
 * Platform is always injected as `'linux'` in the golden case so the
 * recorded constants stay cross-machine deterministic.
 */
const GOLDEN_HANDLER: SenpiTrustCommandHookHandler = {
  event: 'PreToolUse',
  matcher: 'Bash',
  groupIndex: 0,
  handlerIndex: 1,
  config: {
    type: 'command',
    command: 'node ./hooks/check.mjs',
    commandWindows: 'node .\\hooks\\check.mjs',
    timeout: 30,
    statusMessage: 'check tools',
  },
  source: {
    scope: 'project',
    sourcePath: '/repo/.senpi/hooks.json',
  },
};

/**
 * Golden constants computed offline from vendored `hooks/trust.js` algorithm
 * with injected platform `'linux'`. These MUST stay literals in source —
 * never recompute via `process.platform` at test time.
 *
 * Cross-check (manual):
 * - sourceKeyHash = sha256("project\\0/repo/.senpi/hooks.json\\0\\0").slice(0,12)
 *   = `f426e074193a`
 * - id = `hk_f426e074193a_PreToolUse_0_1`
 * - canonical identity JSON (sorted keys, undefined omitted):
 *   {"event":"PreToolUse","hook":{"async":false,"command":"node ./hooks/check.mjs",
 *   "commandWindows":"node .\\hooks\\check.mjs","platformCommand":"node ./hooks/check.mjs",
 *   "statusMessage":"check tools","timeout":30,"type":"command"},
 *   "matcher":"Bash","sourceKeyHash":"f426e074193a"}
 * - hash = sha256:<hex of that JSON>
 */
const GOLDEN_PLATFORM = 'linux' as const;
const GOLDEN_TRUST_ID = 'hk_f426e074193a_PreToolUse_0_1';
const GOLDEN_TRUST_HASH =
  'sha256:aaa23e5d68ace327ac8246b67318b7ec2155e73ea633a56aa2e575a38632844b';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'senpi-trust-'));
}

describe('senpi trust — golden hash parity', () => {
  it('senpiHookTrustId matches recorded golden constant (linux fixture)', () => {
    const id = senpiHookTrustId(GOLDEN_HANDLER);
    expect(id).toBe(GOLDEN_TRUST_ID);
  });

  it('senpiHashCommandHook matches recorded golden constant with injected platform', () => {
    const hash = senpiHashCommandHook(GOLDEN_HANDLER, {
      platform: GOLDEN_PLATFORM,
    });
    expect(hash).toBe(GOLDEN_TRUST_HASH);
    // Guard against accidental default-platform golden: win32 differs.
    const winHash = senpiHashCommandHook(GOLDEN_HANDLER, {
      platform: 'win32',
    });
    expect(winHash).not.toBe(GOLDEN_TRUST_HASH);
    expect(winHash).toBe(
      'sha256:fc8ea7fc3d83906c0f19987bb1787dbc3dff500dc8fef601fe3c2b5ac97dfa68'
    );
  });
});

describe('senpi trust — readSenpiHookTrustState fail-closed', () => {
  it('missing file yields empty ok state (no throw)', () => {
    const dir = tempDir();
    const path = join(dir, SENPI_HOOKS_STATE_FILENAME);
    const result = readSenpiHookTrustState(path);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.state).toEqual(emptySenpiHookTrustState());
    expect(result.path).toBe(path);
  });

  it('corrupt JSON yields fail-closed error result, never throws', () => {
    const dir = tempDir();
    const path = join(dir, SENPI_HOOKS_STATE_FILENAME);
    writeFileSync(path, '{not-json!!', 'utf-8');
    const result = readSenpiHookTrustState(path);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected fail-closed');
    }
    expect(result.error).toMatch(/invalid JSON/i);
    expect(result.path).toBe(path);
  });

  it('wrong version yields fail-closed error result', () => {
    const dir = tempDir();
    const path = join(dir, SENPI_HOOKS_STATE_FILENAME);
    writeFileSync(path, JSON.stringify({ version: 99, hooks: {} }), 'utf-8');
    const result = readSenpiHookTrustState(path);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected fail-closed');
    }
    expect(result.error).toMatch(/invalid trust state shape or version/i);
  });

  it('truncated root (hooks not object) yields fail-closed error result', () => {
    const dir = tempDir();
    const path = join(dir, SENPI_HOOKS_STATE_FILENAME);
    writeFileSync(path, JSON.stringify({ version: 1, hooks: [] }), 'utf-8');
    const result = readSenpiHookTrustState(path);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected fail-closed');
    }
    expect(result.error).toMatch(/invalid trust state shape or version/i);
  });

  it('valid v1 state round-trips and preserves trusted entry', () => {
    const dir = tempDir();
    const path = join(dir, SENPI_HOOKS_STATE_FILENAME);
    const state: SenpiHookTrustState = {
      version: 1,
      hooks: {
        [GOLDEN_TRUST_ID]: {
          enabled: true,
          trustedHash: GOLDEN_TRUST_HASH,
          scope: 'project',
          sourcePath: '/repo/.senpi/hooks.json',
          matcher: 'Bash',
          commandPreview: 'node ./hooks/check.mjs',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      },
    };
    writeFileSync(path, JSON.stringify(state), 'utf-8');
    const result = readSenpiHookTrustState(path);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.state.version).toBe(1);
    expect(result.state.hooks[GOLDEN_TRUST_ID]?.trustedHash).toBe(
      GOLDEN_TRUST_HASH
    );
    expect(
      isSenpiCommandHookTrusted(GOLDEN_HANDLER, result.state, {
        platform: GOLDEN_PLATFORM,
      })
    ).toBe(true);
  });

  it('enabled:false entry is not trusted even with matching hash', () => {
    const state: SenpiHookTrustState = {
      version: 1,
      hooks: {
        [GOLDEN_TRUST_ID]: {
          enabled: false,
          trustedHash: GOLDEN_TRUST_HASH,
          scope: 'project',
          sourcePath: '/repo/.senpi/hooks.json',
          commandPreview: 'node ./hooks/check.mjs',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      },
    };
    expect(
      isSenpiCommandHookTrusted(GOLDEN_HANDLER, state, {
        platform: GOLDEN_PLATFORM,
      })
    ).toBe(false);
  });

  it('hash mismatch is not trusted', () => {
    const state: SenpiHookTrustState = {
      version: 1,
      hooks: {
        [GOLDEN_TRUST_ID]: {
          enabled: true,
          trustedHash: 'sha256:deadbeef',
          scope: 'project',
          sourcePath: '/repo/.senpi/hooks.json',
          commandPreview: 'node ./hooks/check.mjs',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      },
    };
    expect(
      isSenpiCommandHookTrusted(GOLDEN_HANDLER, state, {
        platform: GOLDEN_PLATFORM,
      })
    ).toBe(false);
  });
});

describe('senpi trust — scope path resolution', () => {
  it('recognizes global and project state paths', () => {
    const agentHome = '/home/user/.senpi/agent';
    const cwd = '/repo/project';
    expect(resolveSenpiHookTrustStatePath('global', { agentHome, cwd })).toBe(
      join(agentHome, SENPI_HOOKS_STATE_FILENAME)
    );
    expect(resolveSenpiHookTrustStatePath('project', { agentHome, cwd })).toBe(
      join(cwd, SENPI_PROJECT_CONFIG_DIR, SENPI_HOOKS_STATE_FILENAME)
    );
  });

  it('reads state from both global and project path layouts', () => {
    const root = tempDir();
    const agentHome = join(root, 'agent');
    const cwd = join(root, 'project');
    mkdirSync(agentHome, { recursive: true });
    mkdirSync(join(cwd, SENPI_PROJECT_CONFIG_DIR), { recursive: true });

    const globalPath = resolveSenpiHookTrustStatePath('global', {
      agentHome,
      cwd,
    });
    const projectPath = resolveSenpiHookTrustStatePath('project', {
      agentHome,
      cwd,
    });

    writeFileSync(
      globalPath,
      JSON.stringify({
        version: 1,
        hooks: {
          hk_global: {
            enabled: true,
            scope: 'global',
            sourcePath: join(agentHome, 'hooks.json'),
            commandPreview: 'echo global',
            updatedAt: '2026-08-19T00:00:00.000Z',
          },
        },
      }),
      'utf-8'
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        version: 1,
        hooks: {
          hk_project: {
            enabled: true,
            scope: 'project',
            sourcePath: join(cwd, '.senpi', 'hooks.json'),
            commandPreview: 'echo project',
            updatedAt: '2026-08-19T00:00:00.000Z',
          },
        },
      }),
      'utf-8'
    );

    const globalResult = readSenpiHookTrustState(globalPath);
    const projectResult = readSenpiHookTrustState(projectPath);
    expect(globalResult.ok).toBe(true);
    expect(projectResult.ok).toBe(true);
    if (!globalResult.ok || !projectResult.ok) {
      throw new Error('expected both scopes readable');
    }
    expect(globalResult.state.hooks['hk_global']?.scope).toBe('global');
    expect(projectResult.state.hooks['hk_project']?.scope).toBe('project');
  });
});
