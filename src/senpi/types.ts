import { z } from 'zod';

/**
 * Zod schema for a `text` content block inside a message content array
 * (session-format.md, "Content Blocks").
 */
export const senpiTextContentSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

/**
 * Zod schema for an `image` content block: base64 `data` plus a MIME type
 * such as `image/jpeg`.
 */
export const senpiImageContentSchema = z.looseObject({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string(),
});

/**
 * Zod schema for a `thinking` content block. `startedAt`/`endedAt` are
 * best-effort epoch milliseconds stamped by the agent loop; they are absent
 * on pre-feature sessions and renderers must treat absence as "no timing
 * available".
 */
export const senpiThinkingContentSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

/**
 * Zod schema for a `toolCall` content block referencing a tool invocation;
 * `arguments` is an open record of JSON-decoded tool arguments.
 */
export const senpiToolCallSchema = z.looseObject({
  type: z.literal('toolCall'),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

/** Parsed form of {@link senpiTextContentSchema}. */
export type SenpiTextContent = z.infer<typeof senpiTextContentSchema>;

/** Parsed form of {@link senpiImageContentSchema}. */
export type SenpiImageContent = z.infer<typeof senpiImageContentSchema>;

/** Parsed form of {@link senpiThinkingContentSchema}. */
export type SenpiThinkingContent = z.infer<typeof senpiThinkingContentSchema>;

/** Parsed form of {@link senpiToolCallSchema}. */
export type SenpiToolCall = z.infer<typeof senpiToolCallSchema>;

/** Content blocks allowed on a `user`-shaped message body. */
const userBodyContentSchema = z.union([
  senpiTextContentSchema,
  senpiImageContentSchema,
]);

/** Content value shared by user and custom messages: plain text or blocks. */
const stringOrBlocksContentSchema = z.union([
  z.string(),
  z.array(userBodyContentSchema),
]);

/**
 * Zod schema for token/cost accounting as persisted on assistant messages,
 * compaction entries, and branch-summary entries.
 */
export const senpiUsageSchema = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});

/**
 * Zod schema for a `user` message. Message-level `timestamp` values are Unix
 * epoch milliseconds (unlike entry-level ISO strings).
 */
export const senpiUserMessageSchema = z.looseObject({
  role: z.literal('user'),
  content: stringOrBlocksContentSchema,
  timestamp: z.number(),
});

/**
 * Zod schema for terminal assistant stop reasons. The upstream `StopReason`
 * union also contains `"pending"`, but that value only exists on streaming
 * partials and never reaches persisted session JSONL.
 */
export const senpiStopReasonSchema = z.enum([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
]);

/**
 * Zod schema for an `assistant` message carrying provider/model metadata and
 * required usage totals.
 */
export const senpiAssistantMessageSchema = z.looseObject({
  role: z.literal('assistant'),
  content: z.array(
    z.union([
      senpiTextContentSchema,
      senpiThinkingContentSchema,
      senpiToolCallSchema,
    ])
  ),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  usage: senpiUsageSchema,
  stopReason: senpiStopReasonSchema,
  errorMessage: z.string().optional(),
  timestamp: z.number(),
});

/**
 * Zod schema for a `toolResult` message; `details` holds tool-specific
 * metadata and `usage` the nested LLM work performed by the tool.
 */
export const senpiToolResultMessageSchema = z.looseObject({
  role: z.literal('toolResult'),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(userBodyContentSchema),
  details: z.unknown().optional(),
  usage: senpiUsageSchema.optional(),
  isError: z.boolean(),
  timestamp: z.number(),
});

/**
 * Zod schema for a `bashExecution` message recorded by shell commands run
 * inside the harness. `exitCode` is `undefined` when the command was
 * cancelled before exiting.
 */
export const senpiBashExecutionMessageSchema = z.looseObject({
  role: z.literal('bashExecution'),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().optional(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  fullOutputPath: z.string().optional(),
  excludeFromContext: z.boolean().optional(),
  timestamp: z.number(),
});

/**
 * Zod schema for a `custom` message injected by an extension that DOES
 * participate in LLM context (`customType` identifies the extension).
 */
export const senpiCustomMessageSchema = z.looseObject({
  role: z.literal('custom'),
  customType: z.string(),
  content: stringOrBlocksContentSchema,
  display: z.boolean(),
  details: z.unknown().optional(),
  timestamp: z.number(),
});

/**
 * Zod schema for a `branchSummary` message produced when switching branches
 * with an LLM-generated summary of the abandoned path.
 */
export const senpiBranchSummaryMessageSchema = z.looseObject({
  role: z.literal('branchSummary'),
  summary: z.string(),
  fromId: z.string(),
  timestamp: z.number(),
});

/**
 * Zod schema for a `compactionSummary` message synthesized from a compaction
 * entry during context building.
 */
export const senpiCompactionSummaryMessageSchema = z.looseObject({
  role: z.literal('compactionSummary'),
  summary: z.string(),
  tokensBefore: z.number(),
  timestamp: z.number(),
});

/** Union of every AgentMessage role persisted in session JSONL. */
export const senpiAgentMessageSchema = z.discriminatedUnion('role', [
  senpiUserMessageSchema,
  senpiAssistantMessageSchema,
  senpiToolResultMessageSchema,
  senpiBashExecutionMessageSchema,
  senpiCustomMessageSchema,
  senpiBranchSummaryMessageSchema,
  senpiCompactionSummaryMessageSchema,
]);

/** Parsed form of {@link senpiUsageSchema}. */
export type SenpiUsage = z.infer<typeof senpiUsageSchema>;

/** Parsed form of {@link senpiUserMessageSchema}. */
export type SenpiUserMessage = z.infer<typeof senpiUserMessageSchema>;

/** Parsed form of {@link senpiAssistantMessageSchema}. */
export type SenpiAssistantMessage = z.infer<typeof senpiAssistantMessageSchema>;

/** Parsed form of {@link senpiToolResultMessageSchema}. */
export type SenpiToolResultMessage = z.infer<
  typeof senpiToolResultMessageSchema
>;

/** Parsed form of {@link senpiBashExecutionMessageSchema}. */
export type SenpiBashExecutionMessage = z.infer<
  typeof senpiBashExecutionMessageSchema
>;

/** Parsed form of {@link senpiCustomMessageSchema}. */
export type SenpiCustomMessage = z.infer<typeof senpiCustomMessageSchema>;

/** Parsed form of {@link senpiBranchSummaryMessageSchema}. */
export type SenpiBranchSummaryMessage = z.infer<
  typeof senpiBranchSummaryMessageSchema
>;

/** Parsed form of {@link senpiCompactionSummaryMessageSchema}. */
export type SenpiCompactionSummaryMessage = z.infer<
  typeof senpiCompactionSummaryMessageSchema
>;

/** Parsed form of {@link senpiAgentMessageSchema}. */
export type SenpiAgentMessage = z.infer<typeof senpiAgentMessageSchema>;

/**
 * The exactly 9 known non-header entry `type` tags in a session v3 JSONL
 * file, in documentation order.
 */
export const SENPI_ENTRY_TAGS = [
  'message',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
] as const;

/** Known non-header entry tag names. */
export type SenpiEntryTag = (typeof SENPI_ENTRY_TAGS)[number];

/**
 * Tree-link fields shared by every non-header entry. Entry `timestamp` is an
 * ISO string (message bodies carry their own numeric Unix-ms timestamps).
 * Unknown extra fields survive parsing for additive forward-compatibility.
 */
const senpiEntryBaseFields = {
  id: z.string(),
  parentId: z.string().nullable(),
  timestamp: z.string(),
};

/**
 * Zod schema for the session header line (first line of the file). Unlike
 * tree entries it has no `parentId`; its `id` is the session UUID and
 * `parentSession` records the source file of forked/cloned sessions.
 */
export const senpiSessionHeaderSchema = z.looseObject({
  type: z.literal('session'),
  version: z.number(),
  id: z.string(),
  timestamp: z.string(),
  cwd: z.string(),
  parentSession: z.string().optional(),
});

/** Zod schema for a `message` entry wrapping one {@link SenpiAgentMessage}. */
export const senpiMessageEntrySchema = z.looseObject({
  type: z.literal('message'),
  ...senpiEntryBaseFields,
  message: senpiAgentMessageSchema,
});

/** Zod schema for a mid-session model switch entry. */
export const senpiModelChangeEntrySchema = z.looseObject({
  type: z.literal('model_change'),
  ...senpiEntryBaseFields,
  provider: z.string(),
  modelId: z.string(),
});

/** Zod schema for a thinking/reasoning level change entry. */
export const senpiThinkingLevelChangeEntrySchema = z.looseObject({
  type: z.literal('thinking_level_change'),
  ...senpiEntryBaseFields,
  thinkingLevel: z.string(),
});

/**
 * Zod schema for a compaction checkpoint entry. `retainedTail` materializes
 * the post-compaction context (newer sessions); legacy sessions instead use
 * `firstKeptEntryId`. `fromHook` is true when an extension generated the
 * compaction.
 */
export const senpiCompactionEntrySchema = z.looseObject({
  type: z.literal('compaction'),
  ...senpiEntryBaseFields,
  summary: z.string(),
  tokensBefore: z.number(),
  retainedTail: z.array(senpiAgentMessageSchema).optional(),
  firstKeptEntryId: z.string().optional(),
  usage: senpiUsageSchema.optional(),
  details: z.unknown().optional(),
  fromHook: z.boolean().optional(),
});

/**
 * Zod schema for a branch_summary entry recording the LLM summary of the
 * abandoned branch path up to the common ancestor at `fromId`.
 */
export const senpiBranchSummaryEntrySchema = z.looseObject({
  type: z.literal('branch_summary'),
  ...senpiEntryBaseFields,
  fromId: z.string(),
  summary: z.string(),
  usage: senpiUsageSchema.optional(),
  details: z.unknown().optional(),
  fromHook: z.boolean().optional(),
});

/**
 * Zod schema for a custom extension-state entry; NOT part of LLM context.
 * `customType` identifies the owning extension, `data` its opaque payload.
 */
export const senpiCustomEntrySchema = z.looseObject({
  type: z.literal('custom'),
  ...senpiEntryBaseFields,
  customType: z.string(),
  data: z.unknown().optional(),
});

/**
 * Zod schema for a custom_message entry: an extension-injected message that
 * DOES participate in LLM context. `display` controls TUI visibility.
 */
export const senpiCustomMessageEntrySchema = z.looseObject({
  type: z.literal('custom_message'),
  ...senpiEntryBaseFields,
  customType: z.string(),
  content: stringOrBlocksContentSchema,
  display: z.boolean(),
  details: z.unknown().optional(),
});

/**
 * Zod schema for a label bookmark entry pointing at `targetId`; `label` is
 * cleared by setting it to undefined upstream.
 */
export const senpiLabelEntrySchema = z.looseObject({
  type: z.literal('label'),
  ...senpiEntryBaseFields,
  targetId: z.string(),
  label: z.string(),
});

/** Zod schema for a session_info metadata entry (e.g. user-set name). */
export const senpiSessionInfoEntrySchema = z.looseObject({
  type: z.literal('session_info'),
  ...senpiEntryBaseFields,
  name: z.string(),
});

/**
 * Discriminated union covering the session header plus the EXACTLY 9 known
 * non-header entry tags of the session v3 wire format. Unknown tags are
 * intentionally not accepted here; they are handled by the parse policy.
 */
export const senpiSessionEntrySchema = z.discriminatedUnion('type', [
  senpiSessionHeaderSchema,
  senpiMessageEntrySchema,
  senpiModelChangeEntrySchema,
  senpiThinkingLevelChangeEntrySchema,
  senpiCompactionEntrySchema,
  senpiBranchSummaryEntrySchema,
  senpiCustomEntrySchema,
  senpiCustomMessageEntrySchema,
  senpiLabelEntrySchema,
  senpiSessionInfoEntrySchema,
]);

/** Parsed form of {@link senpiSessionHeaderSchema}. */
export type SenpiSessionHeader = z.infer<typeof senpiSessionHeaderSchema>;

/** Parsed form of {@link senpiMessageEntrySchema}. */
export type SenpiMessageEntry = z.infer<typeof senpiMessageEntrySchema>;

/** Parsed form of {@link senpiModelChangeEntrySchema}. */
export type SenpiModelChangeEntry = z.infer<typeof senpiModelChangeEntrySchema>;

/** Parsed form of {@link senpiThinkingLevelChangeEntrySchema}. */
export type SenpiThinkingLevelChangeEntry = z.infer<
  typeof senpiThinkingLevelChangeEntrySchema
>;

/** Parsed form of {@link senpiCompactionEntrySchema}. */
export type SenpiCompactionEntry = z.infer<typeof senpiCompactionEntrySchema>;

/** Parsed form of {@link senpiBranchSummaryEntrySchema}. */
export type SenpiBranchSummaryEntry = z.infer<
  typeof senpiBranchSummaryEntrySchema
>;

/** Parsed form of {@link senpiCustomEntrySchema}. */
export type SenpiCustomEntry = z.infer<typeof senpiCustomEntrySchema>;

/** Parsed form of {@link senpiCustomMessageEntrySchema}. */
export type SenpiCustomMessageEntry = z.infer<
  typeof senpiCustomMessageEntrySchema
>;

/** Parsed form of {@link senpiLabelEntrySchema}. */
export type SenpiLabelEntry = z.infer<typeof senpiLabelEntrySchema>;

/** Parsed form of {@link senpiSessionInfoEntrySchema}. */
export type SenpiSessionInfoEntry = z.infer<typeof senpiSessionInfoEntrySchema>;

/** Parsed form of {@link senpiSessionEntrySchema}: header + 9 known tags. */
export type SenpiSessionEntry = z.infer<typeof senpiSessionEntrySchema>;
