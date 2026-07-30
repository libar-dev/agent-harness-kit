/**
 * Type contracts for Claude Code hook inputs, outputs, tool inputs, and settings.
 * These declarations mirror the JSON read from stdin and written to stdout by hook handlers.
 */

/** Common fields present in all hook inputs. */
export interface BaseHookInput {
  /** Unique identifier for the current Claude Code session */
  session_id: string;
  /** Absolute path to the conversation transcript JSON file */
  transcript_path: string;
  /** Current working directory when the hook is invoked */
  cwd: string;
  /** The specific hook event that triggered this execution */
  hook_event_name: string;
  /** UUID identifying the user prompt currently being processed */
  prompt_id?: string | undefined;
  /** Current permission mode */
  permission_mode?: PermissionMode | undefined;
  /** Unique identifier for a subagent context, when present */
  agent_id?: string | undefined;
  /** Agent name when running under --agent or inside a subagent */
  agent_type?: string | undefined;
  /** Effort metadata for the current turn, when provided by Claude Code */
  effort?:
    | {
        level: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      }
    | undefined;
}

/**
 * Permission modes recognised by the harness. Shared between `permission_mode`
 * input fields and `setMode` permission updates.
 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/**
 * Common output fields that all hooks can return via JSON
 */
export interface BaseHookOutput {
  /** Whether Claude should continue after hook execution (default: true) */
  continue?: boolean | undefined;
  /** Message shown to user when continue is false */
  stopReason?: string | undefined;
  /** Hide stdout from transcript mode (default: false) */
  suppressOutput?: boolean | undefined;
  /** Optional warning message shown to the user */
  systemMessage?: string | undefined;
  /** ANSI escape sequences or similar terminal control output */
  terminalSequence?: string | undefined;
}

/**
 * Input for PreToolUse hooks - runs before tool execution
 */
export interface PreToolUseInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  /** Name of the tool about to be executed */
  tool_name: string;
  /** Parameters passed to the tool. */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool use */
  tool_use_id: string;
}

/**
 * Input for PostToolUse hooks - runs after successful tool execution
 */
export interface PostToolUseInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  /** Name of the tool that was executed */
  tool_name: string;
  /** Parameters that were passed to the tool */
  tool_input: Record<string, unknown>;
  /** Response/output from the tool execution */
  tool_response: Record<string, unknown>;
  /** Unique identifier for this tool use */
  tool_use_id: string;
  /** Tool execution duration in milliseconds */
  duration_ms?: number | undefined;
}

/**
 * PreToolUse-specific output for permission control
 */
export interface PreToolUseOutput extends BaseHookOutput {
  /** Controls whether the tool call proceeds */
  decision?: 'approve' | 'block'; // Deprecated: use hookSpecificOutput instead
  /** Reason for the decision */
  reason?: string; // Deprecated: use hookSpecificOutput instead
  /** Structured hook-specific output. */
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    /** Permission decision: allow bypasses permission system, deny blocks, ask prompts user */
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer';
    /** Reason shown to user (allow/ask) or Claude (deny) */
    permissionDecisionReason: string;
    /** Modifies the tool's input parameters before execution */
    updatedInput?: Record<string, unknown>;
    /** String added to Claude's context before the tool executes */
    additionalContext?: string;
  };
}

/**
 * PostToolUse-specific output for feedback to Claude
 */
export interface PostToolUseOutput extends BaseHookOutput {
  /** Provide feedback to Claude after tool execution */
  decision?: 'block';
  /** Explanation for the decision - shown to Claude if decision is 'block' */
  reason?: string;
  /** Additional context for Claude */
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    /** Additional information for Claude to consider */
    additionalContext?: string;
    /** For MCP tools only: replaces the tool's output with the provided value */
    updatedMCPToolOutput?: unknown;
    /** Replaces the tool output with the provided value */
    updatedToolOutput?: unknown;
  };
}

/**
 * Input for PermissionRequest hooks - runs when a permission dialog appears
 * Unlike PreToolUse, does NOT include tool_use_id
 */
export interface PermissionRequestInput extends BaseHookInput {
  hook_event_name: 'PermissionRequest';
  /** Name of the tool requesting permission */
  tool_name: string;
  /** Parameters for the tool requesting permission */
  tool_input: Record<string, unknown>;
  /** "Always allow" options the user would normally see in the permission dialog */
  permission_suggestions?: PermissionUpdateEntry[] | undefined;
}

/**
 * PermissionRequest-specific output for allow/deny decisions
 */
export interface PermissionRequestOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionRequest';
    decision:
      | {
          behavior: 'allow';
          /** Modifies the tool's input parameters before execution */
          updatedInput?: Record<string, unknown>;
          /** Applies permission rule updates (equivalent to "always allow" selection) */
          updatedPermissions?: PermissionUpdateEntry[];
        }
      | {
          behavior: 'deny';
          /** Tells Claude why the permission was denied */
          message?: string;
          /** If true, stops Claude */
          interrupt?: boolean;
        };
  };
}

/**
 * Input for PostToolUseFailure hooks - runs when tool execution fails
 */
export interface PostToolUseFailureInput extends BaseHookInput {
  hook_event_name: 'PostToolUseFailure';
  /** Name of the tool that failed */
  tool_name: string;
  /** Parameters that were passed to the tool */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool use */
  tool_use_id: string;
  /** String describing what went wrong */
  error: string;
  /** Whether the failure was caused by user interruption */
  is_interrupt?: boolean | undefined;
  /** Tool execution duration in milliseconds */
  duration_ms?: number | undefined;
}

/**
 * PostToolUseFailure-specific output for providing context after failure
 */
export interface PostToolUseFailureOutput extends BaseHookOutput {
  /** Block to provide feedback to Claude */
  decision?: 'block';
  /** Explanation shown to Claude */
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUseFailure';
    /** Additional context for Claude to consider alongside the error */
    additionalContext?: string;
  };
}

/** Settings destination for a permission update. */
export type PermissionUpdateDestination =
  | 'session'
  | 'localSettings'
  | 'projectSettings'
  | 'userSettings';

/** Behavior applied by a permission rule update. */
export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask';

/** Tool permission rule used by rule-based permission updates. */
export interface PermissionRule {
  /** Tool name to match */
  toolName: string;
  /** Optional rule content; omit to match the whole tool */
  ruleContent?: string | undefined;
}

/** Permission mode accepted by `setMode` updates, including the manual alias. */
export type PermissionUpdateMode = PermissionMode | 'manual';

/** Add permission rules at a settings destination. */
export interface AddPermissionRulesUpdate {
  type: 'addRules';
  rules: PermissionRule[];
  behavior: PermissionRuleBehavior;
  destination: PermissionUpdateDestination;
}

/** Replace permission rules at a settings destination. */
export interface ReplacePermissionRulesUpdate {
  type: 'replaceRules';
  rules: PermissionRule[];
  behavior: PermissionRuleBehavior;
  destination: PermissionUpdateDestination;
}

/** Remove permission rules from a settings destination. */
export interface RemovePermissionRulesUpdate {
  type: 'removeRules';
  rules: PermissionRule[];
  behavior: PermissionRuleBehavior;
  destination: PermissionUpdateDestination;
}

/** Change the active permission mode at a settings destination. */
export interface SetPermissionModeUpdate {
  type: 'setMode';
  mode: PermissionUpdateMode;
  destination: PermissionUpdateDestination;
}

/** Add working directories at a settings destination. */
export interface AddPermissionDirectoriesUpdate {
  type: 'addDirectories';
  directories: string[];
  destination: PermissionUpdateDestination;
}

/** Remove working directories from a settings destination. */
export interface RemovePermissionDirectoriesUpdate {
  type: 'removeDirectories';
  directories: string[];
  destination: PermissionUpdateDestination;
}

/** Documented permission update entries used by PermissionRequest input/output. */
export type PermissionUpdateEntry =
  | AddPermissionRulesUpdate
  | ReplacePermissionRulesUpdate
  | RemovePermissionRulesUpdate
  | SetPermissionModeUpdate
  | AddPermissionDirectoriesUpdate
  | RemovePermissionDirectoriesUpdate;

/**
 * Input for PermissionDenied hooks - runs when auto mode denies a tool call
 */
export interface PermissionDeniedInput extends BaseHookInput {
  hook_event_name: 'PermissionDenied';
  /** Name of the tool that was denied */
  tool_name: string;
  /** Parameters that would have been passed to the tool */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool use */
  tool_use_id: string;
  /** Auto mode classifier explanation */
  reason: string;
}

/**
 * PermissionDenied-specific output for retry control
 */
export interface PermissionDeniedOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionDenied';
    /** Whether Claude may retry the denied tool call */
    retry: boolean;
  };
}

/**
 * A single tool call result in a PostToolBatch hook
 */
export interface PostToolBatchCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response: string | Array<Record<string, unknown>>;
}

/**
 * Input for PostToolBatch hooks - runs after a batch of tool calls resolves
 */
export interface PostToolBatchInput extends BaseHookInput {
  hook_event_name: 'PostToolBatch';
  /** Every tool call result in the resolved batch */
  tool_calls: PostToolBatchCall[];
}

/**
 * PostToolBatch-specific output for next-turn context injection
 */
export interface PostToolBatchOutput extends BaseHookOutput {
  /** Block the agentic loop before the next model call */
  decision?: 'block';
  /** Explanation shown to Claude when blocked */
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PostToolBatch';
    /** String injected before the next model call */
    additionalContext?: string;
  };
}

/**
 * Input for SubagentStart hooks - runs when a subagent is spawned
 */
export interface SubagentStartInput extends BaseHookInput {
  hook_event_name: 'SubagentStart';
  /** Unique identifier for the subagent */
  agent_id: string;
  /** Agent type name — used for matcher filtering */
  agent_type: string;
}

/**
 * SubagentStart-specific output for context injection
 */
export interface SubagentStartOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SubagentStart';
    /** String added to the subagent's context */
    additionalContext?: string;
  };
}

/**
 * Input for TeammateIdle hooks - runs when a teammate is about to go idle
 * Decision control: exit code only (no JSON decision control)
 */
export interface TeammateIdleInput extends BaseHookInput {
  hook_event_name: 'TeammateIdle';
  /** Name of the teammate that is about to go idle */
  teammate_name: string;
  /** Name of the team */
  team_name: string;
}

/**
 * Input for TaskCreated hooks - runs when a task is being created
 */
export interface TaskCreatedInput extends BaseHookInput {
  hook_event_name: 'TaskCreated';
  /** Identifier of the task being created */
  task_id: string;
  /** Title of the task */
  task_subject: string;
  /** Detailed description of the task */
  task_description?: string | undefined;
  /** Name of the teammate creating the task */
  teammate_name?: string | undefined;
  /** Name of the team */
  team_name?: string | undefined;
}

/**
 * Input for TaskCompleted hooks - runs when a task is being marked as completed
 * Decision control: exit code only (no JSON decision control)
 */
export interface TaskCompletedInput extends BaseHookInput {
  hook_event_name: 'TaskCompleted';
  /** Identifier of the task being completed */
  task_id: string;
  /** Title of the task */
  task_subject: string;
  /** Detailed description of the task */
  task_description?: string | undefined;
  /** Name of the teammate completing the task */
  teammate_name?: string | undefined;
  /** Name of the team */
  team_name?: string | undefined;
}

/**
 * Input for UserPromptSubmit hooks - runs when user submits a prompt
 */
export interface UserPromptSubmitInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit';
  /** The prompt text submitted by the user */
  prompt: string;
}

/**
 * UserPromptSubmit-specific output for prompt control
 */
export interface UserPromptSubmitOutput extends BaseHookOutput {
  /** Block prompt processing - erases prompt from context */
  decision?: 'block';
  /** Reason shown to user (not added to context) */
  reason?: string;
  /**
   * When `decision` is `"block"` and this is `true`, omits the original prompt
   * text from the block message shown to the user.
   */
  suppressOriginalPrompt?: boolean;
  /** Add context if not blocked */
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    /** String added to context for Claude */
    additionalContext?: string;
    /** Sets the session title */
    sessionTitle?: string;
  };
}

/**
 * Input for UserPromptExpansion hooks - runs before a slash/MCP prompt expands
 */
export interface UserPromptExpansionInput extends BaseHookInput {
  hook_event_name: 'UserPromptExpansion';
  /** Prompt expansion source type */
  expansion_type: 'slash_command' | 'mcp_prompt';
  /** Command or MCP prompt name */
  command_name: string;
  /** Raw arguments supplied to the command */
  command_args: string;
  /** Source that provided the command */
  command_source: string;
  /** Original user prompt */
  prompt: string;
}

/**
 * UserPromptExpansion-specific output for expansion control
 */
export interface UserPromptExpansionOutput extends BaseHookOutput {
  /** Block prompt expansion */
  decision?: 'block';
  /** Reason shown to the user when blocked */
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'UserPromptExpansion';
    /** String added to Claude's context alongside the expanded prompt */
    additionalContext?: string;
  };
}

/**
 * Input for Notification hooks - runs when Claude Code sends notifications
 */
export interface NotificationInput extends BaseHookInput {
  hook_event_name: 'Notification';
  /** The notification message being sent */
  message: string;
  /** Optional notification title */
  title?: string | undefined;
  /** Type of notification — used for matcher filtering */
  notification_type:
    | 'permission_prompt'
    | 'idle_prompt'
    | 'auth_success'
    | 'elicitation_dialog'
    | 'elicitation_complete'
    | 'elicitation_response'
    | 'agent_needs_input'
    | 'agent_completed';
}

/**
 * Input for MessageDisplay hooks - runs while assistant text is streaming
 */
export interface MessageDisplayInput extends BaseHookInput {
  hook_event_name: 'MessageDisplay';
  /** Unique identifier for the current turn */
  turn_id: string;
  /** Unique identifier for the message being displayed */
  message_id: string;
  /** Zero-based chunk index for this display delta */
  index: number;
  /** Whether this is the final chunk */
  final: boolean;
  /** Delta text being displayed */
  delta: string;
}

/**
 * MessageDisplay-specific output for overriding rendered content
 */
export interface MessageDisplayOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'MessageDisplay';
    /** Optional replacement content for display */
    displayContent?: string;
  };
}

/** Notification hooks return only universal hook output fields. */
export type NotificationOutput = BaseHookOutput;

/** In-flight background task reported to Stop and SubagentStop hooks. */
export interface BackgroundTaskEntry {
  /** Task identifier */
  id: string;
  /** Friendly task-type label */
  type: string;
  /** Current task status */
  status: string;
  /** Free-text task description */
  description: string;
  /** Shell command for shell tasks */
  command?: string | undefined;
  /** Subagent type for subagent tasks */
  agent_type?: string | undefined;
  /** MCP server for monitor and MCP tasks */
  server?: string | undefined;
  /** MCP tool for monitor and MCP tasks */
  tool?: string | undefined;
  /** Workflow name for workflow tasks */
  name?: string | undefined;
  /** Additional task metadata supplied by future Claude Code versions */
  [key: string]: unknown;
}

/** Session-scoped scheduled wakeup reported to Stop and SubagentStop hooks. */
export interface SessionCronEntry {
  /** Cron task identifier */
  id: string;
  /** Cron expression */
  schedule: string;
  /** Whether the cron fires on every match */
  recurring: boolean;
  /** Prompt submitted when the cron fires */
  prompt: string;
  /** Additional cron metadata supplied by future Claude Code versions */
  [key: string]: unknown;
}

/**
 * Input for Stop hooks - runs when Claude Code finishes responding
 */
export interface StopInput extends BaseHookInput {
  hook_event_name: 'Stop';
  /** True when Claude Code is already continuing as a result of a stop hook */
  stop_hook_active: boolean;
  /** Text content of Claude's final response */
  last_assistant_message?: string | undefined;
  /** In-flight tasks registered for the session */
  background_tasks?: BackgroundTaskEntry[] | undefined;
  /** Session-scoped scheduled wakeups */
  session_crons?: SessionCronEntry[] | undefined;
}

/**
 * Input for SubagentStop hooks - runs when subagent tasks complete
 */
export interface SubagentStopInput extends BaseHookInput {
  hook_event_name: 'SubagentStop';
  /** True when Claude Code is already continuing as a result of a stop hook */
  stop_hook_active: boolean;
  /** Unique identifier for the subagent */
  agent_id: string;
  /** Agent type name — used for matcher filtering */
  agent_type: string;
  /** Path to the subagent's own transcript */
  agent_transcript_path: string;
  /** Text content of the subagent's final response */
  last_assistant_message?: string | undefined;
  /** Parent-session in-flight tasks */
  background_tasks?: BackgroundTaskEntry[] | undefined;
  /** Parent-session scheduled wakeups */
  session_crons?: SessionCronEntry[] | undefined;
}

/** Universal output accepted by Stop hooks. */
export type StopUniversalOutput = BaseHookOutput & {
  decision?: never;
  reason?: never;
  hookSpecificOutput?: never;
};

/** Blocking Stop output that keeps the main session running. */
export type StopBlockOutput = BaseHookOutput & {
  decision: 'block';
  reason: string;
  hookSpecificOutput?: never;
};

/** Non-error Stop feedback that keeps the main session running. */
export type StopContextOutput = BaseHookOutput & {
  decision?: never;
  reason?: never;
  hookSpecificOutput: {
    hookEventName: 'Stop';
    additionalContext: string;
  };
};

/** Event-safe output union for Stop hooks. */
export type StopOutput =
  | StopUniversalOutput
  | StopBlockOutput
  | StopContextOutput;

/** Universal output accepted by SubagentStop hooks. */
export type SubagentStopUniversalOutput = BaseHookOutput & {
  decision?: never;
  reason?: never;
  hookSpecificOutput?: never;
};

/** Blocking SubagentStop output that keeps the subagent running. */
export type SubagentStopBlockOutput = BaseHookOutput & {
  decision: 'block';
  reason: string;
  hookSpecificOutput?: never;
};

/** Non-error SubagentStop feedback that keeps the subagent running. */
export type SubagentStopContextOutput = BaseHookOutput & {
  decision?: never;
  reason?: never;
  hookSpecificOutput: {
    hookEventName: 'SubagentStop';
    additionalContext: string;
  };
};

/** Event-safe output union for SubagentStop hooks. */
export type SubagentStopOutput =
  | SubagentStopUniversalOutput
  | SubagentStopBlockOutput
  | SubagentStopContextOutput;

/**
 * Input for PreCompact hooks - runs before compact operations
 */
export interface PreCompactInput extends BaseHookInput {
  hook_event_name: 'PreCompact';
  /** What triggered the compact: 'manual' (from /compact) or 'auto' (full context) */
  trigger: 'manual' | 'auto';
  /** Custom instructions from user (manual) or empty (auto) */
  custom_instructions: string;
}

/**
 * PreCompact-specific output for compaction control
 */
export type PreCompactOutput =
  | (BaseHookOutput & {
      decision?: never;
      reason?: never;
    })
  | (BaseHookOutput & {
      /** Block compaction */
      decision: 'block';
      /** Explanation shown when compaction is blocked */
      reason: string;
    });

/**
 * Input for SessionStart hooks - runs when Claude Code session starts
 */
export interface SessionStartInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  /** How the session was started: 'startup', 'resume', 'clear', 'compact' */
  source: 'startup' | 'resume' | 'clear' | 'compact';
  /** The model identifier */
  model?: string | undefined;
  /** Session title when one is already known */
  session_title?: string | undefined;
  /** Agent name if started with --agent */
  agent_type?: string | undefined;
}

/**
 * SessionStart-specific output for context injection
 */
export interface SessionStartOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    /** String added to the context at session start */
    additionalContext?: string;
    /** Initial user-visible message to seed the session */
    initialUserMessage?: string;
    /** Sets the session title */
    sessionTitle?: string;
    /** Dynamic absolute paths to watch */
    watchPaths?: string[];
    /** Reload active skills after session setup */
    reloadSkills?: boolean;
  };
}

/**
 * Input for Setup hooks - runs during init-only or maintenance mode
 */
export interface SetupInput extends BaseHookInput {
  hook_event_name: 'Setup';
  /** How setup was triggered */
  trigger: 'init' | 'maintenance';
}

/**
 * Setup-specific output for context injection
 */
export interface SetupOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Setup';
    /** String added to setup context */
    additionalContext?: string;
  };
}

/**
 * Input for SessionEnd hooks - runs when Claude Code session ends
 */
export interface SessionEndInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
  /** Why the session ended */
  reason:
    | 'clear'
    | 'resume'
    | 'logout'
    | 'prompt_input_exit'
    | 'bypass_permissions_disabled'
    | 'other';
}

/**
 * Input for StopFailure hooks - runs when a turn ends due to an API error
 */
export interface StopFailureInput extends BaseHookInput {
  hook_event_name: 'StopFailure';
  /** API error type */
  error:
    | 'rate_limit'
    | 'overloaded'
    | 'authentication_failed'
    | 'oauth_org_not_allowed'
    | 'billing_error'
    | 'invalid_request'
    | 'model_not_found'
    | 'server_error'
    | 'max_output_tokens'
    | 'unknown';
  /** Additional error details */
  error_details?: string | undefined;
  /** Rendered error text shown in the conversation */
  last_assistant_message?: string | undefined;
}

/**
 * Input for InstructionsLoaded hooks
 */
export interface InstructionsLoadedInput extends BaseHookInput {
  hook_event_name: 'InstructionsLoaded';
  /** Path to the loaded instruction file */
  file_path: string;
  /** Type of loaded memory/instructions */
  memory_type: 'User' | 'Project' | 'Local' | 'Managed';
  /** Why instructions were loaded */
  load_reason:
    | 'session_start'
    | 'nested_traversal'
    | 'path_glob_match'
    | 'include'
    | 'compact';
  /** Globs that caused loading, when applicable */
  globs?: string[] | undefined;
  /** File that triggered the load, when applicable */
  trigger_file_path?: string | undefined;
  /** Parent instruction file for includes, when applicable */
  parent_file_path?: string | undefined;
}

/**
 * Input for ConfigChange hooks
 */
export interface ConfigChangeInput extends BaseHookInput {
  hook_event_name: 'ConfigChange';
  /** Source of the configuration change */
  source:
    | 'user_settings'
    | 'project_settings'
    | 'local_settings'
    | 'policy_settings'
    | 'skills';
  /** Path to the changed file */
  file_path?: string | undefined;
}

/**
 * ConfigChange-specific output for blocking config changes
 */
export interface ConfigChangeOutput extends BaseHookOutput {
  /** Block the configuration change */
  decision?: 'block';
  /** Explanation shown when blocked */
  reason?: string;
}

/**
 * Input for CwdChanged hooks
 */
export interface CwdChangedInput extends BaseHookInput {
  hook_event_name: 'CwdChanged';
  /** Previous working directory */
  old_cwd: string;
  /** Working directory after the change. */
  new_cwd: string;
}

/**
 * Input for FileChanged hooks
 */
export interface FileChangedInput extends BaseHookInput {
  hook_event_name: 'FileChanged';
  /** Absolute path to the changed file */
  file_path: string;
  /** File watcher event */
  event: 'change' | 'add' | 'unlink';
}

/**
 * Output for hooks that update watched paths
 */
export interface WatchPathsOutput extends BaseHookOutput {
  /** Dynamic absolute paths to watch */
  watchPaths?: string[];
}

/**
 * Input for WorktreeCreate hooks
 */
export interface WorktreeCreateInput extends BaseHookInput {
  hook_event_name: 'WorktreeCreate';
  /** Slug identifier for the worktree being created. */
  name: string;
}

/**
 * WorktreeCreate-specific output for HTTP hooks
 */
export interface WorktreeCreateOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'WorktreeCreate';
    /** Absolute path to the created worktree */
    worktreePath: string;
  };
}

/**
 * Input for WorktreeRemove hooks
 */
export interface WorktreeRemoveInput extends BaseHookInput {
  hook_event_name: 'WorktreeRemove';
  /** Absolute path to the worktree being removed */
  worktree_path: string;
}

/**
 * Input for PostCompact hooks
 */
export interface PostCompactInput extends BaseHookInput {
  hook_event_name: 'PostCompact';
  /** What triggered compaction */
  trigger: 'manual' | 'auto';
  /** Generated conversation summary */
  compact_summary: string;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationMode = 'form' | 'url';

/**
 * Input for Elicitation hooks
 */
export interface ElicitationInput extends BaseHookInput {
  hook_event_name: 'Elicitation';
  /** MCP server requesting input */
  mcp_server_name: string;
  /** Message shown to the user */
  message: string;
  /** Elicitation mode */
  mode?: ElicitationMode | undefined;
  /** Requested JSON schema for form mode */
  requested_schema?: Record<string, unknown> | undefined;
  /** Authentication URL for URL mode */
  url?: string | undefined;
  /** Unique elicitation identifier */
  elicitation_id?: string | undefined;
}

/**
 * Input for ElicitationResult hooks
 */
export interface ElicitationResultInput extends BaseHookInput {
  hook_event_name: 'ElicitationResult';
  /** MCP server that requested input */
  mcp_server_name: string;
  /** User's action */
  action: ElicitationAction;
  /** Response content */
  content?: Record<string, unknown> | undefined;
  /** Elicitation mode */
  mode?: ElicitationMode | undefined;
  /** Unique elicitation identifier */
  elicitation_id?: string | undefined;
}

/**
 * Elicitation output for programmatic response or override
 */
export interface ElicitationOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Elicitation' | 'ElicitationResult';
    /** Programmatic action */
    action: ElicitationAction;
    /** Form field values */
    content?: Record<string, unknown>;
  };
}

/**
 * Union of all possible hook input types
 */
export type HookInput =
  | SetupInput
  | PreToolUseInput
  | PostToolUseInput
  | PermissionRequestInput
  | PermissionDeniedInput
  | PostToolUseFailureInput
  | PostToolBatchInput
  | UserPromptSubmitInput
  | UserPromptExpansionInput
  | NotificationInput
  | MessageDisplayInput
  | StopInput
  | StopFailureInput
  | SubagentStartInput
  | SubagentStopInput
  | TeammateIdleInput
  | TaskCreatedInput
  | TaskCompletedInput
  | InstructionsLoadedInput
  | ConfigChangeInput
  | CwdChangedInput
  | FileChangedInput
  | WorktreeCreateInput
  | WorktreeRemoveInput
  | PreCompactInput
  | PostCompactInput
  | ElicitationInput
  | ElicitationResultInput
  | SessionStartInput
  | SessionEndInput;

/**
 * Union of all possible hook output types
 */
export type HookOutput =
  | SetupOutput
  | PreToolUseOutput
  | PostToolUseOutput
  | PermissionRequestOutput
  | PermissionDeniedOutput
  | PostToolUseFailureOutput
  | PostToolBatchOutput
  | SubagentStartOutput
  | MessageDisplayOutput
  | NotificationOutput
  | UserPromptSubmitOutput
  | UserPromptExpansionOutput
  | StopOutput
  | SubagentStopOutput
  | PreCompactOutput
  | SessionStartOutput
  | ConfigChangeOutput
  | WatchPathsOutput
  | WorktreeCreateOutput
  | ElicitationOutput
  | BaseHookOutput; // For hooks that don't have specific output requirements (TeammateIdle, TaskCompleted, etc.)

/**
 * Common tool input patterns for frequently used tools
 */
export interface BashToolInput {
  command: string;
  description?: string | undefined;
  timeout?: number | undefined;
  run_in_background?: boolean | undefined;
  dangerouslyDisableSandbox?: boolean | undefined;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}

export interface MultiEditToolInput {
  file_path: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean | undefined;
  }>;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  pages?: string | undefined;
}

export interface GrepToolInput {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  type?: string | undefined;
  output_mode?: 'content' | 'files_with_matches' | 'count' | undefined;
  multiline?: boolean | undefined;
  '-i'?: boolean | undefined; // case insensitive
  '-n'?: boolean | undefined; // show line numbers
  '-A'?: number | undefined; // lines after
  '-B'?: number | undefined; // lines before
  '-C'?: number | undefined; // lines before and after
}

export interface GlobToolInput {
  pattern: string;
  path?: string | undefined;
}

export interface WebFetchToolInput {
  url: string;
  prompt: string;
}

export interface WebSearchToolInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/** Input for the Agent tool. */
export interface AgentToolInput {
  /** Task for the agent to perform */
  prompt: string;
  /** Short description shown while the agent runs */
  description?: string | undefined;
  subagent_type?: string | undefined;
  model?: string | undefined;
  run_in_background?: boolean | undefined;
  isolation?: 'worktree' | 'remote' | undefined;
}

/** Selectable option shown by AskUserQuestion. */
export interface AskUserQuestionOption {
  label: string;
  description?: string | undefined;
  preview?: string | undefined;
}

/** One question presented by AskUserQuestion. */
export interface AskUserQuestionEntry {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean | undefined;
}

/** Input for the AskUserQuestion tool. */
export interface AskUserQuestionToolInput {
  questions: AskUserQuestionEntry[];
  answers?: Record<string, string> | undefined;
  annotations?:
    | Record<
        string,
        {
          preview?: string | undefined;
          notes?: string | undefined;
        }
      >
    | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** Deprecated prompt-based permission request accepted by ExitPlanMode. */
export interface ExitPlanModeAllowedPrompt {
  /** Tool the prompt permission applied to */
  tool: string;
  /** Prompt-based permission description */
  prompt: string;
}

/** Input for ExitPlanMode after Claude Code injects the saved plan. */
export interface ExitPlanModeToolInput {
  /** Plan content in Markdown */
  plan: string;
  /** Path to the plan file */
  planFilePath: string;
  /** Deprecated prompt-based permissions accepted but ignored by Claude Code */
  allowedPrompts?: ExitPlanModeAllowedPrompt[] | undefined;
}

export interface TodoWriteToolInput {
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
}

export type MCPToolInput = Record<string, unknown>;

/** Input for the compatibility Task tool. */
export interface TaskToolInput {
  prompt: string;
  description?: string | undefined;
  subagent_type?: string | undefined;
  model?: string | undefined;
  run_in_background?: boolean | undefined;
}

/**
 * All supported hook event names
 */
export type HookEventName =
  | 'SessionStart'
  | 'Setup'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'MessageDisplay'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Stop'
  | 'StopFailure'
  | 'TeammateIdle'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'CwdChanged'
  | 'FileChanged'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'PreCompact'
  | 'PostCompact'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'SessionEnd';

/**
 * Common fields shared by all hook handler types
 */
interface HookHandlerBase {
  /**
   * Seconds before canceling. Defaults: 600 for `command`, `http`, and
   * `mcp_tool`; 30 for `prompt`; 60 for `agent`. UserPromptSubmit lowers the
   * command/http/mcp_tool default to 30; MessageDisplay lowers it to 10.
   */
  timeout?: number | undefined;
  /** Custom spinner message displayed while the hook runs */
  statusMessage?: string | undefined;
  /** If true, runs only once per session then is removed. Skills only, not agents */
  once?: boolean | undefined;
  /** Permission-rule syntax filter for tool events */
  if?: string | undefined;
}

/**
 * Command hook handler — runs a shell command
 */
export interface CommandHookHandler extends HookHandlerBase {
  type: 'command';
  /** Shell command to execute */
  command: string;
  args?: string[] | undefined;
  /** If true, runs in the background without blocking. Only for command hooks */
  async?: boolean | undefined;
  /** If true, runs in the background and wakes Claude on exit code 2 */
  asyncRewake?: boolean | undefined;
  /** Shell to use for this hook */
  shell?: 'bash' | 'powershell' | undefined;
}

/**
 * HTTP hook handler — posts hook input to an HTTP endpoint
 */
export interface HttpHookHandler extends HookHandlerBase {
  type: 'http';
  /** URL to send the POST request to */
  url: string;
  /** Additional HTTP headers */
  headers?: Record<string, string> | undefined;
  /** Environment variables allowed for header interpolation */
  allowedEnvVars?: string[] | undefined;
}

/**
 * MCP tool hook handler — calls a tool on an already-connected MCP server
 */
export interface McpToolHookHandler extends HookHandlerBase {
  type: 'mcp_tool';
  /** Name of a configured MCP server */
  server: string;
  /** Name of the tool to call on that server */
  tool: string;
  /** Arguments passed to the MCP tool */
  input?: Record<string, unknown> | undefined;
}

/**
 * Prompt hook handler — single-turn LLM evaluation
 */
export interface PromptHookHandler extends HookHandlerBase {
  type: 'prompt';
  /** Prompt text. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: string;
  /** Model to use. Defaults to a fast model */
  model?: string | undefined;
  /** Continue the turn after a negative prompt decision where the event permits it */
  continueOnBlock?: boolean | undefined;
}

/**
 * Agent hook handler — spawns a subagent with tool access
 */
export interface AgentHookHandler extends HookHandlerBase {
  type: 'agent';
  /** Prompt text. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: string;
  /** Model to use. Defaults to a fast model */
  model?: string | undefined;
  /** Continue the turn after a negative agent decision where the event permits it */
  continueOnBlock?: boolean | undefined;
}

/**
 * Union of all hook handler types, discriminated on `type`
 */
export type HookHandler =
  | CommandHookHandler
  | HttpHookHandler
  | McpToolHookHandler
  | PromptHookHandler
  | AgentHookHandler;

/** Hook events that accept command, HTTP, MCP tool, prompt, and agent handlers. */
export type DecisionHookEventName =
  | 'PermissionDenied'
  | 'PermissionRequest'
  | 'PostToolBatch'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'TaskCompleted'
  | 'TaskCreated'
  | 'TeammateIdle'
  | 'UserPromptExpansion'
  | 'UserPromptSubmit';

/** Hook events that accept command, HTTP, and MCP tool handlers. */
export type ExternalHookEventName =
  | 'ConfigChange'
  | 'CwdChanged'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'FileChanged'
  | 'InstructionsLoaded'
  | 'Notification'
  | 'PostCompact'
  | 'PreCompact'
  | 'SessionEnd'
  | 'StopFailure'
  | 'SubagentStart'
  | 'WorktreeCreate'
  | 'WorktreeRemove';

/** Hook events that accept only command and MCP tool handlers. */
export type StartupHookEventName = 'SessionStart' | 'Setup';

/** Handler union accepted for a specific hook event. */
export type HookHandlerFor<E extends HookEventName> =
  E extends DecisionHookEventName
    ? HookHandler
    : E extends ExternalHookEventName
      ? CommandHookHandler | HttpHookHandler | McpToolHookHandler
      : E extends StartupHookEventName
        ? CommandHookHandler | McpToolHookHandler
        : HookHandler;

/** A matcher group for a specific hook event. */
export interface MatcherGroupFor<E extends HookEventName = HookEventName> {
  /** Regex pattern to filter when hooks fire. Omit or use "*" / "" to match all */
  matcher?: string | undefined;
  /** Array of handlers accepted by the event */
  hooks: HookHandlerFor<E>[];
}

/** Backward-compatible generic matcher group. */
export type MatcherGroup = MatcherGroupFor;

/** Event-aware hooks map from settings.json. */
export type HooksMap = {
  [E in HookEventName]?: MatcherGroupFor<E>[] | undefined;
};

/** Full hooks configuration block from settings.json. */
export interface HooksConfig {
  hooks?: HooksMap | undefined;
  /** Disable hooks at this settings layer, subject to managed-settings precedence */
  disableAllHooks?: boolean | undefined;
  /** Managed settings flag that restricts hooks to managed and force-enabled plugin hooks */
  allowManagedHooksOnly?: boolean | undefined;
  /** URL patterns that HTTP hooks may target */
  allowedHttpHookUrls?: string[] | undefined;
  /** Environment variable names HTTP hooks may interpolate */
  httpHookAllowedEnvVars?: string[] | undefined;
}

/**
 * Type guard to check if input is a specific hook type
 */
export function isHookType<T extends HookInput>(
  input: HookInput,
  eventName: T['hook_event_name']
): input is T {
  return input.hook_event_name === eventName;
}

// Compatibility export for HookOutputBuilder.
export { HookOutputBuilder } from '../utils/output-builder.js';

/**
 * Environment variables provided by Claude Code to hook processes.
 *
 * Claude Code sets these variables in the hook's execution environment.
 * Not all variables are available for all event types.
 */
export interface HookEnvironmentVars {
  /** Set to `"1"` in Claude Code child processes. */
  CLAUDECODE?: '1' | undefined;
  /** Set to `"1"` when a hook runs inside a child Claude Code session. */
  CLAUDE_CODE_CHILD_SESSION?: '1' | undefined;
  /** Project root used for hook path placeholders; distinct from the current `cwd` */
  CLAUDE_PROJECT_DIR: string;
  /**
   * Set to `"true"` in remote web environments (e.g., Claude.ai web).
   * Not set (undefined) in the local CLI.
   * Useful for hooks that need to detect execution context.
   */
  CLAUDE_CODE_REMOTE?: string;
  /** Remote Control session ID while the local session has an active bridge */
  CLAUDE_CODE_BRIDGE_SESSION_ID?: string;
  /**
   * Path to a file where SessionStart, Setup, CwdChanged, and FileChanged hooks
   * can persist environment variables for subsequent Bash commands.
   * Write `export VAR=value` lines and append when preserving prior hook output.
   *
   * @example
   * ```bash
   * if [ -n "$CLAUDE_ENV_FILE" ]; then
   *   echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
   * fi
   * ```
   */
  CLAUDE_ENV_FILE?: string;
  /** Active effort level exported for hook commands and the Bash tool */
  CLAUDE_EFFORT?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Plugin root directory. Set when hook is defined in a plugin's `hooks/hooks.json`.
   * Use to reference scripts bundled with the plugin.
   */
  CLAUDE_PLUGIN_ROOT?: string;
  /** Plugin persistent data directory for dependencies and state across updates */
  CLAUDE_PLUGIN_DATA?: string;
  /**
   * Overrides the total SessionEnd hooks timeout budget in milliseconds.
   * Values above 60000 are capped by Claude Code.
   */
  CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS?: string;
  /**
   * Enables additional hook matcher diagnostics when set to `verbose`.
   */
  CLAUDE_CODE_DEBUG_LOG_LEVEL?: string;
  /**
   * Forces marketplace plugin installation events to complete before the first turn.
   */
  CLAUDE_CODE_SYNC_PLUGIN_INSTALL?: string;
}

/**
 * Configuration interface for hook behavior
 */
export interface HookConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Timeout for hook execution in seconds */
  timeout?: number;
  /** Total SessionEnd hook timeout budget in milliseconds */
  sessionEndTimeoutMs?: number;
  /** Whether plugin install events are synchronized before first turn */
  syncPluginInstall?: boolean;
  /** Project-specific rules */
  rules?: {
    /** File patterns to protect from editing */
    protectedFiles?: string[];
    /** Commands that require approval */
    dangerousCommands?: string[];
    /** Auto-format file extensions */
    autoFormatExtensions?: string[];
  };
}
