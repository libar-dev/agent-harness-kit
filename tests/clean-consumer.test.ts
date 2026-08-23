import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`expected string field ${key}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`expected number field ${key}`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`expected boolean field ${key}`);
  }
  return value;
}

describe('clean consumer matrix contract', () => {
  it('encodes Node 22 and 24 packed-consumer jobs in CI', async () => {
    const workflow = await readFile(
      join(repoRoot, '.github/workflows/test.yml'),
      'utf8'
    );

    expect(workflow).toMatch(/^ {2}clean-consumer:\s*$/m);
    expect(workflow).toMatch(/^ {2}engine-mismatch:\s*$/m);
    expect(workflow).toContain('scripts/clean-consumer.mjs --mode happy');
    expect(workflow).toContain(
      'scripts/clean-consumer.mjs --mode engine-mismatch --tarball'
    );
    expect(workflow).toContain('npm pack --ignore-scripts');
    expect(workflow).toContain('node-version: 20');

    const cleanConsumerBlock = workflow.slice(
      workflow.indexOf('  clean-consumer:')
    );
    const cleanMatrix = /node-version:\s*\[([^\]]+)\]/.exec(cleanConsumerBlock);
    expect(cleanMatrix?.[1]?.replaceAll(' ', '')).toBe('22,24');
    expect(cleanConsumerBlock).toContain('--mode happy');
    expect(cleanConsumerBlock).not.toContain('npm install --ignore-scripts');
  });

  it('ships the isolated clean-consumer probe fixture', async () => {
    await expect(
      access(join(repoRoot, 'scripts/clean-consumer.mjs'))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repoRoot, 'tests/fixtures/clean-consumer/probe.mjs'))
    ).resolves.toBeUndefined();

    const pkg = JSON.parse(
      await readFile(join(repoRoot, 'package.json'), 'utf8')
    ) as unknown;
    if (!isRecord(pkg) || !isRecord(pkg['scripts'])) {
      throw new Error('package.json scripts missing');
    }
    expect(pkg['scripts']['consumer:matrix']).toBe(
      'node scripts/clean-consumer.mjs --matrix'
    );
    expect(pkg['version']).toBe('0.3.0');
  });

  it('installs the packed tarball with scripts enabled and exercises public exports', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(repoRoot, 'scripts/clean-consumer.mjs'), '--mode', 'happy'],
      { cwd: repoRoot, timeout: 180_000 }
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error('clean-consumer report was not an object');
    }
    expect(readBoolean(parsed, 'ok')).toBe(true);
    expect(readString(parsed, 'mode')).toBe('happy');

    const tarball = parsed['tarball'];
    if (!isRecord(tarball)) {
      throw new Error('missing tarball report');
    }
    expect(readString(tarball, 'version')).toBe('0.3.0');
    expect(readString(tarball, 'filename')).toBe(
      'libar-dev-agent-harness-kit-0.3.0.tgz'
    );
    expect(readString(tarball, 'sha512')).toMatch(/^[0-9a-f]{128}$/);
    const files = tarball['files'];
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) {
      throw new Error('tarball file list missing');
    }
    expect(files).toContain('dist/standalone/hook-forwarder.mjs');
    expect(files).toContain('dist/standalone/hook-forwarder-senpi.mjs');

    const install = parsed['install'];
    if (!isRecord(install)) {
      throw new Error('missing install report');
    }
    expect(readBoolean(install, 'scriptsEnabled')).toBe(true);
    expect(readBoolean(install, 'ignoreScripts')).toBe(false);
    expect(readBoolean(install, 'workspaceLinked')).toBe(false);
    expect(readBoolean(install, 'fileSourceTree')).toBe(false);
    expect(readNumber(install, 'exitCode')).toBe(0);

    const probe = parsed['probe'];
    if (!isRecord(probe)) {
      throw new Error('missing probe report');
    }
    const imported = probe['imported'];
    if (
      !Array.isArray(imported) ||
      imported.some(entry => typeof entry !== 'string')
    ) {
      throw new Error('probe imported list missing');
    }
    expect(imported).toEqual([
      ...documentedConcreteSubpaths,
      ...documentedWildcardExamples,
    ]);

    const grok = probe['grok'];
    const senpi = probe['senpi'];
    const forwarder = probe['forwarder'];
    if (!isRecord(grok) || !isRecord(senpi) || !isRecord(forwarder)) {
      throw new Error('probe did not exercise processing and forwarders');
    }
    expect(readBoolean(grok, 'ok')).toBe(true);
    expect(readNumber(grok, 'recordCount')).toBeGreaterThan(0);
    expect(readBoolean(senpi, 'ok')).toBe(true);
    expect(readNumber(senpi, 'recordCount')).toBeGreaterThan(0);

    const claude = forwarder['claude'];
    const senpiForward = forwarder['senpi'];
    if (!isRecord(claude) || !isRecord(senpiForward)) {
      throw new Error('forwarder results missing');
    }
    expect(readBoolean(claude, 'ok')).toBe(true);
    expect(readBoolean(senpiForward, 'ok')).toBe(true);
  }, 180_000);
});
