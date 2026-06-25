/**
 * Markdown formatter — converts denoised sessions to clean markdown.
 *
 * Output format serves:
 * 1. Human readability (review session insights)
 * 2. LLM ingestion (feed to memU memorize, Gemini analysis, etc.)
 * 3. Archive (searchable session history)
 */

import type {
  ParsedSession,
  CleanMessage,
  ParsedSubagentSession,
  SessionStats,
} from './types.js';
import type { SessionInfo } from './discovery.js';
import { compareStrings } from './ordering.js';

// Configuration

export interface FormatConfig {
  /** Include session stats header (default: true) */
  readonly includeStats: boolean;
  /** Include tool call annotations inline (default: true) */
  readonly includeToolAnnotations: boolean;
  /** Include subagent sections (default: true) */
  readonly includeSubagents: boolean;
  /** Include timestamps on each message (default: false) */
  readonly includeTimestamps: boolean;
  /** Separator between messages (default: blank line) */
  readonly messageSeparator: string;
}

const DEFAULT_FORMAT_CONFIG: FormatConfig = {
  includeStats: true,
  includeToolAnnotations: true,
  includeSubagents: true,
  includeTimestamps: false,
  messageSeparator: '\n',
};

// Formatters

function formatStats(
  stats: SessionStats,
  sessionId: string,
  startTime: string,
  endTime: string
): string {
  const duration = formatDuration(stats.durationMs);
  const cost = stats.costUSD > 0 ? `$${stats.costUSD.toFixed(4)}` : 'N/A';

  return `---
session: ${sessionId}
start: ${startTime}
end: ${endTime}
duration: ${duration}
messages: ${String(stats.userMessages)} user, ${String(stats.assistantMessages)} assistant
tools: ${String(stats.toolCalls)} calls, ${String(stats.errors)} errors
cost: ${cost}
raw_lines: ${String(stats.totalRawLines)}
---`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return `${String(hours)}h ${String(mins)}m`;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMessage(msg: CleanMessage, config: FormatConfig): string {
  const parts: string[] = [];

  // Role prefix
  const timePrefix = config.includeTimestamps
    ? `[${formatTime(msg.timestamp)}] `
    : '';
  const sidechain = msg.isSidechain ? ' *(sidechain)*' : '';

  if (msg.role === 'user') {
    parts.push(`### ${timePrefix}User${sidechain}\n`);
    parts.push(msg.text);
  } else {
    parts.push(`### ${timePrefix}Assistant${sidechain}\n`);

    // Tool call annotations before the text
    if (
      config.includeToolAnnotations &&
      msg.toolCalls &&
      msg.toolCalls.length > 0
    ) {
      const toolLines = msg.toolCalls.map(tc => `- ${tc}`);
      parts.push(`*Tools:*\n${toolLines.join('\n')}\n`);
    }

    if (msg.text) {
      parts.push(msg.text);
    }
  }

  // Errors
  if (msg.errors && msg.errors.length > 0) {
    parts.push(`\n*Errors:*`);
    for (const err of msg.errors) {
      parts.push(`- \`${err}\``);
    }
  }

  return parts.join('\n');
}

function formatSubagentSession(
  sub: ParsedSubagentSession,
  config: FormatConfig
): string {
  if (sub.messages.length === 0) return '';

  const parts: string[] = [];
  parts.push(`## Subagent: ${sub.agentFile}\n`);

  for (const msg of sub.messages) {
    parts.push(formatMessage(msg, config));
  }

  return parts.join(config.messageSeparator);
}

// Public API

/**
 * Format a denoised session as clean markdown.
 *
 * The output is structured for both human review and LLM ingestion:
 * - YAML-like frontmatter with session stats
 * - Clean user/assistant message pairs
 * - Tool call summaries as inline annotations
 * - Subagent sessions as separate sections
 */
export function toMarkdown(
  session: ParsedSession,
  config: Partial<FormatConfig> = {}
): string {
  const cfg: FormatConfig = { ...DEFAULT_FORMAT_CONFIG, ...config };
  const parts: string[] = [];

  // Header with stats
  if (cfg.includeStats) {
    parts.push(
      formatStats(
        session.stats,
        session.sessionId,
        session.startTime,
        session.endTime
      )
    );
    parts.push('');
  }

  parts.push(`# Session ${session.sessionId.substring(0, 8)}\n`);

  // Main conversation
  for (const msg of session.messages) {
    parts.push(formatMessage(msg, cfg));
  }

  // Subagent sessions
  if (cfg.includeSubagents && session.subagentSessions.length > 0) {
    parts.push('\n---\n');
    for (const sub of session.subagentSessions) {
      const formatted = formatSubagentSession(sub, cfg);
      if (formatted) {
        parts.push(formatted);
      }
    }
  }

  return parts.join(cfg.messageSeparator) + '\n';
}

// Merged timeline — interleaves subagent messages inline with main session

/**
 * Merge main session messages and subagent messages into a single timeline,
 * sorted by timestamp. Agent messages keep their `subagent` attribution.
 */
export function mergeTimeline(session: ParsedSession): CleanMessage[] {
  const all: CleanMessage[] = [...session.messages];

  for (const sub of session.subagentSessions) {
    all.push(...sub.messages);
  }

  // Sort by timestamp (stable — preserves order within same timestamp)
  all.sort((a, b) => compareStrings(a.timestamp, b.timestamp));
  return all;
}

// Export formatter — inline agents, thinking blocks, full detail

export interface ExportConfig {
  /** Include tool call annotations (default: true) */
  readonly includeTools: boolean;
  /** Include thinking blocks in <details> (default: true) */
  readonly includeThinking: boolean;
  /** Include timestamps on messages (default: true) */
  readonly includeTimestamps: boolean;
  /** Include error annotations (default: true) */
  readonly includeErrors: boolean;
  /** Include session stats frontmatter (default: true) */
  readonly includeStats: boolean;
  /** Extra session info from discovery (for richer frontmatter) */
  readonly sessionInfo?: SessionInfo | undefined;
}

const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  includeTools: true,
  includeThinking: true,
  includeTimestamps: true,
  includeErrors: true,
  includeStats: true,
};

/**
 * Format a session for export with inline agent responses.
 *
 * Key differences from toMarkdown():
 * - Subagent messages are merged into the main timeline by timestamp
 * - Agent messages get attributed headers: "### Agent: Explore memU-server repo"
 * - Thinking blocks rendered in <details> tags
 * - Suitable for archival and memU ingestion
 */
export function toExportMarkdown(
  session: ParsedSession,
  config: Partial<ExportConfig> = {}
): string {
  const cfg: ExportConfig = { ...DEFAULT_EXPORT_CONFIG, ...config };
  const parts: string[] = [];

  // Frontmatter
  if (cfg.includeStats) {
    parts.push(formatExportFrontmatter(session, cfg));
    parts.push('');
  }

  const dateStr = formatDate(session.startTime);
  parts.push(`# Session ${session.sessionId.substring(0, 8)} — ${dateStr}\n`);

  // Merge all messages into one timeline
  const timeline = mergeTimeline(session);

  // Track current agent context for grouping
  let currentAgent: string | undefined;

  for (const msg of timeline) {
    const formatted = formatExportMessage(msg, cfg);
    if (!formatted) continue;

    // Agent boundary markers
    if (msg.subagent && msg.subagent !== currentAgent) {
      const agentLabel = formatAgentLabel(msg.subagent);
      parts.push(`\n---\n**Agent: ${agentLabel}**\n`);
      currentAgent = msg.subagent;
    } else if (!msg.subagent && currentAgent) {
      parts.push(`\n---\n`);
      currentAgent = undefined;
    }

    parts.push(formatted);
  }

  return parts.join('\n') + '\n';
}

function formatExportFrontmatter(
  session: ParsedSession,
  cfg: ExportConfig
): string {
  const duration = formatDuration(session.stats.durationMs);
  const cost =
    session.stats.costUSD > 0 ? `$${session.stats.costUSD.toFixed(4)}` : 'N/A';
  const subagentCount = session.subagentSessions.length;
  const subagentMsgCount = session.subagentSessions.reduce(
    (acc, s) => acc + s.messages.length,
    0
  );

  const lines = [
    '---',
    `session: ${session.sessionId}`,
    `start: ${session.startTime}`,
    `end: ${session.endTime}`,
    `duration: ${duration}`,
    `messages: ${String(session.stats.userMessages)} user, ${String(session.stats.assistantMessages)} assistant`,
    `tools: ${String(session.stats.toolCalls)} calls, ${String(session.stats.errors)} errors`,
  ];

  if (subagentCount > 0) {
    lines.push(
      `agents: ${String(subagentCount)} sessions, ${String(subagentMsgCount)} messages`
    );
  }

  if (cfg.sessionInfo) {
    const sizeKB = Math.round(cfg.sessionInfo.fileSize / 1024);
    lines.push(`raw_size: ${String(sizeKB)}KB`);
  }

  lines.push(`cost: ${cost}`);
  lines.push('---');

  return lines.join('\n');
}

function formatExportMessage(msg: CleanMessage, cfg: ExportConfig): string {
  const parts: string[] = [];
  const timePrefix = cfg.includeTimestamps
    ? `[${formatTime(msg.timestamp)}] `
    : '';
  // Don't show sidechain marker on agent messages (they're always sidechain)
  const sidechain = msg.isSidechain && !msg.subagent ? ' *(sidechain)*' : '';

  if (msg.role === 'user') {
    if (msg.subagent) {
      // User messages inside subagent context are Claude's instructions to the agent
      // Skip them — the agent's response is the valuable part
      return '';
    }
    parts.push(`### ${timePrefix}User${sidechain}\n`);
    if (msg.text) {
      parts.push(msg.text);
    }
  } else {
    // For agent messages, skip tool-only turns (no text = just doing reads/globs)
    const hasText = msg.text !== '' && !/^\s*$/.test(msg.text);
    if (msg.subagent !== undefined && !hasText) {
      return '';
    }

    // Suppress role header on tool-only assistant turns — each tool call
    // already has its own `### Tool: X` heading, so an empty `### Claude`
    // section above it is just noise.
    const hasToolCalls = (msg.toolCalls?.length ?? 0) > 0;
    const hasToolResults = (msg.toolResults?.length ?? 0) > 0;
    const hasOnlyToolCalls = !hasText && (hasToolCalls || hasToolResults);
    const roleLabel = msg.subagent ? 'Agent' : 'Claude';
    if (!hasOnlyToolCalls) {
      parts.push(`### ${timePrefix}${roleLabel}${sidechain}\n`);
    }

    // Thinking blocks
    if (cfg.includeThinking && msg.text.includes('[thinking]')) {
      const thinkingMatch = msg.text.match(
        /\[thinking\]\n([\s\S]*?)\n\[\/thinking\]\n\n([\s\S]*)/
      );
      if (thinkingMatch) {
        parts.push('<details>\n<summary>Thinking</summary>\n');
        parts.push(thinkingMatch[1] ?? '');
        parts.push('\n</details>\n');
        if (thinkingMatch[2]) {
          parts.push(thinkingMatch[2]);
        }
      } else {
        parts.push(msg.text);
      }
    } else if (msg.text) {
      // Strip thinking blocks if not configured to include them
      const stripped = msg.text.replace(
        /\[thinking\]\n[\s\S]*?\n\[\/thinking\]\n\n/,
        ''
      );
      parts.push(stripped);
    }

    // Tool calls — one section per call so each call→result pair is readable
    // together. Mirrors claude-code-webui conversationExport.ts (`### Tool: X`).
    if (cfg.includeTools && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        parts.push('');
        parts.push(`### Tool: ${tc}`);
      }
    }
  }

  // Tool result bodies (Bash stdout, Read content, Edit diffs) — render
  // verbatim inside fenced code blocks. Truncated upstream by line count.
  if (cfg.includeTools && msg.toolResults && msg.toolResults.length > 0) {
    for (const result of msg.toolResults) {
      parts.push('');
      const heading = result.toolName
        ? `### ${result.toolName} Result${result.isError ? ' (error)' : ''}`
        : `### Tool Result${result.isError ? ' (error)' : ''}`;
      parts.push(heading);
      parts.push('');
      parts.push('```');
      parts.push(result.content);
      parts.push('```');
    }
  }

  // Errors
  if (cfg.includeErrors && msg.errors && msg.errors.length > 0) {
    parts.push('');
    for (const err of msg.errors) {
      parts.push(`> **Error:** \`${err}\``);
    }
  }

  return parts.join('\n');
}

/**
 * Clean up agent file name into a readable label.
 * "agent-a18fad0" → "a18fad0"
 * If the agent had a Task description, we'd use that instead,
 * but the subagent filename is what we have from the JSONL files.
 */
function formatAgentLabel(agentFile: string): string {
  return agentFile.replace(/^agent-/, '');
}

function formatDate(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Compact summary formatter.

/**
 * Format a session as a compact summary (for context injection or quick review).
 *
 * Shorter than full markdown: no tool annotations, no subagents,
 * truncated messages. Good for feeding into a context window.
 */
export function toCompactSummary(session: ParsedSession): string {
  const parts: string[] = [];

  const duration = formatDuration(session.stats.durationMs);
  parts.push(
    `**Session ${session.sessionId.substring(0, 8)}** | ${duration} | ${String(session.stats.userMessages)} exchanges | ${String(session.stats.toolCalls)} tool calls\n`
  );

  // Only user messages and non-empty assistant text
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      const preview =
        msg.text.length > 150 ? msg.text.substring(0, 150) + '...' : msg.text;
      parts.push(`> ${preview}\n`);
    } else if (msg.text) {
      const preview =
        msg.text.length > 300 ? msg.text.substring(0, 300) + '...' : msg.text;
      parts.push(`${preview}\n`);
    }
  }

  return parts.join('\n');
}
