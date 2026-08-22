import type {
  SenpiAgentMessage,
  SenpiBranchSummaryEntry,
  SenpiCompactionEntry,
  SenpiLabelEntry,
  SenpiMessageEntry,
  SenpiSessionEntry,
  SenpiSessionHeader,
  SenpiSessionInfoEntry,
} from '../types.js';
import type { SenpiEntryParseResult, SenpiUnknownEntry } from './parse.js';

type SenpiKnownTreeEntry = Exclude<SenpiSessionEntry, SenpiSessionHeader>;

/** A validated known or forward-compatible unknown entry that participates in the session tree. */
export type SenpiTreeEntry = SenpiKnownTreeEntry | SenpiUnknownEntry;

/** Inputs accepted by the pure projection boundary; invalid parse results are diagnosed and skipped. */
export type SenpiProjectionInput = SenpiSessionEntry | SenpiEntryParseResult;

/** Stable diagnostic codes emitted while indexing or projecting malformed session trees. */
export type SenpiProjectionWarningCode =
  | 'cycle'
  | 'dangling_branch_reference'
  | 'dangling_label_reference'
  | 'dangling_tool_reference'
  | 'duplicate_id'
  | 'empty_id'
  | 'invalid_entry'
  | 'missing_first_kept'
  | 'missing_leaf'
  | 'missing_parent'
  | 'multiple_session_headers';

/** A deterministic, machine-readable projection diagnostic tied to an entry when possible. */
export interface SenpiProjectionWarning {
  readonly code: SenpiProjectionWarningCode;
  readonly message: string;
  readonly entryId?: string;
  readonly relatedId?: string;
}

/**
 * Immutable index view implementing physical-order leaf selection and reject-without-overwrite tree insertion.
 */
export interface SenpiTreeIndex {
  readonly byId: ReadonlyMap<string, SenpiTreeEntry>;
  readonly parentById: ReadonlyMap<string, string | null>;
  readonly childrenByParent: ReadonlyMap<string | null, readonly string[]>;
  readonly appendOrder: readonly string[];
  readonly leafId: string | null;
  readonly structuralLeaves: readonly string[];
  readonly sessionName: string | undefined;
  readonly labelsByTargetId: ReadonlyMap<string, string>;
}

/** Resolution result whose `invalid` state prevents corrupt duplicate/cyclic graphs from masquerading as success. */
export type SenpiLeafResolution =
  | {
      readonly kind: 'empty';
      readonly leafId: null;
      readonly index: SenpiTreeIndex;
      readonly warnings: readonly SenpiProjectionWarning[];
    }
  | {
      readonly kind: 'resolved';
      readonly leafId: string;
      readonly index: SenpiTreeIndex;
      readonly warnings: readonly SenpiProjectionWarning[];
    }
  | {
      readonly kind: 'invalid';
      readonly leafId: string | null;
      readonly index: SenpiTreeIndex;
      readonly warnings: readonly SenpiProjectionWarning[];
    };

/** Disposition applied only to accepted physical entries excluded from the active projected context. */
export type SenpiOffPathDisposition = 'off_branch' | 'summarized';

/** An accepted physical entry retained in the active context under its stable entry-id key. */
export interface SenpiEntryProjectionRecord {
  readonly key: string;
  readonly entryId: string;
  readonly parentId: string | null;
  readonly origin: 'entry';
  readonly disposition: 'active';
  readonly entry: SenpiTreeEntry;
}

/** A message materialized by retained-tail compaction under a synthetic compaction-scoped stable key. */
export interface SenpiRetainedProjectionRecord {
  readonly key: string;
  readonly entryId: string;
  readonly parentId: string;
  readonly origin: 'retained_tail';
  readonly disposition: 'active';
  readonly retainedIndex: number;
  readonly message: SenpiAgentMessage;
}

/** One stable active-context record, either physical or synthesized from a retained tail. */
export type SenpiProjectionRecord =
  | SenpiEntryProjectionRecord
  | SenpiRetainedProjectionRecord;

/** An accepted physical entry omitted from context because it is another branch or compacted history. */
export interface SenpiOffPathRecord {
  readonly key: string;
  readonly entryId: string;
  readonly parentId: string | null;
  readonly origin: 'entry';
  readonly disposition: SenpiOffPathDisposition;
  readonly entry: SenpiTreeEntry;
}

/** Projection options preserve off-path visibility by default while allowing callers to omit that metadata. */
export interface SenpiProjectionOptions {
  readonly includeOffPath?: boolean;
}

interface SenpiProjectionResultBase {
  readonly leafId: string | null;
  readonly index: SenpiTreeIndex;
  readonly records: readonly SenpiProjectionRecord[];
  readonly offPath: readonly SenpiOffPathRecord[];
  readonly warnings: readonly SenpiProjectionWarning[];
  readonly complete: boolean;
}

/** Projection outcome with explicit empty, valid, and structurally invalid states. */
export type SenpiProjectionResult =
  | (SenpiProjectionResultBase & { readonly kind: 'empty' })
  | (SenpiProjectionResultBase & { readonly kind: 'projected' })
  | (SenpiProjectionResultBase & { readonly kind: 'invalid' });

/** A single suffix splice derived from the longest common prefix of stable projection keys. */
export interface SenpiProjectionMutation {
  readonly index: number;
  readonly deleteCount: number;
  readonly records: readonly SenpiProjectionRecord[];
  readonly removedRecordKeys: readonly string[];
}

interface NormalizedInputs {
  readonly headers: readonly SenpiSessionHeader[];
  readonly entries: readonly SenpiTreeEntry[];
  readonly warnings: readonly SenpiProjectionWarning[];
}

function isHeader(entry: SenpiSessionEntry): entry is SenpiSessionHeader {
  return entry.type === 'session';
}

function isParseResult(
  input: SenpiProjectionInput
): input is SenpiEntryParseResult {
  const kind = Reflect.get(input, 'kind');
  return kind === 'known' || kind === 'unknown' || kind === 'invalid';
}

function isCompaction(entry: SenpiTreeEntry): entry is SenpiCompactionEntry {
  return entry.type === 'compaction' && typeof entry.summary === 'string';
}

function isMessage(entry: SenpiTreeEntry): entry is SenpiMessageEntry {
  return entry.type === 'message' && typeof entry.message === 'object';
}

function isSessionInfo(entry: SenpiTreeEntry): entry is SenpiSessionInfoEntry {
  return entry.type === 'session_info' && typeof entry.name === 'string';
}

function isLabel(entry: SenpiTreeEntry): entry is SenpiLabelEntry {
  return entry.type === 'label' && typeof entry.targetId === 'string';
}

function isBranchSummary(
  entry: SenpiTreeEntry
): entry is SenpiBranchSummaryEntry {
  return entry.type === 'branch_summary' && typeof entry.fromId === 'string';
}

function normalizeInputs(
  inputs: readonly SenpiProjectionInput[]
): NormalizedInputs {
  const headers: SenpiSessionHeader[] = [];
  const entries: SenpiTreeEntry[] = [];
  const warnings: SenpiProjectionWarning[] = [];

  for (const input of inputs) {
    if (isParseResult(input)) {
      if (input.kind === 'invalid') {
        warnings.push({
          code: 'invalid_entry',
          message: `Invalid parsed entry was excluded: ${input.error}`,
        });
        continue;
      }
      if (input.kind === 'known') {
        if (isHeader(input.entry)) {
          headers.push(input.entry);
        } else {
          entries.push(input.entry);
        }
      } else {
        entries.push(input.entry);
      }
      continue;
    }

    if (isHeader(input)) {
      headers.push(input);
    } else {
      entries.push(input);
    }
  }

  if (headers.length > 1) {
    warnings.push({
      code: 'multiple_session_headers',
      message: `Session contains ${headers.length} headers; only the first header is authoritative.`,
    });
  }

  return { headers, entries, warnings };
}

function detectCycles(entries: readonly SenpiTreeEntry[]): readonly string[] {
  const parentById = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.id.length > 0 && !parentById.has(entry.id)) {
      parentById.set(entry.id, entry.parentId);
    }
  }

  const cyclic = new Set<string>();
  const settled = new Set<string>();
  for (const start of parentById.keys()) {
    if (settled.has(start)) continue;
    const positions = new Map<string, number>();
    const walk: string[] = [];
    let cursor: string | null | undefined = start;
    while (cursor !== null && cursor !== undefined && !settled.has(cursor)) {
      const cycleStart = positions.get(cursor);
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < walk.length; index += 1) {
          const id = walk[index];
          if (id !== undefined) cyclic.add(id);
        }
        break;
      }
      positions.set(cursor, walk.length);
      walk.push(cursor);
      cursor = parentById.get(cursor);
    }
    for (const id of walk) settled.add(id);
  }
  return [...cyclic];
}

function buildTreeIndex(inputs: readonly SenpiProjectionInput[]): {
  readonly index: SenpiTreeIndex;
  readonly warnings: readonly SenpiProjectionWarning[];
  readonly fatal: boolean;
} {
  const normalized = normalizeInputs(inputs);
  const warnings = [...normalized.warnings];
  const cycleIds = detectCycles(normalized.entries);
  const cycleSet = new Set(cycleIds);
  for (const id of cycleIds) {
    warnings.push({
      code: 'cycle',
      message: `Entry "${id}" participates in a parent cycle.`,
      entryId: id,
    });
  }

  const byId = new Map<string, SenpiTreeEntry>();
  const parentById = new Map<string, string | null>();
  const childrenByParent = new Map<string | null, string[]>();
  const appendOrder: string[] = [];
  const labelsByTargetId = new Map<string, string>();
  let sessionName: string | undefined;
  let fatal = cycleIds.length > 0;

  for (const entry of normalized.entries) {
    if (entry.id.length === 0) {
      warnings.push({
        code: 'empty_id',
        message: 'Entry with an empty id was rejected.',
      });
      fatal = true;
      continue;
    }
    if (byId.has(entry.id)) {
      warnings.push({
        code: 'duplicate_id',
        message: `Duplicate entry id "${entry.id}" was rejected without overwriting its first occurrence.`,
        entryId: entry.id,
      });
      fatal = true;
      continue;
    }
    if (cycleSet.has(entry.id)) continue;
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      warnings.push({
        code: 'missing_parent',
        message: `Entry "${entry.id}" was rejected because parent "${entry.parentId}" was not already indexed.`,
        entryId: entry.id,
        relatedId: entry.parentId,
      });
      continue;
    }

    byId.set(entry.id, entry);
    parentById.set(entry.id, entry.parentId);
    appendOrder.push(entry.id);
    const siblings = childrenByParent.get(entry.parentId) ?? [];
    siblings.push(entry.id);
    childrenByParent.set(entry.parentId, siblings);

    if (isSessionInfo(entry)) sessionName = entry.name;
    if (isLabel(entry)) labelsByTargetId.set(entry.targetId, entry.label);
  }

  for (const entry of byId.values()) {
    if (isLabel(entry) && !byId.has(entry.targetId)) {
      warnings.push({
        code: 'dangling_label_reference',
        message: `Label "${entry.id}" targets missing entry "${entry.targetId}".`,
        entryId: entry.id,
        relatedId: entry.targetId,
      });
    }
    if (isBranchSummary(entry) && !byId.has(entry.fromId)) {
      warnings.push({
        code: 'dangling_branch_reference',
        message: `Branch summary "${entry.id}" references missing entry "${entry.fromId}".`,
        entryId: entry.id,
        relatedId: entry.fromId,
      });
    }
  }

  const structuralLeaves = appendOrder.filter(
    id => (childrenByParent.get(id)?.length ?? 0) === 0
  );
  const leafId = appendOrder.at(-1) ?? null;
  return {
    index: {
      byId,
      parentById,
      childrenByParent,
      appendOrder,
      leafId,
      structuralLeaves,
      sessionName,
      labelsByTargetId,
    },
    warnings,
    fatal,
  };
}

/**
 * Resolves the persisted leaf as the last accepted non-header entry in physical order, never by timestamp.
 */
export function resolveSenpiLeaf(
  entries: readonly SenpiProjectionInput[],
  requestedLeafId?: string | null
): SenpiLeafResolution {
  const built = buildTreeIndex(entries);
  const leafId =
    requestedLeafId === undefined ? built.index.leafId : requestedLeafId;
  const warnings = [...built.warnings];

  if (leafId !== null && !built.index.byId.has(leafId)) {
    warnings.push({
      code: 'missing_leaf',
      message: `Requested leaf "${leafId}" is not an accepted tree entry.`,
      relatedId: leafId,
    });
    return { kind: 'invalid', leafId, index: built.index, warnings };
  }
  if (built.fatal) {
    return { kind: 'invalid', leafId, index: built.index, warnings };
  }
  if (leafId === null) {
    return { kind: 'empty', leafId: null, index: built.index, warnings };
  }
  return { kind: 'resolved', leafId, index: built.index, warnings };
}

function walkRootPath(
  index: SenpiTreeIndex,
  leafId: string
): { readonly path: readonly SenpiTreeEntry[]; readonly cycleId?: string } {
  const reversed: SenpiTreeEntry[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (visited.has(cursor)) return { path: [], cycleId: cursor };
    visited.add(cursor);
    const entry = index.byId.get(cursor);
    if (entry === undefined) return { path: [] };
    reversed.push(entry);
    cursor = index.parentById.get(cursor) ?? null;
  }
  return { path: reversed.reverse() };
}

function entryRecord(entry: SenpiTreeEntry): SenpiEntryProjectionRecord {
  return {
    key: entry.id,
    entryId: entry.id,
    parentId: entry.parentId,
    origin: 'entry',
    disposition: 'active',
    entry,
  };
}

function diagnoseDanglingToolReferences(
  records: readonly SenpiProjectionRecord[],
  warnings: SenpiProjectionWarning[]
): void {
  const toolCalls = new Set<string>();
  for (const record of records) {
    const message =
      record.origin === 'retained_tail'
        ? record.message
        : isMessage(record.entry)
          ? record.entry.message
          : undefined;
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') toolCalls.add(block.id);
      }
    } else if (
      message?.role === 'toolResult' &&
      !toolCalls.has(message.toolCallId)
    ) {
      warnings.push({
        code: 'dangling_tool_reference',
        message: `Tool result in "${record.key}" references missing tool call "${message.toolCallId}".`,
        entryId: record.entryId,
        relatedId: message.toolCallId,
      });
    }
  }
}

/**
 * Projects one accepted root-to-leaf branch, applying only its latest compaction and stable retained-tail keys.
 */
export function projectSenpiBranch(
  entries: readonly SenpiProjectionInput[],
  leafId: string | null,
  options: SenpiProjectionOptions = {}
): SenpiProjectionResult {
  const resolution = resolveSenpiLeaf(entries, leafId);
  const warnings = [...resolution.warnings];
  if (resolution.kind === 'invalid') {
    return {
      kind: 'invalid',
      leafId: resolution.leafId,
      index: resolution.index,
      records: [],
      offPath: [],
      warnings,
      complete: false,
    };
  }
  if (resolution.kind === 'empty') {
    return {
      kind: 'empty',
      leafId: null,
      index: resolution.index,
      records: [],
      offPath: [],
      warnings,
      complete: true,
    };
  }

  const walked = walkRootPath(resolution.index, resolution.leafId);
  if (walked.cycleId !== undefined) {
    warnings.push({
      code: 'cycle',
      message: `Cycle encountered while projecting from "${walked.cycleId}".`,
      entryId: walked.cycleId,
    });
    return {
      kind: 'invalid',
      leafId: resolution.leafId,
      index: resolution.index,
      records: [],
      offPath: [],
      warnings,
      complete: false,
    };
  }

  const path = walked.path;
  let activePhysical: readonly SenpiTreeEntry[] = path;
  let records: SenpiProjectionRecord[];
  let complete = true;
  let latestCompactionIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry !== undefined && isCompaction(entry)) {
      latestCompactionIndex = index;
      break;
    }
  }

  if (latestCompactionIndex < 0) {
    records = path.map(entryRecord);
  } else {
    const compaction = path[latestCompactionIndex];
    if (compaction === undefined || !isCompaction(compaction)) {
      records = path.map(entryRecord);
    } else {
      const post = path.slice(latestCompactionIndex + 1);
      if (compaction.retainedTail !== undefined) {
        activePhysical = [compaction, ...post];
        records = [
          entryRecord(compaction),
          ...compaction.retainedTail.map(
            (message, retainedIndex): SenpiRetainedProjectionRecord => ({
              key: `retained:${compaction.id}:${retainedIndex}`,
              entryId: compaction.id,
              parentId: compaction.id,
              origin: 'retained_tail',
              disposition: 'active',
              retainedIndex,
              message,
            })
          ),
          ...post.map(entryRecord),
        ];
      } else {
        const firstKeptIndex =
          compaction.firstKeptEntryId === undefined
            ? -1
            : path.findIndex(
                (entry, index) =>
                  index < latestCompactionIndex &&
                  entry.id === compaction.firstKeptEntryId
              );
        if (firstKeptIndex < 0) {
          warnings.push({
            code: 'missing_first_kept',
            message:
              compaction.firstKeptEntryId === undefined
                ? `Legacy compaction "${compaction.id}" has no firstKeptEntryId.`
                : `Legacy compaction "${compaction.id}" references missing or off-path firstKeptEntryId "${compaction.firstKeptEntryId}".`,
            entryId: compaction.id,
            ...(compaction.firstKeptEntryId === undefined
              ? {}
              : { relatedId: compaction.firstKeptEntryId }),
          });
          complete = false;
          activePhysical = [compaction, ...post];
          records = [entryRecord(compaction), ...post.map(entryRecord)];
        } else {
          const kept = path
            .slice(firstKeptIndex, latestCompactionIndex)
            .filter(entry => !isCompaction(entry));
          activePhysical = [compaction, ...kept, ...post];
          records = [
            entryRecord(compaction),
            ...kept.map(entryRecord),
            ...post.map(entryRecord),
          ];
        }
      }
    }
  }

  diagnoseDanglingToolReferences(records, warnings);
  const activeIds = new Set(activePhysical.map(entry => entry.id));
  const pathIds = new Set(path.map(entry => entry.id));
  const offPath =
    options.includeOffPath === false
      ? []
      : resolution.index.appendOrder.flatMap(id => {
          if (activeIds.has(id)) return [];
          const entry = resolution.index.byId.get(id);
          if (entry === undefined) return [];
          const disposition: SenpiOffPathDisposition = pathIds.has(id)
            ? 'summarized'
            : 'off_branch';
          return [
            {
              key: entry.id,
              entryId: entry.id,
              parentId: entry.parentId,
              origin: 'entry' as const,
              disposition,
              entry,
            },
          ];
        });

  return {
    kind: 'projected',
    leafId: resolution.leafId,
    index: resolution.index,
    records,
    offPath,
    warnings,
    complete,
  };
}

/**
 * Computes the sole suffix splice after the longest common prefix, returning null only for identical key sequences.
 */
export function computeProjectionMutation(
  previousRecordKeys: readonly string[],
  nextRecords: readonly SenpiProjectionRecord[]
): SenpiProjectionMutation | null {
  let index = 0;
  while (
    index < previousRecordKeys.length &&
    index < nextRecords.length &&
    previousRecordKeys[index] === nextRecords[index]?.key
  ) {
    index += 1;
  }
  if (index === previousRecordKeys.length && index === nextRecords.length) {
    return null;
  }
  return {
    index,
    deleteCount: previousRecordKeys.length - index,
    records: nextRecords.slice(index),
    removedRecordKeys: previousRecordKeys.slice(index),
  };
}
