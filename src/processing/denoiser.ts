/**
 * Session denoiser — extracts conversation intelligence from raw JSONL.
 *
 * The raw session data is extremely noisy: tool results contain full file
 * contents, git output, error stacks; every line carries usage/cache stats;
 * system metadata is interleaved with actual reasoning.
 *
 * This module extracts the signal:
 * - User intent (what was asked)
 * - Assistant reasoning (analysis, decisions, insights)
 * - Tool call summaries (what was done, not the raw output)
 * - Errors worth remembering
 *
 * And drops the noise:
 * - Raw tool output (file contents, git diffs, search results)
 * - Usage/cache token counts
 * - stop_reason, stop_sequence, model metadata
 * - Result-type lines (session summaries with cost/duration)
 */

import type { RawSession } from './parser.js';
import {
  type RawHistoryLine,
  type RawMessage,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ThinkingBlock,
  type ImageContentBlock,
  type CleanMessage,
  type ToolResultEntry,
  type ParsedSession,
  type ParsedSubagentSession,
  type SessionStats,
  type DenoiseConfig,
  DEFAULT_DENOISE_CONFIG,
} from './types.js';
import { isSystemNoise } from './block-decomposition.js';
import {
  MAX_TOOL_RESULT_LINES,
  prepareToolResultForRetention,
  redactRetainedToolResultText,
} from './tool-result-redaction.js';
import { compareStrings } from './ordering.js';
import { isRecord } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Tool call summarizer
// ---------------------------------------------------------------------------

type ToolCallSummarizer = (input: Readonly<Record<string, unknown>>) => string;

const TOOL_CALL_SUMMARIZERS: Readonly<Record<string, ToolCallSummarizer>> = {
  // --- File operations ---
  Read: input => `Read(${String(input['file_path'] ?? '?')})`,
  Write: input => `Write(${String(input['file_path'] ?? '?')})`,
  Edit: input => `Edit(${String(input['file_path'] ?? '?')})`,
  MultiEdit: input => `MultiEdit(${String(input['file_path'] ?? '?')})`,
  NotebookEdit: input =>
    `NotebookEdit(${String(input['notebook_path'] ?? input['file_path'] ?? '?')})`,

  // --- Shell / search ---
  Bash: input => `Bash(${truncate(String(input['command'] ?? '?'), 80)})`,
  Glob: input => `Glob(${String(input['pattern'] ?? '?')})`,
  Grep: input => `Grep(${String(input['pattern'] ?? '?')})`,

  // --- Web ---
  WebFetch: input => `WebFetch(${String(input['url'] ?? '?')})`,
  WebSearch: input =>
    `WebSearch(${truncate(String(input['query'] ?? '?'), 60)})`,

  // --- Agent / Task ---
  Agent: input => {
    const desc = input['description'] ?? input['subagent_type'] ?? '?';
    return `Agent(${truncate(String(desc), 60)})`;
  },
  Skill: input => {
    const skill = String(input['skill'] ?? '?');
    const args = input['args'];
    return args !== undefined && args !== null && args !== ''
      ? `Skill(${skill}: ${truncate(String(args), 40)})`
      : `Skill(${skill})`;
  },

  // --- TaskCreate/TaskUpdate family (replaces deprecated TodoWrite/Task) ---
  TaskCreate: input =>
    `TaskCreate(${truncate(String(input['subject'] ?? input['description'] ?? '?'), 60)})`,
  TaskUpdate: input => {
    const id = input['taskId'];
    const status = input['status'];
    if (id !== undefined && status !== undefined) {
      return `TaskUpdate(${String(id)}: ${String(status)})`;
    }
    if (id !== undefined) return `TaskUpdate(${String(id)})`;
    return 'TaskUpdate(?)';
  },
  TaskGet: input => `TaskGet(${String(input['taskId'] ?? '?')})`,
  TaskStop: input => `TaskStop(${String(input['taskId'] ?? '?')})`,
  TaskOutput: input => `TaskOutput(${String(input['taskId'] ?? '?')})`,
  TaskList: () => 'TaskList()',

  // --- Tool/skill discovery ---
  ToolSearch: input =>
    `ToolSearch(${truncate(String(input['query'] ?? '?'), 60)})`,

  // --- Plan / interaction ---
  EnterPlanMode: () => 'EnterPlanMode()',
  ExitPlanMode: input =>
    `ExitPlanMode(${truncate(String(input['plan'] ?? '?'), 60)})`,
  AskUserQuestion: input => {
    const questions = input['questions'];
    if (Array.isArray(questions) && questions.length > 0) {
      const q: unknown = questions[0];
      if (q !== null && typeof q === 'object' && 'question' in q) {
        const qText = (q as Record<string, unknown>)['question'];
        return `AskUserQuestion(${truncate(String(qText), 60)})`;
      }
    }
    return 'AskUserQuestion(?)';
  },

  // --- Background / scheduling ---
  ScheduleWakeup: input => {
    const delay = input['delaySeconds'];
    const reason = input['reason'];
    const delayStr = delay !== undefined ? `${String(delay)}s` : '?';
    return reason !== undefined
      ? `ScheduleWakeup(${delayStr}: ${truncate(String(reason), 40)})`
      : `ScheduleWakeup(${delayStr})`;
  },
  Monitor: input =>
    `Monitor(${truncate(String(input['command'] ?? input['taskId'] ?? '?'), 60)})`,
  RemoteTrigger: input =>
    `RemoteTrigger(${truncate(String(input['agentId'] ?? input['name'] ?? '?'), 60)})`,
  PushNotification: input =>
    `PushNotification(${truncate(String(input['message'] ?? input['title'] ?? '?'), 60)})`,

  // --- Worktree ---
  EnterWorktree: input =>
    `EnterWorktree(${String(input['name'] ?? input['path'] ?? '?')})`,
  ExitWorktree: () => 'ExitWorktree()',

  // --- Cron ---
  CronCreate: input =>
    `CronCreate(${truncate(String(input['name'] ?? input['schedule'] ?? '?'), 60)})`,
  CronList: () => 'CronList()',
  CronDelete: input =>
    `CronDelete(${String(input['id'] ?? input['name'] ?? '?')})`,

  // --- IDE / LSP ---
  LSP: input =>
    `LSP(${truncate(String(input['method'] ?? input['command'] ?? '?'), 60)})`,
  ListMcpResourcesTool: input =>
    `ListMcpResourcesTool(${String(input['server'] ?? '?')})`,
  ReadMcpResourceTool: input =>
    `ReadMcpResourceTool(${String(input['uri'] ?? input['server'] ?? '?')})`,
};

/** Summarize a tool_use block into a one-liner like "Read(file_path: src/index.ts)" */
export function summarizeToolCall(block: ToolUseBlock): string {
  const name = block.name;
  const input = block.input;

  // MCP tools follow `mcp__<server>__<tool>` naming. Render as `mcp:server.tool(...)`
  // so they're visually distinct from built-ins and shorter than the raw name.
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const sep = rest.indexOf('__');
    if (sep !== -1) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      return `mcp:${server}.${tool}(${summarizeGenericArgs(input)})`;
    }
  }

  // Guard the lookup with hasOwnProperty: TOOL_CALL_SUMMARIZERS is a plain
  // object literal, so a bare `TOOL_CALL_SUMMARIZERS[name]` would resolve
  // inherited Object.prototype members for names like 'constructor',
  // 'toString', or 'hasOwnProperty' and then invoke them as formatters (wrong
  // output / crash). Only own keys count as real summarizers; everything else
  // takes the generic fallback below.
  const formatter = Object.prototype.hasOwnProperty.call(
    TOOL_CALL_SUMMARIZERS,
    name
  )
    ? TOOL_CALL_SUMMARIZERS[name]
    : undefined;
  return formatter !== undefined
    ? formatter(input)
    : `${name}(${summarizeGenericArgs(input)})`;
}

/** Pick the most informative scalar arg from an unknown tool's input object. */
function summarizeGenericArgs(
  input: Readonly<Record<string, unknown>>
): string {
  const firstArg = Object.entries(input).find(([, v]) => typeof v === 'string');
  if (firstArg) {
    return `${firstArg[0]}: ${truncate(String(firstArg[1]), 50)}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

function isImageBlock(block: ContentBlock): block is ImageContentBlock {
  return block.type === 'image';
}

function imagePlaceholder(source: unknown): string {
  if (!isRecord(source)) return '[Image]';
  const mediaType = source['media_type'];
  if (!isSafeMediaType(mediaType)) return '[Image]';
  return `[Image: ${mediaType}]`;
}

function isSafeMediaType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value)
  );
}

/** Extract user-facing text from a message's content field */
function extractText(
  content: string | readonly ContentBlock[],
  maxLength: number
): string {
  if (typeof content === 'string') {
    return truncate(content, maxLength);
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block) && block.text.trim()) {
      textParts.push(block.text);
    } else if (isImageBlock(block)) {
      textParts.push(imagePlaceholder(block.source));
    }
  }

  const joined = textParts.join('\n\n');
  return truncate(joined, maxLength);
}

/** Extract tool_use summaries from content blocks */
function extractToolCalls(content: string | readonly ContentBlock[]): string[] {
  if (typeof content === 'string') return [];

  const calls: string[] = [];
  for (const block of content) {
    if (isToolUseBlock(block)) {
      calls.push(summarizeToolCall(block));
    }
  }
  return calls;
}

/** Extract thinking text from content blocks */
function extractThinking(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return '';

  const parts: string[] = [];
  for (const block of content) {
    if (isThinkingBlock(block)) {
      parts.push(block.thinking);
    }
  }
  return parts.join('\n\n');
}

/** Extract error information from tool_result blocks */
function extractErrors(content: string | readonly ContentBlock[]): string[] {
  if (typeof content === 'string') return [];

  const errors: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const text = extractToolResultText(block.content);
      if (text && block.is_error) {
        errors.push(truncate(redactRetainedToolResultText(text), 200));
      }
    }
  }
  return errors;
}

/**
 * Tool results may be a string OR an array of `{type:"text", text:"..."}` blocks
 * (the SDK shape for Task/Agent/MCP results). Mirrors `extractTextFromContent`
 * from claude-code-webui (UnifiedMessageProcessor.ts, commit eeb0dca).
 */
interface ToolResultTextBlock {
  readonly type: string;
  readonly text?: string | undefined;
}

function hasTypeProperty(
  item: Record<string, unknown>
): item is Record<string, unknown> & { type: unknown } {
  return 'type' in item;
}

function hasTextProperty(
  item: Record<string, unknown>
): item is Record<string, unknown> & { text: unknown } {
  return 'text' in item;
}

function isTextResultBlock(item: unknown): item is ToolResultTextBlock {
  if (!isRecord(item)) return false;

  return (
    hasTypeProperty(item) &&
    item.type === 'text' &&
    hasTextProperty(item) &&
    typeof item.text === 'string'
  );
}

export function extractToolResultText(
  content: string | readonly ToolResultTextBlock[]
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (isTextResultBlock(item) && item.text !== undefined) {
      parts.push(item.text);
    }
  }
  return parts.join('\n\n');
}

/** Capture full tool_result bodies for `### <Tool> Result` rendering. */
function extractToolResults(
  content: string | readonly ContentBlock[],
  toolNameById: ReadonlyMap<string, string>
): ToolResultEntry[] {
  if (typeof content === 'string') return [];
  const out: ToolResultEntry[] = [];
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const text = extractToolResultText(block.content);
    if (!text) continue;
    const prepared = prepareToolResultForRetention(text, MAX_TOOL_RESULT_LINES);
    out.push({
      toolUseId: block.tool_use_id,
      toolName: toolNameById.get(block.tool_use_id),
      content: prepared.content,
      isError: block.is_error,
    });
  }
  return out;
}

/** Build session-wide tool_use_id → tool_name map so results can be paired with their call. */
export function buildToolNameMap(
  lines: readonly RawHistoryLine[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const msg = line.message;
    if (msg?.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (isToolUseBlock(block)) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

const MAX_THINKING_PREVIEW_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Denoiser — converts raw lines to clean messages
// ---------------------------------------------------------------------------

function denoiseLines(
  lines: readonly RawHistoryLine[],
  config: DenoiseConfig,
  subagentName?: string
): CleanMessage[] {
  const messages: CleanMessage[] = [];
  const toolNameById = buildToolNameMap(lines);

  for (const line of lines) {
    // Skip non-message lines (session summaries, system, progress indicators)
    if (
      line.type === 'result' ||
      line.type === 'system' ||
      line.type === 'progress'
    ) {
      continue;
    }

    // Skip sidechain messages unless configured to include them.
    // Subagent lines always have isSidechain=true (Claude Code quirk) — ignore it.
    if (line.isSidechain && !config.includeSidechains && !subagentName) {
      continue;
    }

    const msg = line.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const text = extractUserText(msg, config);
      const errors = config.includeErrors ? extractErrors(msg.content) : [];
      const toolResults = config.includeToolResults
        ? extractToolResults(msg.content, toolNameById)
        : [];

      // Skip user messages with no text, errors, or tool results
      if (!text && errors.length === 0 && toolResults.length === 0) continue;

      messages.push({
        role: 'user',
        text,
        timestamp: line.timestamp,
        errors: errors.length > 0 ? errors : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        subagent: subagentName,
        isSidechain: line.isSidechain ?? undefined,
      });
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content, config.maxAssistantBlockLength);

      // Skip assistant messages that have no text (pure tool-call turns)
      if (!text && !config.includeToolSummaries) continue;

      const toolCalls = config.includeToolSummaries
        ? extractToolCalls(msg.content)
        : [];

      const thinking = config.includeThinking
        ? extractThinking(msg.content)
        : '';

      const fullText = thinking
        ? `[thinking]\n${truncate(thinking, MAX_THINKING_PREVIEW_LENGTH)}\n[/thinking]\n\n${text}`
        : text;

      // Skip if there's truly nothing
      if (!fullText && toolCalls.length === 0) continue;

      messages.push({
        role: 'assistant',
        text: fullText,
        timestamp: line.timestamp,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        subagent: subagentName,
        isSidechain: line.isSidechain ?? undefined,
      });
    }
  }

  return messages;
}

/**
 * Extract text from user messages, filtering out tool_result noise.
 *
 * User messages in Claude Code JSONL often contain tool_result blocks
 * with raw file contents, git output, etc. We only want the actual
 * user-typed text.
 */
function extractUserText(msg: RawMessage, config: DenoiseConfig): string {
  const content = msg.content;

  // Simple string content — this is the actual user message
  if (typeof content === 'string') {
    if (isSystemNoise(content)) return '';
    return truncate(content, config.maxUserMessageLength);
  }

  // Array content — extract only text blocks, skip tool_result blocks
  const textParts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block) && block.text.trim()) {
      if (!isSystemNoise(block.text)) {
        textParts.push(block.text);
      }
    } else if (isImageBlock(block)) {
      textParts.push(imagePlaceholder(block.source));
    }
    // tool_result blocks in user messages are Claude Code feeding back
    // tool output — this is noise (file contents, command output, etc.)
  }

  const joined = textParts.join('\n\n');
  return truncate(joined, config.maxUserMessageLength);
}

// ---------------------------------------------------------------------------
// Stats calculation
// ---------------------------------------------------------------------------

function calculateStats(raw: RawSession): SessionStats {
  const allLines = [
    ...raw.mainLines,
    ...raw.subagentFiles.flatMap(f => f.lines),
  ];

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let errors = 0;
  let costUSD = 0;

  const timestamps: number[] = [];

  for (const line of allLines) {
    if (line.timestamp) {
      timestamps.push(new Date(line.timestamp).getTime());
    }

    if (line.type === 'result') {
      costUSD += line.costUSD ?? 0;
      if (line.isError) errors++;
      continue;
    }

    const msg = line.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      userMessages++;
      // Count tool_result errors in user messages
      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if (
            block.type === 'tool_result' &&
            'is_error' in block &&
            block.is_error
          ) {
            errors++;
          }
        }
      }
    } else if (msg.role === 'assistant') {
      assistantMessages++;
      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if (block.type === 'tool_use') toolCalls++;
        }
      }
    }
  }

  const sorted = timestamps.sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const durationMs =
    sorted.length >= 2 && first !== undefined && last !== undefined
      ? last - first
      : 0;

  return {
    totalRawLines: allLines.length,
    userMessages,
    assistantMessages,
    toolCalls,
    errors,
    durationMs,
    costUSD,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Denoise a raw session into clean, structured messages.
 *
 * Takes the noisy JSONL data (tool results with file contents, usage stats,
 * system metadata) and extracts just the conversation intelligence:
 * user intent, assistant reasoning, tool call summaries, and errors.
 */
export function denoiseSession(
  raw: RawSession,
  config: Partial<DenoiseConfig> = {}
): ParsedSession {
  const cfg: DenoiseConfig = { ...DEFAULT_DENOISE_CONFIG, ...config };

  // Denoise main session
  const mainMessages = denoiseLines(raw.mainLines, cfg);

  // Denoise subagent sessions
  const subagentSessions: ParsedSubagentSession[] = cfg.includeSubagents
    ? raw.subagentFiles.map(f => ({
        agentFile: f.filename,
        messages: denoiseLines(f.lines, cfg, f.filename),
      }))
    : [];

  // Calculate timestamps from clean messages
  const allTimestamps = [
    ...mainMessages.map(m => m.timestamp),
    ...subagentSessions.flatMap(s => s.messages.map(m => m.timestamp)),
  ].sort(compareStrings);

  const stats = calculateStats(raw);

  return {
    sessionId: raw.sessionId,
    projectDir: '', // Caller can set this
    startTime: allTimestamps[0] ?? new Date().toISOString(),
    endTime:
      allTimestamps[allTimestamps.length - 1] ?? new Date().toISOString(),
    messages: mainMessages,
    subagentSessions,
    stats,
  };
}
