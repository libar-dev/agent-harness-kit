import type { JsonlDelta, JsonlLine } from '../../internal/jsonl-cursor.js';
import type { GrokNormalizedRecord, GrokRecordOrigin } from './blocks.js';
import { grokSourceKinds } from './tail-order.js';
import { parseGrokEvent } from './events.js';
import type {
  GrokTailDiagnostic,
  GrokTailRecord,
  GrokTailSourceKind,
} from './tail-types.js';
import { parseGrokSessionUpdate } from './updates.js';

/** Parsed records and diagnostics across both source snapshots. */
export interface GrokParsedSources {
  readonly records: readonly GrokTailRecord[];
  readonly diagnostics: readonly GrokTailDiagnostic[];
}

interface ParsedLine {
  readonly record?: GrokTailRecord;
  readonly diagnostic?: GrokTailDiagnostic;
}

/** Parse complete lines from both Grok source deltas. */
export function parseGrokSources(
  deltas: Readonly<Record<GrokTailSourceKind, JsonlDelta>>,
  generations?: Readonly<Record<GrokTailSourceKind, number>>
): GrokParsedSources {
  const records: GrokTailRecord[] = [];
  const diagnostics: GrokTailDiagnostic[] = [];
  for (const sourceKind of grokSourceKinds()) {
    const delta = deltas[sourceKind];
    const generation =
      generations?.[sourceKind] ?? delta.cursor?.generation ?? 0;
    for (const diagnostic of delta.diagnostics) {
      diagnostics.push({
        sourceKind,
        kind: 'oversized',
        lineNumber: diagnostic.lineNumber,
        byteStart: diagnostic.byteStart,
        byteEnd: diagnostic.byteEnd,
        message: 'JSONL line exceeds maxLineBytes',
      });
    }
    for (const line of delta.lines) {
      const parsed = parseLine(sourceKind, generation, line);
      if (parsed.record !== undefined) records.push(parsed.record);
      if (parsed.diagnostic !== undefined) diagnostics.push(parsed.diagnostic);
    }
  }
  return { records, diagnostics };
}

function parseLine(
  sourceKind: GrokTailSourceKind,
  generation: number,
  line: JsonlLine
): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line.value) as unknown;
  } catch (error: unknown) {
    return {
      diagnostic: lineDiagnostic(
        sourceKind,
        line,
        'invalid_json',
        error instanceof Error ? error.message : String(error)
      ),
    };
  }
  if (sourceKind === 'updates') {
    const parsed = parseGrokSessionUpdate(raw);
    if (parsed.kind === 'unknown') {
      return unknownParsedLine(
        sourceKind,
        generation,
        line,
        parsed.tag,
        parsed.raw
      );
    }
    if (parsed.kind !== 'known') {
      return {
        diagnostic: lineDiagnostic(
          sourceKind,
          line,
          'invalid_record',
          parsed.error
        ),
      };
    }
    const nativeType = parsed.envelope.params.update.sessionUpdate;
    const origin = createOrigin(sourceKind, nativeType, generation, line);
    const record: GrokNormalizedRecord = {
      kind: 'update',
      envelope: parsed.envelope,
      origin,
    };
    return {
      record: {
        sourceKind,
        effectiveTimestamp: updateTimestamp(parsed.envelope),
        nativeType,
        generation,
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        record,
      },
    };
  }
  const parsed = parseGrokEvent(raw);
  if (parsed.kind === 'unknown') {
    return unknownParsedLine(
      sourceKind,
      generation,
      line,
      parsed.tag,
      parsed.raw
    );
  }
  if (parsed.kind !== 'known') {
    return {
      diagnostic: lineDiagnostic(
        sourceKind,
        line,
        'invalid_record',
        parsed.error
      ),
    };
  }
  const nativeType = parsed.event.type;
  const origin = createOrigin(sourceKind, nativeType, generation, line);
  const record: GrokNormalizedRecord = {
    kind: 'event',
    event: parsed.event,
    origin,
  };
  const parsedTimestamp = Date.parse(parsed.event.ts);
  return {
    record: {
      sourceKind,
      effectiveTimestamp: Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : 0,
      nativeType,
      generation,
      byteStart: line.byteStart,
      byteEnd: line.byteEnd,
      record,
    },
  };
}

function unknownParsedLine(
  sourceKind: GrokTailSourceKind,
  generation: number,
  line: JsonlLine,
  tag: string,
  raw: unknown
): ParsedLine {
  const origin = createOrigin(sourceKind, tag, generation, line);
  const record: GrokNormalizedRecord = { kind: 'unknown', tag, raw, origin };
  return {
    record: {
      sourceKind,
      effectiveTimestamp: unknownRecordTimestamp(sourceKind, raw),
      nativeType: tag,
      generation,
      byteStart: line.byteStart,
      byteEnd: line.byteEnd,
      record,
    },
    diagnostic: lineDiagnostic(
      sourceKind,
      line,
      'unknown_record',
      sourceKind === 'updates'
        ? `Unknown update '${tag}'`
        : `Unknown event '${tag}'`
    ),
  };
}

function createOrigin(
  sourceKind: GrokTailSourceKind,
  nativeType: string,
  generation: number,
  line: JsonlLine
): GrokRecordOrigin {
  return {
    harness: 'grok',
    stream: sourceKind === 'updates' ? 'conversation' : 'activity',
    sourceId: sourceKind,
    nativeType,
    generation,
    byteStart: line.byteStart,
    byteEnd: line.byteEnd,
  };
}

function lineDiagnostic(
  sourceKind: GrokTailSourceKind,
  line: JsonlLine,
  kind: GrokTailDiagnostic['kind'],
  message: string
): GrokTailDiagnostic {
  return {
    sourceKind,
    kind,
    lineNumber: line.lineNumber,
    byteStart: line.byteStart,
    byteEnd: line.byteEnd,
    message,
  };
}

function unknownRecordTimestamp(
  sourceKind: GrokTailSourceKind,
  raw: unknown
): number {
  if (!isRecord(raw)) return 0;
  if (sourceKind === 'updates') {
    const timestamp = raw['timestamp'];
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return Math.abs(timestamp) < 100_000_000_000
        ? timestamp * 1_000
        : timestamp;
    }
    return 0;
  }
  const timestamp = raw['ts'];
  if (typeof timestamp !== 'string') return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updateTimestamp(
  envelope: Extract<GrokNormalizedRecord, { kind: 'update' }>['envelope']
): number {
  const meta = envelope.params._meta;
  if (typeof meta === 'object' && meta !== null) {
    const value: unknown = Reflect.get(meta, 'agentTimestampMs');
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return Math.abs(envelope.timestamp) < 100_000_000_000
    ? envelope.timestamp * 1_000
    : envelope.timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
