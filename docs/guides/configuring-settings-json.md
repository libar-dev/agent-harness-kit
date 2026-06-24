# Configuring settings.json

Hooks are registered in `.claude/settings.json` (project-level) or `~/.claude/settings.json` (user-level). The `hooks` block maps event names to arrays of **matcher groups**, each containing an array of **handlers**.

## Structure Overview

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<regex or *>",
        "hooks": [
          { "type": "command", "command": "..." }
        ]
      }
    ]
  }
}
```

## The 28 Event Names

`SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

## Matcher Groups

A matcher group fires its handlers when the event's primary identifier matches the `matcher` regex.

For tool events (`PreToolUse`, `PostToolUse`, etc.), the matcher applies to `tool_name`. For `SubagentStart`/`SubagentStop`, it applies to `agent_type`. For `Notification`, it applies to `notification_type`.

```json
{
  "matcher": "Bash",          // matches tool_name === "Bash" exactly
  "matcher": "Write|Edit",    // matches Write or Edit
  "matcher": ".*",            // matches anything
  "matcher": ""               // also matches anything (same as omitting matcher)
}
```

Omitting `matcher` (or using `"*"` / `""`) matches all events of that type.

## The Five Handler Types

### `command` — Run a shell command

```json
{
  "type": "command",
  "command": "tsx .claude/hooks/my-hook.ts",
  "timeout": 30,
  "async": false,
  "asyncRewake": false,
  "shell": "bash"
}
```

Claude Code pipes the hook input JSON to the command's stdin and reads JSON from stdout.

`command`-specific fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `async` | boolean | `false` | Run in background without blocking Claude |
| `asyncRewake` | boolean | `false` | Background run; exit code 2 wakes Claude |
| `shell` | `"bash"` \| `"powershell"` | system default | Shell to use |

### `http` — POST to an HTTP endpoint

```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/pre-tool-use",
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 60
}
```

Claude Code sends a POST with the hook input JSON as the body. The response body is treated as hook output JSON.

`allowedEnvVars` whitelists which environment variables are interpolated into `headers` values.

### `mcp_tool` — Call a tool on a connected MCP server

```json
{
  "type": "mcp_tool",
  "server": "my_server",
  "tool": "security_scan",
  "input": { "file_path": "${tool_input.file_path}" }
}
```

The `input` object supports `${...}` template interpolation from the hook input JSON. The MCP tool's return value is treated as hook output.

### `prompt` — Single-turn LLM evaluation

```json
{
  "type": "prompt",
  "prompt": "Review this bash command for safety issues: $ARGUMENTS",
  "model": "claude-haiku-4-5-20251001",
  "timeout": 30
}
```

`$ARGUMENTS` is replaced with the hook input JSON. The model response is treated as hook output. No tool access.

### `agent` — Subagent with tool access

```json
{
  "type": "agent",
  "prompt": "Review the following code change and check for security issues: $ARGUMENTS",
  "model": "claude-sonnet-4-6",
  "timeout": 120
}
```

Same as `prompt` but the spawned agent has access to tools. Use for hooks that need to read files or run commands.

## Common Fields (all handler types)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | number | 60 (command/http), 30 (prompt), 60 (agent) | Seconds before the handler is cancelled |
| `statusMessage` | string | — | Custom spinner text shown while the hook runs |
| `once` | boolean | `false` | Run only once per session, then remove (skills only, not agents) |
| `if` | string | — | Permission-rule syntax filter; hook only runs when the condition matches |

### The `if` field

`if` uses permission-rule syntax for conditional execution:

```json
{ "type": "command", "command": "...", "if": "Bash(git *)" }
```

This runs only when the tool is `Bash` and the command matches `git *`.

## Settings-Root Restriction Fields

These fields live at the root of the settings object (not inside `hooks`):

| Field | Description |
|-------|-------------|
| `allowManagedHooksOnly` | Restricts hooks to managed and force-enabled plugin hooks |
| `allowedHttpHookUrls` | URL patterns that HTTP hooks may target |
| `httpHookAllowedEnvVars` | Environment variable names HTTP hooks may interpolate globally |

## Full Example

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/bash-validator.ts",
            "timeout": 10,
            "statusMessage": "Checking command safety..."
          }
        ]
      },
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/file-protector.ts",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/format-code.ts",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/session-start.ts",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/notify.ts",
            "async": true
          }
        ]
      }
    ]
  }
}
```

## Starter and Example Configurations

The `examples/` directory contains ready-to-use settings files:

| File | Description |
|------|-------------|
| `settings.starter.json` | Minimal setup: bash validator, code formatter, notification |
| `settings.comprehensive.json` | All hook event types configured |
| `settings.example.json` | Annotated minimal example |
| `settings.direct-typescript.json` | Running `.ts` hooks directly via `tsx` |
| `http-hook-settings.json` | HTTP handler configuration |

## Type-Checking Your Configuration

Use `validateHooksConfig` to validate a parsed settings object at runtime:

```typescript
import { validateHooksConfig } from '@libar-dev/agent-harness-kit/validation';

const config = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
const validated = validateHooksConfig(config); // throws if invalid
```
