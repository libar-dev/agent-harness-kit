/**
 * Structured block extractor — converts raw JSONL into typed `SessionBlock`s.
 *
 * This is the live-ingest / DB ingestion / AI processing path. Where the
 * markdown formatter produces a single string for human review, the block
 * extractor produces a sequence of typed records, each with:
 *
 *   - a stable upsert ID (idempotent re-runs)
 *   - a discriminator on `type` for UI routing
 *   - self-contained markdown content for copy-as-markdown
 *   - foreign keys (`toolUseId`) for join/correlation
 *
 * Output is suitable for JSONL serialization: one block per line, sorted by
 * timestamp, ready for streaming ingest.
 */

import type { RawSession } from './parser.js';
import {
  type SessionBlock,
  type AgentBoundaryBlock,
  type SessionHeaderBlock,
  type ParsedSession,
} from './types.js';
import { buildToolNameMap } from './denoiser.js';
import { decomposeHistoryLine } from './block-decomposition.js';
import { compareStrings } from './ordering.js';

// Public API

/**
 * Extract all `SessionBlock`s from a raw session.
 * Includes optional session header + agent enter/exit boundaries.
 */
export function extractBlocks(
  raw: RawSession,
  options: {
    parsed?: ParsedSession;
    projectDir?: string;
    includeToolResults?: boolean;
  } = {}
): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  const lineOptions =
    options.includeToolResults === undefined
      ? undefined
      : { includeToolResults: options.includeToolResults };

  // Build a session-wide tool_use_id → tool_name map across main + subagents
  // so tool_result blocks (which only carry tool_use_id) can be paired with
  // their originating tool name.
  const allLines = [
    ...raw.mainLines,
    ...raw.subagentFiles.flatMap(f => f.lines),
  ];
  const toolNameById = buildToolNameMap(allLines);

  // Optional session header (first line if present)
  if (options.parsed) {
    blocks.push(
      buildSessionHeader(raw.sessionId, raw, options.parsed, options.projectDir)
    );
  }

  // Main session lines
  for (const line of raw.mainLines) {
    blocks.push(...decomposeHistoryLine(line, toolNameById, lineOptions));
  }

  // Subagent lines — bracketed by enter/exit boundary blocks for UI routing
  for (const sub of raw.subagentFiles) {
    if (sub.lines.length === 0) continue;
    const stamps = sub.lines
      .map(l => l.timestamp)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .sort(compareStrings);
    const firstTs = stamps[0];
    const lastTs = stamps[stamps.length - 1];
    if (firstTs) {
      blocks.push(buildBoundary(raw.sessionId, sub.filename, firstTs, 'enter'));
    }
    for (const line of sub.lines) {
      blocks.push(
        ...decomposeHistoryLine(line, toolNameById, {
          subagentId: sub.filename,
          includeSidechain: true,
          ...(lineOptions ?? {}),
        })
      );
    }
    if (lastTs) {
      blocks.push(buildBoundary(raw.sessionId, sub.filename, lastTs, 'exit'));
    }
  }

  // Sort by timestamp — preserves correct interleaving when subagent
  // execution overlaps with main thread tool calls.
  // Header (if any) keeps its position at index 0 since its timestamp is
  // the session start.
  blocks.sort((a, b) => compareStrings(a.timestamp, b.timestamp));
  return blocks;
}

/**
 * Serialize blocks as JSONL (one JSON record per line, trailing newline).
 * Suitable for `fs.appendFile` tail-mode ingestion downstream.
 */
export function toJsonlBlocks(blocks: readonly SessionBlock[]): string {
  if (blocks.length === 0) return '';
  return blocks.map(b => JSON.stringify(b)).join('\n') + '\n';
}

// Helpers

function buildBoundary(
  sessionId: string,
  agentFile: string,
  timestamp: string,
  direction: 'enter' | 'exit'
): AgentBoundaryBlock {
  return {
    id: `${sessionId}:agent-${direction}:${agentFile}`,
    type: 'agent_boundary',
    sessionId,
    timestamp,
    messageUuid: agentFile,
    subagentId: agentFile,
    agentFile,
    direction,
  };
}

function buildSessionHeader(
  sessionId: string,
  raw: RawSession,
  parsed: ParsedSession,
  projectDir: string | undefined
): SessionHeaderBlock {
  const { startTime, endTime } = getSessionBounds(raw, parsed);
  const header: SessionHeaderBlockShape = {
    id: sessionId,
    type: 'session_header',
    sessionId,
    timestamp: startTime,
    startTime,
    endTime,
    durationMs: parsed.stats.durationMs,
    userMessages: parsed.stats.userMessages,
    assistantMessages: parsed.stats.assistantMessages,
    toolCalls: parsed.stats.toolCalls,
    errors: parsed.stats.errors,
    costUSD: parsed.stats.costUSD,
    subagentCount: parsed.subagentSessions.length,
  };
  if (projectDir !== undefined) header.projectDir = projectDir;
  return header;
}

function getSessionBounds(
  raw: RawSession,
  parsed: ParsedSession
): { startTime: string; endTime: string } {
  const timestamps = [
    ...raw.mainLines.map(line => line.timestamp),
    ...raw.subagentFiles.flatMap(file =>
      file.lines.map(line => line.timestamp)
    ),
  ]
    .filter((timestamp): timestamp is string => typeof timestamp === 'string')
    .sort(compareStrings);

  return {
    startTime: timestamps[0] ?? parsed.startTime,
    endTime: timestamps[timestamps.length - 1] ?? parsed.endTime,
  };
}

interface SessionHeaderBlockShape {
  id: string;
  type: 'session_header';
  sessionId: string;
  timestamp: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  errors: number;
  costUSD: number;
  subagentCount: number;
  projectDir?: string;
}
