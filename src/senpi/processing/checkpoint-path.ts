import { basename, dirname, join, resolve } from 'node:path';

import {
  createMarkerPathDigest,
  resolveAllowedMarkerDir,
  sanitizeMarkerBase,
  type ResolveAllowedMarkerDirOptions,
} from '../../internal/marker-store.js';
import type { SenpiSessionCheckpointCommitOptions } from './checkpoint-types.js';

const MARKER_ROOTS_ENV = 'SENPI_TAIL_MARKER_ROOTS';

function senpiAllowedMarkerDirOptions(
  options: Pick<SenpiSessionCheckpointCommitOptions, 'allowedMarkerRoots'>
): ResolveAllowedMarkerDirOptions {
  return {
    allowedMarkerRoots: options.allowedMarkerRoots,
    rootsEnvVar: MARKER_ROOTS_ENV,
    emptyRootsMessage:
      'Custom markerDir requires allowedMarkerRoots (or SENPI_TAIL_MARKER_ROOTS) to include an allowed root',
  };
}

/**
 * SHA-256 hex digest of the resolved session JSONL path.
 *
 * @param sessionPath - Session JSONL path.
 * @returns Digest used in marker identity and filename.
 */
export function createSenpiSessionPathDigest(sessionPath: string): string {
  return createMarkerPathDigest(sessionPath);
}

/**
 * Resolve the Senpi-prefixed marker filename for a session path.
 *
 * @param sessionPath - Session JSONL path whose digest names the marker.
 * @param options - Custom directory and allowed roots.
 * @returns Absolute marker path.
 * @throws If a custom marker directory fails the allowed-root gate.
 */
export function getSenpiSessionMarkerPath(
  sessionPath: string,
  options: SenpiSessionCheckpointCommitOptions = {}
): string {
  const resolvedSessionPath = resolve(sessionPath);
  const dir =
    options.markerDir === undefined
      ? resolve(dirname(resolvedSessionPath), '.tail-markers')
      : resolveAllowedMarkerDir(
          options.markerDir,
          senpiAllowedMarkerDirOptions(options)
        );
  const digest = createSenpiSessionPathDigest(resolvedSessionPath);
  const base = sanitizeMarkerBase(basename(resolvedSessionPath, '.jsonl'));
  return join(dir, `senpi-${base}-${digest.slice(0, 16)}.json`);
}
