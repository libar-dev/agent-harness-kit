# Hook Events Reference

All 30 Claude Code hook events. For each event: when it fires, its input fields, the output it accepts, and the `HookOutputBuilder` method to use.

**Source of truth for types:** [`src/types/index.ts`](../../src/types/index.ts)

---

## Table of Contents

**Tool Lifecycle**
- [PreToolUse](#pretooluse) · [PostToolUse](#posttooluse) · [PostToolUseFailure](#posttoolusefailure) · [PostToolBatch](#posttoolbatch)

**Permissions**
- [PermissionRequest](#permissionrequest) · [PermissionDenied](#permissiondenied)

**User Interaction**
- [UserPromptSubmit](#userpromptsubmit) · [UserPromptExpansion](#userpromptexpansion) · [Notification](#notification) · [MessageDisplay](#messagedisplay) · [Elicitation](#elicitation) · [ElicitationResult](#elicitationresult)

**Subagents & Teams**
- [SubagentStart](#subagentstart) · [SubagentStop](#subagentstart) · [TeammateIdle](#teammateidle) · [TaskCreated](#taskcreated) · [TaskCompleted](#taskcompleted)

**Session Lifecycle**
- [Setup](#setup) · [SessionStart](#sessionstart) · [Stop](#stop) · [StopFailure](#stopfailure) · [SessionEnd](#sessionend)

**Instructions & Config**
- [InstructionsLoaded](#instructionsloaded) · [ConfigChange](#configchange)

**File System**
- [CwdChanged](#cwdchanged) · [FileChanged](#filechanged) · [WorktreeCreate](#worktreecreate) · [WorktreeRemove](#worktreeremove)

**Compaction**
- [PreCompact](#precompact) · [PostCompact](#postcompact)

---

## Base Fields

Every event's input includes these fields (from `BaseHookInput`):

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Unique identifier for the current session |
| `transcript_path` | `string` | Absolute path to the conversation transcript JSON |
| `cwd` | `string` | Current working directory when the hook fires |
| `hook_event_name` | `string` | The event name (matches the key in `settings.json`) |
| `permission_mode` | `PermissionMode?` | Current permission mode (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) |
| `agent_id` | `string?` | Subagent context identifier when present |
| `agent_type` | `string?` | Agent name when running inside a subagent |

Base output fields (from `BaseHookOutput`, applicable to all events):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `continue` | `boolean` | `true` | Set to `false` to stop Claude |
| `stopReason` | `string` | — | Message shown when `continue` is false |
| `suppressOutput` | `boolean` | `false` | Hide stdout from transcript mode |
| `systemMessage` | `string` | — | Optional warning shown to the user |

---

## Tool Lifecycle

### PreToolUse

**When it fires:** Before any tool call executes. The hook can allow, deny, or ask about the call.

**Matcher target:** `tool_name`

**Input** (`PreToolUseInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Name of the tool about to run (`Bash`, `Write`, `Read`, etc.) |
| `tool_input` | `Record<string, unknown>` | Parameters for the tool — use a [tool-input validator](validators.md) |
| `tool_use_id` | `string` | Unique identifier for this tool use |

**Output** (`PreToolUseOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer',
    permissionDecisionReason: string,
    updatedInput?: Record<string, unknown>,   // modify tool params before execution
    additionalContext?: string,               // add to Claude's context
  }
}
```

No output (or `defer`) = proceed with normal permission handling.

**Builder methods:** `HookOutputBuilder.permission(decision, reason, options?)`

```typescript
// Allow — bypasses the permission system
outputJson(HookOutputBuilder.permission('allow', 'Safe command'));

// Deny — blocks the tool call
outputJson(HookOutputBuilder.permission('deny', 'rm -rf is not allowed'));

// Ask — prompts the user with your message
outputJson(HookOutputBuilder.permission('ask', 'This looks risky — proceed?'));

// Modify the tool input before it runs
outputJson(HookOutputBuilder.permission('allow', 'Redirected to safe path', {
  updatedInput: { file_path: '/safe/path/output.txt' }
}));
```

---

### PostToolUse

**When it fires:** After a tool call succeeds. Used to run formatters, type-checkers, or feed observations back to Claude.

**Matcher target:** `tool_name`

**Input** (`PostToolUseInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Name of the tool that ran |
| `tool_input` | `Record<string, unknown>` | Parameters that were passed |
| `tool_response` | `Record<string, unknown>` | The tool's output |
| `tool_use_id` | `string` | Unique identifier for this tool use |

**Output** (`PostToolUseOutput`):

```typescript
{
  decision?: 'block',
  reason?: string,
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse',
    additionalContext?: string,
    updatedMCPToolOutput?: Record<string, unknown>,  // MCP tools only
  }
}
```

**Builder method:** `HookOutputBuilder.feedback(reason, additionalContext?, updatedMCPToolOutput?)`

```typescript
outputJson(HookOutputBuilder.feedback('Formatted file with Prettier'));
outputJson(HookOutputBuilder.feedback('TypeScript errors found', tscOutput));
```

---

### PostToolUseFailure

**When it fires:** After a tool call fails (error returned). Provides additional context about the failure to Claude.

**Matcher target:** `tool_name`

**Input** (`PostToolUseFailureInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Name of the tool that failed |
| `tool_input` | `Record<string, unknown>` | Parameters that were passed |
| `tool_use_id` | `string` | Unique identifier for this tool use |
| `error` | `string` | Error description |
| `is_interrupt` | `boolean?` | Whether failure was caused by user interruption |

**Output** (`PostToolUseFailureOutput`): Same shape as PostToolUse output.

**Builder method:** `HookOutputBuilder.feedback(reason, additionalContext?)`

---

### PostToolBatch

**When it fires:** After a batch of parallel tool calls completes (one notification per batch, not per tool).

**Input** (`PostToolBatchInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_calls` | `PostToolBatchCall[]` | All tool call results in the batch |

`PostToolBatchCall` fields: `tool_name`, `tool_input`, `tool_use_id`, `tool_response`.

**Output** (`PostToolBatchOutput`):

```typescript
{
  decision?: 'block',
  reason?: string,
  hookSpecificOutput?: {
    hookEventName: 'PostToolBatch',
    additionalContext?: string,
  }
}
```

**Builder method:** `HookOutputBuilder.batchBlock(reason)`

---

## Permissions

### PermissionRequest

**When it fires:** When Claude Code shows a permission dialog to the user. The hook can approve, deny, or update permissions automatically.

**Matcher target:** `tool_name`

**Input** (`PermissionRequestInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Tool requesting permission |
| `tool_input` | `Record<string, unknown>` | Tool parameters |
| `permission_suggestions` | `PermissionUpdateEntry[]?` | "Always allow" options shown in the dialog |

> Unlike PreToolUse, `PermissionRequest` does **not** include `tool_use_id`.

**Output** (`PermissionRequestOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'allow',
      updatedInput?: Record<string, unknown>,
      updatedPermissions?: PermissionUpdateEntry[],
    } | {
      behavior: 'deny',
      message?: string,
      interrupt?: boolean,
    }
  }
}
```

**Builder methods:**

```typescript
// Auto-allow
outputJson(HookOutputBuilder.allowPermission());

// Auto-allow and apply an "always allow" rule
outputJson(HookOutputBuilder.allowPermission({ updatedPermissions: [...] }));

// Deny with a message to Claude
outputJson(HookOutputBuilder.denyPermission({ message: 'Not allowed in this project' }));

// Change permission mode
outputJson(HookOutputBuilder.permissionRequestSetMode('auto', 'session'));
```

---

### PermissionDenied

**When it fires:** When auto mode denies a tool call. The hook can tell Claude whether to retry.

**Matcher target:** `tool_name`

**Input** (`PermissionDeniedInput`):

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Tool that was denied |
| `tool_input` | `Record<string, unknown>` | Tool parameters |
| `tool_use_id` | `string` | Unique identifier for this tool use |
| `reason` | `string` | Auto mode classifier explanation |

**Output** (`PermissionDeniedOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'PermissionDenied',
    retry: boolean,
  }
}
```

**Builder method:** `HookOutputBuilder.permissionDeniedRetry(retry)`

---

## User Interaction

### UserPromptSubmit

**When it fires:** When the user submits a prompt. Can add context, block the prompt, or set the session title.

**Input** (`UserPromptSubmitInput`):

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The prompt text submitted |

**Output** (`UserPromptSubmitOutput`):

```typescript
{
  decision?: 'block',
  reason?: string,    // shown to user, NOT added to context
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit',
    additionalContext?: string,
    sessionTitle?: string,
  }
}
```

**Builder methods:**

```typescript
outputJson(HookOutputBuilder.blockPrompt('Contains a secret'));
outputJson(HookOutputBuilder.addContext('Current date: 2026-04-24'));
outputJson(HookOutputBuilder.sessionTitle('Feature: auth refactor'));
```

---

### UserPromptExpansion

**When it fires:** Before a slash command or MCP prompt expands. Can add context or block expansion.

**Input** (`UserPromptExpansionInput`):

| Field | Type | Description |
|-------|------|-------------|
| `expansion_type` | `'slash_command' \| 'mcp_prompt'` | Source type |
| `command_name` | `string` | Command or MCP prompt name |
| `command_args` | `string` | Raw arguments |
| `command_source` | `string` | Source that provided the command |
| `prompt` | `string` | Original user prompt |

**Output:** Same shape as `UserPromptSubmitOutput` but `hookEventName: 'UserPromptExpansion'`.

---

### Notification

**When it fires:** When Claude Code sends a notification to the user (permission prompt, idle, auth, elicitation dialog).

**Matcher target:** `notification_type`

**Input** (`NotificationInput`):

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string` | Notification message |
| `title` | `string?` | Notification title |
| `notification_type` | `'permission_prompt' \| 'idle_prompt' \| 'auth_success' \| 'elicitation_dialog'` | Type filter |

**Output:** `NotificationOutput` — can add `additionalContext`. No decision control.

---

### MessageDisplay

**When it fires:** While assistant text is streaming. The hook can override the currently rendered chunk content.

**Input** (`MessageDisplayInput`):

| Field | Type | Description |
|-------|------|-------------|
| `turn_id` | `string` | Unique identifier for the current turn |
| `message_id` | `string` | Unique identifier for the message being displayed |
| `index` | `number` | Zero-based chunk index for this display delta |
| `final` | `boolean` | Whether this is the final chunk |
| `delta` | `string` | Delta text being displayed |

**Output** (`MessageDisplayOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'MessageDisplay',
    displayContent?: string,
  }
}
```

**Builder method:** `HookOutputBuilder.messageDisplayContent(content)`

```typescript
outputJson(HookOutputBuilder.messageDisplayContent(validatedInput.delta));
```

---

### Elicitation

**When it fires:** When an MCP server requests user input via the elicitation protocol.

**Input** (`ElicitationInput`):

| Field | Type | Description |
|-------|------|-------------|
| `mcp_server_name` | `string` | MCP server requesting input |
| `message` | `string` | Message shown to the user |
| `mode` | `'form' \| 'url'?` | Elicitation mode |
| `requested_schema` | `Record<string, unknown>?` | JSON schema for form fields |
| `url` | `string?` | Auth URL for URL mode |
| `elicitation_id` | `string?` | Unique identifier |

**Output** (`ElicitationOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'Elicitation' | 'ElicitationResult',
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  }
}
```

**Builder method:** `HookOutputBuilder.elicitation(action, content?, hookEventName?)`

---

### ElicitationResult

**When it fires:** After the user responds to an elicitation request. Allows the hook to observe or override the result.

**Input** (`ElicitationResultInput`):

| Field | Type | Description |
|-------|------|-------------|
| `mcp_server_name` | `string` | MCP server that requested input |
| `action` | `'accept' \| 'decline' \| 'cancel'` | User's action |
| `content` | `Record<string, unknown>?` | Response content |
| `mode` | `'form' \| 'url'?` | Elicitation mode |
| `elicitation_id` | `string?` | Unique identifier |

**Output:** Same as Elicitation. Pass `hookEventName: 'ElicitationResult'` to the builder.

---

## Subagents & Teams

### SubagentStart

**When it fires:** When a subagent (Agent tool) is spawned.

**Matcher target:** `agent_type`

**Input** (`SubagentStartInput`):

| Field | Type | Description |
|-------|------|-------------|
| `agent_id` | `string` | Unique subagent identifier |
| `agent_type` | `string` | Agent type name (used for matcher filtering) |

**Output** (`SubagentStartOutput`): Inject context into the subagent's system prompt.

**Builder method:** `HookOutputBuilder.subagentContext(context)`

---

### SubagentStop

**When it fires:** When a subagent completes (or is stopped).

**Input** (`SubagentStopInput`): Extends `StopInput` with `agent_id`, `agent_type`, `agent_transcript_path`.

**Output** (`StopOutput`): Can block to provide additional context or prevent stopping.

**Builder method:** `HookOutputBuilder.subagentStopContext(reason)`

---

### TeammateIdle

**When it fires:** When a teammate in a multi-agent team is about to go idle.

**Input** (`TeammateIdleInput`):

| Field | Type | Description |
|-------|------|-------------|
| `teammate_name` | `string` | Teammate going idle |
| `team_name` | `string` | Team name |

**Output:** Exit code only — no JSON decision control. Non-zero exit stops the teammate.

**Builder method:** `HookOutputBuilder.teammateStop(reason)` (sets `continue: false`)

---

### TaskCreated

**When it fires:** When a task is being created.

**Input** (`TaskCreatedInput`):

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | `string` | Task identifier |
| `task_subject` | `string` | Task title |
| `task_description` | `string?` | Detailed description |
| `teammate_name` | `string?` | Teammate creating the task |
| `team_name` | `string?` | Team name |

**Output:** `continue: false` + `stopReason` to block task creation.

**Builder method:** `HookOutputBuilder.taskBlock(reason, 'TaskCreated')`

---

### TaskCompleted

**When it fires:** When a task is being marked as completed. Exit code only (no JSON decision control).

**Input** (`TaskCompletedInput`): Same fields as `TaskCreated`.

**Builder method:** `HookOutputBuilder.taskBlock(reason, 'TaskCompleted')`

---

## Session Lifecycle

### Setup

**When it fires:** During init-only or maintenance mode before the main session lifecycle begins.

**Input** (`SetupInput`):

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | `'init' \| 'maintenance'` | How setup was triggered |

**Output** (`SetupOutput`):

```typescript
{
  hookSpecificOutput: {
    hookEventName: 'Setup',
    additionalContext?: string,
  }
}
```

**Builder method:** `HookOutputBuilder.setupContext(context)`

```typescript
outputJson(HookOutputBuilder.setupContext('Repository bootstrap complete'));
```

---

### SessionStart

**When it fires:** At the beginning of every session (startup, resume, clear, compact).

**Input** (`SessionStartInput`):

| Field | Type | Description |
|-------|------|-------------|
| `source` | `'startup' \| 'resume' \| 'clear' \| 'compact'` | How the session started |
| `model` | `string` | The model identifier |
| `agent_type` | `string?` | Agent name if started with `--agent` |

**Special env var:** `CLAUDE_ENV_FILE` — write `export VAR=value` lines to persist env vars for the session.

**Output** (`SessionStartOutput`): Inject context into the session.

**Builder method:** `HookOutputBuilder.sessionStartContext(context)`

---

### Stop

**When it fires:** When Claude finishes responding (end of turn).

**Input** (`StopInput`):

| Field | Type | Description |
|-------|------|-------------|
| `stop_hook_active` | `boolean` | True when already continuing due to a stop hook — guard against loops |
| `last_assistant_message` | `string?` | Claude's final response text |

**Output** (`StopOutput`): Return `decision: 'block'` with a `reason` to make Claude continue.

**Builder method:** `HookOutputBuilder.subagentStopContext(reason)` (sets `decision: 'block'`)

---

### StopFailure

**When it fires:** When a turn ends due to an API error.

**Input** (`StopFailureInput`):

| Field | Type | Description |
|-------|------|-------------|
| `error` | `'rate_limit' \| 'authentication_failed' \| 'billing_error' \| 'invalid_request' \| 'server_error' \| 'max_output_tokens' \| 'unknown'` | Error type |
| `error_details` | `string?` | Additional error information |
| `last_assistant_message` | `string?` | Rendered error text |

**Builder method:** `HookOutputBuilder.stopFailureLog(systemMessage?)`

---

### SessionEnd

**When it fires:** When a session ends.

**Input** (`SessionEndInput`):

| Field | Type | Description |
|-------|------|-------------|
| `reason` | `'clear' \| 'resume' \| 'logout' \| 'prompt_input_exit' \| 'bypass_permissions_disabled' \| 'other'` | Why the session ended |

**Output:** None (observability only).

**Total timeout:** `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` (default 1500 ms, max 60000 ms).

---

## Instructions & Config

### InstructionsLoaded

**When it fires:** When Claude Code loads a CLAUDE.md or other instruction file.

**Input** (`InstructionsLoadedInput`):

| Field | Type | Description |
|-------|------|-------------|
| `file_path` | `string` | Path to the loaded file |
| `memory_type` | `'User' \| 'Project' \| 'Local' \| 'Managed'` | Instruction type |
| `load_reason` | `'session_start' \| 'nested_traversal' \| 'path_glob_match' \| 'include' \| 'compact'` | Why it was loaded |
| `globs` | `string[]?` | Globs that caused loading |
| `trigger_file_path` | `string?` | File that triggered the load |
| `parent_file_path` | `string?` | Parent instruction file for includes |

**Output:** None (observability only).

---

### ConfigChange

**When it fires:** When Claude Code settings change at runtime.

**Input** (`ConfigChangeInput`):

| Field | Type | Description |
|-------|------|-------------|
| `source` | `'user_settings' \| 'project_settings' \| 'local_settings' \| 'policy_settings' \| 'skills'` | Source of change |
| `file_path` | `string?` | Changed file |

**Output** (`ConfigChangeOutput`): `decision: 'block'` + `reason` to reject the change.

---

## File System

### CwdChanged

**When it fires:** When the working directory changes.

**Input** (`CwdChangedInput`):

| Field | Type | Description |
|-------|------|-------------|
| `old_cwd` | `string` | Previous working directory |
| `new_cwd` | `string` | New working directory |

**Output** (`WatchPathsOutput`): Return `watchPaths` to update the file-watch list.

**Builder method:** `HookOutputBuilder.watchPaths(paths)`

---

### FileChanged

**When it fires:** When a watched file changes (add, change, or unlink).

**Matcher target:** `file_path`

**Input** (`FileChangedInput`):

| Field | Type | Description |
|-------|------|-------------|
| `file_path` | `string` | Absolute path to the changed file |
| `event` | `'change' \| 'add' \| 'unlink'` | Watcher event |

**Output:** Same as `CwdChanged` — can update the watch path list.

---

### WorktreeCreate

**When it fires:** When a git worktree is being created.

**Input** (`WorktreeCreateInput`):

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Slug identifier for the new worktree |

**Output** (`WorktreeCreateOutput`): Return an absolute path to place the worktree.

> **Any non-zero exit code is treated as a creation failure** (regardless of JSON output).

**Builder method:** `HookOutputBuilder.worktreePath(absolutePath)`

---

### WorktreeRemove

**When it fires:** When a git worktree is being removed.

**Input** (`WorktreeRemoveInput`):

| Field | Type | Description |
|-------|------|-------------|
| `worktree_path` | `string` | Absolute path to the worktree being removed |

**Output:** None (observability only).

---

## Compaction

### PreCompact

**When it fires:** Before the conversation is compacted (manual `/compact` or auto on full context).

**Input** (`PreCompactInput`):

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | `'manual' \| 'auto'` | What triggered compaction |
| `custom_instructions` | `string` | User-provided instructions (manual) or empty (auto) |

**Output** (`PreCompactOutput`): `decision: 'block'` to prevent compaction, or `additionalContext` to inject into the compaction.

---

### PostCompact

**When it fires:** After compaction completes.

**Input** (`PostCompactInput`):

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | `'manual' \| 'auto'` | What triggered compaction |
| `compact_summary` | `string` | Generated conversation summary |

**Output:** None (observability only).
