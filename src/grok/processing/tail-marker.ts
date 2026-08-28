import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  byteCursorsEqual,
  checkpointRevision,
} from '../../internal/incremental.js';
import { withMarkerLock } from '../../internal/marker-lock.js';
import {
  createMarkerPathDigest,
  resolveAllowedMarkerDir,
  sanitizeMarkerBase,
  writePrivateJson,
  type ResolveAllowedMarkerDirOptions,
} from '../../internal/marker-store.js';
import {
  parseJsonlOversizedPending,
  type JsonlCursor,
} from '../../internal/jsonl-cursor.js';
import { StaleCheckpointConflict } from '../../processing/stale-checkpoint-conflict.js';
import { grokSourceKinds } from './tail-order.js';
import type {
  GrokSessionCheckpoint,
  GrokSessionCheckpointCommitOptions,
  GrokTailSourceKind,
} from './tail-types.js';

const MARKER_VERSION = 1;

/** Private persisted Grok marker schema. */
export interface GrokSessionMarker {
  readonly version: 1;
  readonly sessionPathDigest: string;
  readonly revision: number;
  readonly sources: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>;
}

/** Stable digest of one resolved Grok session directory. */
export function createGrokSessionPathDigest(sessionDir: string): string {
  return createMarkerPathDigest(sessionDir);
}

/** Resolve the bounded private marker path for one Grok session. */
export function getGrokSessionMarkerPath(
  sessionDir: string,
  options: GrokSessionCheckpointCommitOptions
): string {
  const markerDir =
    options.markerDir === undefined
      ? resolve(sessionDir, '.tail-markers')
      : resolveAllowedMarkerDir(
          options.markerDir,
          grokAllowedMarkerDirOptions(options)
        );
  const digest = createGrokSessionPathDigest(sessionDir);
  const sessionName = sanitizeMarkerBase(basename(sessionDir));
  return join(
    markerDir,
    `${sessionName}-${digest.slice(0, 16)}.grok-session.json`
  );
}

/** Read and validate one Grok marker; invalid or missing bytes are absent-state. */
export async function readGrokSessionMarker(
  markerPath: string,
  sessionPathDigest: string
): Promise<GrokSessionMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!isRecord(parsed) || parsed['version'] !== MARKER_VERSION) return null;
    if (parsed['sessionPathDigest'] !== sessionPathDigest) return null;
    const revision = parsed['revision'];
    const sources = parsed['sources'];
    if (!isSafeNonnegativeInteger(revision) || !isRecord(sources)) return null;
    const updates = parseCursor(sources['updates']);
    const events = parseCursor(sources['events']);
    if (updates === undefined || events === undefined) return null;
    return {
      version: MARKER_VERSION,
      sessionPathDigest,
      revision,
      sources: { updates, events },
    };
  } catch {
    return null;
  }
}

/** Validate and index both source cursors from a public checkpoint. */
export function grokCheckpointSources(
  checkpoint: GrokSessionCheckpoint
): Record<GrokTailSourceKind, JsonlCursor | null> {
  if (!isSafeNonnegativeInteger(checkpoint.baseRevision)) {
    throw new Error('Invalid Grok session checkpoint revision');
  }
  const sources: Partial<Record<GrokTailSourceKind, JsonlCursor | null>> = {};
  for (const source of checkpoint.sources) {
    if (source.sourceKind !== 'updates' && source.sourceKind !== 'events') {
      throw new Error('Invalid Grok session checkpoint source');
    }
    if (Object.hasOwn(sources, source.sourceKind)) {
      throw new Error('Grok session checkpoint has duplicate sources');
    }
    const parsed = parseCursor(source.cursor);
    if (parsed === undefined) {
      throw new Error('Invalid Grok session checkpoint cursor');
    }
    sources[source.sourceKind] = parsed;
  }
  if (!Object.hasOwn(sources, 'updates') || !Object.hasOwn(sources, 'events')) {
    throw new Error('Grok session checkpoint must contain both sources');
  }
  return { updates: sources.updates ?? null, events: sources.events ?? null };
}

/** True when automatic persistence would advance at least one cursor. */
export function shouldCommitGrokMarker(
  marker: GrokSessionMarker | null,
  checkpoint: GrokSessionCheckpoint
): boolean {
  const next = grokCheckpointSources(checkpoint);
  if (marker === null) return next.updates !== null || next.events !== null;
  return grokSourceKinds().some(
    sourceKind =>
      !byteCursorsEqual(marker.sources[sourceKind], next[sourceKind])
  );
}

/** Commit a validated Grok checkpoint under the shared private marker lock. */
export async function commitGrokSessionCheckpoint(
  sessionDir: string,
  checkpoint: GrokSessionCheckpoint,
  options: GrokSessionCheckpointCommitOptions = {}
): Promise<void> {
  const resolvedSessionDir = resolve(sessionDir);
  const sessionPathDigest = createGrokSessionPathDigest(resolvedSessionDir);
  if (checkpoint.sessionPathDigest !== sessionPathDigest) {
    throw new Error('Grok session checkpoint does not match the session path');
  }
  const nextSources = grokCheckpointSources(checkpoint);
  const markerPath = getGrokSessionMarkerPath(resolvedSessionDir, options);
  await withMarkerLock(
    markerPath,
    async () => {
      const marker = await readGrokSessionMarker(markerPath, sessionPathDigest);
      const revision = marker?.revision ?? 0;
      if (checkpoint.baseRevision !== revision) {
        throw new StaleCheckpointConflict({
          expectedRevision: checkpoint.baseRevision,
          actualRevision: revision,
        });
      }
      validateProgression(marker, nextSources);
      await writePrivateJson(
        markerPath,
        {
          version: MARKER_VERSION,
          sessionPathDigest,
          revision: checkpointRevision(revision, true),
          sources: nextSources,
        } satisfies GrokSessionMarker,
        options.markerDir === undefined
          ? undefined
          : grokAllowedMarkerDirOptions(options)
      );
    },
    { lockedLabel: 'Grok session marker' }
  );
}

function grokAllowedMarkerDirOptions(
  options: GrokSessionCheckpointCommitOptions
): ResolveAllowedMarkerDirOptions {
  return {
    allowedMarkerRoots: options.allowedMarkerRoots ?? [],
    emptyRootsMessage:
      'Custom markerDir requires allowedMarkerRoots to include an allowed root',
  };
}

function parseCursor(value: unknown): JsonlCursor | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const pending = parseJsonlOversizedPending(value['pending']);
  if (
    typeof value['device'] !== 'string' ||
    typeof value['inode'] !== 'string' ||
    !isSafeNonnegativeInteger(value['offset']) ||
    !isSafeNonnegativeInteger(value['lineNumber']) ||
    value['lineNumber'] < 1 ||
    !isSafeNonnegativeInteger(value['generation']) ||
    typeof value['headDigest'] !== 'string' ||
    typeof value['boundaryDigest'] !== 'string' ||
    pending === undefined
  )
    return undefined;
  return {
    device: value['device'],
    inode: value['inode'],
    offset: value['offset'],
    lineNumber: value['lineNumber'],
    generation: value['generation'],
    headDigest: value['headDigest'],
    boundaryDigest: value['boundaryDigest'],
    pending,
  };
}

function validateProgression(
  marker: GrokSessionMarker | null,
  next: Readonly<Record<GrokTailSourceKind, JsonlCursor | null>>
): void {
  for (const sourceKind of grokSourceKinds()) {
    const previous = marker?.sources[sourceKind] ?? null;
    const cursor = next[sourceKind];
    if (previous === null || cursor === null) continue;
    if (cursor.generation === previous.generation) {
      if (cursor.offset < previous.offset) {
        throw new Error(
          'Grok session checkpoint would move a source backwards'
        );
      }
    } else if (cursor.generation !== previous.generation + 1) {
      throw new Error(
        'Grok session checkpoint has an invalid generation transition'
      );
    }
  }
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
