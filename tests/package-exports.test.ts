import { describe, it, expect } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rootExports from '../src/index.js';
import * as lifecycleExports from '../src/lifecycle/index.js';
import * as processingExports from '../src/processing/index.js';
import * as grokExports from '../src/grok/index.js';
import * as grokProcessingExports from '../src/grok/processing/index.js';
import * as senpiExports from '../src/senpi/index.js';
import * as senpiProcessingExports from '../src/senpi/processing/index.js';
import * as validationExports from '../src/validation/index.js';

const repoRoot = process.cwd();

interface PackageExports {
  readonly '.': {
    readonly import: string;
    readonly types: string;
  };
  readonly './processing'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './grok'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './grok/processing'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './senpi'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './senpi/processing'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './validation'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './types'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './utils'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './pre-tool-use'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './pre-tool-use/*'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './post-tool-use'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './post-tool-use/*'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './lifecycle'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './lifecycle/*'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './endpoint-discovery'?: {
    readonly import: string;
    readonly types: string;
  };
  readonly './forwarder'?: {
    readonly import: string;
    readonly default: string;
    readonly types: string;
  };
}

interface PackageJsonShape {
  readonly name: string;
  readonly bin?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly repository?: {
    readonly url: string;
  };
  readonly exports: PackageExports;
}

async function readPackageJson(): Promise<PackageJsonShape> {
  const file = await readFile(join(repoRoot, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(file);
  if (!isPackageJsonShape(parsed)) {
    throw new Error('package.json does not match expected shape');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPackageJsonShape(value: unknown): value is PackageJsonShape {
  if (!isRecord(value)) return false;
  if (typeof value['name'] !== 'string') return false;
  if (!isRecord(value['exports'])) return false;
  if (value['bin'] !== undefined && !isRecord(value['bin'])) return false;
  if (value['scripts'] !== undefined && !isRecord(value['scripts']))
    return false;
  if (value['repository'] !== undefined) {
    if (!isRecord(value['repository'])) return false;
    if (typeof value['repository']['url'] !== 'string') return false;
  }
  return true;
}

const expectedPackageExportKeys = [
  '.',
  './processing',
  './grok',
  './grok/processing',
  './senpi',
  './senpi/processing',
  './validation',
  './types',
  './utils',
  './pre-tool-use',
  './pre-tool-use/*',
  './post-tool-use',
  './post-tool-use/*',
  './lifecycle',
  './lifecycle/*',
  './endpoint-discovery',
  './forwarder',
] as const;

const expectedProcessingRuntimeExports = [
  'DEFAULT_DENOISE_CONFIG',
  'commitRawTranscriptSessionCheckpoint',
  'cwdFromProjectDir',
  'denoiseSession',
  'discoverSessions',
  'exportSession',
  'extractBlocks',
  'getMarkerPath',
  'getRawTranscriptSessionMarkerPath',
  'listProjects',
  'processSession',
  'projectDirFromCwd',
  'readExportMarker',
  'readMarker',
  'readRawSessionFiles',
  'isStaleCheckpointConflict',
  'readSessionFiles',
  'resolveProjectPath',
  'STALE_CHECKPOINT_CONFLICT_CODE',
  'StaleCheckpointConflict',
  'tailBlocks',
  'tailRawTranscriptRecords',
  'tailRawTranscriptSessionRecords',
  'toCompactSummary',
  'toExportMarkdown',
  'toJsonlBlocks',
  'toMarkdown',
  'watchRawTranscriptRecords',
  'watchRawTranscriptSessionRecords',
  'writeExportMarker',
  'writeMarker',
] as const;

const removedImplementationExports = [
  'mergeTimeline',
  'parseJsonlContent',
  'parseSessionContent',
] as const;

const expectedGrokRuntimeExports = [
  'GrokHookEventName',
  'executeGrokHook',
  'grokGateOutputSchema',
  'grokHookInputSchema',
  'grokStopOutputSchema',
  'outputGrokJson',
  'readGrokStdinJson',
  'validateGrokHookInput',
  'validateGrokHooksConfig',
  'validateGrokHooksToml',
  'GrokHookOutputBuilder',
] as const;

const expectedSenpiRuntimeExports = [
  'AGENT_DIR_ENV_NAMES',
  'AGENT_HOME_SENTINEL',
  'HOOK_DECISIONS',
  'HOOK_INPUT_BRANCHES',
  'SENPI_HOOK_EVENT_NAMES',
  'SENPI_UNSUPPORTED_HANDLER_TYPES',
  'SENPI_UNSUPPORTED_HOOK_EVENT_NAMES',
  'SenpiHookOutputBuilder',
  'SenpiTrustConsentError',
  'SenpiTrustLockError',
  'SenpiTrustStateMalformedError',
  'buildSenpiHooksRegistration',
  'executeSenpiHook',
  'isSenpiCommandHookTrusted',
  'outputSenpiJson',
  'readSenpiHookTrustState',
  'readSenpiStdinJson',
  'resolveSenpiAgentHome',
  'senpiHashCommandHook',
  'senpiHookInputSchema',
  'senpiHookOutputSchema',
  'senpiHookTrustId',
  'validateSenpiHookInput',
  'validateSenpiHooksConfig',
  'writeSenpiHookTrustEntry',
  'writeSenpiHooksConfig',
] as const;

const expectedSenpiProcessingRuntimeExports = [
  'commitSenpiSessionCheckpoint',
  'computeProjectionMutation',
  'encodeSenpiCwdDirname',
  'findSenpiSessionDirs',
  'foldSenpiBlockChanges',
  'getSenpiSessionsRoot',
  'isStaleCheckpointConflict',
  'STALE_CHECKPOINT_CONFLICT_CODE',
  'StaleCheckpointConflict',
  'listAllSenpiSessions',
  'listSenpiSessions',
  'parseSenpiEntry',
  'projectSenpiBranch',
  'reduceSenpiProjection',
  'resolveSenpiLeaf',
  'tailSenpiSession',
  'watchSenpiSession',
] as const;

const senpiInternalExports = [
  'JsonlCursor',
  'JsonlDelta',
  'JsonlLine',
  'SENPI_MARKER_VERSION',
  'SenpiSessionMarker',
  'createSenpiSessionPathDigest',
  'evaluateSenpiCheckpointInvalidation',
  'getSenpiSessionMarkerPath',
  'parseSenpiSessionMarker',
  'readJsonlDelta',
  'readSenpiSessionMarker',
] as const;

const expectedGrokProcessingRuntimeExports = [
  'commitGrokSessionCheckpoint',
  'encodeGrokCwdDirname',
  'findGrokSessionDirs',
  'foldGrokBlockChanges',
  'getGrokHome',
  'grokEventSchema',
  'grokSummarySchema',
  'grokUpdateEnvelopeSchema',
  'isStaleCheckpointConflict',
  'STALE_CHECKPOINT_CONFLICT_CODE',
  'StaleCheckpointConflict',
  'listGrokSessions',
  'parseGrokEvent',
  'parseGrokSessionUpdate',
  'reduceGrokRecords',
  'tailGrokSession',
  'watchGrokSession',
] as const;

const expectedLifecycleHandlerExports = [
  'handleSetup',
  'handleMessageDisplay',
] as const;

describe('package export contract', () => {
  it('defines the documented root and barrel exports', async () => {
    const pkg = await readPackageJson();

    expect(pkg.name).toBe('@libar-dev/agent-harness-kit');
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [...expectedPackageExportKeys].sort()
    );
    expect(pkg.exports['.']).toEqual({
      import: './dist/index.js',
      types: './dist/index.d.ts',
    });
    expect(pkg.exports['./processing']).toEqual({
      import: './dist/processing/index.js',
      types: './dist/processing/index.d.ts',
    });
    expect(pkg.exports['./grok']).toEqual({
      import: './dist/grok/index.js',
      types: './dist/grok/index.d.ts',
    });
    expect(pkg.exports['./grok/processing']).toEqual({
      import: './dist/grok/processing/index.js',
      types: './dist/grok/processing/index.d.ts',
    });
    expect(pkg.exports['./senpi']).toEqual({
      import: './dist/senpi/index.js',
      types: './dist/senpi/index.d.ts',
    });
    expect(pkg.exports['./senpi/processing']).toEqual({
      import: './dist/senpi/processing/index.js',
      types: './dist/senpi/processing/index.d.ts',
    });
    expect(pkg.exports['./validation']).toEqual({
      import: './dist/validation/index.js',
      types: './dist/validation/index.d.ts',
    });
    expect(pkg.exports['./types']).toEqual({
      import: './dist/types/index.js',
      types: './dist/types/index.d.ts',
    });
    expect(pkg.exports['./utils']).toEqual({
      import: './dist/utils/index.js',
      types: './dist/utils/index.d.ts',
    });
    expect(pkg.exports['./pre-tool-use']).toEqual({
      import: './dist/pre-tool-use/index.js',
      types: './dist/pre-tool-use/index.d.ts',
    });
    expect(pkg.exports['./pre-tool-use/*']).toEqual({
      import: './dist/pre-tool-use/*.js',
      types: './dist/pre-tool-use/*.d.ts',
    });
    expect(pkg.exports['./post-tool-use']).toEqual({
      import: './dist/post-tool-use/index.js',
      types: './dist/post-tool-use/index.d.ts',
    });
    expect(pkg.exports['./post-tool-use/*']).toEqual({
      import: './dist/post-tool-use/*.js',
      types: './dist/post-tool-use/*.d.ts',
    });
    expect(pkg.exports['./lifecycle']).toEqual({
      import: './dist/lifecycle/index.js',
      types: './dist/lifecycle/index.d.ts',
    });
    expect(pkg.exports['./lifecycle/*']).toEqual({
      import: './dist/lifecycle/*.js',
      types: './dist/lifecycle/*.d.ts',
    });
    expect(pkg.exports['./endpoint-discovery']).toEqual({
      import: './dist/endpoint-discovery/index.js',
      types: './dist/endpoint-discovery/index.d.ts',
    });
    expect(pkg.exports['./forwarder']).toEqual({
      types: './dist/forwarder/index.d.ts',
      import: './dist/forwarder/index.js',
      default: './dist/forwarder/index.js',
    });
  });

  it('keeps processing deep paths out of the package export map', async () => {
    const pkg = await readPackageJson();

    expect(
      Object.keys(pkg.exports).filter(key => key.startsWith('./processing/'))
    ).toEqual([]);
    expect(pkg.exports).not.toHaveProperty('./processing/*');
    expect(pkg.exports).not.toHaveProperty('./processing/internal');
    expect(pkg.exports).not.toHaveProperty('./senpi/*');
    expect(pkg.exports).not.toHaveProperty('./senpi/processing/*');
  });

  it('has source entrypoints for the root and documented barrels', async () => {
    await expect(
      access(join(repoRoot, 'src/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/validation/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/processing/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/grok/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/grok/processing/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/senpi/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/senpi/processing/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/types/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/utils/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/pre-tool-use/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/post-tool-use/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/lifecycle/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/endpoint-discovery/index.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/forwarder/index.ts'))
    ).resolves.toBeUndefined();
  });

  it('defines a prepare script so git and file installs build dist entrypoints', async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts?.['prepare']).toBe('pnpm run build');
  });

  it('keeps the root barrel processing-free', () => {
    for (const exportName of expectedProcessingRuntimeExports) {
      expect(rootExports).not.toHaveProperty(exportName);
    }

    for (const exportName of removedImplementationExports) {
      expect(rootExports).not.toHaveProperty(exportName);
    }
    expect(rootExports).not.toHaveProperty('tailGrokSession');

    for (const exportName of expectedSenpiProcessingRuntimeExports) {
      expect(rootExports).not.toHaveProperty(exportName);
    }
    for (const exportName of expectedSenpiRuntimeExports) {
      expect(rootExports).not.toHaveProperty(exportName);
    }
  });

  it('exports the public Grok hook barrel surface', () => {
    expect(Object.keys(grokExports).sort()).toEqual(
      [...expectedGrokRuntimeExports].sort()
    );

    for (const exportName of expectedGrokRuntimeExports) {
      expect(grokExports).toHaveProperty(exportName);
    }
  });

  it('exports the public Grok processing barrel without its internal cursor', () => {
    expect(Object.keys(grokProcessingExports).sort()).toEqual(
      [...expectedGrokProcessingRuntimeExports].sort()
    );
    expect(grokProcessingExports).not.toHaveProperty('readJsonlDelta');
    expect(grokProcessingExports).not.toHaveProperty('JsonlCursor');
  });

  it('exports the final public Senpi barrel surface', () => {
    expect(Object.keys(senpiExports).sort()).toEqual(
      [...expectedSenpiRuntimeExports].sort()
    );

    for (const exportName of expectedSenpiRuntimeExports) {
      expect(senpiExports).toHaveProperty(exportName);
    }
    for (const exportName of senpiInternalExports) {
      expect(senpiExports).not.toHaveProperty(exportName);
    }
    for (const exportName of expectedSenpiProcessingRuntimeExports) {
      expect(senpiExports).not.toHaveProperty(exportName);
    }
  });

  it('exports the public Senpi processing barrel without cursor or marker internals', () => {
    expect(Object.keys(senpiProcessingExports).sort()).toEqual(
      [...expectedSenpiProcessingRuntimeExports].sort()
    );
    expect(senpiProcessingExports).not.toHaveProperty(
      'EMPTY_SENPI_BLOCK_REDUCTION_STATE'
    );
    for (const exportName of senpiInternalExports) {
      expect(senpiProcessingExports).not.toHaveProperty(exportName);
    }
  });

  it('smoke-imports the senpi package subpaths', async () => {
    const pkg = await readPackageJson();
    const senpiExport = pkg.exports['./senpi'];
    const processingExport = pkg.exports['./senpi/processing'];
    if (senpiExport === undefined || processingExport === undefined) {
      throw new Error('senpi package subpaths are missing from exports');
    }

    const senpi = await import('../src/senpi/index.js');
    const processing = await import('../src/senpi/processing/index.js');
    const packageSenpi: unknown = await import(
      pathToFileURL(join(repoRoot, senpiExport.import)).href
    );
    const packageProcessing: unknown = await import(
      pathToFileURL(join(repoRoot, processingExport.import)).href
    );

    expect(senpiExport.import).toBe('./dist/senpi/index.js');
    expect(processingExport.import).toBe('./dist/senpi/processing/index.js');
    expect(typeof senpi.resolveSenpiAgentHome).toBe('function');
    expect(typeof processing.parseSenpiEntry).toBe('function');
    expect(isRecord(packageSenpi)).toBe(true);
    expect(isRecord(packageProcessing)).toBe(true);
    if (!isRecord(packageSenpi) || !isRecord(packageProcessing)) {
      throw new Error('senpi package subpath modules did not resolve');
    }
    expect(typeof packageSenpi['resolveSenpiAgentHome']).toBe('function');
    expect(typeof packageProcessing['parseSenpiEntry']).toBe('function');
    expect(Object.keys(packageSenpi).sort()).toEqual(
      [...expectedSenpiRuntimeExports].sort()
    );
    expect(Object.keys(packageProcessing).sort()).toEqual(
      [...expectedSenpiProcessingRuntimeExports].sort()
    );
  });

  it('exports only the ADR-approved runtime processing surface', () => {
    expect(Object.keys(processingExports).sort()).toEqual(
      [...expectedProcessingRuntimeExports].sort()
    );

    for (const exportName of removedImplementationExports) {
      expect(processingExports).not.toHaveProperty(exportName);
    }
  });

  it('exposes lifecycle handlers from the lifecycle barrel', () => {
    for (const exportName of expectedLifecycleHandlerExports) {
      expect(lifecycleExports).toHaveProperty(exportName);
      expect(typeof lifecycleExports[exportName]).toBe('function');
    }
  });

  it('exports Setup and MessageDisplay named schemas from validation barrel', () => {
    const expectedNamedSchemas = [
      'setupInputSchema',
      'setupOutputSchema',
      'messageDisplayInputSchema',
      'messageDisplayOutputSchema',
    ] as const;

    for (const exportName of expectedNamedSchemas) {
      expect(validationExports).toHaveProperty(exportName);
      expect(validationExports[exportName]).toBeDefined();
    }
  });

  it('maps package binaries to built CLI entrypoints with matching source files', async () => {
    const pkg = await readPackageJson();

    expect(pkg.bin).toEqual({
      'claude-session-export': 'dist/cli/export-sessions.js',
      'claude-session-tail': 'dist/cli/tail-session.js',
    });
    expect(pkg.repository?.url).toBe(
      'git+https://github.com/libar-dev/agent-harness-kit.git'
    );
    await expect(
      access(join(repoRoot, 'src/cli/export-sessions.ts'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'src/cli/tail-session.ts'))
    ).resolves.toBeUndefined();
  });
});
