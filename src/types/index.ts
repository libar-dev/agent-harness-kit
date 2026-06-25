/**
 * TypeScript type definitions for Claude Code hooks
 *
 * This file contains comprehensive type definitions for all Claude Code hook events,
 * their input data, and expected output formats.
 */

// =============================================================================
// Base Hook Interfaces
// =============================================================================

/**
 * Common fields present in all hook inputs
 */
export interface BaseHookInput {
  /** Unique identifier for the current Claude Code session */
  session_id: string;
  /** Absolute path to the conversation transcript JSON file */
  transcript_path: string;
  /** Current working directory when the hook is invoked */
  cwd: string;
  /** The specific hook event that triggered this execution */
  hook_event_name: string;
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
  continue?: boolean;
  /** Message shown to user when continue is false */
  stopReason?: string;
  /** Hide stdout from transcript mode (default: false) */
  suppressOutput?: boolean;
  /** Optional warning message shown to the user */
  systemMessage?: string;
  /** ANSI escape sequences or similar terminal control output */
  terminalSequence?: string;
}

// =============================================================================
// Tool-Related Hook Interfaces
// =============================================================================

/**
 * Input for PreToolUse hooks - runs before tool execution
 */
export interface PreToolUseInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  /** Name of the tool about to be executed */
  tool_name: string;
  /** Parameters that will be passed to the tool */
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
  /** Modern hook-specific output format */
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

// =============================================================================
// Permission Request Hook Interfaces
// =============================================================================

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

// =============================================================================
// Post Tool Use Failure Hook Interfaces
// =============================================================================

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

/**
 * Permission update entries used by PermissionRequest input/output.
 * The official schema is discriminated by `type`; this type keeps the
 * required discriminator while allowing the event-specific payload fields.
 */
export interface PermissionUpdateEntry {
  type: string;
  [key: string]: unknown;
}

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

// =============================================================================
// Subagent Start Hook Interfaces
// =============================================================================

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

// =============================================================================
// Agent Teams Hook Interfaces
// =============================================================================

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

// =============================================================================
// Lifecycle Hook Interfaces
// =============================================================================

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
    | 'elicitation_response';
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

/**
 * Notification-specific output for context injection
 */
export interface NotificationOutput extends BaseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Notification';
    /** Additional context for the notification handling */
    additionalContext?: string;
  };
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
}

/**
 * Stop/SubagentStop-specific output for continuation control
 */
export interface StopOutput extends BaseHookOutput {
  /** Block Claude from stopping - must provide reason for how to proceed */
  decision?: 'block';
  /** Must be provided when decision is 'block' - tells Claude how to proceed */
  reason?: string;
}

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
export interface PreCompactOutput extends BaseHookOutput {
  /** Block compaction */
  decision?: 'block';
  /** Explanation shown when compaction is blocked */
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreCompact';
    /** String injected into compaction */
    additionalContext?: string;
  };
}

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
  /** New working directory */
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
  /** Slug identifier for the new worktree */
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

// =============================================================================
// Union Types for Type Guards
// =============================================================================

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
  | PreCompactOutput
  | SessionStartOutput
  | ConfigChangeOutput
  | WatchPathsOutput
  | WorktreeCreateOutput
  | ElicitationOutput
  | BaseHookOutput; // For hooks that don't have specific output requirements (TeammateIdle, TaskCompleted, etc.)

// =============================================================================
// Common Tool Input Types
// =============================================================================

/**
 * Common tool input patterns for frequently used tools
 */
export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditToolInput {
  file_path: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  multiline?: boolean;
  '-i'?: boolean; // case insensitive
  '-n'?: boolean; // show line numbers
  '-A'?: number; // lines after
  '-B'?: number; // lines before
  '-C'?: number; // lines before and after
}

export interface GlobToolInput {
  pattern: string;
  path?: string;
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

export interface AgentToolInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
}

export interface AskUserQuestionToolInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
    }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
}

export interface ExitPlanModeToolInput {
  [key: string]: never;
}

export interface TodoWriteToolInput {
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
}

export type MCPToolInput = Record<string, unknown>;

export interface TaskToolInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
}

// =============================================================================
// Hook Configuration Types (settings.json schema)
// =============================================================================

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
  /** Seconds before canceling. Defaults: 60 (command/HTTP), 30 (prompt), 60 (agent) */
  timeout?: number;
  /** Custom spinner message displayed while the hook runs */
  statusMessage?: string;
  /** If true, runs only once per session then is removed. Skills only, not agents */
  once?: boolean;
  /** Permission-rule syntax filter for tool events */
  if?: string;
}

/**
 * Command hook handler — runs a shell command
 */
export interface CommandHookHandler extends HookHandlerBase {
  type: 'command';
  /** Shell command to execute */
  command: string;
  args?: string[];
  /** If true, runs in the background without blocking. Only for command hooks */
  async?: boolean;
  /** If true, runs in the background and wakes Claude on exit code 2 */
  asyncRewake?: boolean;
  /** Shell to use for this hook */
  shell?: 'bash' | 'powershell';
}

/**
 * HTTP hook handler — posts hook input to an HTTP endpoint
 */
export interface HttpHookHandler extends HookHandlerBase {
  type: 'http';
  /** URL to send the POST request to */
  url: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Environment variables allowed for header interpolation */
  allowedEnvVars?: string[];
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
  input?: Record<string, unknown>;
}

/**
 * Prompt hook handler — single-turn LLM evaluation
 */
export interface PromptHookHandler extends HookHandlerBase {
  type: 'prompt';
  /** Prompt text. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: string;
  /** Model to use. Defaults to a fast model */
  model?: string;
}

/**
 * Agent hook handler — spawns a subagent with tool access
 */
export interface AgentHookHandler extends HookHandlerBase {
  type: 'agent';
  /** Prompt text. Use $ARGUMENTS as placeholder for hook input JSON */
  prompt: string;
  /** Model to use. Defaults to a fast model */
  model?: string;
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

/**
 * A matcher group: an optional regex filter and the handlers to run when matched
 */
export interface MatcherGroup {
  /** Regex pattern to filter when hooks fire. Omit or use "*" / "" to match all */
  matcher?: string;
  /** Array of hook handlers to execute */
  hooks: HookHandler[];
}

/**
 * Full hooks configuration block from settings.json
 */
export interface HooksConfig {
  hooks?: Partial<Record<HookEventName, MatcherGroup[]>>;
  /** Managed settings flag that restricts hooks to managed and force-enabled plugin hooks */
  allowManagedHooksOnly?: boolean;
  /** URL patterns that HTTP hooks may target */
  allowedHttpHookUrls?: string[];
  /** Environment variable names HTTP hooks may interpolate */
  httpHookAllowedEnvVars?: string[];
}

// =============================================================================
// Utility Types and Helpers
// =============================================================================

/**
 * Type guard to check if input is a specific hook type
 */
export function isHookType<T extends HookInput>(
  input: HookInput,
  eventName: T['hook_event_name']
): input is T {
  return input.hook_event_name === eventName;
}

// HookOutputBuilder moved to src/utils/output-builder.ts — re-export for compatibility
export { HookOutputBuilder } from '../utils/output-builder.js';

/**
 * Environment variables provided by Claude Code to hook processes.
 *
 * These are set in the hook's execution environment automatically.
 * Not all variables are available for all event types.
 */
export interface HookEnvironmentVars {
  /** Current working directory (same as `cwd` in hook input JSON) */
  CLAUDE_PROJECT_DIR: string;
  /**
   * Set to `"true"` in remote web environments (e.g., Claude.ai web).
   * Not set (undefined) in the local CLI.
   * Useful for hooks that need to detect execution context.
   */
  CLAUDE_CODE_REMOTE?: string;
  /**
   * Path to a file where SessionStart hooks can persist environment variables.
   * Write `export VAR=value` lines (using `>>` to append) to make variables
   * available in all subsequent Bash commands during the session.
   *
   * Only available in SessionStart hooks. Other hook types do not receive this variable.
   *
   * @example
   * ```bash
   * if [ -n "$CLAUDE_ENV_FILE" ]; then
   *   echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
   * fi
   * ```
   */
  CLAUDE_ENV_FILE?: string;
  /**
   * Plugin root directory. Set when hook is defined in a plugin's `hooks/hooks.json`.
   * Use to reference scripts bundled with the plugin.
   */
  CLAUDE_PLUGIN_ROOT?: string;
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
