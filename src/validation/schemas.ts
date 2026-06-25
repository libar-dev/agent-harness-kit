/**
 * Zod schemas for Claude Code hooks
 *
 * These schemas provide runtime validation for hook data contracts.
 * The library maintains a dual type system: manual TypeScript interfaces
 * in `src/types/index.ts` AND Zod-inferred types here. Both must stay in sync.
 */

import { z } from 'zod';

export const permissionModeSchema = z.enum([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);

export const compactionTriggerSchema = z.enum(['manual', 'auto']);

export const elicitationActionSchema = z.enum(['accept', 'decline', 'cancel']);

export const elicitationModeSchema = z.enum(['form', 'url']);

export const stopFailureErrorSchema = z.enum([
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
]);

export const configChangeSourceSchema = z.enum([
  'user_settings',
  'project_settings',
  'local_settings',
  'policy_settings',
  'skills',
]);

export const instructionMemoryTypeSchema = z.enum([
  'User',
  'Project',
  'Local',
  'Managed',
]);

export const instructionLoadReasonSchema = z.enum([
  'session_start',
  'nested_traversal',
  'path_glob_match',
  'include',
  'compact',
]);

export const fileChangedEventSchema = z.enum(['change', 'add', 'unlink']);

export const permissionUpdateEntrySchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const taskLifecycleFields = {
  task_id: z.string().min(1),
  task_subject: z.string().min(1),
  task_description: z.string().optional(),
  teammate_name: z.string().optional(),
  team_name: z.string().optional(),
};

/**
 * Base schema for all hook inputs - common fields present in every hook
 */
export const baseHookInputSchema = z.object({
  /** Unique identifier for the current Claude Code session */
  session_id: z.string().min(1),
  /** Absolute path to the conversation transcript JSON file */
  transcript_path: z.string().min(1),
  /** Current working directory when the hook is invoked */
  cwd: z.string().min(1),
  /** The specific hook event that triggered this execution */
  hook_event_name: z.string().min(1),
  /** Current permission mode */
  permission_mode: permissionModeSchema.optional(),
  /** Unique identifier for a subagent context, when present */
  agent_id: z.string().optional(),
  /** Agent name when running under --agent or inside a subagent */
  agent_type: z.string().optional(),
  /** Effort metadata for the current turn, when provided by Claude Code */
  effort: z
    .object({
      level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    })
    .optional(),
});

/**
 * Base schema for all hook outputs - common fields hooks can return
 */
export const baseHookOutputSchema = z.object({
  /** Whether Claude should continue after hook execution (default: true) */
  continue: z.boolean().optional(),
  /** Message shown to user when continue is false */
  stopReason: z.string().optional(),
  /** Hide stdout from transcript mode (default: false) */
  suppressOutput: z.boolean().optional(),
  /** Optional warning message shown to the user */
  systemMessage: z.string().optional(),
  /** ANSI escape sequences or similar terminal control output */
  terminalSequence: z.string().optional(),
});

/**
 * Schema for Setup hook inputs
 */
export const setupInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('Setup'),
  /** How setup was triggered */
  trigger: z.enum(['init', 'maintenance']),
});

/**
 * Schema for Setup hook outputs
 */
export const setupOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('Setup'),
      /** String added to setup context */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for PreToolUse hook inputs
 */
export const preToolUseInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PreToolUse'),
  /** Name of the tool about to be executed */
  tool_name: z.string().min(1),
  /** Parameters that will be passed to the tool - kept as Record for flexibility */
  tool_input: z.record(z.string(), z.unknown()),
  /** Unique identifier for this tool use */
  tool_use_id: z.string().min(1),
});

/**
 * Schema for PostToolUse hook inputs
 */
export const postToolUseInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  /** Name of the tool that was executed */
  tool_name: z.string().min(1),
  /** Parameters that were passed to the tool */
  tool_input: z.record(z.string(), z.unknown()),
  /** Response/output from the tool execution */
  tool_response: z.record(z.string(), z.unknown()),
  /** Unique identifier for this tool use */
  tool_use_id: z.string().min(1),
  /** Tool execution duration in milliseconds */
  duration_ms: z.number().optional(),
});

/**
 * Schema for UserPromptSubmit hook inputs
 */
export const userPromptSubmitInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  /** The user's raw prompt text */
  prompt: z.string(),
});

/**
 * Schema for UserPromptExpansion hook inputs
 */
export const userPromptExpansionInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('UserPromptExpansion'),
  /** Prompt expansion source type */
  expansion_type: z.enum(['slash_command', 'mcp_prompt']),
  /** Command or MCP prompt name */
  command_name: z.string().min(1),
  /** Raw arguments supplied to the command */
  command_args: z.string(),
  /** Source that provided the command */
  command_source: z.string().min(1),
  /** Original user prompt */
  prompt: z.string(),
});

/**
 * Schema for SessionStart hook inputs
 */
export const sessionStartInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  /** How the session was started */
  source: z.enum(['startup', 'resume', 'clear', 'compact']),
  /** The model identifier */
  model: z.string().optional(),
  /** Session title when one is already known */
  session_title: z.string().optional(),
  /** Agent name if started with --agent */
  agent_type: z.string().optional(),
});

/**
 * Schema for SessionEnd hook inputs
 */
export const sessionEndInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('SessionEnd'),
  /** Why the session ended */
  reason: z.enum([
    'clear',
    'resume',
    'logout',
    'prompt_input_exit',
    'bypass_permissions_disabled',
    'other',
  ]),
});

/**
 * Schema for Notification hook inputs
 */
export const notificationInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('Notification'),
  /** The notification message being sent */
  message: z.string(),
  /** Optional notification title */
  title: z.string().optional(),
  /** Type of notification — used for matcher filtering */
  notification_type: z.enum([
    'permission_prompt',
    'idle_prompt',
    'auth_success',
    'elicitation_dialog',
    'elicitation_complete',
    'elicitation_response',
  ]),
});

/**
 * Schema for MessageDisplay hook inputs
 */
export const messageDisplayInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('MessageDisplay'),
  /** Unique identifier for the current turn */
  turn_id: z.string().uuid(),
  /** Unique identifier for the message being displayed */
  message_id: z.string().uuid(),
  /** Zero-based chunk index for this display delta */
  index: z.number().int().nonnegative(),
  /** Whether this is the final chunk */
  final: z.boolean(),
  /** Delta text being displayed */
  delta: z.string(),
});

/**
 * Schema for MessageDisplay hook outputs
 */
export const messageDisplayOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('MessageDisplay'),
      /** Optional replacement content for display */
      displayContent: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for Stop hook inputs
 */
export const stopInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('Stop'),
  /** True when Claude Code is already continuing as a result of a stop hook */
  stop_hook_active: z.boolean(),
  /** Text content of Claude's final response */
  last_assistant_message: z.string().optional(),
});

/**
 * Schema for SubagentStop hook inputs
 */
export const subagentStopInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('SubagentStop'),
  /** True when Claude Code is already continuing as a result of a stop hook */
  stop_hook_active: z.boolean(),
  /** Unique identifier for the subagent */
  agent_id: z.string(),
  /** Agent type name — used for matcher filtering */
  agent_type: z.string(),
  /** Path to the subagent's own transcript */
  agent_transcript_path: z.string(),
  /** Text content of the subagent's final response */
  last_assistant_message: z.string().optional(),
});

/**
 * Schema for PreCompact hook inputs
 */
export const preCompactInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PreCompact'),
  /** What triggered the compact: 'manual' (from /compact) or 'auto' (full context) */
  trigger: compactionTriggerSchema,
  /** Custom instructions from user (manual) or empty (auto) */
  custom_instructions: z.string(),
});

/**
 * Schema for PostCompact hook inputs
 */
export const postCompactInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PostCompact'),
  /** What triggered compaction */
  trigger: compactionTriggerSchema,
  /** Generated conversation summary */
  compact_summary: z.string(),
});

/**
 * Schema for PermissionRequest hook inputs
 * Unlike PreToolUse, does NOT include tool_use_id
 */
export const permissionRequestInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PermissionRequest'),
  /** Name of the tool requesting permission */
  tool_name: z.string().min(1),
  /** Parameters for the tool requesting permission */
  tool_input: z.record(z.string(), z.unknown()),
  /** "Always allow" options from the permission dialog */
  permission_suggestions: z.array(permissionUpdateEntrySchema).optional(),
});

/**
 * Schema for PermissionDenied hook inputs
 */
export const permissionDeniedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PermissionDenied'),
  /** Name of the denied tool */
  tool_name: z.string().min(1),
  /** Parameters that would have been passed to the tool */
  tool_input: z.record(z.string(), z.unknown()),
  /** Unique identifier for this tool use */
  tool_use_id: z.string().min(1),
  /** Auto mode classifier explanation */
  reason: z.string().min(1),
});

/**
 * Schema for PostToolUseFailure hook inputs
 */
export const postToolUseFailureInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolUseFailure'),
  /** Name of the tool that failed */
  tool_name: z.string().min(1),
  /** Parameters that were passed to the tool */
  tool_input: z.record(z.string(), z.unknown()),
  /** Unique identifier for this tool use */
  tool_use_id: z.string().min(1),
  /** String describing what went wrong */
  error: z.string(),
  /** Whether the failure was caused by user interruption */
  is_interrupt: z.boolean().optional(),
  /** Tool execution duration in milliseconds */
  duration_ms: z.number().optional(),
});

const postToolBatchResponseSchema = z.union([
  z.string(),
  z.array(z.record(z.string(), z.unknown())),
]);

/**
 * Schema for PostToolBatch hook inputs
 */
export const postToolBatchInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolBatch'),
  /** Every tool call result in the resolved batch */
  tool_calls: z
    .array(
      z.object({
        tool_name: z.string().min(1),
        tool_input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().min(1),
        tool_response: postToolBatchResponseSchema,
      })
    )
    .min(1),
});

/**
 * Schema for SubagentStart hook inputs
 */
export const subagentStartInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('SubagentStart'),
  /** Unique identifier for the subagent */
  agent_id: z.string(),
  /** Agent type name — used for matcher filtering */
  agent_type: z.string(),
});

/**
 * Schema for TeammateIdle hook inputs
 * Decision control: exit code only (no JSON decision control)
 */
export const teammateIdleInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('TeammateIdle'),
  /** Name of the teammate that is about to go idle */
  teammate_name: z.string().min(1),
  /** Name of the team */
  team_name: z.string().min(1),
});

/**
 * Schema for TaskCreated hook inputs
 */
export const taskCreatedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('TaskCreated'),
  ...taskLifecycleFields,
});

/**
 * Schema for TaskCompleted hook inputs
 * Decision control: exit code only (no JSON decision control)
 */
export const taskCompletedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('TaskCompleted'),
  ...taskLifecycleFields,
});

/**
 * Schema for StopFailure hook inputs
 */
export const stopFailureInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('StopFailure'),
  /** API error type */
  error: stopFailureErrorSchema,
  /** Additional error details */
  error_details: z.string().optional(),
  /** Rendered error text shown in the conversation */
  last_assistant_message: z.string().optional(),
});

/**
 * Schema for InstructionsLoaded hook inputs
 */
export const instructionsLoadedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('InstructionsLoaded'),
  /** Path to the loaded instruction file */
  file_path: z.string().min(1),
  /** Type of loaded memory/instructions */
  memory_type: instructionMemoryTypeSchema,
  /** Why instructions were loaded */
  load_reason: instructionLoadReasonSchema,
  /** Globs that caused loading, when applicable */
  globs: z.array(z.string()).optional(),
  /** File that triggered the load, when applicable */
  trigger_file_path: z.string().optional(),
  /** Parent instruction file for includes, when applicable */
  parent_file_path: z.string().optional(),
});

/**
 * Schema for ConfigChange hook inputs
 */
export const configChangeInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('ConfigChange'),
  /** Source of the configuration change */
  source: configChangeSourceSchema,
  /** Path to the changed file */
  file_path: z.string().optional(),
});

/**
 * Schema for CwdChanged hook inputs
 */
export const cwdChangedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('CwdChanged'),
  /** Previous working directory */
  old_cwd: z.string().min(1),
  /** New working directory */
  new_cwd: z.string().min(1),
});

/**
 * Schema for FileChanged hook inputs
 */
export const fileChangedInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('FileChanged'),
  /** Absolute path to the changed file */
  file_path: z.string().min(1),
  /** File watcher event */
  event: fileChangedEventSchema,
});

/**
 * Schema for WorktreeCreate hook inputs
 */
export const worktreeCreateInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('WorktreeCreate'),
  /** Slug identifier for the new worktree */
  name: z.string().min(1),
});

/**
 * Schema for WorktreeRemove hook inputs
 */
export const worktreeRemoveInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('WorktreeRemove'),
  /** Absolute path to the worktree being removed */
  worktree_path: z.string().min(1),
});

const elicitationBaseInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('Elicitation'),
  /** MCP server requesting input */
  mcp_server_name: z.string().min(1),
  /** Message shown to the user */
  message: z.string(),
  /** Unique elicitation identifier */
  elicitation_id: z.string().optional(),
});

/**
 * Schema for Elicitation hook inputs
 *
 * Discriminated on `mode`: `"form"` (schema-driven input), `"url"` (external
 * form), or absent (caller defaults). Absent-mode is modeled as a literal
 * `undefined` branch so Zod can still route via the discriminant.
 */
export const elicitationInputSchema = z.discriminatedUnion('mode', [
  elicitationBaseInputSchema.extend({
    mode: z.literal('form'),
    requested_schema: z.record(z.string(), z.unknown()).optional(),
    url: z.string().optional(),
  }),
  elicitationBaseInputSchema.extend({
    mode: z.literal('url'),
    url: z.string().url(),
    requested_schema: z.record(z.string(), z.unknown()).optional(),
  }),
  elicitationBaseInputSchema.extend({
    mode: z.undefined(),
    requested_schema: z.record(z.string(), z.unknown()).optional(),
    url: z.string().optional(),
  }),
]);

/**
 * Schema for ElicitationResult hook inputs
 */
export const elicitationResultInputSchema = baseHookInputSchema.extend({
  hook_event_name: z.literal('ElicitationResult'),
  /** MCP server that requested input */
  mcp_server_name: z.string().min(1),
  /** User's action */
  action: elicitationActionSchema,
  /** Response content */
  content: z.record(z.string(), z.unknown()).optional(),
  /** Elicitation mode */
  mode: elicitationModeSchema.optional(),
  /** Unique elicitation identifier */
  elicitation_id: z.string().optional(),
});

/**
 * Schema for PreToolUse hook outputs - controls permission
 */
export const preToolUseOutputSchema = baseHookOutputSchema.extend({
  /** Legacy fields - deprecated but maintained for compatibility */
  decision: z.enum(['approve', 'block']).optional(),
  reason: z.string().optional(),

  /** Modern hook-specific output format */
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PreToolUse'),
      /** Permission decision: allow bypasses permission, deny blocks, ask prompts user */
      permissionDecision: z.enum(['allow', 'deny', 'ask', 'defer']),
      /** Reason shown to user (allow/ask) or Claude (deny) */
      permissionDecisionReason: z.string().min(1),
      /** Modifies the tool's input parameters before execution */
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      /** String added to Claude's context before the tool executes */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for PostToolUse hook outputs - provides feedback
 */
export const postToolUseOutputSchema = baseHookOutputSchema.extend({
  /** Legacy decision field */
  decision: z.enum(['block']).optional(),
  /** Explanation for the decision */
  reason: z.string().optional(),

  /** Modern hook-specific output */
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PostToolUse'),
      /** Additional information for Claude to consider */
      additionalContext: z.string().optional(),
      /** For MCP tools only: replaces the tool's output with the provided value */
      updatedMCPToolOutput: z.unknown().optional(),
      /** Replaces the tool output with the provided value */
      updatedToolOutput: z.unknown().optional(),
    })
    .optional(),
});

/**
 * Schema for UserPromptSubmit hook outputs - controls prompt processing
 */
export const userPromptSubmitOutputSchema = baseHookOutputSchema.extend({
  /** Block prompt processing - erases prompt from context */
  decision: z.enum(['block']).optional(),
  /** Reason shown to user (not added to context) */
  reason: z.string().optional(),
  /** Add context if not blocked */
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('UserPromptSubmit'),
      /** String added to context for Claude */
      additionalContext: z.string().optional(),
      /** Sets the session title */
      sessionTitle: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for UserPromptExpansion hook outputs
 */
export const userPromptExpansionOutputSchema = baseHookOutputSchema.extend({
  /** Block prompt expansion */
  decision: z.enum(['block']).optional(),
  /** Reason shown to the user when blocked */
  reason: z.string().optional(),
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('UserPromptExpansion'),
      /** String added to Claude's context alongside the expanded prompt */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for Stop/SubagentStop hook outputs - controls continuation
 */
export const stopOutputSchema = baseHookOutputSchema.extend({
  /** Block Claude from stopping - must provide reason for how to proceed */
  decision: z.enum(['block']).optional(),
  /** Must be provided when decision is 'block' - tells Claude how to proceed */
  reason: z.string().optional(),
});

/**
 * Schema for SessionStart hook outputs - context injection
 */
export const sessionStartOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('SessionStart'),
      /** String added to the context at session start */
      additionalContext: z.string().optional(),
      /** Initial user-visible message to seed the session */
      initialUserMessage: z.string().optional(),
      /** Sets the session title */
      sessionTitle: z.string().optional(),
      /** Dynamic absolute paths to watch */
      watchPaths: z.array(z.string()).optional(),
      /** Reload active skills after session setup */
      reloadSkills: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Schema for Notification hook outputs
 */
export const notificationOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('Notification'),
      /** Additional context for the notification handling */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for outputs that can block and inject additional context
 */
const blockContextOutputSchema = <T extends string>(hookEventName: T) =>
  baseHookOutputSchema.extend({
    decision: z.enum(['block']).optional(),
    reason: z.string().optional(),
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal(hookEventName),
        additionalContext: z.string().optional(),
      })
      .optional(),
  });

/**
 * Schema for PermissionRequest hook outputs - allow/deny decisions
 */
const permissionRequestAllowDecisionSchema = z.object({
  behavior: z.literal('allow'),
  /** Modifies the tool's input parameters before execution */
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  /** Applies permission rule updates (equivalent to "always allow" selection) */
  updatedPermissions: z.array(permissionUpdateEntrySchema).optional(),
});

const permissionRequestDenyDecisionSchema = z.object({
  behavior: z.literal('deny'),
  /** Tells Claude why the permission was denied */
  message: z.string().optional(),
  /** If true, stops Claude */
  interrupt: z.boolean().optional(),
});

export const permissionRequestOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PermissionRequest'),
      decision: z.discriminatedUnion('behavior', [
        permissionRequestAllowDecisionSchema,
        permissionRequestDenyDecisionSchema,
      ]),
    })
    .optional(),
});

/**
 * Schema for PostToolUseFailure hook outputs
 */
export const postToolUseFailureOutputSchema = baseHookOutputSchema.extend({
  /** Block to provide feedback to Claude */
  decision: z.enum(['block']).optional(),
  /** Explanation shown to Claude */
  reason: z.string().optional(),
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PostToolUseFailure'),
      /** Additional context for Claude to consider alongside the error */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for PermissionDenied hook outputs
 */
export const permissionDeniedOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PermissionDenied'),
      /** Whether Claude may retry the denied tool call */
      retry: z.boolean(),
    })
    .optional(),
});

/**
 * Schema for PostToolBatch hook outputs
 */
export const postToolBatchOutputSchema =
  blockContextOutputSchema('PostToolBatch');

/**
 * Schema for SubagentStart hook outputs - context injection
 */
export const subagentStartOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('SubagentStart'),
      /** String added to the subagent's context */
      additionalContext: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for PreCompact hook outputs
 */
export const preCompactOutputSchema = blockContextOutputSchema('PreCompact');

/**
 * Schema for ConfigChange hook outputs
 */
export const configChangeOutputSchema = baseHookOutputSchema.extend({
  decision: z.enum(['block']).optional(),
  reason: z.string().optional(),
});

/**
 * Schema for CwdChanged/FileChanged hook outputs
 */
export const watchPathsOutputSchema = baseHookOutputSchema.extend({
  watchPaths: z.array(z.string().min(1)).optional(),
});

/**
 * Schema for WorktreeCreate hook outputs
 */
export const worktreeCreateOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('WorktreeCreate'),
      worktreePath: z.string().min(1),
    })
    .optional(),
});

/**
 * Schema for Elicitation hook outputs
 */
export const elicitationOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('Elicitation'),
      action: elicitationActionSchema,
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/**
 * Schema for ElicitationResult hook outputs
 */
export const elicitationResultOutputSchema = baseHookOutputSchema.extend({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('ElicitationResult'),
      action: elicitationActionSchema,
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/**
 * Schema for Bash tool inputs
 */
export const bashToolInputSchema = z.object({
  /** The shell command to execute */
  command: z.string().min(1),
  /** Optional description of what the command does */
  description: z.string().optional(),
  /** Timeout in milliseconds */
  timeout: z.number().positive().optional(),
  /** Whether to run in background */
  run_in_background: z.boolean().optional(),
});

/**
 * Schema for Write tool inputs
 */
export const writeToolInputSchema = z.object({
  /** Absolute path to the file to write */
  file_path: z.string().min(1),
  /** Content to write to the file */
  content: z.string(),
});

/**
 * Schema for Edit tool inputs
 */
export const editToolInputSchema = z.object({
  /** Absolute path to the file to modify */
  file_path: z.string().min(1),
  /** Text to replace */
  old_string: z.string(),
  /** Text to replace it with */
  new_string: z.string(),
  /** Replace all occurrences */
  replace_all: z.boolean().optional(),
});

/**
 * Schema for Read tool inputs
 */
export const readToolInputSchema = z.object({
  /** Absolute path to the file to read */
  file_path: z.string().min(1),
  /** Line number to start reading from */
  offset: z.number().nonnegative().optional(),
  /** Number of lines to read */
  limit: z.number().positive().optional(),
});

/**
 * Schema for WebFetch tool inputs
 */
export const webFetchToolInputSchema = z.object({
  /** URL to fetch content from */
  url: z.string().min(1),
  /** Prompt to run on the fetched content */
  prompt: z.string().min(1),
});

/**
 * Schema for WebSearch tool inputs
 */
export const webSearchToolInputSchema = z.object({
  /** Search query */
  query: z.string().min(1),
  /** Only include results from these domains */
  allowed_domains: z.array(z.string()).optional(),
  /** Exclude results from these domains */
  blocked_domains: z.array(z.string()).optional(),
});

/**
 * Schema for Task tool inputs (spawns a subagent)
 */
export const taskToolInputSchema = z.object({
  /** The task for the agent to perform */
  prompt: z.string().min(1),
  /** Short description of the task */
  description: z.string().optional(),
  /** Type of specialized agent to use */
  subagent_type: z.string().optional(),
  /** Optional model alias to override the default */
  model: z.string().optional(),
});

/**
 * Schema for Agent tool inputs (official name for subagent spawning).
 */
export const agentToolInputSchema = taskToolInputSchema;

const askUserQuestionOptionSchema = z.object({
  /** Option label shown to the user */
  label: z.string().min(1),
});

const askUserQuestionQuestionSchema = z.object({
  /** Question text shown to the user */
  question: z.string().min(1),
  /** Short UI header */
  header: z.string().min(1),
  /** Selectable answers */
  options: z.array(askUserQuestionOptionSchema).min(1),
  /** Whether multiple options may be selected */
  multiSelect: z.boolean().optional(),
});

/**
 * Schema for AskUserQuestion tool inputs.
 */
export const askUserQuestionToolInputSchema = z.object({
  /** Questions to present to the user */
  questions: z.array(askUserQuestionQuestionSchema).min(1).max(4),
  /** Programmatic answers keyed by question text */
  answers: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for ExitPlanMode tool inputs.
 */
export const exitPlanModeToolInputSchema = z.object({}).strict();

/**
 * Schema for TodoWrite tool inputs.
 */
export const todoWriteToolInputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed']),
      activeForm: z.string().min(1),
    })
  ),
});

/**
 * Generic schema for MCP tool inputs.
 */
export const mcpToolInputSchema = z.record(z.string(), z.unknown());

/**
 * Schema for Glob tool inputs
 */
export const globToolInputSchema = z.object({
  /** Glob pattern to match files against */
  pattern: z.string().min(1),
  /** Optional directory to search in. Defaults to cwd */
  path: z.string().optional(),
});

/**
 * Schema for Grep tool inputs
 */
export const grepToolInputSchema = z.object({
  /** Regular expression pattern to search for */
  pattern: z.string().min(1),
  /** Optional file or directory to search in */
  path: z.string().optional(),
  /** Optional glob pattern to filter files */
  glob: z.string().optional(),
  /** File type to search (e.g., 'js', 'py', 'rust') */
  type: z.string().optional(),
  /** Output mode */
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  /** Enable multiline matching */
  multiline: z.boolean().optional(),
  /** Case insensitive search */
  '-i': z.boolean().optional(),
  /** Show line numbers */
  '-n': z.boolean().optional(),
  /** Lines after each match */
  '-A': z.number().nonnegative().optional(),
  /** Lines before each match */
  '-B': z.number().nonnegative().optional(),
  /** Lines before and after each match */
  '-C': z.number().nonnegative().optional(),
});

/**
 * Schema for MultiEdit tool inputs
 */
export const multiEditToolInputSchema = z.object({
  /** Absolute path to the file to modify */
  file_path: z.string().min(1),
  /** Array of edits to apply */
  edits: z.array(
    z.object({
      /** Text to replace */
      old_string: z.string(),
      /** Text to replace it with */
      new_string: z.string(),
      /** Replace all occurrences */
      replace_all: z.boolean().optional(),
    })
  ),
});

/**
 * Collection of all hook input schemas by event type
 */
export const hookInputSchemas = {
  SessionStart: sessionStartInputSchema,
  Setup: setupInputSchema,
  UserPromptSubmit: userPromptSubmitInputSchema,
  UserPromptExpansion: userPromptExpansionInputSchema,
  PreToolUse: preToolUseInputSchema,
  PermissionRequest: permissionRequestInputSchema,
  PermissionDenied: permissionDeniedInputSchema,
  PostToolUse: postToolUseInputSchema,
  PostToolUseFailure: postToolUseFailureInputSchema,
  PostToolBatch: postToolBatchInputSchema,
  Notification: notificationInputSchema,
  MessageDisplay: messageDisplayInputSchema,
  SubagentStart: subagentStartInputSchema,
  SubagentStop: subagentStopInputSchema,
  TaskCreated: taskCreatedInputSchema,
  TaskCompleted: taskCompletedInputSchema,
  Stop: stopInputSchema,
  StopFailure: stopFailureInputSchema,
  TeammateIdle: teammateIdleInputSchema,
  InstructionsLoaded: instructionsLoadedInputSchema,
  ConfigChange: configChangeInputSchema,
  CwdChanged: cwdChangedInputSchema,
  FileChanged: fileChangedInputSchema,
  WorktreeCreate: worktreeCreateInputSchema,
  WorktreeRemove: worktreeRemoveInputSchema,
  PreCompact: preCompactInputSchema,
  PostCompact: postCompactInputSchema,
  Elicitation: elicitationInputSchema,
  ElicitationResult: elicitationResultInputSchema,
  SessionEnd: sessionEndInputSchema,
} as const;

/**
 * Collection of all hook output schemas by event type
 */
export const hookOutputSchemas = {
  SessionStart: sessionStartOutputSchema,
  Setup: setupOutputSchema,
  UserPromptSubmit: userPromptSubmitOutputSchema,
  UserPromptExpansion: userPromptExpansionOutputSchema,
  PreToolUse: preToolUseOutputSchema,
  PermissionRequest: permissionRequestOutputSchema,
  PermissionDenied: permissionDeniedOutputSchema,
  PostToolUse: postToolUseOutputSchema,
  PostToolUseFailure: postToolUseFailureOutputSchema,
  PostToolBatch: postToolBatchOutputSchema,
  Notification: notificationOutputSchema,
  MessageDisplay: messageDisplayOutputSchema,
  SubagentStart: subagentStartOutputSchema,
  SubagentStop: stopOutputSchema,
  TaskCreated: baseHookOutputSchema,
  TaskCompleted: baseHookOutputSchema,
  Stop: stopOutputSchema,
  StopFailure: baseHookOutputSchema,
  TeammateIdle: baseHookOutputSchema,
  InstructionsLoaded: baseHookOutputSchema,
  ConfigChange: configChangeOutputSchema,
  CwdChanged: watchPathsOutputSchema,
  FileChanged: watchPathsOutputSchema,
  WorktreeCreate: worktreeCreateOutputSchema,
  WorktreeRemove: baseHookOutputSchema,
  PreCompact: preCompactOutputSchema,
  PostCompact: baseHookOutputSchema,
  Elicitation: elicitationOutputSchema,
  ElicitationResult: elicitationResultOutputSchema,
  SessionEnd: baseHookOutputSchema,
} as const;

/**
 * Collection of all tool input schemas by tool name
 */
export const toolInputSchemas = {
  Bash: bashToolInputSchema,
  Write: writeToolInputSchema,
  Edit: editToolInputSchema,
  Read: readToolInputSchema,
  Glob: globToolInputSchema,
  Grep: grepToolInputSchema,
  MultiEdit: multiEditToolInputSchema,
  WebFetch: webFetchToolInputSchema,
  WebSearch: webSearchToolInputSchema,
  Agent: agentToolInputSchema,
  AskUserQuestion: askUserQuestionToolInputSchema,
  ExitPlanMode: exitPlanModeToolInputSchema,
  TodoWrite: todoWriteToolInputSchema,
  Task: taskToolInputSchema,
} as const;

/**
 * Common fields shared by all hook handler types.
 * Spread into each handler schema (not a base schema, since
 * z.discriminatedUnion requires separate z.object schemas).
 */
const hookHandlerCommonFields = {
  /** Seconds before canceling. Defaults: 600 (command), 30 (prompt), 60 (agent) */
  timeout: z.number().positive().optional(),
  /** Custom spinner message displayed while the hook runs */
  statusMessage: z.string().optional(),
  /** If true, runs only once per session then is removed. Skills only, not agents */
  once: z.boolean().optional(),
  /** Permission-rule syntax filter for tool events */
  if: z.string().min(1).optional(),
};

/**
 * Schema for command hook handlers — run a shell command
 */
export const commandHookHandlerSchema = z.object({
  type: z.literal('command'),
  /** Shell command to execute */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** If true, runs in the background without blocking. Only for command hooks */
  async: z.boolean().optional(),
  /** If true, runs in the background and wakes Claude on exit code 2 */
  asyncRewake: z.boolean().optional(),
  /** Shell to use for this hook */
  shell: z.enum(['bash', 'powershell']).optional(),
  ...hookHandlerCommonFields,
});

/**
 * Schema for HTTP hook handlers — post hook input to an endpoint
 */
export const httpHookHandlerSchema = z.object({
  type: z.literal('http'),
  /** URL to send the POST request to */
  url: z.string().url(),
  /** Additional HTTP headers */
  headers: z.record(z.string(), z.string()).optional(),
  /** Environment variables allowed for header interpolation */
  allowedEnvVars: z.array(z.string()).optional(),
  ...hookHandlerCommonFields,
});

/**
 * Schema for MCP tool hook handlers — call a connected MCP server tool
 */
export const mcpToolHookHandlerSchema = z.object({
  type: z.literal('mcp_tool'),
  /** Configured MCP server name */
  server: z.string().min(1),
  /** MCP tool name */
  tool: z.string().min(1),
  /** Tool input with optional substitution expressions */
  input: z.record(z.string(), z.unknown()).optional(),
  ...hookHandlerCommonFields,
});

/**
 * Schema for prompt hook handlers — single-turn LLM evaluation
 */
export const promptHookHandlerSchema = z.object({
  type: z.literal('prompt'),
  /** Prompt text sent to the model. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: z.string().min(1),
  /** Model to use for evaluation. Defaults to a fast model */
  model: z.string().optional(),
  ...hookHandlerCommonFields,
});

/**
 * Schema for agent hook handlers — spawn a subagent with tool access
 */
export const agentHookHandlerSchema = z.object({
  type: z.literal('agent'),
  /** Prompt text sent to the agent. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: z.string().min(1),
  /** Model to use for the agent. Defaults to a fast model */
  model: z.string().optional(),
  ...hookHandlerCommonFields,
});

/**
 * Union schema for hook handlers, discriminated on the `type` field
 */
export const hookHandlerSchema = z.discriminatedUnion('type', [
  commandHookHandlerSchema,
  httpHookHandlerSchema,
  mcpToolHookHandlerSchema,
  promptHookHandlerSchema,
  agentHookHandlerSchema,
]);

/**
 * Schema for a matcher group — a matcher pattern plus the handlers to run
 */
export const matcherGroupSchema = z.object({
  /** Regex pattern to filter when hooks fire. Omit or use "*" / "" to match all */
  matcher: z.string().optional(),
  /** Array of hook handlers to execute when the matcher matches */
  hooks: z.array(hookHandlerSchema).min(1),
});

/**
 * All supported hook event names as a Zod enum
 */
export const hookEventNameSchema = z.enum([
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
]);

/**
 * Schema for the hooks map — partial record where each key is a hook event name.
 * Uses z.object with all keys optional instead of z.record to allow partial configs.
 */
const hookEventEntries = Object.fromEntries(
  hookEventNameSchema.options.map((name: string) => [
    name,
    z.array(matcherGroupSchema).optional(),
  ])
);

export const hooksConfigSchema = z.object({
  hooks: z.object(hookEventEntries).optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  allowedHttpHookUrls: z.array(z.string()).optional(),
  httpHookAllowedEnvVars: z.array(z.string()).optional(),
});

export const rawTranscriptPayloadMetadataSchema = z.looseObject({
  type: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
});

export const transcriptToolResultContentItemSchema = z.looseObject({
  type: z.string().min(1),
  text: z.string().optional(),
});

export const textContentBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

export const toolUseContentBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export const toolResultContentBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(transcriptToolResultContentItemSchema),
  ]),
  is_error: z.boolean().optional(),
});

export const thinkingContentBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
});

export const imageContentBlockSchema = z.looseObject({
  type: z.literal('image'),
  source: z.unknown().optional(),
});

export const contentBlockSchema = z.discriminatedUnion('type', [
  textContentBlockSchema,
  toolUseContentBlockSchema,
  toolResultContentBlockSchema,
  thinkingContentBlockSchema,
  imageContentBlockSchema,
]);

const rawMessageFields = {
  id: z.string().optional(),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.record(z.string(), z.number()).optional(),
};

export const rawUserMessageSchema = z.looseObject({
  role: z.literal('user'),
  ...rawMessageFields,
});

export const rawAssistantMessageSchema = z.looseObject({
  role: z.literal('assistant'),
  ...rawMessageFields,
});

export const rawMessageSchema = z.discriminatedUnion('role', [
  rawUserMessageSchema,
  rawAssistantMessageSchema,
]);

const rawHistoryLineBaseFields = {
  sessionId: z.string().min(1),
  timestamp: z.string().min(1),
  uuid: z.string().min(1),
  parentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  userType: z.string().optional(),
  cwd: z.string().optional(),
  version: z.string().optional(),
  requestId: z.string().optional(),
};

export const rawUserHistoryLineSchema = z.looseObject({
  type: z.literal('user'),
  message: rawUserMessageSchema,
  ...rawHistoryLineBaseFields,
});

export const rawAssistantHistoryLineSchema = z.looseObject({
  type: z.literal('assistant'),
  message: rawAssistantMessageSchema,
  ...rawHistoryLineBaseFields,
});

export const rawSystemHistoryLineSchema = z.looseObject({
  type: z.literal('system'),
  message: rawMessageSchema.optional(),
  ...rawHistoryLineBaseFields,
});

export const rawResultHistoryLineSchema = z.looseObject({
  type: z.literal('result'),
  message: rawMessageSchema.optional(),
  costUSD: z.number().optional(),
  duration: z.number().optional(),
  isError: z.boolean().optional(),
  result: z.string().optional(),
  subagentId: z.string().optional(),
  ...rawHistoryLineBaseFields,
});

export const rawProgressHistoryLineSchema = z.looseObject({
  type: z.literal('progress'),
  message: rawMessageSchema.optional(),
  ...rawHistoryLineBaseFields,
});

export const rawFileHistorySnapshotLineSchema = z.looseObject({
  type: z.literal('file-history-snapshot'),
  message: rawMessageSchema.optional(),
  ...rawHistoryLineBaseFields,
});

export const rawHistoryLineSchema = z.discriminatedUnion('type', [
  rawUserHistoryLineSchema,
  rawAssistantHistoryLineSchema,
  rawSystemHistoryLineSchema,
  rawResultHistoryLineSchema,
  rawProgressHistoryLineSchema,
  rawFileHistorySnapshotLineSchema,
]);

export const transcriptParseIssueSchema = z.looseObject({
  code: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1),
});

export const transcriptParseDiagnosticsSchema = z.looseObject({
  summary: z.string().min(1),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(transcriptParseIssueSchema),
});

// Base types
export type BaseHookInputSchema = z.infer<typeof baseHookInputSchema>;
export type BaseHookOutputSchema = z.infer<typeof baseHookOutputSchema>;

// Hook event types
export type PreToolUseInputSchema = z.infer<typeof preToolUseInputSchema>;
export type PostToolUseInputSchema = z.infer<typeof postToolUseInputSchema>;
export type SetupInputSchema = z.infer<typeof setupInputSchema>;
export type UserPromptSubmitInputSchema = z.infer<
  typeof userPromptSubmitInputSchema
>;
export type UserPromptExpansionInputSchema = z.infer<
  typeof userPromptExpansionInputSchema
>;
export type SessionStartInputSchema = z.infer<typeof sessionStartInputSchema>;
export type SessionEndInputSchema = z.infer<typeof sessionEndInputSchema>;
export type NotificationInputSchema = z.infer<typeof notificationInputSchema>;
export type MessageDisplayInputSchema = z.infer<
  typeof messageDisplayInputSchema
>;
export type StopInputSchema = z.infer<typeof stopInputSchema>;
export type StopFailureInputSchema = z.infer<typeof stopFailureInputSchema>;
export type SubagentStopInputSchema = z.infer<typeof subagentStopInputSchema>;
export type PreCompactInputSchema = z.infer<typeof preCompactInputSchema>;
export type PostCompactInputSchema = z.infer<typeof postCompactInputSchema>;
export type PermissionRequestInputSchema = z.infer<
  typeof permissionRequestInputSchema
>;
export type PermissionDeniedInputSchema = z.infer<
  typeof permissionDeniedInputSchema
>;
export type PostToolUseFailureInputSchema = z.infer<
  typeof postToolUseFailureInputSchema
>;
export type PostToolBatchInputSchema = z.infer<typeof postToolBatchInputSchema>;
export type SubagentStartInputSchema = z.infer<typeof subagentStartInputSchema>;
export type TeammateIdleInputSchema = z.infer<typeof teammateIdleInputSchema>;
export type TaskCreatedInputSchema = z.infer<typeof taskCreatedInputSchema>;
export type TaskCompletedInputSchema = z.infer<typeof taskCompletedInputSchema>;
export type InstructionsLoadedInputSchema = z.infer<
  typeof instructionsLoadedInputSchema
>;
export type ConfigChangeInputSchema = z.infer<typeof configChangeInputSchema>;
export type CwdChangedInputSchema = z.infer<typeof cwdChangedInputSchema>;
export type FileChangedInputSchema = z.infer<typeof fileChangedInputSchema>;
export type WorktreeCreateInputSchema = z.infer<
  typeof worktreeCreateInputSchema
>;
export type WorktreeRemoveInputSchema = z.infer<
  typeof worktreeRemoveInputSchema
>;
export type ElicitationInputSchema = z.infer<typeof elicitationInputSchema>;
export type ElicitationResultInputSchema = z.infer<
  typeof elicitationResultInputSchema
>;

// Hook output types
export type PreToolUseOutputSchema = z.infer<typeof preToolUseOutputSchema>;
export type PostToolUseOutputSchema = z.infer<typeof postToolUseOutputSchema>;
export type SetupOutputSchema = z.infer<typeof setupOutputSchema>;
export type UserPromptSubmitOutputSchema = z.infer<
  typeof userPromptSubmitOutputSchema
>;
export type UserPromptExpansionOutputSchema = z.infer<
  typeof userPromptExpansionOutputSchema
>;
export type StopOutputSchema = z.infer<typeof stopOutputSchema>;
export type SessionStartOutputSchema = z.infer<typeof sessionStartOutputSchema>;
export type NotificationOutputSchema = z.infer<typeof notificationOutputSchema>;
export type MessageDisplayOutputSchema = z.infer<
  typeof messageDisplayOutputSchema
>;
export type PermissionRequestOutputSchema = z.infer<
  typeof permissionRequestOutputSchema
>;
export type PermissionDeniedOutputSchema = z.infer<
  typeof permissionDeniedOutputSchema
>;
export type PostToolUseFailureOutputSchema = z.infer<
  typeof postToolUseFailureOutputSchema
>;
export type PostToolBatchOutputSchema = z.infer<
  typeof postToolBatchOutputSchema
>;
export type SubagentStartOutputSchema = z.infer<
  typeof subagentStartOutputSchema
>;
export type PreCompactOutputSchema = z.infer<typeof preCompactOutputSchema>;
export type ConfigChangeOutputSchema = z.infer<typeof configChangeOutputSchema>;
export type WatchPathsOutputSchema = z.infer<typeof watchPathsOutputSchema>;
export type WorktreeCreateOutputSchema = z.infer<
  typeof worktreeCreateOutputSchema
>;
export type ElicitationOutputSchema = z.infer<typeof elicitationOutputSchema>;
export type ElicitationResultOutputSchema = z.infer<
  typeof elicitationResultOutputSchema
>;

// Tool input types
export type BashToolInputSchema = z.infer<typeof bashToolInputSchema>;
export type WriteToolInputSchema = z.infer<typeof writeToolInputSchema>;
export type EditToolInputSchema = z.infer<typeof editToolInputSchema>;
export type ReadToolInputSchema = z.infer<typeof readToolInputSchema>;
export type GlobToolInputSchema = z.infer<typeof globToolInputSchema>;
export type GrepToolInputSchema = z.infer<typeof grepToolInputSchema>;
export type MultiEditToolInputSchema = z.infer<typeof multiEditToolInputSchema>;
export type WebFetchToolInputSchema = z.infer<typeof webFetchToolInputSchema>;
export type WebSearchToolInputSchema = z.infer<typeof webSearchToolInputSchema>;
export type AgentToolInputSchema = z.infer<typeof agentToolInputSchema>;
export type AskUserQuestionToolInputSchema = z.infer<
  typeof askUserQuestionToolInputSchema
>;
export type ExitPlanModeToolInputSchema = z.infer<
  typeof exitPlanModeToolInputSchema
>;
export type TodoWriteToolInputSchema = z.infer<typeof todoWriteToolInputSchema>;
export type MCPToolInputSchema = z.infer<typeof mcpToolInputSchema>;
export type TaskToolInputSchema = z.infer<typeof taskToolInputSchema>;

// Transcript parsing types
export type RawTranscriptPayloadMetadataSchema = z.infer<
  typeof rawTranscriptPayloadMetadataSchema
>;
export type TranscriptToolResultContentItemSchema = z.infer<
  typeof transcriptToolResultContentItemSchema
>;
export type TextContentBlockSchema = z.infer<typeof textContentBlockSchema>;
export type ToolUseContentBlockSchema = z.infer<
  typeof toolUseContentBlockSchema
>;
export type ToolResultContentBlockSchema = z.infer<
  typeof toolResultContentBlockSchema
>;
export type ThinkingContentBlockSchema = z.infer<
  typeof thinkingContentBlockSchema
>;
export type ImageContentBlockSchema = z.infer<typeof imageContentBlockSchema>;
export type ContentBlockSchema = z.infer<typeof contentBlockSchema>;
export type RawUserMessageSchema = z.infer<typeof rawUserMessageSchema>;
export type RawAssistantMessageSchema = z.infer<
  typeof rawAssistantMessageSchema
>;
export type RawMessageSchema = z.infer<typeof rawMessageSchema>;
export type RawUserHistoryLineSchema = z.infer<typeof rawUserHistoryLineSchema>;
export type RawAssistantHistoryLineSchema = z.infer<
  typeof rawAssistantHistoryLineSchema
>;
export type RawSystemHistoryLineSchema = z.infer<
  typeof rawSystemHistoryLineSchema
>;
export type RawResultHistoryLineSchema = z.infer<
  typeof rawResultHistoryLineSchema
>;
export type RawProgressHistoryLineSchema = z.infer<
  typeof rawProgressHistoryLineSchema
>;
export type RawFileHistorySnapshotLineSchema = z.infer<
  typeof rawFileHistorySnapshotLineSchema
>;
export type RawHistoryLineSchema = z.infer<typeof rawHistoryLineSchema>;
export type TranscriptParseIssueSchema = z.infer<
  typeof transcriptParseIssueSchema
>;
export type TranscriptParseDiagnosticsSchema = z.infer<
  typeof transcriptParseDiagnosticsSchema
>;

// Union types
export type HookInputSchema =
  | PreToolUseInputSchema
  | PostToolUseInputSchema
  | SetupInputSchema
  | PermissionRequestInputSchema
  | PermissionDeniedInputSchema
  | PostToolUseFailureInputSchema
  | PostToolBatchInputSchema
  | UserPromptSubmitInputSchema
  | UserPromptExpansionInputSchema
  | SessionStartInputSchema
  | SessionEndInputSchema
  | NotificationInputSchema
  | MessageDisplayInputSchema
  | StopInputSchema
  | StopFailureInputSchema
  | SubagentStartInputSchema
  | SubagentStopInputSchema
  | TeammateIdleInputSchema
  | TaskCreatedInputSchema
  | TaskCompletedInputSchema
  | InstructionsLoadedInputSchema
  | ConfigChangeInputSchema
  | CwdChangedInputSchema
  | FileChangedInputSchema
  | WorktreeCreateInputSchema
  | WorktreeRemoveInputSchema
  | PreCompactInputSchema
  | PostCompactInputSchema
  | ElicitationInputSchema
  | ElicitationResultInputSchema;

export type ToolInputSchema =
  | BashToolInputSchema
  | WriteToolInputSchema
  | EditToolInputSchema
  | ReadToolInputSchema
  | GlobToolInputSchema
  | GrepToolInputSchema
  | MultiEditToolInputSchema
  | WebFetchToolInputSchema
  | WebSearchToolInputSchema
  | AgentToolInputSchema
  | AskUserQuestionToolInputSchema
  | ExitPlanModeToolInputSchema
  | TodoWriteToolInputSchema
  | MCPToolInputSchema
  | TaskToolInputSchema;

// Hook configuration types (settings.json)
export type CommandHookHandlerSchema = z.infer<typeof commandHookHandlerSchema>;
export type HttpHookHandlerSchema = z.infer<typeof httpHookHandlerSchema>;
export type McpToolHookHandlerSchema = z.infer<typeof mcpToolHookHandlerSchema>;
export type PromptHookHandlerSchema = z.infer<typeof promptHookHandlerSchema>;
export type AgentHookHandlerSchema = z.infer<typeof agentHookHandlerSchema>;
export type HookHandlerSchema = z.infer<typeof hookHandlerSchema>;
export type MatcherGroupSchema = z.infer<typeof matcherGroupSchema>;
export type HookEventNameSchema = z.infer<typeof hookEventNameSchema>;
export type HooksConfigSchema = z.infer<typeof hooksConfigSchema>;
