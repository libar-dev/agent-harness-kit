import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOME_SENTINEL,
  resolveSenpiAgentHome,
} from '../src/senpi/home.js';
import { SENPI_PROJECT_CONFIG_DIR } from '../src/senpi/trust.js';
import {
  extractSettingsLocationPaths,
  settingsMdPinSha256,
} from './senpi-upstream-runtime-utils.js';

const ROOT = path.join(process.cwd(), 'docs/upstream/senpi');
const SETTINGS_MD = path.join(ROOT, 'settings.md');
const PIN_JSON = path.join(ROOT, 'pin.json');
const read = (p: string): string => readFileSync(p, 'utf8');
const sha256 = (p: string): string =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

describe('senpi settings.md upstream drift', () => {
  it('matches pin.json sha256 for settings.md', () => {
    expect(sha256(SETTINGS_MD)).toBe(settingsMdPinSha256(read(PIN_JSON)));
  });

  it('matches settings location tokens against production home/project contracts', () => {
    const { globalPath, projectPath } = extractSettingsLocationPaths(
      read(SETTINGS_MD)
    );
    expect(path.posix.basename(globalPath)).toBe(AGENT_HOME_SENTINEL);
    expect(path.posix.basename(projectPath)).toBe(AGENT_HOME_SENTINEL);
    const projectDir = projectPath.split('/')[0];
    expect(projectDir).toBe(SENPI_PROJECT_CONFIG_DIR);
    expect(SENPI_PROJECT_CONFIG_DIR).toBe(projectDir);
    const segs = globalPath.replace(/^~\//, '').split('/');
    expect(segs[0]).toBe(SENPI_PROJECT_CONFIG_DIR);
    expect(segs[1]).toBe('agent');
    expect(segs[2]).toBe(AGENT_HOME_SENTINEL);
    expect(
      resolveSenpiAgentHome({
        homeDir: '/tmp/senpi-drift-home',
        env: {},
        exists: () => false,
      })
    ).toBe(
      path.join('/tmp/senpi-drift-home', SENPI_PROJECT_CONFIG_DIR, 'agent')
    );
  });
});
