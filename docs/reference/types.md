# Types Reference

Public TypeScript contracts exported by `@libar-dev/agent-harness-kit/types`.

**Source:** [`src/types/index.ts`](../../src/types/index.ts)

## Base contracts

| Type | Contract |
|---|---|
| `BaseHookInput` | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, optional `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, and `effort` |
| `BaseHookOutput` | Optional `continue`, `stopReason`, `suppressOutput`, `systemMessage`, and `terminalSequence` |
| `HookInput` | Union of all 30 event inputs |
| `HookOutput` | Union of event-specific and universal outputs |
| `HookEventName` | Union of all 30 event strings |
| `PermissionMode` | `'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions'` |

`prompt_id` is an optional UUID that identifies the user prompt being processed. It is absent before the first user input. `effort`, when present, is `{ level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }`.

## Event input types

All event inputs extend `BaseHookInput`.

| Type | Event-specific fields |
|---|---|
| `SetupInput` | `trigger: 'init' | 'maintenance'` |
| `SessionStartInput` | `source`, optional `model`, `session_title`, `agent_type` |
| `UserPromptSubmitInput` | `prompt` |
| `UserPromptExpansionInput` | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` |
| `PreToolUseInput` | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequestInput` | `tool_name`, `tool_input`, optional `permission_suggestions`; no `tool_use_id` |
| `PermissionDeniedInput` | `tool_name`, `tool_input`, `tool_use_id`, `reason` |
| `PostToolUseInput` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms` |
| `PostToolUseFailureInput` | `tool_name`, `tool_input`, `tool_use_id`, `error`, optional `is_interrupt`, `duration_ms` |
| `PostToolBatchInput` | `tool_calls: PostToolBatchCall[]` |
| `NotificationInput` | `message`, optional `title`, `notification_type` |
| `MessageDisplayInput` | UUID `turn_id`, UUID `message_id`, non-negative `index`, `final`, `delta` |
| `SubagentStartInput` | `agent_id`, `agent_type` |
| `SubagentStopInput` | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, optional final message and registries |
| `TaskCreatedInput`, `TaskCompletedInput` | `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` |
| `StopInput` | `stop_hook_active`, optional `last_assistant_message`, `background_tasks`, `session_crons` |
| `StopFailureInput` | `error`, optional `error_details`, `last_assistant_message` |
| `TeammateIdleInput` | `teammate_name`, `team_name` |
| `InstructionsLoadedInput` | `file_path`, `memory_type`, `load_reason`, optional `globs`, `trigger_file_path`, `parent_file_path` |
| `ConfigChangeInput` | `source`, optional `file_path` |
| `CwdChangedInput` | `old_cwd`, `new_cwd` |
| `FileChangedInput` | `file_path`, `event` |
| `WorktreeCreateInput` | `name` |
| `WorktreeRemoveInput` | `worktree_path` |
| `PreCompactInput` | `trigger`, `custom_instructions` |
| `PostCompactInput` | `trigger`, `compact_summary` |
| `ElicitationInput` | `mcp_server_name`, `message`, optional `mode`, `requested_schema`, `url`, `elicitation_id` |
| `ElicitationResultInput` | `mcp_server_name`, `action`, optional `content`, `mode`, `elicitation_id` |
| `SessionEndInput` | `reason` |

### Notification types

`NotificationInput.notification_type` is one of:

- `permission_prompt`
- `idle_prompt`
- `auth_success`
- `elicitation_dialog`
- `elicitation_complete`
- `elicitation_response`
- `agent_needs_input`
- `agent_completed`

### Stop registries

`StopInput` and `SubagentStopInput` can carry parent-session registries:

- `background_tasks?: BackgroundTaskEntry[]` with required `id`, `type`, `status`, `description` and optional `command`, `agent_type`, `server`, `tool`, `name`. The type permits additional metadata for forward compatibility.
- `session_crons?: SessionCronEntry[]` with `id`, `schedule`, `recurring`, `prompt`, plus additional metadata.

### StopFailure errors

`StopFailureInput.error` is `'rate_limit' | 'overloaded' | 'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error' | 'invalid_request' | 'model_not_found' | 'server_error' | 'max_output_tokens' | 'unknown'`.

## Permission update types

`PermissionUpdateEntry` is a discriminated union, not an open record.

| Variant | Fields |
|---|---|
| `AddPermissionRulesUpdate` | `{ type: 'addRules', rules, behavior, destination }` |
| `ReplacePermissionRulesUpdate` | `{ type: 'replaceRules', rules, behavior, destination }` |
| `RemovePermissionRulesUpdate` | `{ type: 'removeRules', rules, behavior, destination }` |
| `SetPermissionModeUpdate` | `{ type: 'setMode', mode, destination }` |
| `AddPermissionDirectoriesUpdate` | `{ type: 'addDirectories', directories, destination }` |
| `RemovePermissionDirectoriesUpdate` | `{ type: 'removeDirectories', directories, destination }` |

`PermissionRule` is `{ toolName: string; ruleContent?: string }`. Rule behavior is `allow`, `deny`, or `ask`. Destination is `session`, `localSettings`, `projectSettings`, or `userSettings`.

`PermissionUpdateMode` accepts every `PermissionMode` plus the output-only alias `manual`. Hook input `permission_mode` still reports Manual mode as `default`, never `manual`.

## Output types

| Type | Contract |
|---|---|
| `PreToolUseOutput` | Structured allow/deny/ask/defer decision with required reason and optional updated input/context |
| `PermissionRequestOutput` | Nested allow/deny decision; allow may include `updatedInput` and `updatedPermissions` |
| `PermissionDeniedOutput` | Optional `hookSpecificOutput.retry` |
| `PostToolUseOutput` | Optional top-level block feedback and/or `hookSpecificOutput` with context plus optional `updatedMCPToolOutput` / `updatedToolOutput` |
| `PostToolUseFailureOutput` | Optional top-level block feedback and/or context-only `additionalContext`; no output-replacement fields |
| `PostToolBatchOutput` | Optional block/context before the next model call |
| `NotificationOutput` | Exactly the universal `BaseHookOutput` shape; no notification-specific output or `additionalContext` |
| `MessageDisplayOutput` | Optional display-only `displayContent` replacement |
| `SubagentStartOutput`, `SetupOutput` | Optional `additionalContext` |
| `SessionStartOutput` | Optional context, initial user message, title, watch paths, and skill reload |
| `UserPromptSubmitOutput` | Block with reason and optional `suppressOriginalPrompt`, or inject context/title |
| `UserPromptExpansionOutput` | Block with reason or inject context |
| `StopOutput` | Universal output, blocking output, or non-error context output |
| `SubagentStopOutput` | Universal output, blocking output, or non-error context output |
| `PreCompactOutput` | Universal fields or top-level block/reason only; no PreCompact `hookSpecificOutput` / `additionalContext` |
| `ConfigChangeOutput` | Optional block/reason |
| `WatchPathsOutput` | Optional `watchPaths` |
| `WorktreeCreateOutput` | Optional `worktreePath` |
| `ElicitationOutput` | Accept/decline/cancel with optional content |

For `StopBlockOutput` and `SubagentStopBlockOutput`, `decision: 'block'` requires a `reason` string (presence required; empty string is accepted). Non-error feedback uses `hookSpecificOutput.additionalContext` without a top-level decision. These are distinct modes and may not be combined in the strict event schemas.

`StopFailure` is side-effect-only in Claude Code: output and exit code are ignored. It therefore has no dedicated output type beyond the universal compatibility union.

## Tool input types

| Type | Fields |
|---|---|
| `BashToolInput` | `command`, optional `description`, `timeout`, `run_in_background` |
| `WriteToolInput` | `file_path`, `content` |
| `EditToolInput` | `file_path`, `old_string`, `new_string`, optional `replace_all` |
| `MultiEditToolInput` | `file_path`, `edits[]` |
| `ReadToolInput` | `file_path`, optional `offset`, `limit` |
| `GlobToolInput` | `pattern`, optional `path` |
| `GrepToolInput` | search pattern and optional path/filter/output flags |
| `WebFetchToolInput` | `url`, `prompt` |
| `WebSearchToolInput` | `query`, optional allowed/blocked domains |
| `AgentToolInput` | `prompt`, optional `description`, `subagent_type`, `model`, `run_in_background`, `isolation` (`worktree` \| `remote`) |
| `TaskToolInput` | Legacy compatibility subset of Agent core fields (`prompt`, optional `description`, `subagent_type`, `model`, `run_in_background`); does not include `isolation` |
| `AskUserQuestionToolInput` | `questions[]`, optional `answers` |
| `ExitPlanModeToolInput` | injected `plan`, `planFilePath`, optional deprecated `allowedPrompts[]` |
| `TodoWriteToolInput` | `todos[]` |
| `MCPToolInput` | `Record<string, unknown>` |

`ExitPlanModeAllowedPrompt` is `{ tool, prompt }`; Claude Code accepts it for compatibility but ignores prompt-based permission grants.

## Settings types

Five handler variants share `timeout?`, `statusMessage?`, `once?`, and `if?`:

| Type | Additional fields |
|---|---|
| `CommandHookHandler` | `command`, optional `args`, `async`, `asyncRewake`, `shell` |
| `HttpHookHandler` | `url`, optional `headers`, `allowedEnvVars` |
| `McpToolHookHandler` | `server`, `tool`, optional `input` |
| `PromptHookHandler` | `prompt`, optional `model`, `continueOnBlock` |
| `AgentHookHandler` | `prompt`, optional `model`, `continueOnBlock` |

`HookHandlerFor<E>` and `MatcherGroupFor<E>` encode the event-specific handler support matrix. `HooksMap` maps all 30 events to their event-aware groups. `MatcherGroup` remains the generic compatibility alias.

`HooksConfig` contains optional `hooks`, `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, and `httpHookAllowedEnvVars`.

## Environment and library configuration

`HookEnvironmentVars` describes variables Claude Code supplies to hook processes: `CLAUDE_PROJECT_DIR`, optional `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_ENV_FILE`, `CLAUDE_EFFORT`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `CLAUDE_CODE_DEBUG_LOG_LEVEL`, and `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`.

`HookConfig` is the much smaller result of this library's `getConfig()`: debug flag, default library timeout, SessionEnd budget, plugin-install synchronization, and protection/format rule arrays.
