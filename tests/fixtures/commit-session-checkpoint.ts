import { readFile } from 'node:fs/promises';

import {
  commitRawTranscriptSessionCheckpoint,
  type RawTranscriptSessionCheckpoint,
  type RawTranscriptSourceCheckpoint,
} from '../../src/processing/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSourceCheckpoint(
  value: unknown
): value is RawTranscriptSourceCheckpoint {
  return (
    isRecord(value) &&
    (value['sourceKind'] === 'main' || value['sourceKind'] === 'subagent') &&
    typeof value['sourceId'] === 'string' &&
    typeof value['generation'] === 'number' &&
    typeof value['byteOffset'] === 'number' &&
    typeof value['fileSize'] === 'number'
  );
}

function isSessionCheckpoint(
  value: unknown
): value is RawTranscriptSessionCheckpoint {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['mainPathDigest'] === 'string' &&
    typeof value['baseRevision'] === 'number' &&
    Array.isArray(value['sources']) &&
    value['sources'].every(source => isSourceCheckpoint(source))
  );
}

async function main(): Promise<void> {
  const [mainJsonlPath, markerDir, allowedRoot, checkpointPath] =
    process.argv.slice(2);
  if (
    mainJsonlPath === undefined ||
    markerDir === undefined ||
    allowedRoot === undefined ||
    checkpointPath === undefined
  ) {
    throw new Error('Expected main path, marker dir, allowed root, checkpoint');
  }
  const parsed: unknown = JSON.parse(await readFile(checkpointPath, 'utf8'));
  if (!isSessionCheckpoint(parsed)) {
    throw new Error('Invalid checkpoint fixture');
  }
  await commitRawTranscriptSessionCheckpoint(mainJsonlPath, parsed, {
    markerDir,
    allowedMarkerRoots: [allowedRoot],
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
