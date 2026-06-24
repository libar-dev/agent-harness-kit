/**
 * Session processing module — parse, denoise, and format Claude Code sessions.
 *
 * Pipeline: Raw JSONL → Parse → Denoise → Format (markdown)
 *
 * Usage:
 *   import { readSessionFiles, denoiseSession, toMarkdown } from './processing';
 *
 *   const raw = await readSessionFiles(projectDir, sessionId);
 *   const clean = denoiseSession(raw);
 *   const markdown = toMarkdown(clean);
 */

// ---------------------------------------------------------------------------
// Imports (single import per module to satisfy no-duplicate-imports)
// ---------------------------------------------------------------------------

import {
  type RawHistoryLine,
  type RawMessage,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ThinkingBlock,
  type CleanMessage,
  type ToolResultEntry,
  type ParsedSession,
  type ParsedSubagentSession,
  type SessionStats,
  type DenoiseConfig,
  type SessionBlock,
  type SessionBlockBase,
  type SessionHeaderBlock,
  type UserTextBlock,
  type AssistantTextBlock,
  type ThinkingTextBlock,
  type ToolUseBlockExport,
  type ToolResultBlockExport,
  type AgentBoundaryBlock,
  type RawTranscriptRecord,
  type RawTranscriptRedactionMode,
  type RawTranscriptSession,
  type RawTranscriptTailResult,
  DEFAULT_DENOISE_CONFIG,
} from './types.js';

import { type RawSession, readSessionFiles } from './parser.js';

import { denoiseSession } from './denoiser.js';

import { extractBlocks, toJsonlBlocks } from './blocks.js';

import {
  type TailMarker,
  type TailOptions,
  type RawTranscriptTailOptions,
  type RawTranscriptWatchOptions,
  type RawTranscriptReadOptions,
  type TailResult,
  tailBlocks,
  tailRawTranscriptRecords,
  watchRawTranscriptRecords,
  readRawSessionFiles,
} from './tail.js';

import {
  type FormatConfig,
  type ExportConfig,
  toMarkdown,
  toCompactSummary,
  toExportMarkdown,
} from './formatter.js';

import {
  type SessionInfo,
  type DiscoverOptions,
  discoverSessions,
  projectDirFromCwd,
  listProjects,
  cwdFromProjectDir,
  resolveProjectPath,
  readExportMarker,
  writeExportMarker,
} from './discovery.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  // types.ts — raw + denoised
  RawHistoryLine,
  RawMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  CleanMessage,
  ToolResultEntry,
  ParsedSession,
  ParsedSubagentSession,
  SessionStats,
  DenoiseConfig,
  // types.ts — structured blocks (live-ingest / DB / AI consumers)
  SessionBlock,
  SessionBlockBase,
  SessionHeaderBlock,
  UserTextBlock,
  AssistantTextBlock,
  ThinkingTextBlock,
  ToolUseBlockExport,
  ToolResultBlockExport,
  AgentBoundaryBlock,
  RawTranscriptRecord,
  RawTranscriptRedactionMode,
  RawTranscriptSession,
  RawTranscriptTailResult,
  // parser.ts
  RawSession,
  // formatter.ts
  FormatConfig,
  ExportConfig,
  // discovery.ts
  SessionInfo,
  DiscoverOptions,
  // tail.ts — incremental block emission for live consumers
  TailMarker,
  TailOptions,
  RawTranscriptTailOptions,
  RawTranscriptWatchOptions,
  RawTranscriptReadOptions,
  TailResult,
};

export {
  // types.ts
  DEFAULT_DENOISE_CONFIG,
  // parser.ts
  readSessionFiles,
  // denoiser.ts
  denoiseSession,
  // blocks.ts — structured (JSONL) export
  extractBlocks,
  toJsonlBlocks,
  // tail.ts — incremental block emission
  tailBlocks,
  tailRawTranscriptRecords,
  watchRawTranscriptRecords,
  readRawSessionFiles,
  // formatter.ts
  toMarkdown,
  toCompactSummary,
  toExportMarkdown,
  // discovery.ts
  discoverSessions,
  projectDirFromCwd,
  listProjects,
  cwdFromProjectDir,
  resolveProjectPath,
  readExportMarker,
  writeExportMarker,
};

// ---------------------------------------------------------------------------
// Convenience: full pipeline in one call
// ---------------------------------------------------------------------------

/**
 * Full pipeline: read JSONL from disk → denoise → format as markdown.
 *
 * @param projectDir - Claude projects directory
 *   (e.g., ~/.claude/projects/-Users-foo-dev-bar)
 * @param sessionId - Session UUID
 * @param denoiseConfig - Optional denoising configuration
 * @param formatConfig - Optional formatting configuration
 * @returns Clean markdown string
 */
export async function processSession(
  projectDir: string,
  sessionId: string,
  denoiseConfig?: Partial<DenoiseConfig>,
  formatConfig?: Partial<FormatConfig>
): Promise<string> {
  const raw = await readSessionFiles(projectDir, sessionId);
  const clean = denoiseSession(raw, denoiseConfig);
  return toMarkdown(clean, formatConfig);
}

/**
 * Export pipeline: read → denoise (with thinking) → format with inline agents.
 */
export async function exportSession(
  projectDir: string,
  sessionId: string,
  exportConfig?: Partial<ExportConfig>
): Promise<string> {
  const raw = await readSessionFiles(projectDir, sessionId);
  const clean = denoiseSession(raw, {
    includeThinking: true,
    includeSubagents: true,
    includeToolSummaries: true,
    includeToolResults: false,
    includeErrors: true,
    maxAssistantBlockLength: 10000,
    maxUserMessageLength: 5000,
  });
  return toExportMarkdown(clean, exportConfig);
}
