/**
 * Builders for hook output JSON returned on stdout by Claude Code hook handlers.
 * Each helper returns an event-specific output shape without performing I/O.
 */

import type {
  BaseHookOutput,
  ElicitationAction,
  ElicitationOutput,
  MessageDisplayOutput,
  PermissionDeniedOutput,
  PermissionUpdateEntry,
  PermissionUpdateMode,
  PreToolUseOutput,
  PostToolUseOutput,
  PostToolUseFailureOutput,
  PostToolBatchOutput,
  PermissionRequestOutput,
  StopBlockOutput,
  StopContextOutput,
  SubagentStartOutput,
  SetupOutput,
  SessionStartOutput,
  SubagentStopBlockOutput,
  SubagentStopContextOutput,
  SubagentStopOutput,
  UserPromptSubmitOutput,
  WatchPathsOutput,
  WorktreeCreateOutput,
} from '../types/index.js';

type SessionStartContextOptions = {
  context?: string;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
};

function buildSessionStartContext(context: string): SessionStartOutput;
function buildSessionStartContext(
  options: SessionStartContextOptions
): SessionStartOutput;
function buildSessionStartContext(
  contextOrOptions: string | SessionStartContextOptions
): SessionStartOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      ...(typeof contextOrOptions === 'string'
        ? { additionalContext: contextOrOptions }
        : {
            ...(contextOrOptions.context !== undefined && {
              additionalContext: contextOrOptions.context,
            }),
            ...(contextOrOptions.initialUserMessage !== undefined && {
              initialUserMessage: contextOrOptions.initialUserMessage,
            }),
            ...(contextOrOptions.sessionTitle !== undefined && {
              sessionTitle: contextOrOptions.sessionTitle,
            }),
            ...(contextOrOptions.watchPaths !== undefined && {
              watchPaths: contextOrOptions.watchPaths,
            }),
            ...(contextOrOptions.reloadSkills !== undefined && {
              reloadSkills: contextOrOptions.reloadSkills,
            }),
          }),
    },
  };
}

export const HookOutputBuilder = {
  /** Build a successful generic hook output with optional user-visible text. */
  success: (message?: string): BaseHookOutput => ({
    suppressOutput: !message,
    ...(message && { systemMessage: message }),
  }),

  /** Build a generic error output, optionally stopping execution. */
  error: (reason: string, stopExecution = false): BaseHookOutput => ({
    continue: !stopExecution,
    ...(stopExecution && { stopReason: reason }),
    systemMessage: reason,
  }),

  /** Build a PreToolUse permission decision. */
  permission: (
    decision: 'allow' | 'deny' | 'ask' | 'defer',
    reason: string,
    options?: {
      updatedInput?: Record<string, unknown>;
      additionalContext?: string;
    }
  ): PreToolUseOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
      ...(options?.updatedInput && { updatedInput: options.updatedInput }),
      ...(options?.additionalContext && {
        additionalContext: options.additionalContext,
      }),
    },
  }),

  /**
   * Build PostToolUse block feedback for Claude, with optional context and
   * tool-output replacements.
   *
   * Always sets `decision: "block"` and `reason`. For replace/context-only
   * output without a block decision, use {@link HookOutputBuilder.postToolUseContext}.
   */
  feedback: (
    reason: string,
    additionalContext?: string,
    updatedMCPToolOutput?: unknown,
    updatedToolOutput?: unknown
  ): PostToolUseOutput => ({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...(additionalContext !== undefined && { additionalContext }),
      ...(updatedMCPToolOutput !== undefined && { updatedMCPToolOutput }),
      ...(updatedToolOutput !== undefined && { updatedToolOutput }),
    },
  }),

  /**
   * Build PostToolUse non-block context and/or tool-output replacement.
   *
   * Emits only `hookSpecificOutput` (no top-level `decision`/`reason`). Use
   * {@link HookOutputBuilder.feedback} when Claude should receive block feedback.
   */
  postToolUseContext: (options: {
    additionalContext?: string;
    updatedMCPToolOutput?: unknown;
    updatedToolOutput?: unknown;
  }): PostToolUseOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...(options.additionalContext !== undefined && {
        additionalContext: options.additionalContext,
      }),
      ...(options.updatedMCPToolOutput !== undefined && {
        updatedMCPToolOutput: options.updatedMCPToolOutput,
      }),
      ...(options.updatedToolOutput !== undefined && {
        updatedToolOutput: options.updatedToolOutput,
      }),
    },
  }),

  /**
   * Build PostToolUseFailure block feedback for Claude after a tool failure.
   *
   * Always sets `decision: "block"` and `reason`. For context-only failure
   * output, use {@link HookOutputBuilder.failureContext}.
   */
  failureFeedback: (
    reason: string,
    additionalContext?: string
  ): PostToolUseFailureOutput => ({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      ...(additionalContext !== undefined && { additionalContext }),
    },
  }),

  /**
   * Build PostToolUseFailure non-block context injection.
   *
   * Emits only `hookSpecificOutput.additionalContext` (no top-level
   * `decision`/`reason`). Use {@link HookOutputBuilder.failureFeedback} for
   * block feedback after a failed tool call.
   */
  failureContext: (additionalContext: string): PostToolUseFailureOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext,
    },
  }),

  /** Build a PermissionRequest allow decision. */
  allowPermission: (options?: {
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdateEntry[];
  }): PermissionRequestOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        ...(options?.updatedInput && { updatedInput: options.updatedInput }),
        ...(options?.updatedPermissions && {
          updatedPermissions: options.updatedPermissions,
        }),
      },
    },
  }),

  /** Build a PermissionRequest deny decision. */
  denyPermission: (options?: {
    message?: string;
    interrupt?: boolean;
  }): PermissionRequestOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        ...(options?.message && { message: options.message }),
        ...(options?.interrupt !== undefined && {
          interrupt: options.interrupt,
        }),
      },
    },
  }),

  /** Build a PermissionRequest allow decision that changes the permission mode. */
  permissionRequestSetMode: (
    mode: PermissionUpdateMode,
    destination:
      | 'session'
      | 'localSettings'
      | 'projectSettings'
      | 'userSettings' = 'session'
  ): PermissionRequestOutput =>
    HookOutputBuilder.allowPermission({
      updatedPermissions: [{ type: 'setMode', mode, destination }],
    }),

  /** Build PermissionDenied retry guidance. */
  permissionDeniedRetry: (retry: boolean): PermissionDeniedOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PermissionDenied',
      retry,
    },
  }),

  /** Build an Elicitation or ElicitationResult action response. */
  elicitation: (
    action: ElicitationAction,
    content?: Record<string, unknown>,
    hookEventName: 'Elicitation' | 'ElicitationResult' = 'Elicitation'
  ): ElicitationOutput => ({
    hookSpecificOutput: {
      hookEventName,
      action,
      ...(content && { content }),
    },
  }),

  /** Build watched-path updates for CwdChanged or FileChanged hooks. */
  watchPaths: (paths: string[]): WatchPathsOutput => ({
    watchPaths: paths,
  }),

  /** Build a WorktreeCreate output with the created worktree path. */
  worktreePath: (absolutePath: string): WorktreeCreateOutput => ({
    hookSpecificOutput: {
      hookEventName: 'WorktreeCreate',
      worktreePath: absolutePath,
    },
  }),

  /**
   * Build a task lifecycle stop response.
   *
   * @deprecated The event-name argument is accepted for source compatibility but ignored.
   */
  taskBlock: (
    reason: string,
    _hookEventName: 'TaskCreated' | 'TaskCompleted' = 'TaskCompleted'
  ): BaseHookOutput => ({
    continue: false,
    stopReason: reason,
  }),

  /** Build a TeammateIdle stop response. */
  teammateStop: (reason: string): BaseHookOutput => ({
    continue: false,
    stopReason: reason,
  }),

  /** Build a PostToolBatch block response. */
  batchBlock: (reason: string): PostToolBatchOutput => ({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolBatch',
      additionalContext: reason,
    },
  }),

  /** Build SubagentStart context injection. */
  subagentContext: (context: string): SubagentStartOutput => ({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: context,
    },
  }),

  /** Build Setup context injection. */
  setupContext: (context: string): SetupOutput => ({
    hookSpecificOutput: {
      hookEventName: 'Setup',
      additionalContext: context,
    },
  }),

  /** Build MessageDisplay replacement content. */
  messageDisplayContent: (content: string): MessageDisplayOutput => ({
    hookSpecificOutput: {
      hookEventName: 'MessageDisplay',
      displayContent: content,
    },
  }),

  /** Build SessionStart context, title, initial message, watch paths, or skill reload output. */
  sessionStartContext: buildSessionStartContext,

  /** Build UserPromptSubmit context injection. */
  addContext: (context: string): UserPromptSubmitOutput => ({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }),

  /** Build a UserPromptSubmit session-title update. */
  sessionTitle: (title: string): UserPromptSubmitOutput => ({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      sessionTitle: title,
    },
  }),

  /**
   * Build a UserPromptSubmit prompt block.
   *
   * @param reason - Reason shown to the user when the prompt is blocked
   * @param options - Optional block modifiers
   * @param options.suppressOriginalPrompt - When true, omit the original prompt
   *   text from the block message shown to the user
   */
  blockPrompt: (
    reason: string,
    options?: { suppressOriginalPrompt?: boolean }
  ): UserPromptSubmitOutput => {
    const output: UserPromptSubmitOutput = {
      decision: 'block',
      reason,
    };
    if (options?.suppressOriginalPrompt !== undefined) {
      output.suppressOriginalPrompt = options.suppressOriginalPrompt;
    }
    return output;
  },

  /** Build a Stop block that keeps the main session running. */
  stopBlock: (reason: string): StopBlockOutput => ({
    decision: 'block',
    reason,
  }),

  /** Build non-error Stop feedback that keeps the main session running. */
  stopContext: (context: string): StopContextOutput => ({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: context,
    },
  }),

  /** Build a SubagentStop block that keeps the subagent running. */
  subagentStopBlock: (reason: string): SubagentStopBlockOutput => ({
    decision: 'block',
    reason,
  }),

  /** Build non-error SubagentStop feedback that keeps the subagent running. */
  subagentStopAdditionalContext: (
    context: string
  ): SubagentStopContextOutput => ({
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: context,
    },
  }),

  /**
   * @deprecated Use `subagentStopBlock` for blocking SubagentStop output.
   * Compatibility alias that continues to emit `decision: "block"`.
   */
  subagentStopContext: (reason: string): SubagentStopOutput =>
    HookOutputBuilder.subagentStopBlock(reason),

  /**
   * @deprecated StopFailure is side-effect-only; Claude Code ignores output and
   * exit code. Kept as a no-op compatibility shim that returns an empty object.
   */
  stopFailureLog: (_systemMessage?: string): BaseHookOutput => ({}),
};
