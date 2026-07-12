import { describe, it, expect } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as rootExports from '../src/index.js';
import * as lifecycleExports from '../src/lifecycle/index.js';
import * as processingExports from '../src/processing/index.js';

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
  'cwdFromProjectDir',
  'denoiseSession',
  'discoverSessions',
  'exportSession',
  'extractBlocks',
  'getMarkerPath',
  'listProjects',
  'processSession',
  'projectDirFromCwd',
  'readExportMarker',
  'readMarker',
  'readRawSessionFiles',
  'readSessionFiles',
  'resolveProjectPath',
  'tailBlocks',
  'tailRawTranscriptRecords',
  'toCompactSummary',
  'toExportMarkdown',
  'toJsonlBlocks',
  'toMarkdown',
  'watchRawTranscriptRecords',
  'writeExportMarker',
  'writeMarker',
] as const;

const removedImplementationExports = [
  'mergeTimeline',
  'parseJsonlContent',
  'parseSessionContent',
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
      import: './dist/forwarder/index.js',
      default: './dist/forwarder/index.js',
      types: './dist/forwarder/index.d.ts',
    });
  });

  it('keeps processing deep paths out of the package export map', async () => {
    const pkg = await readPackageJson();

    expect(
      Object.keys(pkg.exports).filter(key => key.startsWith('./processing/'))
    ).toEqual([]);
    expect(pkg.exports).not.toHaveProperty('./processing/*');
    expect(pkg.exports).not.toHaveProperty('./processing/internal');
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
