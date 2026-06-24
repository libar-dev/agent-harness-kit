/**
 * Standardized hook output builder utilities
 *
 * Provides convenience methods for creating properly structured
 * hook output objects for all hook event types.
 */

import type {
  BaseHookOutput,
  ElicitationAction,
  ElicitationOutput,
  PermissionDeniedOutput,
  PermissionMode,
  PermissionUpdateEntry,
  PreToolUseOutput,
  PostToolUseOutput,
  PostToolBatchOutput,
  PermissionRequestOutput,
  SubagentStartOutput,
  SessionStartOutput,
  StopOutput,
  UserPromptSubmitOutput,
  WatchPathsOutput,
  WorktreeCreateOutput,
} from '../types/index.js';

type LifecycleStopOutput = BaseHookOutput & {
  hookSpecificOutput: {
    hookEventName: 'TaskCreated' | 'TaskCompleted' | 'TeammateIdle';
  };
};

export const HookOutputBuilder = {
  success: (message?: string): BaseHookOutput => ({
    suppressOutput: !message,
    ...(message && { systemMessage: message }),
  }),

  error: (reason: string, stopExecution = false): BaseHookOutput => ({
    continue: !stopExecution,
    ...(stopExecution && { stopReason: reason }),
    systemMessage: reason,
  }),

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

  feedback: (
    reason: string,
    additionalContext?: string,
    updatedMCPToolOutput?: Record<string, unknown>
  ): PostToolUseOutput => ({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...(additionalContext && { additionalContext }),
      ...(updatedMCPToolOutput && { updatedMCPToolOutput }),
    },
  }),

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

  permissionRequestSetMode: (
    mode: PermissionMode,
    destination:
      | 'session'
      | 'localSettings'
      | 'projectSettings'
      | 'userSettings' = 'session'
  ): PermissionRequestOutput =>
    HookOutputBuilder.allowPermission({
      updatedPermissions: [{ type: 'setMode', mode, destination }],
    }),

  permissionDeniedRetry: (retry: boolean): PermissionDeniedOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PermissionDenied',
      retry,
    },
  }),

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

  watchPaths: (paths: string[]): WatchPathsOutput => ({
    watchPaths: paths,
  }),

  worktreePath: (absolutePath: string): WorktreeCreateOutput => ({
    hookSpecificOutput: {
      hookEventName: 'WorktreeCreate',
      worktreePath: absolutePath,
    },
  }),

  taskBlock: (
    reason: string,
    hookEventName: 'TaskCreated' | 'TaskCompleted' = 'TaskCompleted'
  ): LifecycleStopOutput => ({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName,
    },
  }),

  teammateStop: (reason: string): LifecycleStopOutput => ({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName: 'TeammateIdle',
    },
  }),

  batchBlock: (reason: string): PostToolBatchOutput => ({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolBatch',
      additionalContext: reason,
    },
  }),

  subagentContext: (context: string): SubagentStartOutput => ({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: context,
    },
  }),

  sessionStartContext: (context: string): SessionStartOutput => ({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),

  addContext: (context: string): UserPromptSubmitOutput => ({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }),

  sessionTitle: (title: string): UserPromptSubmitOutput => ({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      sessionTitle: title,
    },
  }),

  blockPrompt: (reason: string): UserPromptSubmitOutput => ({
    decision: 'block',
    reason,
  }),

  subagentStopContext: (reason: string): StopOutput => ({
    decision: 'block',
    reason,
  }),

  stopFailureLog: (systemMessage?: string): BaseHookOutput =>
    HookOutputBuilder.success(systemMessage),
};
