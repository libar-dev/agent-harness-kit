import { summarizeToolCall, extractToolResultText } from './denoiser.js';
import { imagePlaceholder } from './image-placeholder.js';
import type { ContentBlock, RawHistoryLine, SessionBlock } from './types.js';
import {
  MAX_TOOL_RESULT_LINES,
  prepareToolResultForRetention,
} from './tool-result-redaction.js';

export interface DecomposeLineOptions {
  readonly subagentId?: string;
  readonly includeSidechain?: boolean;
  readonly includeToolResults?: boolean;
}

export function decomposeHistoryLine(
  line: RawHistoryLine,
  toolNameById: ReadonlyMap<string, string>,
  options: DecomposeLineOptions = {}
): SessionBlock[] {
  if (line.type !== 'user' && line.type !== 'assistant') return [];
  const msg = line.message;
  if (!msg) return [];
  if (line.isSidechain && options.includeSidechain !== true) return [];

  const meta = buildLineMeta(line, options.subagentId);

  if (typeof msg.content === 'string') {
    if (!msg.content.trim() || isSystemNoise(msg.content)) return [];
    return [makeTextBlock(blockId(line.uuid, 0), meta, msg.role, msg.content)];
  }

  const out: SessionBlock[] = [];
  msg.content.forEach((block, i) => {
    const child = blockForContentBlock(
      block,
      blockId(line.uuid, i),
      meta,
      msg.role,
      toolNameById,
      options
    );
    if (child !== undefined) out.push(child);
  });
  return out;
}

interface BlockMeta {
  sessionId: string;
  timestamp: string;
  messageUuid: string;
  parentUuid?: string;
  subagentId?: string;
  isSidechain?: boolean;
}

function buildLineMeta(
  line: RawHistoryLine,
  subagentId: string | undefined
): BlockMeta {
  const meta: BlockMeta = {
    sessionId: line.sessionId,
    timestamp: line.timestamp,
    messageUuid: line.uuid,
  };
  if (line.parentUuid !== null && line.parentUuid !== undefined) {
    meta.parentUuid = line.parentUuid;
  }
  if (subagentId !== undefined) meta.subagentId = subagentId;
  if (line.isSidechain) meta.isSidechain = true;
  return meta;
}

function blockId(messageUuid: string, blockIndex: number): string {
  return `${messageUuid}:${String(blockIndex)}`;
}

function makeTextBlock(
  id: string,
  meta: BlockMeta,
  role: 'user' | 'assistant',
  content: string
): SessionBlock {
  return role === 'user'
    ? { ...meta, id, type: 'user_text', content }
    : { ...meta, id, type: 'assistant_text', content };
}

function blockForContentBlock(
  block: ContentBlock,
  id: string,
  meta: BlockMeta,
  role: 'user' | 'assistant',
  toolNameById: ReadonlyMap<string, string>,
  options: DecomposeLineOptions
): SessionBlock | undefined {
  switch (block.type) {
    case 'text':
      if (!block.text.trim() || isSystemNoise(block.text)) return undefined;
      return makeTextBlock(id, meta, role, block.text);

    case 'thinking':
      if (!block.thinking.trim()) return undefined;
      return { ...meta, id, type: 'thinking', content: block.thinking };

    case 'image':
      return makeTextBlock(id, meta, role, imagePlaceholder(block.source));

    case 'tool_use':
      return {
        ...meta,
        id,
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        summary: summarizeToolCall(block),
        input: block.input,
      };

    case 'tool_result': {
      if (options.includeToolResults === false) return undefined;
      const text = extractToolResultText(block.content);
      const prepared = prepareToolResultForRetention(
        text,
        MAX_TOOL_RESULT_LINES
      );
      const content = prepared.content;
      if (!content.trim() && !block.is_error) return undefined;
      const result: ToolResultBlockShape = {
        ...meta,
        id,
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content,
        truncated: prepared.truncated,
        isError: block.is_error ?? false,
      };
      const resolvedName = toolNameById.get(block.tool_use_id);
      if (resolvedName !== undefined) result.toolName = resolvedName;
      if (prepared.truncated)
        result.originalLineCount = prepared.originalLineCount;
      return result;
    }

    default:
      return assertNever(block);
  }
}

interface ToolResultBlockShape extends BlockMeta {
  id: string;
  type: 'tool_result';
  toolUseId: string;
  toolName?: string;
  content: string;
  truncated: boolean;
  originalLineCount?: number;
  isError: boolean;
}

export function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('<task-notification>')) return true;
  if (trimmed.startsWith('<system-reminder>')) return true;
  if (trimmed.startsWith('<local-command-stdout>')) return true;
  if (trimmed.startsWith('<local-command-caveat>')) return true;
  if (trimmed.startsWith('<command-name>')) return true;
  return false;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled content block type: ${JSON.stringify(value)}`);
}
