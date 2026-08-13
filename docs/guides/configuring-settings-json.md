# Configuring settings.json

Hooks are registered in `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`, managed settings, plugins, skills, or agent frontmatter. The `hooks` map contains event names, matcher groups, and handler arrays.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "tsx .claude/hooks/bash-guard.ts" }
        ]
      }
    ]
  }
}
```

## Event names

The library validates all 30 events:

`Setup`, `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, and `SessionEnd`.

## Matcher semantics

A matcher filters one event-specific input field. `"*"`, `""`, or an omitted matcher matches every occurrence.

Matcher strings containing only letters, digits, `_`, `-`, spaces, `,`, and `|` use exact matching. `|` and `,` separate exact alternatives. A matcher containing another character is an unanchored JavaScript regular expression; use `^...$` when a whole-string regex match is required.

`FileChanged` and `StopFailure` have a narrower exact-match character set: letters, digits, `_`, and `|`. `FileChanged` also uses its matcher as a literal filename watch list rather than as a normal runtime filter.

| Events | Matcher target |
|---|---|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | `tool_name` |
| `SessionStart` | `source` |
| `Setup` | `trigger` |
| `SessionEnd` | `reason` |
| `Notification` | `notification_type` |
| `SubagentStart`, `SubagentStop` | `agent_type` |
| `PreCompact`, `PostCompact` | `trigger` |
| `ConfigChange` | `source` |
| `StopFailure` | `error` |
| `InstructionsLoaded` | `load_reason` |
| `UserPromptExpansion` | `command_name` |
| `Elicitation`, `ElicitationResult` | `mcp_server_name` |
| `FileChanged` | literal filenames to watch |
| `CwdChanged`, `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay` | no matcher support; any configured matcher is ignored |

### MCP tool names in tool-event matchers

MCP calls appear in tool events as `mcp__<server>__<tool>`, for example `mcp__memory__create_entities`. Plugin-bundled tools use `mcp__plugin_<plugin-name>_<server-name>__<tool>`. Match every tool from a server with a regex such as `mcp__memory__.*`.

This name is different from an `mcp_tool` hook handler's `server` field, described below.

## Handler support matrix

`validateHooksConfig()` enforces this matrix:

| Events | Accepted handler types |
|---|---|
| `PermissionDenied`, `PermissionRequest`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit` | `command`, `http`, `mcp_tool`, `prompt`, `agent` |
| `ConfigChange`, `CwdChanged`, `Elicitation`, `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `Notification`, `PostCompact`, `PreCompact`, `SessionEnd`, `StopFailure`, `SubagentStart`, `WorktreeCreate`, `WorktreeRemove` | `command`, `http`, `mcp_tool` |
| `SessionStart`, `Setup` | `command`, `mcp_tool` |
| `MessageDisplay` | all five types in this library's compatibility schema |

The refreshed upstream matrix does not classify `MessageDisplay` by handler type. The library therefore keeps its generic five-handler compatibility behavior. Claude Code does explicitly ignore `MessageDisplay.matcher` and applies a 10-second default timeout.

## Handler types

### `command`

```json
{
  "type": "command",
  "command": "node",
  "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/check.mjs"],
  "timeout": 30,
  "async": false,
  "asyncRewake": false,
  "shell": "bash"
}
```

When `args` is present, `command` is an executable and Claude Code spawns it directly without a shell. Without `args`, `command` is shell form. `shell` is ignored in exec form. `asyncRewake` implies background execution; asynchronous handlers cannot control an action that has already continued.

### `http`

```json
{
  "type": "http",
  "url": "https://hooks.example.com/pre-tool-use",
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 30
}
```

Claude Code posts the event JSON. A non-2xx response, connection failure, or timeout is non-blocking. Blocking requires a 2xx response whose JSON body contains the event's decision fields.

### `mcp_tool`

```json
{
  "type": "mcp_tool",
  "server": "my_server",
  "tool": "security_scan",
  "input": { "file_path": "${tool_input.file_path}" }
}
```

`server` is the configured MCP server name. For a plugin-bundled server it must be `plugin:<plugin-name>:<server-name>`, not the `mcp__...` tool-event name. `tool` is the bare server tool name. The server must already be connected; `SessionStart` and `Setup` commonly run before that connection exists.

### `prompt`

```json
{
  "type": "prompt",
  "prompt": "Evaluate this event: $ARGUMENTS",
  "model": "claude-haiku-4-5-20251001",
  "continueOnBlock": true,
  "timeout": 30
}
```

The model returns `{ "ok": true }` or `{ "ok": false, "reason": "..." }`. A reason is required for a negative result. `continueOnBlock` is meaningful where Claude Code permits a negative prompt decision to continue, notably `PostToolUse` and `TeammateIdle`; some events always end or continue regardless of this field, and `PermissionRequest`/`PermissionDenied` discard negative prompt or agent decisions.

### `agent`

```json
{
  "type": "agent",
  "prompt": "Inspect the repository and evaluate: $ARGUMENTS",
  "model": "claude-sonnet-4-6",
  "continueOnBlock": true,
  "timeout": 120
}
```

Agent handlers use the same decision format and `continueOnBlock` semantics as prompt handlers, but can use tools while evaluating.

## Common fields and runtime semantics

| Field | Validation | Runtime behavior |
|---|---|---|
| `timeout` | Positive number on every handler | Default 600 seconds for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`. `UserPromptSubmit` lowers external-handler defaults to 30. `MessageDisplay` defaults to 10. An explicit value overrides the event/type default. |
| `statusMessage` | Accepted on every handler | Custom spinner text while the handler runs. |
| `once` | Accepted on every handler | Honored only in skill frontmatter; inert in settings files and agent frontmatter. |
| `if` | Non-empty string accepted on every handler | Evaluated only for tool events. On other events a handler with `if` never runs. It contains one permission rule, not boolean expression syntax. |
| `continueOnBlock` | Accepted only on `prompt` and `agent` | Event-dependent as described above. |
| `async`, `asyncRewake`, `shell`, `args` | Accepted only on `command` | Other handler variants reject these fields through their object schemas. |

`CLAUDE_HOOK_TIMEOUT` is the default used by this library's `getConfig()`/reference-hook runner. It does not change Claude Code's settings-level handler defaults listed above.

## Root restriction fields

These fields are siblings of `hooks` in the settings object:

| Field | Semantics |
|---|---|
| `disableAllHooks` | Temporarily disables hooks and custom status line at that settings layer. User/project/local values cannot disable managed hooks; only managed `disableAllHooks` disables managed hooks. |
| `allowManagedHooksOnly` | Managed-settings-only policy. Loads managed hooks, SDK hooks, and hooks from plugins force-enabled by full `plugin@marketplace` ID; blocks user, project, and all other plugin hooks. |
| `allowedHttpHookUrls` | URL wildcard allowlist. Undefined means unrestricted; an empty array blocks every HTTP hook. Arrays merge across settings sources. Non-matching hooks are silently blocked. |
| `httpHookAllowedEnvVars` | Global allowlist for HTTP header interpolation. A handler's effective variables are the intersection of this list and its own `allowedEnvVars`. Undefined means no global restriction. Arrays merge across sources. |

## Validate configuration

```typescript
import { validateHooksConfig } from '@libar-dev/agent-harness-kit/validation';

const validated = validateHooksConfig(JSON.parse(settingsText));
```

The validator accepts the complete settings-shaped object represented by `HooksConfig`: optional `hooks` plus the four root fields above. Unknown hook event keys are rejected.
