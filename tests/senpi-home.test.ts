import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_DIR_ENV_NAMES,
  AGENT_HOME_SENTINEL,
  resolveSenpiAgentHome,
} from '../src/senpi/home.js';

const HOME = '/injected/home';

function existsAt(paths: readonly string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path: string): boolean => present.has(path);
}

interface PrecedenceCase {
  readonly name: string;
  readonly env: Record<string, string | undefined>;
  readonly homeDir: string;
  readonly present: readonly string[];
  readonly expected: string;
}

const precedenceMatrix: readonly PrecedenceCase[] = [
  {
    name: 'env wins over sentinel dirs',
    env: { OMO_CODING_AGENT_DIR: '/custom/omo-home' },
    homeDir: HOME,
    present: [
      join(HOME, '.omo', 'agent', AGENT_HOME_SENTINEL),
      join(HOME, '.omo', AGENT_HOME_SENTINEL),
    ],
    expected: resolve('/custom/omo-home'),
  },
  {
    name: 'first-non-empty env prefers OMO over SENPI and PI',
    env: {
      OMO_CODING_AGENT_DIR: '/from-omo',
      SENPI_CODING_AGENT_DIR: '/from-senpi',
      PI_CODING_AGENT_DIR: '/from-pi',
    },
    homeDir: HOME,
    present: [],
    expected: resolve('/from-omo'),
  },
  {
    name: 'first-non-empty env prefers SENPI when OMO is empty',
    env: {
      OMO_CODING_AGENT_DIR: '',
      SENPI_CODING_AGENT_DIR: '/from-senpi',
      PI_CODING_AGENT_DIR: '/from-pi',
    },
    homeDir: HOME,
    present: [],
    expected: resolve('/from-senpi'),
  },
  {
    name: 'first-non-empty env prefers PI when OMO and SENPI are empty',
    env: {
      OMO_CODING_AGENT_DIR: '',
      SENPI_CODING_AGENT_DIR: '',
      PI_CODING_AGENT_DIR: '/from-pi',
    },
    homeDir: HOME,
    present: [],
    expected: resolve('/from-pi'),
  },
  {
    name: 'empty-string env value is skipped not returned',
    env: {
      OMO_CODING_AGENT_DIR: '',
      SENPI_CODING_AGENT_DIR: '',
      PI_CODING_AGENT_DIR: '',
    },
    homeDir: HOME,
    present: [join(HOME, '.omo', 'agent', AGENT_HOME_SENTINEL)],
    expected: join(HOME, '.omo', 'agent'),
  },
  {
    name: 'whitespace-only env value is skipped not returned',
    env: { OMO_CODING_AGENT_DIR: '   ', SENPI_CODING_AGENT_DIR: '/from-senpi' },
    homeDir: HOME,
    present: [],
    expected: resolve('/from-senpi'),
  },
  {
    name: 'sentinel detection prefers .omo/agent over .omo over fallback',
    env: {},
    homeDir: HOME,
    present: [
      join(HOME, '.omo', 'agent', AGENT_HOME_SENTINEL),
      join(HOME, '.omo', AGENT_HOME_SENTINEL),
    ],
    expected: join(HOME, '.omo', 'agent'),
  },
  {
    name: 'flat fallback uses .omo when it contains the sentinel',
    env: {},
    homeDir: HOME,
    present: [join(HOME, '.omo', AGENT_HOME_SENTINEL)],
    expected: join(HOME, '.omo'),
  },
  {
    name: 'senpi fallback when no env and no sentinel dirs',
    env: {},
    homeDir: HOME,
    present: [],
    expected: join(HOME, '.senpi', 'agent'),
  },
  {
    name: 'homeDir injection is used for sentinel and fallback paths',
    env: {},
    homeDir: '/other/home',
    present: [join('/other/home', '.omo', 'agent', AGENT_HOME_SENTINEL)],
    expected: join('/other/home', '.omo', 'agent'),
  },
  {
    name: 'undefined env entries fall through precedence',
    env: {
      OMO_CODING_AGENT_DIR: undefined,
      SENPI_CODING_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    },
    homeDir: HOME,
    present: [],
    expected: join(HOME, '.senpi', 'agent'),
  },
];

describe('resolveSenpiAgentHome', () => {
  it('exports the sentinel name and env order', () => {
    expect(AGENT_HOME_SENTINEL).toBe('settings.json');
    expect(AGENT_DIR_ENV_NAMES).toEqual([
      'OMO_CODING_AGENT_DIR',
      'SENPI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_DIR',
    ]);
  });

  it.each(precedenceMatrix)('$name', ({ env, homeDir, present, expected }) => {
    expect(
      resolveSenpiAgentHome({
        env,
        homeDir,
        exists: existsAt(present),
      })
    ).toBe(expected);
  });

  it('empty-string env value is skipped not returned when falling to senpi', () => {
    const resolved = resolveSenpiAgentHome({
      env: { OMO_CODING_AGENT_DIR: '' },
      homeDir: HOME,
      exists: existsAt([]),
    });
    expect(resolved).not.toBe('');
    expect(resolved).toBe(join(HOME, '.senpi', 'agent'));
  });

  it('does not throw when homeDir is omitted and exists is injected', () => {
    const resolved = resolveSenpiAgentHome({
      env: {},
      exists: () => false,
    });
    expect(resolved).toBe(join(homedir(), '.senpi', 'agent'));
  });

  it('defaults resolve against real process.env and homedir', () => {
    const resolved = resolveSenpiAgentHome();
    expect(isAbsolute(resolved)).toBe(true);
    expect(
      resolveSenpiAgentHome({
        env: process.env,
        homeDir: homedir(),
        exists: existsSync,
      })
    ).toBe(resolved);
  });
});
