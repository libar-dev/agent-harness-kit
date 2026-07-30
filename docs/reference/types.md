# Types Reference

Public TypeScript types exported by `@libar-dev/agent-harness-kit/types`.

**Source:** [`src/types/index.ts`](../../src/types/index.ts)

## Base Types

| Type | Description |
|------|-------------|
| `BaseHookInput` | Common fields in every hook input (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `agent_id`, `agent_type`, `effort`) |
| `BaseHookOutput` | Common output fields (`continue`, `stopReason`, `suppressOutput`, `systemMessage`, `terminalSequence`) |
| `HookInput` | Union of all 30 per-event input types |
| `HookOutput` | Union of all per-event output types |
| `PermissionMode` | `'default' \| 'plan' \| 'acceptEdits' \| 'auto' \| 'dontAsk' \| 'bypassPermissions'` |
| `PermissionUpdateEntry` | `{ type: string; [key: string]: unknown }` — used in permission update arrays |
| `ElicitationAction` | `'accept' \| 'decline' \| 'cancel'` |
| `ElicitationMode` | `'form' \| 'url'` |

## Per-Event Input Types

All extend `BaseHookInput`.

### Tool Lifecycle

| Type | Key additional fields |
|------|----------------------|
| `PreToolUseInput` | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUseInput` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?` |
| `PostToolUseFailureInput` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt?`, `duration_ms?` |
| `PostToolBatchInput` | `tool_calls: PostToolBatchCall[]` |

`PostToolBatchCall`: `{ tool_name, tool_input, tool_use_id, tool_response }`.

### Permissions

| Type | Key additional fields |
|------|----------------------|
| `PermissionRequestInput` | `tool_name`, `tool_input`, `permission_suggestions?` (no `tool_use_id`) |
| `PermissionDeniedInput` | `tool_name`, `tool_input`, `tool_use_id`, `reason` |

### User Interaction

| Type | Key additional fields |
|------|----------------------|
| `UserPromptSubmitInput` | `prompt` |
| `UserPromptExpansionInput` | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` |
| `NotificationInput` | `message`, `title?`, `notification_type` |
| `MessageDisplayInput` | `turn_id`, `message_id`, `index`, `final`, `delta` |
| `ElicitationInput` | `mcp_server_name`, `message`, `mode?`, `requested_schema?`, `url?`, `elicitation_id?` |
| `ElicitationResultInput` | `mcp_server_name`, `action`, `content?`, `mode?`, `elicitation_id?` |

### Subagents & Teams

| Type | Key additional fields |
|------|----------------------|
| `SubagentStartInput` | `agent_id`, `agent_type` |
| `SubagentStopInput` | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message?` |
| `TeammateIdleInput` | `teammate_name`, `team_name` |
| `TaskCreatedInput` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
| `TaskCompletedInput` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |

### Session Lifecycle

| Type | Key additional fields |
|------|----------------------|
| `SetupInput` | `trigger` |
| `SessionStartInput` | `source`, `model`, `agent_type?` |
| `SessionEndInput` | `reason` |
| `StopInput` | `stop_hook_active`, `last_assistant_message?` |
| `StopFailureInput` | `error` (enum), `error_details?`, `last_assistant_message?` |

### Instructions & Config

| Type | Key additional fields |
|------|----------------------|
| `InstructionsLoadedInput` | `file_path`, `memory_type`, `load_reason`, `globs?`, `trigger_file_path?`, `parent_file_path?` |
| `ConfigChangeInput` | `source`, `file_path?` |

### File System

| Type | Key additional fields |
|------|----------------------|
| `CwdChangedInput` | `old_cwd`, `new_cwd` |
| `FileChangedInput` | `file_path`, `event` |
| `WorktreeCreateInput` | `name` |
| `WorktreeRemoveInput` | `worktree_path` |

### Compaction

| Type | Key additional fields |
|------|----------------------|
| `PreCompactInput` | `trigger`, `custom_instructions` |
| `PostCompactInput` | `trigger`, `compact_summary` |

## Per-Event Output Types

All extend `BaseHookOutput`.

| Type | Description |
|------|-------------|
| `PreToolUseOutput` | Permission decision via `hookSpecificOutput` |
| `PostToolUseOutput` | Feedback to Claude via `decision: 'block'` + `reason` |
| `PostToolUseFailureOutput` | Same shape as `PostToolUseOutput` |
| `PostToolBatchOutput` | Block the loop before the next model call |
| `PermissionRequestOutput` | Allow/deny decision via `hookSpecificOutput.decision` |
| `PermissionDeniedOutput` | Retry guidance via `hookSpecificOutput.retry` |
| `UserPromptSubmitOutput` | Block prompt or add context/title |
| `UserPromptExpansionOutput` | Block expansion or add context |
| `NotificationOutput` | Add `additionalContext` |
| `MessageDisplayOutput` | Override the currently rendered message chunk |
| `SubagentStartOutput` | Add `additionalContext` to subagent's system prompt |
| `SetupOutput` | Add `additionalContext` during setup |
| `SessionStartOutput` | Add `additionalContext` to session |
| `StopOutput` | Block stopping via `decision: 'block'` + `reason` |
| `PreCompactOutput` | Block compaction or inject `additionalContext` |
| `ConfigChangeOutput` | Block config change via `decision: 'block'` |
| `WatchPathsOutput` | Update watched paths via `watchPaths: string[]` |
| `WorktreeCreateOutput` | Return custom `worktreePath` via `hookSpecificOutput` |
| `ElicitationOutput` | Programmatic response via `hookSpecificOutput.action` |

## Tool Input Types

| Type | Fields |
|------|--------|
| `BashToolInput` | `command: string`, `description?`, `timeout?`, `run_in_background?` |
| `WriteToolInput` | `file_path: string`, `content: string` |
| `EditToolInput` | `file_path: string`, `old_string: string`, `new_string: string`, `replace_all?` |
| `MultiEditToolInput` | `file_path: string`, `edits: Array<{ old_string, new_string, replace_all? }>` |
| `ReadToolInput` | `file_path: string`, `offset?`, `limit?` |
| `GlobToolInput` | `pattern: string`, `path?` |
| `GrepToolInput` | `pattern: string`, `path?`, `glob?`, `type?`, `output_mode?`, `multiline?`, `-i?`, `-n?`, `-A?`, `-B?`, `-C?` |
| `WebFetchToolInput` | `url: string`, `prompt: string` |
| `WebSearchToolInput` | `query: string`, `allowed_domains?`, `blocked_domains?` |
| `AgentToolInput` | `prompt: string`, `description?`, `subagent_type?`, `model?` |
| `AskUserQuestionToolInput` | `questions: Array<{ question, header, options, multiSelect? }>`, `answers?` |
| `ExitPlanModeToolInput` | `{}` (empty) |
| `TodoWriteToolInput` | `todos: Array<{ content, status, activeForm }>` |
| `MCPToolInput` | `Record<string, unknown>` |
| `TaskToolInput` | `prompt: string`, `description?`, `subagent_type?`, `model?` |

## Hook Handler Types (settings.json)

| Type | Key fields |
|------|-----------|
| `CommandHookHandler` | `type: 'command'`, `command: string`, `args?: string[]`, `async?`, `asyncRewake?`, `shell?` |
| `HttpHookHandler` | `type: 'http'`, `url: string`, `headers?`, `allowedEnvVars?` |
| `McpToolHookHandler` | `type: 'mcp_tool'`, `server: string`, `tool: string`, `input?` |
| `PromptHookHandler` | `type: 'prompt'`, `prompt: string`, `model?` |
| `AgentHookHandler` | `type: 'agent'`, `prompt: string`, `model?` |
| `HookHandler` | Union of the five handler types (discriminated on `type`) |
| `MatcherGroup` | `{ matcher?: string; hooks: HookHandler[] }` |
| `HooksConfig` | `{ hooks?: Partial<Record<HookEventName, MatcherGroup[]>>; allowManagedHooksOnly?; allowedHttpHookUrls?; httpHookAllowedEnvVars? }` |
| `HookEventName` | Union of all 30 event name strings |

All handler types share base fields: `timeout?`, `statusMessage?`, `once?`, `if?`.

## Environment and Config Types

| Type | Description |
|------|-------------|
| `HookEnvironmentVars` | Environment variables set by Claude Code in the hook process |
| `HookConfig` | Parsed configuration from `getConfig()` |

`HookEnvironmentVars` key fields: `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_REMOTE?`, `CLAUDE_ENV_FILE?` (SessionStart only), `CLAUDE_PLUGIN_ROOT?`, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS?`, `CLAUDE_CODE_DEBUG_LOG_LEVEL?`.

## Utility

### `isHookType(input, eventName)`

```typescript
isHookType<T extends HookInput>(input: HookInput, eventName: T['hook_event_name']): input is T
```

Type guard that narrows `HookInput` to a specific event type.

```typescript
if (isHookType<PreToolUseInput>(input, 'PreToolUse')) {
  // input is PreToolUseInput
}
```
