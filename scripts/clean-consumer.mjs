#!/usr/bin/env node
/**
 * Pack the 0.3.0 candidate and exercise it as a clean consumer.
 *
 * Installs the packed tarball into an isolated project with lifecycle
 * scripts enabled. Does not use workspace: or file: links to the source
 * tree. Warnings are captured, not suppressed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, '..');
const probeRelativePath = join(
  'tests',
  'fixtures',
  'clean-consumer',
  'probe.mjs'
);

const OFFICIAL_NODES = {
  20: '20.20.2',
  22: '22.23.2',
  24: '24.19.0',
};

function log(message) {
  process.stderr.write(`${message}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  const parsed = {
    mode: 'happy',
    tarball: undefined,
    node: undefined,
    repo: defaultRepoRoot,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--mode' && next !== undefined) {
      parsed.mode = next;
      index += 1;
      continue;
    }
    if (arg === '--tarball' && next !== undefined) {
      parsed.tarball = next;
      index += 1;
      continue;
    }
    if (arg === '--node' && next !== undefined) {
      parsed.node = next;
      index += 1;
      continue;
    }
    if (arg === '--repo' && next !== undefined) {
      parsed.repo = next;
      index += 1;
      continue;
    }
    if (arg === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (arg === '--matrix') {
      parsed.mode = 'matrix';
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (
    parsed.mode !== 'happy' &&
    parsed.mode !== 'engine-mismatch' &&
    parsed.mode !== 'matrix'
  ) {
    throw new Error(`unsupported mode: ${parsed.mode}`);
  }
  return parsed;
}

function platformTriple() {
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : null;
  const arch =
    process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (platform === null || arch === null) {
    throw new Error(
      `unsupported host for official Node cache: ${process.platform}-${process.arch}`
    );
  }
  return `${platform}-${arch}`;
}

function npmForNode(nodePath) {
  return join(dirname(nodePath), 'npm');
}

async function readNodeVersion(nodePath) {
  const { stdout } = await execFileAsync(nodePath, ['-v']);
  return stdout.trim();
}

async function ensureDist(repoRoot) {
  try {
    await access(join(repoRoot, 'dist', 'index.js'));
    await access(join(repoRoot, 'dist', 'standalone', 'hook-forwarder.mjs'));
    await access(
      join(repoRoot, 'dist', 'standalone', 'hook-forwarder-senpi.mjs')
    );
  } catch {
    throw new Error(
      'dist runtime is missing; run `pnpm run build` before packing'
    );
  }
}

function parsePackRecord(raw) {
  const parsed = JSON.parse(raw);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(record) || typeof record.version !== 'string') {
    throw new Error('npm pack --json did not return a versioned record');
  }
  if (typeof record.filename !== 'string') {
    throw new Error('npm pack --json did not return a filename');
  }
  if (!Array.isArray(record.files)) {
    throw new Error('npm pack --json did not return a file list');
  }
  const files = record.files.map(entry => {
    if (typeof entry === 'string') return entry;
    if (isRecord(entry) && typeof entry.path === 'string') return entry.path;
    throw new Error('npm pack file entry was not a path');
  });
  return {
    version: record.version,
    filename: record.filename,
    files,
    unpackedSize:
      typeof record.unpackedSize === 'number' ? record.unpackedSize : null,
    size: typeof record.size === 'number' ? record.size : null,
  };
}

async function resolveRunnerNpm() {
  const sibling = join(dirname(process.execPath), 'npm');
  try {
    await access(sibling);
    return sibling;
  } catch {
    return 'npm';
  }
}

async function packCandidate(repoRoot, destDir) {
  await ensureDist(repoRoot);
  await mkdir(destDir, { recursive: true });
  const packNpm = await resolveRunnerNpm();
  log(`packing with ${packNpm} pack --ignore-scripts from ${repoRoot}`);
  const { stdout, stderr } = await execFileAsync(
    packNpm,
    ['pack', '--ignore-scripts', '--pack-destination', destDir, '--json'],
    { cwd: repoRoot }
  );
  if (stderr.trim() !== '') {
    log(stderr.trim());
  }
  const packed = parsePackRecord(stdout);
  if (packed.version !== '0.3.0') {
    throw new Error(`packed version was ${packed.version}, expected 0.3.0`);
  }
  const tarball = join(destDir, packed.filename);
  const bytes = await readFile(tarball);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  return {
    ...packed,
    path: tarball,
    sha512,
    byteLength: bytes.byteLength,
  };
}

async function inspectTarball(tarballPath) {
  const bytes = await readFile(tarballPath);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const { stdout } = await execFileAsync('tar', ['-tzf', tarballPath]);
  const files = stdout
    .split('\n')
    .map(line => line.replace(/^package\//, ''))
    .filter(line => line !== '' && line !== '.');
  return {
    path: tarballPath,
    filename: tarballPath.split('/').pop() ?? tarballPath,
    sha512,
    byteLength: bytes.byteLength,
    files,
    version: '0.3.0',
    unpackedSize: null,
    size: bytes.byteLength,
  };
}

async function createConsumerDir(parent) {
  const consumerDir = join(parent, 'consumer');
  await mkdir(consumerDir, { recursive: true });
  await writeFile(
    join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'kit-0.3.0-clean-consumer',
        private: true,
        type: 'module',
      },
      null,
      2
    )}\n`
  );
  return consumerDir;
}

function collectEngineSignals(text) {
  const ebadengine =
    text.includes('EBADENGINE') || text.includes('Unsupported engine');
  const required =
    /required:\s*\{[^}]*node:\s*'([^']+)'/.exec(text)?.[1] ??
    /required:\s*\{[^}]*node:\s*"([^"]+)"/.exec(text)?.[1] ??
    /Required:\s*\{\s*"node"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
    null;
  const current =
    /current:\s*\{[^}]*node:\s*'([^']+)'/.exec(text)?.[1] ??
    /current:\s*\{[^}]*node:\s*"([^"]+)"/.exec(text)?.[1] ??
    /Actual:\s*\{[^}]*"node"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
    null;
  return { ebadengine, required, current };
}

function consumerEnv(options) {
  const nodeBin = dirname(options.nodePath);
  const path = `${nodeBin}:/usr/bin:/bin`;
  const env = {
    PATH: path,
    HOME: options.consumerDir,
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
    LANG: process.env['LANG'] ?? 'C',
    npm_config_ignore_scripts: 'false',
    npm_config_userconfig: join(options.consumerDir, '.npmrc'),
    npm_config_globalconfig: join(options.consumerDir, '.npmrc-global'),
    npm_config_cache: join(options.consumerDir, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund_scripts: '',
    npm_config_engine_strict: options.engineStrict ? 'true' : '',
  };
  return env;
}

async function installTarball(options) {
  const args = ['install'];
  if (options.engineStrict) {
    args.push('--engine-strict');
  }
  args.push(options.tarball);
  await writeFile(join(options.consumerDir, '.npmrc'), '');
  await writeFile(join(options.consumerDir, '.npmrc-global'), '');
  log(
    `installing ${options.tarball} with ${options.npmPath} (scripts enabled${
      options.engineStrict ? ', engine-strict' : ''
    })`
  );
  try {
    const { stdout, stderr } = await execFileAsync(options.npmPath, args, {
      cwd: options.consumerDir,
      env: consumerEnv(options),
    });
    if (stdout.trim() !== '') log(stdout.trim());
    if (stderr.trim() !== '') log(stderr.trim());
    return {
      exitCode: 0,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
      scriptsEnabled: true,
      engineStrict: options.engineStrict === true,
    };
  } catch (error) {
    const stdout =
      isRecord(error) && typeof error.stdout === 'string' ? error.stdout : '';
    const stderr =
      isRecord(error) && typeof error.stderr === 'string' ? error.stderr : '';
    const exitCode =
      isRecord(error) && typeof error.code === 'number' ? error.code : 1;
    if (stdout.trim() !== '') log(stdout.trim());
    if (stderr.trim() !== '') log(stderr.trim());
    return {
      exitCode,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
      scriptsEnabled: true,
      engineStrict: options.engineStrict === true,
    };
  }
}

async function runProbe(nodePath, consumerDir, repoRoot) {
  const probeSource = join(repoRoot, probeRelativePath);
  const probeDest = join(consumerDir, 'probe.mjs');
  await copyFile(probeSource, probeDest);
  log(`running consumer probe with ${nodePath}`);
  const { stdout, stderr } = await execFileAsync(nodePath, [probeDest], {
    cwd: consumerDir,
  });
  if (stderr.trim() !== '') log(stderr.trim());
  const parsed = JSON.parse(stdout);
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error(`consumer probe failed: ${stdout}`);
  }
  return parsed;
}

async function runHappy(options) {
  const workspace = await mkdtemp(join(tmpdir(), 'kit-0.3.0-clean-consumer-'));
  try {
    const consumerDir = await createConsumerDir(workspace);
    const nodeVersion = await readNodeVersion(options.nodePath);
    const install = await installTarball({
      nodePath: options.nodePath,
      npmPath: options.npmPath,
      consumerDir,
      tarball: options.tarball.path,
    });
    if (install.exitCode !== 0) {
      throw new Error(
        `clean consumer install failed under ${nodeVersion} with exit ${String(install.exitCode)}`
      );
    }
    const probe = await runProbe(
      options.nodePath,
      consumerDir,
      options.repoRoot
    );
    return {
      ok: true,
      mode: 'happy',
      node: {
        version: nodeVersion,
        execPath: options.nodePath,
        npmPath: options.npmPath,
      },
      tarball: {
        filename: options.tarball.filename,
        path: options.tarball.path,
        sha512: options.tarball.sha512,
        files: options.tarball.files,
        byteLength: options.tarball.byteLength,
        unpackedSize: options.tarball.unpackedSize,
        size: options.tarball.size,
        version: options.tarball.version,
      },
      install: {
        exitCode: install.exitCode,
        scriptsEnabled: true,
        ignoreScripts: false,
        workspaceLinked: false,
        fileSourceTree: false,
        stdout: install.stdout,
        stderr: install.stderr,
      },
      probe,
    };
  } finally {
    if (!options.keep) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      log(`kept workspace ${workspace}`);
    }
  }
}

async function runEngineMismatch(options) {
  const workspace = await mkdtemp(join(tmpdir(), 'kit-0.3.0-engine-mismatch-'));
  try {
    const nodeVersion = await readNodeVersion(options.nodePath);
    const major = Number(nodeVersion.slice(1).split('.')[0]);
    if (major >= 22) {
      throw new Error(
        `engine-mismatch mode requires Node 20, received ${nodeVersion}`
      );
    }
    const warnedDir = await createConsumerDir(join(workspace, 'warned'));
    const warned = await installTarball({
      nodePath: options.nodePath,
      npmPath: options.npmPath,
      consumerDir: warnedDir,
      tarball: options.tarball.path,
    });
    const warnedSignals = collectEngineSignals(warned.combined);
    const strictDir = await createConsumerDir(join(workspace, 'strict'));
    const strict = await installTarball({
      nodePath: options.nodePath,
      npmPath: options.npmPath,
      consumerDir: strictDir,
      tarball: options.tarball.path,
      engineStrict: true,
    });
    const strictSignals = collectEngineSignals(strict.combined);
    const surfaced =
      warnedSignals.ebadengine ||
      strictSignals.ebadengine ||
      strict.exitCode !== 0;
    if (!surfaced) {
      throw new Error(
        `Node ${nodeVersion} install did not surface engines.node mismatch`
      );
    }
    if (strict.exitCode === 0) {
      throw new Error(
        'engine-strict install succeeded; Node 20 was treated as supported'
      );
    }
    return {
      ok: true,
      mode: 'engine-mismatch',
      node: {
        version: nodeVersion,
        execPath: options.nodePath,
        npmPath: options.npmPath,
      },
      tarball: {
        filename: options.tarball.filename,
        path: options.tarball.path,
        sha512: options.tarball.sha512,
        files: options.tarball.files,
        byteLength: options.tarball.byteLength,
        unpackedSize: options.tarball.unpackedSize,
        size: options.tarball.size,
        version: options.tarball.version,
      },
      requiredEngine: '>=22.0.0',
      treatedAsSupported: false,
      warningInstall: {
        exitCode: warned.exitCode,
        ebadengine: warnedSignals.ebadengine,
        required: warnedSignals.required,
        current: warnedSignals.current,
        stdout: warned.stdout,
        stderr: warned.stderr,
      },
      engineStrictInstall: {
        exitCode: strict.exitCode,
        ebadengine: strictSignals.ebadengine,
        required: strictSignals.required,
        current: strictSignals.current,
        stdout: strict.stdout,
        stderr: strict.stderr,
      },
    };
  } finally {
    if (!options.keep) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      log(`kept workspace ${workspace}`);
    }
  }
}

async function verifyOfficialChecksum(version, tarName, tarPath) {
  const { stdout } = await execFileAsync('curl', [
    '-fsSL',
    `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
  ]);
  const line = stdout.split('\n').find(entry => entry.endsWith(tarName));
  if (line === undefined) {
    throw new Error(`SHASUMS256.txt has no entry for ${tarName}`);
  }
  const expected = line.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(tarPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${tarName}`);
  }
}

async function ensureOfficialNode(cacheDir, version) {
  const triple = platformTriple();
  const unpacked = join(cacheDir, `node-v${version}-${triple}`);
  const execPath = join(unpacked, 'bin', 'node');
  const npmPath = join(unpacked, 'bin', 'npm');
  try {
    await access(execPath);
    await access(npmPath);
    return { version, execPath, npmPath };
  } catch {
    // download below
  }
  await mkdir(cacheDir, { recursive: true });
  const tarName = `node-v${version}-${triple}.tar.gz`;
  const tarPath = join(cacheDir, tarName);
  const url = `https://nodejs.org/dist/v${version}/${tarName}`;
  log(`downloading official Node ${version} from ${url}`);
  await execFileAsync('curl', ['-fsSL', url, '-o', tarPath]);
  await verifyOfficialChecksum(version, tarName, tarPath);
  await execFileAsync('tar', ['-xzf', tarPath, '-C', cacheDir]);
  await access(execPath);
  return { version, execPath, npmPath };
}

async function resolveTarball(args, packDir) {
  if (args.tarball !== undefined) {
    return inspectTarball(args.tarball);
  }
  return packCandidate(args.repo, packDir);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packDir = await mkdtemp(join(tmpdir(), 'kit-0.3.0-pack-'));
  try {
    if (args.mode === 'matrix') {
      const cacheDir = join(args.repo, '.cache', 'node');
      const node20 = await ensureOfficialNode(cacheDir, OFFICIAL_NODES[20]);
      const node22 = await ensureOfficialNode(cacheDir, OFFICIAL_NODES[22]);
      const node24 = await ensureOfficialNode(cacheDir, OFFICIAL_NODES[24]);
      const tarball = await resolveTarball(args, packDir);
      const happy22 = await runHappy({
        nodePath: node22.execPath,
        npmPath: node22.npmPath,
        tarball,
        repoRoot: args.repo,
        keep: args.keep,
      });
      const happy24 = await runHappy({
        nodePath: node24.execPath,
        npmPath: node24.npmPath,
        tarball,
        repoRoot: args.repo,
        keep: args.keep,
      });
      const mismatch20 = await runEngineMismatch({
        nodePath: node20.execPath,
        npmPath: node20.npmPath,
        tarball,
        keep: args.keep,
      });
      const report = {
        ok: happy22.ok && happy24.ok && mismatch20.ok,
        mode: 'matrix',
        tarball: happy22.tarball,
        node22: happy22,
        node24: happy24,
        node20: mismatch20,
        officialNodes: OFFICIAL_NODES,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const nodePath = args.node ?? process.execPath;
    const npmPath = npmForNode(nodePath);
    const tarball = await resolveTarball(args, packDir);
    const report =
      args.mode === 'engine-mismatch'
        ? await runEngineMismatch({
            nodePath,
            npmPath,
            tarball,
            keep: args.keep,
          })
        : await runHappy({
            nodePath,
            npmPath,
            tarball,
            repoRoot: args.repo,
            keep: args.keep,
          });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(packDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
