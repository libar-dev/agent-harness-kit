import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const vendorDir = resolve(repoRoot, 'docs', 'upstream', 'senpi');
const pinPath = resolve(vendorDir, 'pin.json');

const engineVersion = '2026.8.19';
const pinnedAt = '2026-08-21';
const source = 'npm';

/** @type {ReadonlyArray<{ localName: string, upstreamPath: string }>} */
const sourceFiles = [
  { localName: 'session-format.md', upstreamPath: 'docs/session-format.md' },
  { localName: 'settings.md', upstreamPath: 'docs/settings.md' },
  {
    localName: 'environment-variables.md',
    upstreamPath: 'docs/environment-variables.md',
  },
  ...[
    'types',
    'index',
    'schema',
    'trust',
    'trust-storage',
    'config-loader',
    'command-runner',
    'dispatcher',
    'output-parser',
    'output-bounds',
    'safety',
    'matcher',
    'command',
    'handler',
    'diagnostics',
    'plugin-loader',
    'plugin-manifest',
    'lifecycle-adapter',
    'tool-adapter',
    'stop-adapter',
    'prompt-adapter',
  ].map((name) => ({
    localName: `hooks/${name}.d.ts`,
    upstreamPath: `dist/core/extensions/builtin/hooks/${name}.d.ts`,
  })),
  ...['trust', 'output-parser', 'trust-storage', 'output-bounds', 'types'].map(
    (name) => ({
      localName: `hooks/${name}.js`,
      upstreamPath: `dist/core/extensions/builtin/hooks/${name}.js`,
    }),
  ),
];

const notes = [
  'Artifact of record is the npm tarball for @code-yeongyu/senpi@2026.8.19; registryIntegrity is npm view dist.integrity (sha512).',
  'Vendored set is complete at pin time: 3 docs, 21 hooks .d.ts, and 5 hooks .js implementations required because .d.ts signatures alone are insufficient (hashCommandHook, output parsing, trust storage lock paths, output bounds, types constants).',
  'No runtime import of @code-yeongyu/senpi; drift checks re-extract from a provided local tarball only (no network at check time).',
  'Upstream package license is MIT (code-yeongyu/senpi).',
];

const fixtureRedump =
  'copy small redacted *.jsonl from ~/.omo/agent/sessions/<encoded-cwd>/ into tests/fixtures/senpi/';

/**
 * Print CLI usage to stdout.
 * @returns {void}
 */
export function printUsage() {
  console.log(`Sync vendored Senpi contract files from an npm tarball.

Usage:
  node scripts/sync-upstream-senpi.mjs --tarball <path> [--check]

Options:
  --tarball <path>  Path to code-yeongyu-senpi-*.tgz (required; no network fetch).
  --check           Verify the vendor and pin manifest without writing files.
  --help            Show this help.
`);
}

/**
 * Parse CLI arguments for the senpi upstream sync script.
 * @param {string[]} args
 * @returns {{ tarballPath: string, check: boolean } | null}
 */
export function parseArgs(args) {
  let tarballPath = null;
  let check = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    } else if (arg === '--tarball') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--tarball requires a path argument');
      }
      tarballPath = resolve(value);
      index += 1;
    } else if (arg.startsWith('--tarball=')) {
      tarballPath = resolve(arg.slice('--tarball='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!tarballPath) {
    throw new Error('--tarball <path> is required');
  }

  return { tarballPath, check };
}

/**
 * Compute lowercase hex SHA-256 of a buffer.
 * @param {Buffer} bytes
 * @returns {string}
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Constant-time-ish buffer equality (length then byte compare).
 * @param {Buffer | null} left
 * @param {Buffer | null} right
 * @returns {boolean}
 */
export function bytesEqual(left, right) {
  if (!left || !right) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.equals(right);
}

/**
 * Read an existing vendored file as a Buffer, or null if missing.
 * @param {string} localName
 * @returns {Buffer | null}
 */
export function readExisting(localName) {
  const path = resolve(vendorDir, localName);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

/**
 * Read and parse the pinned pin.json manifest, or null if absent.
 * @returns {Record<string, unknown> | null}
 */
export function readPinnedManifest() {
  if (!existsSync(pinPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${pinPath}: ${detail}`);
  }
}

/**
 * List relative file paths under a directory (files only, recursive).
 * @param {string} rootDir
 * @returns {string[]}
 */
export function listFilesRecursive(rootDir) {
  /** @type {string[]} */
  const out = [];

  /**
   * @param {string} dir
   * @returns {void}
   */
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(rootDir, full).split(sep).join('/'));
      }
    }
  }

  if (existsSync(rootDir)) {
    walk(rootDir);
  }
  return out.sort();
}

/**
 * Extract the pinned source file set from a local npm tarball into destDir.
 * Paths are written with package/ stripped (docs/... and hooks/... layout).
 * @param {string} tarballPath
 * @param {string} destDir
 * @returns {Map<string, Buffer>}
 */
export function extractFromTarball(tarballPath, destDir) {
  if (!existsSync(tarballPath)) {
    throw new Error(`Tarball does not exist: ${tarballPath}`);
  }

  const extractRoot = mkdtempSync(join(tmpdir(), 'senpi-upstream-extract-'));
  try {
    const tarArgs = [
      '-xzf',
      tarballPath,
      '-C',
      extractRoot,
      ...sourceFiles.map((source) => `package/${source.upstreamPath}`),
    ];
    execFileSync('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    /** @type {Map<string, Buffer>} */
    const expected = new Map();
    mkdirSync(destDir, { recursive: true });

    for (const source of sourceFiles) {
      const extractedPath = join(extractRoot, 'package', source.upstreamPath);
      if (!existsSync(extractedPath)) {
        throw new Error(
          `Missing upstream path in tarball: package/${source.upstreamPath}`,
        );
      }
      const bytes = readFileSync(extractedPath);
      const outPath = join(destDir, source.localName);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
      expected.set(source.localName, bytes);
    }

    return expected;
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

/**
 * Build the pin.json object for the current expected file set.
 * @param {{ registryIntegrity: string, expected: Map<string, Buffer> }} params
 * @returns {Record<string, unknown>}
 */
export function createPin({ registryIntegrity, expected }) {
  /** @type {Record<string, { upstreamPath: string, sha256: string }>} */
  const files = {};
  for (const source of sourceFiles) {
    const bytes = expected.get(source.localName);
    if (!bytes) {
      throw new Error(`Missing expected bytes for ${source.localName}`);
    }
    files[source.localName] = {
      upstreamPath: source.upstreamPath,
      sha256: sha256(bytes),
    };
  }

  return {
    engineVersion,
    pinnedAt,
    source,
    registryIntegrity,
    files,
    fixtureRedump,
    notes,
  };
}

/**
 * Serialize pin.json with trailing newline (stable bytes).
 * @param {Record<string, unknown>} pin
 * @returns {Buffer}
 */
export function pinBytes(pin) {
  return Buffer.from(`${JSON.stringify(pin, null, 2)}\n`, 'utf8');
}

/**
 * Resolve registryIntegrity for a rewrite: keep existing pin value when present.
 * @param {Record<string, unknown> | null} existingPin
 * @returns {string}
 */
export function resolveRegistryIntegrity(existingPin) {
  const value = existingPin?.registryIntegrity;
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new Error(
    'pin.json is missing registryIntegrity; re-run an initial vendor with npm view dist.integrity recorded',
  );
}

/**
 * Compare vendored tree + pin against expected tarball extraction.
 * @param {{
 *   expected: Map<string, Buffer>,
 *   expectedPinBytes: Buffer,
 *   check: boolean,
 * }} params
 * @returns {{ drifted: string[], entries: Array<{ path: string, status: string }> }}
 */
export function compareVendor({ expected, expectedPinBytes, check }) {
  /** @type {Array<{ path: string, status: string }>} */
  const entries = [];
  /** @type {string[]} */
  const drifted = [];

  const expectedNames = new Set(sourceFiles.map((source) => source.localName));

  for (const source of sourceFiles) {
    const actual = readExisting(source.localName);
    const desired = expected.get(source.localName) ?? null;
    const path = `docs/upstream/senpi/${source.localName}`;
    let status;
    if (bytesEqual(actual, desired)) {
      status = 'unchanged';
    } else if (check) {
      status = 'drifted';
      drifted.push(path);
    } else if (actual) {
      status = 'updated';
    } else {
      status = 'added';
    }
    entries.push({ path, status });
  }

  // Extra files under vendor (excluding pin.json and NOTICE) are drift.
  const onDisk = listFilesRecursive(vendorDir).filter(
    (name) => name !== 'pin.json' && name !== 'NOTICE',
  );
  for (const name of onDisk) {
    if (!expectedNames.has(name)) {
      const path = `docs/upstream/senpi/${name}`;
      entries.push({ path, status: check ? 'extra' : 'removed' });
      if (check) {
        drifted.push(path);
      }
    }
  }

  const actualPin = readExisting('pin.json');
  const pinRel = 'docs/upstream/senpi/pin.json';
  if (bytesEqual(actualPin, expectedPinBytes)) {
    entries.push({ path: pinRel, status: 'unchanged' });
  } else if (check) {
    entries.push({ path: pinRel, status: 'drifted' });
    drifted.push(pinRel);
  } else if (actualPin) {
    entries.push({ path: pinRel, status: 'updated' });
  } else {
    entries.push({ path: pinRel, status: 'added' });
  }

  return { drifted, entries };
}

/**
 * Write expected vendored files and pin.json to disk.
 * @param {{ expected: Map<string, Buffer>, expectedPinBytes: Buffer }} params
 * @returns {void}
 */
export function writeVendor({ expected, expectedPinBytes }) {
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(resolve(vendorDir, 'hooks'), { recursive: true });

  // Remove stray vendored files not in the pin set (keep NOTICE).
  const expectedNames = new Set(sourceFiles.map((source) => source.localName));
  for (const name of listFilesRecursive(vendorDir)) {
    if (name === 'pin.json' || name === 'NOTICE') {
      continue;
    }
    if (!expectedNames.has(name)) {
      rmSync(resolve(vendorDir, name), { force: true });
    }
  }

  for (const source of sourceFiles) {
    const bytes = expected.get(source.localName);
    if (!bytes) {
      throw new Error(`Missing expected bytes for ${source.localName}`);
    }
    const outPath = resolve(vendorDir, source.localName);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
  }
  writeFileSync(pinPath, expectedPinBytes);
}

/**
 * CLI entrypoint.
 * @returns {Promise<void>}
 */
export async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const existingPin = readPinnedManifest();
  const registryIntegrity = resolveRegistryIntegrity(existingPin);

  const extractDest = mkdtempSync(join(tmpdir(), 'senpi-upstream-vendor-'));
  try {
    const expected = extractFromTarball(options.tarballPath, extractDest);
    const expectedPinBytes = pinBytes(
      createPin({ registryIntegrity, expected }),
    );
    const { drifted, entries } = compareVendor({
      expected,
      expectedPinBytes,
      check: options.check,
    });

    if (options.check) {
      if (drifted.length > 0) {
        for (const file of drifted) {
          console.error(`Senpi upstream vendor drift detected: ${file}`);
        }
        process.exitCode = 1;
        return;
      }
      console.log('Senpi upstream vendor is in sync.');
      return;
    }

    writeVendor({ expected, expectedPinBytes });
    console.log('Sync summary:');
    for (const entry of entries) {
      console.log(`  ${entry.status.padEnd(9)} ${entry.path}`);
    }
  } finally {
    rmSync(extractDest, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sync-upstream-senpi: ${message}`);
  process.exitCode = 1;
}
