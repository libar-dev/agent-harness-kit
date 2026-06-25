/**
 * Types for session JSONL parsing, denoising, and markdown export.
 *
 * The raw JSONL format matches Claude Code's session storage:
 *   ~/.claude/projects/<project>/<session-id>.jsonl
 *   ~/.claude/projects/<project>/<session-id>/subagents/agent-*.jsonl
 */

/** Content block inside an assistant message */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content:
    | string
    | readonly { type: string; text?: string | undefined }[];
  readonly is_error?: boolean | undefined;
}

export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}

export interface ImageContentBlock {
  readonly type: 'image';
  readonly source?: unknown;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageContentBlock;

export interface RawMessage {
  readonly role: 'user' | 'assistant';
  readonly id?: string | undefined;
  readonly content: string | readonly ContentBlock[];
  readonly model?: string | undefined;
  readonly stop_reason?: string | null | undefined;
  readonly stop_sequence?: string | null | undefined;
  readonly usage?: Record<string, number> | undefined;
}

/** A single line from a .jsonl session file */
export interface RawHistoryLine {
  readonly type:
    | 'user'
    | 'assistant'
    | 'system'
    | 'result'
    | 'progress'
    | 'file-history-snapshot';
  readonly message?: RawMessage | undefined;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly uuid: string;
  readonly parentUuid?: string | null | undefined;
  readonly isSidechain?: boolean | undefined;
  readonly userType?: string | undefined;
  readonly cwd?: string | undefined;
  readonly version?: string | undefined;
  readonly requestId?: string | undefined;
  // Result-type fields
  readonly costUSD?: number | undefined;
  readonly duration?: number | undefined;
  readonly isError?: boolean | undefined;
  readonly result?: string | undefined;
  readonly subagentId?: string | undefined;
}

export type RawTranscriptRedactionMode = 'unsafe-unredacted';

export interface RawTranscriptRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly sourceKind: 'main' | 'subagent';
  readonly sourceId: string;
  readonly lineNumber: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly timestamp?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  readonly type?: string;
  /** Redacted placeholder by default; exact line requires rawRedactionMode: 'unsafe-unredacted'. */
  readonly rawLine: string;
  /** Redacted placeholder by default; exact payload requires rawRedactionMode: 'unsafe-unredacted'. */
  readonly payload: unknown;
}

export interface TailProcessingCounts {
  readonly invalidJsonLineCount: number;
  readonly invalidShapeLineCount: number;
  readonly skippedLineCount: number;
}

export interface RawTranscriptTailResult extends TailProcessingCounts {
  readonly records: readonly RawTranscriptRecord[];
  readonly previousByteOffset: number;
  readonly newByteOffset: number;
  readonly fileSize: number;
  readonly fileRotated: boolean;
}

export interface RawTranscriptSession {
  readonly sessionId: string;
  readonly records: readonly RawTranscriptRecord[];
}

/** A cleaned message with only the valuable signal */
export interface CleanMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp: string;
  /** Tool calls summarized as "ToolName(key: value)" one-liners */
  readonly toolCalls?: readonly string[] | undefined;
  /** Tool result bodies (Bash stdout, Read content, Edit diffs, etc.) — redacted + truncated */
  readonly toolResults?: readonly ToolResultEntry[] | undefined;
  /** Tool errors worth preserving */
  readonly errors?: readonly string[] | undefined;
  /** Whether this came from a subagent */
  readonly subagent?: string | undefined;
  /** Whether this was on a sidechain (rejected branch) */
  readonly isSidechain?: boolean | undefined;
}

/**
 * A captured tool_result body. The webui-style export pairs each result with
 * its originating tool_use via `toolName` (resolved from the session-wide
 * tool_use_id → name map) so consumers can render `### <Tool> Result` blocks.
 */
export interface ToolResultEntry {
  readonly toolUseId: string;
  /** Resolved tool name; undefined if the originating tool_use wasn't in scope */
  readonly toolName?: string | undefined;
  /** Result body, redacted and truncated by line count */
  readonly content: string;
  readonly isError?: boolean | undefined;
}

/** A parsed session with metadata */
export interface ParsedSession {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly messages: readonly CleanMessage[];
  readonly subagentSessions: readonly ParsedSubagentSession[];
  readonly stats: SessionStats;
}

export interface ParsedSubagentSession {
  readonly agentFile: string;
  readonly messages: readonly CleanMessage[];
}

// One record per atomic conversation event. Designed for downstream consumers
// (live-ingest consumers, vector DB ingestion, AI processing) that need typed blocks
// rather than rendered markdown.
//
// IDs are stable (`${messageUuid}:${blockIndex}` for message blocks,
// `${sessionId}:agent-${direction}:${agentFile}` for synthetic boundaries) so
// re-running the parser on the same JSONL produces identical IDs — making DB
// upserts idempotent and enabling tail-mode incremental ingestion of growing
// session files.

export interface SessionBlockBase {
  /** Stable upsert key: `${messageUuid}:${blockIndex}`, sessionId, or namespaced synthetic boundary ID */
  readonly id: string;
  readonly type: string;
  readonly sessionId: string;
  readonly timestamp: string;
  /** UUID of the parent JSONL message (groups blocks of same turn) */
  readonly messageUuid?: string;
  /** Parent message UUID for threading (continuations) */
  readonly parentUuid?: string;
  /** Subagent file name if this block came from a subagent log */
  readonly subagentId?: string;
  readonly isSidechain?: boolean;
}

export interface SessionHeaderBlock extends SessionBlockBase {
  readonly type: 'session_header';
  readonly startTime: string;
  readonly endTime: string;
  readonly durationMs: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly errors: number;
  readonly costUSD: number;
  readonly subagentCount: number;
  readonly projectDir?: string;
}

export interface UserTextBlock extends SessionBlockBase {
  readonly type: 'user_text';
  /** Raw markdown — paste-ready */
  readonly content: string;
}

export interface AssistantTextBlock extends SessionBlockBase {
  readonly type: 'assistant_text';
  /** Raw markdown */
  readonly content: string;
}

export interface ThinkingTextBlock extends SessionBlockBase {
  readonly type: 'thinking';
  readonly content: string;
}

export interface ToolUseBlockExport extends SessionBlockBase {
  readonly type: 'tool_use';
  /** Matches `ToolResultBlockExport.toolUseId` for joining */
  readonly toolUseId: string;
  /** Resolved name (built-in or `mcp:server.tool`) */
  readonly toolName: string;
  /** Pre-formatted one-liner like `Read(/path)` for badges/lists */
  readonly summary: string;
  /** Full input record for "show args" expansion */
  readonly input: Record<string, unknown>;
}

export interface ToolResultBlockExport extends SessionBlockBase {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  /** Resolved from session-wide tool_use_id → name map */
  readonly toolName?: string;
  /** Redacted text content (200-line cap) */
  readonly content: string;
  readonly truncated: boolean;
  /** Original line count when truncated */
  readonly originalLineCount?: number;
  readonly isError: boolean;
}

export interface AgentBoundaryBlock extends SessionBlockBase {
  readonly type: 'agent_boundary';
  readonly agentFile: string;
  readonly direction: 'enter' | 'exit';
}

export type SessionBlock =
  | SessionHeaderBlock
  | UserTextBlock
  | AssistantTextBlock
  | ThinkingTextBlock
  | ToolUseBlockExport
  | ToolResultBlockExport
  | AgentBoundaryBlock;

export interface SessionStats {
  readonly totalRawLines: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly errors: number;
  readonly durationMs: number;
  readonly costUSD: number;
}

export interface DenoiseConfig {
  /** Include tool call summaries (default: true) */
  readonly includeToolSummaries: boolean;
  /** Include redacted tool result bodies — Bash stdout, file contents, diffs (default: true) */
  readonly includeToolResults: boolean;
  /** Include tool errors (default: true) */
  readonly includeErrors: boolean;
  /** Include sidechain messages (default: false) */
  readonly includeSidechains: boolean;
  /** Include subagent sessions (default: true) */
  readonly includeSubagents: boolean;
  /** Include thinking blocks (default: false — they're huge) */
  readonly includeThinking: boolean;
  /** Max chars per user message before truncation (default: 2000) */
  readonly maxUserMessageLength: number;
  /** Max chars per assistant text block before truncation (default: 5000) */
  readonly maxAssistantBlockLength: number;
}

export const DEFAULT_DENOISE_CONFIG: DenoiseConfig = {
  includeToolSummaries: true,
  includeToolResults: true,
  includeErrors: true,
  includeSidechains: false,
  includeSubagents: true,
  includeThinking: false,
  maxUserMessageLength: 2000,
  maxAssistantBlockLength: 5000,
};
