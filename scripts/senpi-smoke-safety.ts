import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Content digest of one probe path. Missing paths use a stable sentinel. */
export interface SenpiSmokeProbeHash {
  readonly path: string;
  readonly digest: string;
}

/**
 * SHA-256 file or directory digest. A missing path hashes to `missing:<path>`
 * so a later create is visible. Directory digests cover sorted child names
 * and their recursive contents.
 *
 * @param path - File or directory to hash.
 * @returns Hex digest or the missing-path sentinel.
 */
export async function hashSenpiSmokeProbePath(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return `missing:${path}`;
    }
    throw error;
  }
  if (info.isDirectory()) {
    const names = (await readdir(path)).sort();
    const parts = await Promise.all(
      names.map(async name => {
        const child = join(path, name);
        return `${name}:${await hashSenpiSmokeProbePath(child)}`;
      })
    );
    return createHash('sha256').update(parts.join('|')).digest('hex');
  }
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Snapshot marker, config, and transcript hashes for a smoke probe.
 *
 * @param paths - Absolute paths that must stay byte-identical.
 * @returns One digest per path, in input order.
 */
export async function hashSenpiSmokeProbeInputs(
  paths: readonly string[]
): Promise<readonly SenpiSmokeProbeHash[]> {
  return Promise.all(
    paths.map(async path => ({
      path,
      digest: await hashSenpiSmokeProbePath(path),
    }))
  );
}

/**
 * Compare two probe snapshots and throw when any digest changed.
 *
 * @param before - Hashes captured before the probe.
 * @param after - Hashes captured after the probe.
 * @throws If any path is new, missing, or has a different digest.
 */
export function assertSenpiSmokeProbeInputsUnchanged(
  before: readonly SenpiSmokeProbeHash[],
  after: readonly SenpiSmokeProbeHash[]
): void {
  if (before.length !== after.length) {
    throw new Error(
      `Smoke probe path count changed: before=${before.length} after=${after.length}`
    );
  }
  const changed: string[] = [];
  for (const [index, previous] of before.entries()) {
    const next = after[index];
    if (next === undefined || next.path !== previous.path) {
      throw new Error('Smoke probe path set changed');
    }
    if (next.digest !== previous.digest) {
      changed.push(previous.path);
    }
  }
  if (changed.length > 0) {
    throw new Error(`Smoke probe inputs mutated: ${changed.join(', ')}`);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
