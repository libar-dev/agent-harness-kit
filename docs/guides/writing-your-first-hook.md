# Writing Your First Hook

This guide walks you through building a real Bash command validator from scratch — the same pattern used by the reference implementation in [`src/pre-tool-use/bash-validator.ts`](../../src/pre-tool-use/bash-validator.ts).

By the end you will:

1. Understand the `executeHook` skeleton that every hook uses.
2. Know how to extract and validate a tool's typed input.
3. Use `HookOutputBuilder.permission()` to allow, deny, or ask.
4. Test the hook without starting Claude Code.

## The Hook Skeleton

Every hook script follows this pattern:

```typescript
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder } from '@libar-dev/agent-harness-kit/types';
import type { PreToolUseInput } from '@libar-dev/agent-harness-kit/types';

async function myHook(input: PreToolUseInput): Promise<void> {
  // your logic here — call outputJson() to send a response
}

// Guard so the module can be imported in tests without auto-running
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(myHook);
}
```

`executeHook`:
1. Reads JSON from stdin.
2. Validates it with Zod (throws if the shape is wrong).
3. Calls your handler.
4. Exits 0 on success, 1 on recoverable errors, 2 on blocking errors.

You never touch `process.stdin`, `process.stdout`, or `process.exit` directly.

## Step 1 — Validate the tool input

`input.tool_input` is typed as `Record<string, unknown>`. Use a tool-input validator to get a typed value:

```typescript
import { validateBashToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PreToolUseInput): Promise<void> {
  if (input.tool_name !== 'Bash') return; // only handle Bash calls

  const bash = validateBashToolInput(input); // throws HookValidationError if shape is wrong
  const command = bash.command.trim();       // string — fully typed
}
```

`validateBashToolInput` returns `BashToolInput`:

```typescript
interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}
```

All other tool validators follow the same pattern — see [Validators Reference](../reference/validators.md).

## Step 2 — Check the command

Use the built-in `validateBashCommand` to run the default rule set:

```typescript
import {
  validateBashToolInput,
  validateBashCommand,
} from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PreToolUseInput): Promise<void> {
  if (input.tool_name !== 'Bash') return;

  const bash = validateBashToolInput(input);
  const result = validateBashCommand(bash.command);

  // result.issues is an array of { severity: 'error'|'warning'|'info', message, suggestion }
}
```

`DEFAULT_BASH_RULES` covers patterns like `rm -rf`, `sudo`, `chmod 777`, and `dd`. You can pass custom rules as the second argument.

## Step 3 — Respond with HookOutputBuilder.permission()

`permission(decision, reason, options?)` produces the correct `hookSpecificOutput` structure:

```typescript
// Allow — bypasses the permission system entirely
outputJson(HookOutputBuilder.permission('allow', 'Safe command'));

// Deny — blocks execution, tells Claude why
outputJson(HookOutputBuilder.permission('deny', 'rm -rf is dangerous'));

// Ask — prompts the user (falls through to the normal permission dialog with your message)
outputJson(HookOutputBuilder.permission('ask', 'This command has warnings — proceed?'));

// Defer — use normal permission handling (same as returning nothing)
outputJson(HookOutputBuilder.permission('defer', 'Passing through'));
```

**No output** (returning from the handler without calling `outputJson`) means "proceed with default behavior" — equivalent to `defer`.

## Step 4 — Put it together

```typescript
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import {
  HookOutputBuilder,
  type PreToolUseInput,
} from '@libar-dev/agent-harness-kit/types';
import {
  validateBashToolInput,
  validateBashCommand,
} from '@libar-dev/agent-harness-kit/validation';

async function bashValidator(input: PreToolUseInput): Promise<void> {
  if (input.tool_name !== 'Bash') return;

  const bash = validateBashToolInput(input);
  const command = bash.command.trim();
  const result = validateBashCommand(command);

  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    const msg = errors.map(e => `${e.message}${e.suggestion ? ` — ${e.suggestion}` : ''}`).join('\n');
    outputJson(HookOutputBuilder.permission('deny', `Dangerous command:\n${msg}`));
    return;
  }

  if (warnings.length > 0) {
    const msg = warnings.map(w => w.message).join('\n');
    outputJson(HookOutputBuilder.permission('ask', `Command has warnings:\n${msg}\n\nProceed?`));
    return;
  }

  // No issues — let normal permission flow handle it
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(bashValidator);
}
```

## Step 5 — Register in settings.json

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
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The `matcher` is a regex applied to `tool_name`. `"Bash"` matches only Bash calls.

## Step 6 — Test without Claude Code

Pipe JSON directly to the script:

```bash
# Should output a deny decision
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "s1",
  "transcript_path": "/tmp/t.json",
  "cwd": "/project",
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf /"},
  "tool_use_id": "tu_1"
}' | tsx .claude/hooks/bash-validator.ts

# Should produce no output (safe command)
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "s1",
  "transcript_path": "/tmp/t.json",
  "cwd": "/project",
  "tool_name": "Bash",
  "tool_input": {"command": "git status"},
  "tool_use_id": "tu_2"
}' | tsx .claude/hooks/bash-validator.ts
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — JSON output (if any) is processed by Claude Code |
| `1` | Non-blocking error — shown to user, Claude continues |
| `2` | Blocking error — shown to Claude, Claude stops the current turn |

`executeHook` maps thrown errors to exit codes automatically. To force a blocking error without outputting JSON, throw:

```typescript
import { createBlockingError } from '@libar-dev/agent-harness-kit/utils';
throw createBlockingError('This must not proceed');
```

## Next Steps

- **[Cookbook](cookbook.md)** — recipes for PostToolUse, SessionStart, UserPromptSubmit, and other events.
- **[HookOutputBuilder Reference](../reference/output-builder.md)** — every method, every event.
- **[Hook Events Reference](../reference/hook-events.md)** — all 28 events with their input shapes.
