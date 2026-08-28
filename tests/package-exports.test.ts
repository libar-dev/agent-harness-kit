import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as rootExports from '../src/index.js';
import * as lifecycleExports from '../src/lifecycle/index.js';
import * as processingExports from '../src/processing/index.js';
import * as grokExports from '../src/grok/index.js';
import * as grokProcessingExports from '../src/grok/processing/index.js';
import * as senpiExports from '../src/senpi/index.js';
import * as senpiProcessingExports from '../src/senpi/processing/index.js';
import * as forwarderExports from '../src/forwarder/index.js';
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
  readonly version: string;
  readonly bin?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly files?: readonly string[];
  readonly engines?: {
    readonly node?: string;
  };
  readonly publishConfig?: {
    readonly access?: string;
    readonly provenance?: boolean;
  };
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
  if (typeof value['version'] !== 'string') return false;
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
  'SENPI_HOOKS_CONFIG_FILENAME',
  'SENPI_HOOKS_STATE_FILENAME',
  'SENPI_HOOK_EVENT_NAMES',
  'SENPI_PROJECT_CONFIG_DIR',
  'SENPI_UNSUPPORTED_HANDLER_TYPES',
  'SENPI_UNSUPPORTED_HOOK_EVENT_NAMES',
  'SenpiHookOutputBuilder',
  'SenpiHooksConsentError',
  'SenpiTrustConsentError',
  'SenpiTrustLockError',
  'SenpiTrustStateMalformedError',
  'buildSenpiHooksRegistration',
  'executeSenpiHook',
  'isSenpiCommandHookTrusted',
  'outputSenpiJson',
  'readSenpiHookTrustState',
  'readSenpiHooksConfig',
  'readSenpiStdinJson',
  'removeSenpiHookTrustEntry',
  'removeSenpiHooksConfig',
  'resolveSenpiAgentHome',
  'resolveSenpiHookTrustStatePath',
  'resolveSenpiHooksConfigPath',
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

const expectedForwarderRuntimeExports = [
  'RUN_HOOK_WRAPPER_SH',
  'STANDALONE_HOOK_FORWARDER_ASSET',
  'STANDALONE_SENPI_HOOK_FORWARDER_ASSET',
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
  'byteCursorsEqual',
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
    expect(pkg.version).toBe('0.3.0');
    expect(pkg.engines?.node).toBe('>=22.0.0');
    expect(pkg.files).toEqual([
      'dist/**/*',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
    ]);
    expect(pkg.publishConfig).toEqual({
      access: 'public',
      provenance: true,
    });
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

  it('exports the public forwarder asset contract', () => {
    expect(Object.keys(forwarderExports).sort()).toEqual(
      [...expectedForwarderRuntimeExports].sort()
    );
    expect(forwarderExports.STANDALONE_HOOK_FORWARDER_ASSET).toBe(
      'dist/standalone/hook-forwarder.mjs'
    );
    expect(forwarderExports.STANDALONE_SENPI_HOOK_FORWARDER_ASSET).toBe(
      'dist/standalone/hook-forwarder-senpi.mjs'
    );
    expect(forwarderExports.RUN_HOOK_WRAPPER_SH.startsWith('#!/bin/sh')).toBe(
      true
    );
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

const execFileAsync = promisify(execFile);

const documentedConcreteSubpaths = [
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
  './post-tool-use',
  './lifecycle',
  './endpoint-discovery',
  './forwarder',
] as const;

const documentedWildcardExamples = [
  './pre-tool-use/bash-validator',
  './post-tool-use/format-code',
  './lifecycle/setup',
] as const;

const undocumentedInternalSubpaths = [
  './processing/internal',
  './processing/tail',
  './senpi/trust',
  './senpi/processing/jsonl-cursor',
  './grok/processing/jsonl-cursor',
] as const;

const requiredPackFiles = [
  'package.json',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/processing/index.js',
  'dist/processing/index.d.ts',
  'dist/grok/index.js',
  'dist/grok/index.d.ts',
  'dist/grok/processing/index.js',
  'dist/grok/processing/index.d.ts',
  'dist/senpi/index.js',
  'dist/senpi/index.d.ts',
  'dist/senpi/processing/index.js',
  'dist/senpi/processing/index.d.ts',
  'dist/forwarder/index.js',
  'dist/forwarder/index.d.ts',
  'dist/standalone/hook-forwarder.mjs',
  'dist/standalone/hook-forwarder-senpi.mjs',
] as const;

const forbiddenPackPrefixes = [
  'src/',
  'tests/',
  'docs/',
  'examples/',
  '.github/',
  '.omo/',
  'plans/',
] as const;

interface PackedImportResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly keys?: readonly string[];
}

function isPackedImportResult(value: unknown): value is PackedImportResult {
  if (!isRecord(value)) return false;
  if (typeof value['ok'] !== 'boolean') return false;
  if (value['code'] !== undefined && typeof value['code'] !== 'string') {
    return false;
  }
  if (value['keys'] !== undefined) {
    if (!Array.isArray(value['keys'])) return false;
    if (value['keys'].some(key => typeof key !== 'string')) return false;
  }
  return true;
}

function specifierForSubpath(subpath: string): string {
  return subpath === '.'
    ? '@libar-dev/agent-harness-kit'
    : `@libar-dev/agent-harness-kit/${subpath.slice(2)}`;
}

/**
 * npm < 11 runs the `prepare` lifecycle script during `npm pack` even with
 * --ignore-scripts (npm/cli#3080), printing the script banner and build
 * output into stdout ahead of the JSON report. The JSON array is the final
 * stdout payload and its top-level `[` is the only line-starting bracket,
 * so anchor on the last line-initial `[` and fall back to a clean payload.
 */
function extractPackJsonArray(raw: string): string {
  const start = raw.lastIndexOf('\n[');
  if (start !== -1) {
    return raw.slice(start + 1);
  }
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[')) {
    return trimmed;
  }
  throw new Error('npm pack --json output contained no JSON array');
}

function parsePackFileList(raw: string): {
  readonly version: string;
  readonly filename: string;
  readonly files: readonly string[];
} {
  const parsed: unknown = JSON.parse(extractPackJsonArray(raw));
  const record: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(record) || typeof record['version'] !== 'string') {
    throw new Error('npm pack --json did not return a versioned record');
  }
  if (typeof record['filename'] !== 'string') {
    throw new Error('npm pack --json did not return a filename');
  }
  if (!Array.isArray(record['files'])) {
    throw new Error('npm pack --json did not return a file list');
  }
  const files = record['files'].map(entry => {
    if (typeof entry === 'string') return entry;
    if (isRecord(entry) && typeof entry['path'] === 'string') {
      return entry['path'];
    }
    throw new Error('npm pack file entry was not a path');
  });
  return {
    version: record['version'],
    filename: record['filename'],
    files,
  };
}

async function importPackedSubpath(
  consumerDir: string,
  subpath: string
): Promise<PackedImportResult> {
  const specifier = specifierForSubpath(subpath);
  const probePath = join(consumerDir, 'import-subpath.mjs');
  await writeFile(
    probePath,
    `try {
  const mod = await import(${JSON.stringify(specifier)});
  console.log(JSON.stringify({ ok: true, keys: Object.keys(mod).sort() }));
} catch (error) {
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
  console.log(JSON.stringify({ ok: false, code }));
}
`
  );
  const { stdout } = await execFileAsync(process.execPath, [probePath], {
    cwd: consumerDir,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!isPackedImportResult(parsed)) {
    throw new Error(
      `packed import probe returned unexpected output: ${stdout}`
    );
  }
  return parsed;
}

describe('packed package contract', () => {
  let consumerDir = '';
  let packedVersion = '';
  let packedFiles: readonly string[] = [];
  let workspace: string | undefined;

  beforeAll(async () => {
    workspace = join(tmpdir(), `kit-0.3.0-pack-${process.pid}`);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });

    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', workspace, '--json'],
      { cwd: repoRoot }
    );
    const packed = parsePackFileList(stdout);
    packedVersion = packed.version;
    packedFiles = packed.files;

    const tarball = join(workspace, packed.filename);
    consumerDir = join(workspace, 'consumer');
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'kit-0.3.0-consumer',
          private: true,
          type: 'module',
        },
        null,
        2
      )}\n`
    );
    await execFileAsync(
      'npm',
      ['install', '--ignore-scripts', '--omit=dev', tarball],
      { cwd: consumerDir }
    );
  }, 60_000);

  afterAll(async () => {
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('packs version 0.3.0 with runtime, declarations, licenses, and forwarders', () => {
    expect(packedVersion).toBe('0.3.0');
    expect(packedFiles).toEqual([...packedFiles].sort());
    for (const file of requiredPackFiles) {
      expect(packedFiles).toContain(file);
    }
    for (const prefix of forbiddenPackPrefixes) {
      expect(packedFiles.filter(file => file.startsWith(prefix))).toEqual([]);
    }
  });

  it('imports every documented subpath from packed bytes', async () => {
    const imported: string[] = [];
    for (const subpath of [
      ...documentedConcreteSubpaths,
      ...documentedWildcardExamples,
    ]) {
      const result = await importPackedSubpath(consumerDir, subpath);
      if (!result.ok || result.keys === undefined) {
        throw new Error(
          `packed subpath ${subpath} failed: ${result.code ?? 'unknown'}`
        );
      }
      expect(result.keys.length, subpath).toBeGreaterThan(0);
      imported.push(subpath);
    }
    expect(imported).toEqual([
      ...documentedConcreteSubpaths,
      ...documentedWildcardExamples,
    ]);
  }, 30_000);

  it('rejects undocumented internal subpaths with ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
    for (const subpath of undocumentedInternalSubpaths) {
      const result = await importPackedSubpath(consumerDir, subpath);
      expect(result, subpath).toEqual({
        ok: false,
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
    }
  }, 30_000);
});
