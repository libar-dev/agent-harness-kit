import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as forwarder from '../src/forwarder/index.js';
import * as senpi from '../src/senpi/index.js';
import * as senpiProcessing from '../src/senpi/processing/index.js';
import type { SenpiTrustCommandHookHandler } from '../src/senpi/trust.js';

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    const dir = CLEANUP_DIRS.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'senpi-contracts-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

function listRelativeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full.slice(root.length + 1));
      }
    }
  };
  if (existsSync(root)) {
    walk(root);
  }
  return found.sort();
}

function snapshotTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const relative of listRelativeFiles(root)) {
    tree[relative] = readFileSync(join(root, relative), 'utf8');
  }
  return tree;
}

function writeHooksUnknown(options: unknown): Promise<unknown> {
  const result: unknown = Reflect.apply(
    senpi.writeSenpiHooksConfig,
    undefined,
    [options]
  );
  return Promise.resolve(result);
}

function removeHooksUnknown(options: unknown): Promise<unknown> {
  const result: unknown = Reflect.apply(
    senpi.removeSenpiHooksConfig,
    undefined,
    [options]
  );
  return Promise.resolve(result);
}

function removeTrustUnknown(options: unknown): Promise<unknown> {
  const result: unknown = Reflect.apply(
    senpi.removeSenpiHookTrustEntry,
    undefined,
    [options]
  );
  return Promise.resolve(result);
}

function makeHandler(): SenpiTrustCommandHookHandler {
  return {
    event: 'PreToolUse',
    matcher: 'Bash',
    groupIndex: 0,
    handlerIndex: 0,
    config: {
      type: 'command',
      command: 'node ./dist/standalone/hook-forwarder-senpi.mjs',
    },
    source: {
      scope: 'global',
      sourcePath: '/tmp/isolated/.omo/agent/hooks.json',
    },
  };
}

const DOCUMENTED_SENPI_MUTATION_EXPORTS = [
  'writeSenpiHooksConfig',
  'readSenpiHooksConfig',
  'removeSenpiHooksConfig',
  'writeSenpiHookTrustEntry',
  'removeSenpiHookTrustEntry',
  'readSenpiHookTrustState',
  'resolveSenpiHooksConfigPath',
  'resolveSenpiHookTrustStatePath',
  'SenpiHooksConsentError',
  'SenpiTrustConsentError',
] as const;

const DOCUMENTED_FORWARDER_EXPORTS = [
  'RUN_HOOK_WRAPPER_SH',
  'STANDALONE_HOOK_FORWARDER_ASSET',
  'STANDALONE_SENPI_HOOK_FORWARDER_ASSET',
] as const;

describe('senpi contract freeze - documented exports', () => {
  it('covers every documented hook/trust/registration/forwarder export', () => {
    for (const name of DOCUMENTED_SENPI_MUTATION_EXPORTS) {
      expect(senpi, name).toHaveProperty(name);
    }
    for (const name of DOCUMENTED_FORWARDER_EXPORTS) {
      expect(forwarder, name).toHaveProperty(name);
    }
    expect(typeof forwarder.RUN_HOOK_WRAPPER_SH).toBe('string');
    expect(forwarder.STANDALONE_HOOK_FORWARDER_ASSET).toBe(
      'dist/standalone/hook-forwarder.mjs'
    );
    expect(forwarder.STANDALONE_SENPI_HOOK_FORWARDER_ASSET).toBe(
      'dist/standalone/hook-forwarder-senpi.mjs'
    );
  });

  it('covers every export named in the senpi-adapter reference tables', () => {
    const markdown = readFileSync('docs/reference/senpi-adapter.md', 'utf8');
    const named = [
      ...markdown.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)`\s+\|/gm),
    ].map(match => match[1] ?? '');
    const publicNames = new Set([
      ...Object.keys(senpi),
      ...Object.keys(senpiProcessing),
      ...Object.keys(forwarder),
    ]);
    const kitExports = named.filter(name =>
      /^(AGENT_|HOOK_|SENPI_|Senpi|senpi|buildSenpi|writeSenpi|readSenpi|removeSenpi|resolveSenpi|isSenpi|executeSenpi|outputSenpi|validateSenpi|STANDALONE_|RUN_HOOK_)/.test(
        name
      )
    );
    expect(kitExports.length).toBeGreaterThan(10);
    for (const name of kitExports) {
      expect(publicNames.has(name), name).toBe(true);
    }
  });

  it('does not write on module import', () => {
    const home = tempHome();
    mkdirSync(join(home, '.omo', 'agent'), { recursive: true });
    writeFileSync(join(home, '.omo', 'agent', 'settings.json'), '{}\n');
    const before = snapshotTree(home);
    expect(listRelativeFiles(home)).toEqual(['.omo/agent/settings.json']);
    expect(before).toEqual(snapshotTree(home));
    expect(existsSync(join(home, 'hooks.json'))).toBe(false);
    expect(existsSync(join(home, '.omo', 'agent', 'hooks.json'))).toBe(false);
    expect(existsSync(join(home, '.omo', 'agent', 'hooks-state.json'))).toBe(
      false
    );
  });
});

describe('senpi contract freeze - mutation consent/target gate', () => {
  it('rejects writeSenpiHooksConfig without an options object before any write', async () => {
    const home = tempHome();

    await expect(
      writeHooksUnknown(join(home, 'hooks.json'))
    ).rejects.toBeInstanceOf(senpi.SenpiHooksConsentError);
    expect(existsSync(home)).toBe(true);
    expect(listRelativeFiles(home)).toEqual([]);
  });

  it('rejects omitted consent and omitted target before any write', async () => {
    const home = join(tempHome(), 'missing-home');
    const document = senpi.buildSenpiHooksRegistration(['Stop'], 'observe');

    await expect(
      writeHooksUnknown({
        reason: 'no consent field',
        target: { scope: 'global', agentHome: home },
        document,
      })
    ).rejects.toBeInstanceOf(senpi.SenpiHooksConsentError);

    await expect(
      writeHooksUnknown({
        consent: true,
        reason: 'missing target',
        document,
      })
    ).rejects.toBeInstanceOf(senpi.SenpiHooksConsentError);

    await expect(
      removeHooksUnknown({
        consent: true,
        reason: 'missing target',
      })
    ).rejects.toBeInstanceOf(senpi.SenpiHooksConsentError);

    await expect(
      removeTrustUnknown({
        consent: false,
        reason: 'explicit denial',
        handler: makeHandler(),
        scope: 'global',
        agentHome: home,
        cwd: home,
      })
    ).rejects.toBeInstanceOf(senpi.SenpiTrustConsentError);

    expect(existsSync(home)).toBe(false);
  });
});

describe('senpi contract freeze - reversible register/inspect/unregister', () => {
  it('registers, inspects, and unregisters against an isolated OmO home', async () => {
    const root = tempHome();
    const agentHome = join(root, '.omo', 'agent');
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(agentHome, 'settings.json'), '{}\n', 'utf8');
    const original = snapshotTree(root);

    const document = senpi.buildSenpiHooksRegistration(
      ['PreToolUse', 'Stop'],
      'node ./dist/standalone/hook-forwarder-senpi.mjs'
    );
    const target = { scope: 'global' as const, agentHome };
    expect(senpi.resolveSenpiHooksConfigPath(target)).toBe(
      join(agentHome, 'hooks.json')
    );

    await senpi.writeSenpiHooksConfig({
      consent: true,
      reason: 'isolated contract QA register',
      target,
      document,
    });

    const inspected = senpi.readSenpiHooksConfig({ target });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) {
      throw new Error('expected readable hooks config');
    }
    expect(inspected.path).toBe(join(agentHome, 'hooks.json'));
    expect(inspected.document).toEqual(document);
    expect(existsSync(join(agentHome, 'hooks.json'))).toBe(true);

    const handler = makeHandler();
    await senpi.writeSenpiHookTrustEntry({
      consent: true,
      reason: 'isolated contract QA trust grant',
      handler,
      scope: 'global',
      agentHome,
      cwd: root,
      platform: 'linux',
    });

    const trustState = senpi.readSenpiHookTrustState(
      join(agentHome, 'hooks-state.json')
    );
    expect(trustState.ok).toBe(true);
    if (!trustState.ok) {
      throw new Error('expected readable trust state');
    }
    expect(
      senpi.isSenpiCommandHookTrusted(handler, trustState.state, {
        platform: 'linux',
      })
    ).toBe(true);

    await senpi.removeSenpiHookTrustEntry({
      consent: true,
      reason: 'isolated contract QA trust revoke',
      handler,
      scope: 'global',
      agentHome,
      cwd: root,
    });
    await senpi.removeSenpiHooksConfig({
      consent: true,
      reason: 'isolated contract QA unregister',
      target,
    });

    const afterUnregister = senpi.readSenpiHooksConfig({ target });
    expect(afterUnregister.ok).toBe(true);
    if (!afterUnregister.ok) {
      throw new Error('expected readable missing hooks config');
    }
    expect(afterUnregister.document).toBeNull();
    expect(snapshotTree(root)).toEqual(original);
    expect(statSync(join(agentHome, 'settings.json')).isFile()).toBe(true);
  });
});
