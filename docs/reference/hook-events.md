# Hook Events Reference

The library implements types and Zod input schemas for all 30 Claude Code hook events.

**Contract sources:** [`src/types/index.ts`](../../src/types/index.ts), [`src/validation/schemas.ts`](../../src/validation/schemas.ts)

For settings handler compatibility and matcher parsing, see [Configuring settings.json](../guides/configuring-settings-json.md). For output constructors, see [HookOutputBuilder](output-builder.md).

## Common input

Every event extends `BaseHookInput`:

| Field | Type | Notes |
|---|---|---|
| `session_id` | `string` | Current session identifier. |
| `transcript_path` | `string` | Transcript JSONL path. The file may lag the in-memory turn. |
| `cwd` | `string` | Working directory when the event fires. |
| `hook_event_name` | event literal | Selects the event schema. |
| `prompt_id` | UUID? | User-prompt correlation identifier; absent before first user input. |
| `permission_mode` | `PermissionMode?` | Manual mode is reported as `default`, not `manual`. |
| `agent_id` | `string?` | Present in subagent contexts. |
| `agent_type` | `string?` | Active agent name/type. |
| `effort` | `{ level }?` | Effective `low`, `medium`, `high`, `xhigh`, or `max`. |

Universal JSON output fields are `continue?`, `stopReason?`, `suppressOutput?`, `systemMessage?`, and `terminalSequence?`.

## Tool lifecycle

### PreToolUse

**Matcher:** `tool_name`.

**Input:** `tool_name`, `tool_input`, `tool_use_id`.

**Output:** `PreToolUseOutput` uses:

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer',
    permissionDecisionReason: string,
    updatedInput?: Record<string, unknown>,
    additionalContext?: string
  }
}
```

The older top-level `decision: 'approve' | 'block'` and `reason` fields remain compatibility fields. Prefer `HookOutputBuilder.permission()`.

### PostToolUse

**Matcher:** `tool_name`.

**Input:** `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms`.

**Output:** top-level `decision?: 'block'` and `reason?`, plus optional PostToolUse `additionalContext`, `updatedMCPToolOutput`, and `updatedToolOutput`.

Use `HookOutputBuilder.feedback()`. Output replacement accepts any value, including primitives, `null`, and falsy values.

### PostToolUseFailure

**Matcher:** `tool_name`.

**Input:** `tool_name`, `tool_input`, `tool_use_id`, `error`, optional `is_interrupt` and `duration_ms`.

**Output:** top-level block feedback plus optional `hookSpecificOutput.additionalContext` for `PostToolUseFailure`.

This is not the same output contract as PostToolUse: it has no `updatedMCPToolOutput` or `updatedToolOutput` because the tool failed. Use `HookOutputBuilder.failureFeedback()`.

### PostToolBatch

**No matcher support at runtime.**

**Input:** `tool_calls: PostToolBatchCall[]`, each with `tool_name`, `tool_input`, `tool_use_id`, and `tool_response: string | Array<Record<string, unknown>>`.

**Output:** optional top-level block/reason plus `PostToolBatch.additionalContext`. `HookOutputBuilder.batchBlock()` blocks before the next model call.

## Permissions

### PermissionRequest

**Matcher:** `tool_name`.

**Input:** `tool_name`, `tool_input`, optional `permission_suggestions`. Unlike PreToolUse, this event has no `tool_use_id`.

**Output:** nested allow/deny decision:

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision:
      | {
          behavior: 'allow',
          updatedInput?: Record<string, unknown>,
          updatedPermissions?: PermissionUpdateEntry[]
        }
      | {
          behavior: 'deny',
          message?: string,
          interrupt?: boolean
        }
  }
}
```

`PermissionUpdateEntry` supports `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, and `removeDirectories`. Rule updates carry `rules`, `behavior`, and `destination`; directory updates carry `directories` and `destination`. `setMode.mode` accepts standard permission modes plus the output-only `manual` alias.

Builders: `allowPermission()`, `denyPermission()`, `permissionRequestSetMode()`.

### PermissionDenied

**Matcher:** `tool_name`.

**Input:** `tool_name`, `tool_input`, `tool_use_id`, `reason`.

**Output:** optional `hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: boolean }`.

Use `HookOutputBuilder.permissionDeniedRetry()`.

## User interaction

### UserPromptSubmit

**No matcher support at runtime.**

**Input:** `prompt`.

**Output:** top-level `decision: 'block'` with optional `reason` and `suppressOriginalPrompt`, or `UserPromptSubmit.additionalContext`/`sessionTitle`.

Builders: `blockPrompt(reason, options?)`, `addContext()`, `sessionTitle()`.

### UserPromptExpansion

**Matcher:** `command_name`.

**Input:** `expansion_type: 'slash_command' | 'mcp_prompt'`, `command_name`, `command_args`, `command_source`, `prompt`.

**Output:** top-level block/reason or `UserPromptExpansion.additionalContext`.

### Notification

**Matcher:** `notification_type`.

**Input:** `message`, optional `title`, and one of eight notification types:

- `permission_prompt`
- `idle_prompt`
- `auth_success`
- `elicitation_dialog`
- `elicitation_complete`
- `elicitation_response`
- `agent_needs_input`
- `agent_completed`

**Output:** exactly `BaseHookOutput`. `notificationOutputSchema` is strict and rejects notification-specific fields, including `hookSpecificOutput.additionalContext`. The event has no decision control; use it for side effects such as desktop, console, Slack, or email delivery.

### MessageDisplay

**No matcher support at runtime.**

**Input:** UUID `turn_id`, UUID `message_id`, non-negative integer `index`, `final`, and `delta`. An empty final delta is valid.

**Output:** optional display-only replacement:

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'MessageDisplay',
    displayContent?: string
  }
}
```

The replacement changes rendering only, not the transcript or Claude's context. Use `HookOutputBuilder.messageDisplayContent()`.

The settings validator keeps MessageDisplay on the generic handler schema because the refreshed upstream handler matrix does not classify it; Claude Code explicitly ignores its matcher and gives it a 10-second default timeout.

### Elicitation

**Matcher:** `mcp_server_name`.

**Input:** `mcp_server_name`, `message`, optional `mode`, `requested_schema`, `url`, and `elicitation_id`.

**Output:** `Elicitation` action `accept | decline | cancel`, with optional form content. Use `HookOutputBuilder.elicitation()`.

### ElicitationResult

**Matcher:** `mcp_server_name`.

**Input:** `mcp_server_name`, `action`, optional `content`, `mode`, and `elicitation_id`.

**Output:** the same action/content contract with `hookEventName: 'ElicitationResult'`.

## Subagents and teams

### SubagentStart

**Matcher:** `agent_type`.

**Input:** `agent_id`, `agent_type`.

**Output:** optional `SubagentStart.additionalContext`. Use `HookOutputBuilder.subagentContext()`.

### SubagentStop

**Matcher:** `agent_type`.

**Input:** `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, optional `last_assistant_message`, `background_tasks`, and `session_crons`.

The two registries describe parent-session work still in flight:

- `background_tasks`: required `id`, `type`, `status`, `description`, optional task-specific fields and future metadata
- `session_crons`: required `id`, `schedule`, `recurring`, `prompt`, plus future metadata

**Output:** three exclusive modes:

1. universal fields only
2. block mode: `decision: 'block'` with a required `reason` string (presence required; empty string is accepted)
3. non-error feedback: `hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: string }`

Use `subagentStopBlock()` to block and `subagentStopAdditionalContext()` for factual feedback that continues the subagent. `subagentStopContext()` is a deprecated block alias.

### TeammateIdle

**No matcher support at runtime.**

**Input:** `teammate_name`, `team_name`.

Use exit code 2 or universal `{ continue: false, stopReason }` behavior to prevent idling. `HookOutputBuilder.teammateStop()` builds the universal stop form.

### TaskCreated

**No matcher support at runtime.**

**Input:** `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name`.

Use exit code 2 or universal stop output to roll back creation. `HookOutputBuilder.taskBlock(reason, 'TaskCreated')` builds the JSON form.

### TaskCompleted

**No matcher support at runtime.**

**Input:** the same task lifecycle fields as TaskCreated.

Use exit code 2 or universal stop output to prevent completion. `HookOutputBuilder.taskBlock(reason, 'TaskCompleted')` builds the JSON form.

## Session lifecycle

### Setup

**Matcher:** `trigger` (`init` or `maintenance`).

**Input:** `trigger`.

**Output:** optional Setup `additionalContext`. Use `HookOutputBuilder.setupContext()`.

Only command and MCP-tool handlers are accepted by the event-aware settings schema.

### SessionStart

**Matcher:** `source` (`startup`, `resume`, `clear`, or `compact`).

**Input:** `source`, optional `model`, `session_title`, and `agent_type`.

**Output:** optional `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, and `reloadSkills`.

Use either `sessionStartContext(context)` or the options overload. `CLAUDE_ENV_FILE` is also available for persisting exports. Only command and MCP-tool handlers are accepted by the event-aware settings schema.

### Stop

**No matcher support at runtime.**

**Input:** `stop_hook_active`, optional `last_assistant_message`, `background_tasks`, and `session_crons`. The registry shapes match SubagentStop.

**Output:** three exclusive modes:

1. universal fields only
2. block mode: `decision: 'block'` plus required `reason` string (presence required; empty string is accepted)
3. non-error feedback: `hookSpecificOutput: { hookEventName: 'Stop', additionalContext: string }`

Use `stopBlock()` for blocking error-style guidance and `stopContext()` for non-error context that keeps the conversation running. A block object without `reason` fails validation.

### StopFailure

**Matcher:** `error`.

**Input error values:** `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown`; optional `error_details` and `last_assistant_message`.

**Output:** side-effect-only in Claude Code. Output and exit code are ignored. The library retains `stopFailureLog()` only as a deprecated no-op compatibility shim returning `{}`. Log, notify, or persist state directly inside the handler.

### SessionEnd

**Matcher:** `reason`.

**Input reason:** `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, or `other`.

No event-specific output. The total SessionEnd handler budget defaults to 1500 ms and is capped at 60000 ms by `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.

## Instructions and configuration

### InstructionsLoaded

**Matcher:** `load_reason`.

**Input:** `file_path`, `memory_type: 'User' | 'Project' | 'Local' | 'Managed'`, `load_reason`, optional `globs`, `trigger_file_path`, `parent_file_path`.

No event-specific output; observability only.

### ConfigChange

**Matcher:** `source`.

**Input source:** `user_settings`, `project_settings`, `local_settings`, `policy_settings`, or `skills`; optional `file_path`.

**Output:** optional top-level block/reason. Policy settings cannot be blocked by runtime hook policy even though the generic output shape accepts the fields.

## File system and worktrees

### CwdChanged

**No matcher support.**

**Input:** `old_cwd`, `new_cwd`.

**Output:** optional top-level `watchPaths`. Use `HookOutputBuilder.watchPaths()`.

### FileChanged

**Matcher:** literal filenames used to build the watch list.

**Input:** `file_path`, `event: 'change' | 'add' | 'unlink'`.

**Output:** optional `watchPaths`, matching CwdChanged.

### WorktreeCreate

**No matcher support at runtime.**

**Input:** `name`.

**Output:** HTTP hooks use `hookSpecificOutput.worktreePath`; command hooks print the path directly. Any non-zero command exit fails creation. Use `HookOutputBuilder.worktreePath()` for JSON output.

### WorktreeRemove

**No matcher support at runtime.**

**Input:** `worktree_path`.

No event-specific output; cleanup/observability only.

## Compaction

### PreCompact

**Matcher:** `trigger` (`manual` or `auto`).

**Input:** `trigger`, `custom_instructions`.

**Output:** optional top-level block/reason or `PreCompact.additionalContext`.

### PostCompact

**Matcher:** `trigger`.

**Input:** `trigger`, `compact_summary`.

No event-specific output.
