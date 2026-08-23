# Getting Started

`@libar-dev/agent-harness-kit` is a TypeScript library for writing [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks). It provides:

- **Type-safe input** for all 30 hook events via Zod-validated interfaces.
- **`HookOutputBuilder`** — a fluent builder that produces the correct JSON output shape for every hook event without you needing to remember the nested structure.
- **Reference implementations** — production-ready handlers for bash validation, file protection, auto-formatting, session management, and more.
- **`executeHook()`** — a runner that handles stdin/stdout, Zod validation, and exit codes for you.

## When to use this library

Use it when you want type-checked, maintainable hook scripts that compose well with the rest of your TypeScript toolchain. If you just need a one-liner shell check, a raw shell script is fine — this library pays off when your hooks grow complex.

## Prerequisites

- Node.js ≥ 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- `tsx` for running `.ts` hook scripts directly (recommended)

Maintainers develop and type-check this repo on Node 24, but the published package is intended to run on Node 22+.

## Installation

```bash
pnpm add @libar-dev/agent-harness-kit
pnpm add -D tsx                        # to run .ts hooks directly
```

Or with npm/yarn:

```bash
npm install @libar-dev/agent-harness-kit
npm install -D tsx
```

## Your First Hook in 5 Minutes

### 1. Write a hook script

Create `.claude/hooks/my-hook.ts`:

```typescript
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder } from '@libar-dev/agent-harness-kit/types';
import type { PreToolUseInput } from '@libar-dev/agent-harness-kit/types';

async function hook(input: PreToolUseInput): Promise<void> {
  // Allow all Bash commands through, but log what was called
  if (input.tool_name === 'Bash') {
    outputJson(HookOutputBuilder.permission('allow', 'Bash approved by my-hook'));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(hook);
}
```

### 2. Register it in `.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "tsx .claude/hooks/my-hook.ts"
          }
        ]
      }
    ]
  }
}
```

### 3. Test it manually

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"test","transcript_path":"/tmp/t.json","cwd":"/","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"tu_1"}' \
  | tsx .claude/hooks/my-hook.ts
```

You should see the JSON output Claude Code would receive:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Bash approved by my-hook"
  }
}
```

### 4. Use it with Claude Code

Start Claude Code in your project — the hook fires automatically every time Claude uses the Bash tool.

## Hook I/O Protocol

Claude Code communicates with hooks over stdio:

| Direction | Format |
|-----------|--------|
| Input | JSON object via stdin |
| Output | JSON object via stdout (optional — silence means "proceed") |
| Exit code | 0 = success, 1 = non-blocking error, 2 = blocking error |

`executeHook()` handles all of this. You only need to call `outputJson()` when you want to send a structured response.

## Sub-path Exports

The package exposes several sub-paths so you only import what you need:

| Import | Contents |
|--------|----------|
| `@libar-dev/agent-harness-kit/types` | All types + `HookOutputBuilder` |
| `@libar-dev/agent-harness-kit/utils` | `executeHook`, `outputJson`, `readStdinJson`, logging, `isProtectedFile`, etc. |
| `@libar-dev/agent-harness-kit/validation` | Zod schemas, per-event validators, tool-input validators |
| `@libar-dev/agent-harness-kit/pre-tool-use` | Reference PreToolUse handlers |
| `@libar-dev/agent-harness-kit/post-tool-use` | Reference PostToolUse handlers |
| `@libar-dev/agent-harness-kit/lifecycle` | Reference lifecycle handlers |
| `@libar-dev/agent-harness-kit/processing` | Claude session parse, export, and raw transcript tailing |
| `@libar-dev/agent-harness-kit/grok` | Attach-only Grok Build hook I/O |
| `@libar-dev/agent-harness-kit/grok/processing` | Grok session discovery and tailing |
| `@libar-dev/agent-harness-kit/senpi` | Attach-only OmO-native (senpi) hook I/O and trust helpers |
| `@libar-dev/agent-harness-kit/senpi/processing` | Senpi session discovery, projection, and tailing |
| `@libar-dev/agent-harness-kit/endpoint-discovery` | Hook-endpoint file contract |
| `@libar-dev/agent-harness-kit/forwarder` | Standalone forwarder wrapper asset |

## What Next?

- **[Writing Your First Hook](writing-your-first-hook.md)** — end-to-end walkthrough building a real Bash command validator.
- **[Configuring settings.json](configuring-settings-json.md)** — all five handler types, matcher syntax, and timing fields.
- **[Cookbook](cookbook.md)** — ten copy-pasteable recipes for common hook patterns.
- **[Hook Events Reference](../reference/hook-events.md)** — all 30 events with input/output shapes.
- **[HookOutputBuilder Reference](../reference/output-builder.md)** — every method with signatures and examples.
