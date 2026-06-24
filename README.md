# @libar-dev/agent-harness-kit

> **Today: a Claude Code toolkit. Future: harness-agnostic.**
>
> This library currently targets [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — all 28 events, strict types, Zod-validated inputs, and a fluent output builder. The long-term goal is to generalize the harness layer so the same validators, builders, and session tooling work across multiple agent platforms. Claude-specific names in the API (event names, CLI binaries) will remain stable; the package itself is being repositioned to reflect that broader ambition.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/libar-dev/agent-harness-kit/releases)
[![Node ≥22](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

TypeScript library for [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) with strict types, Zod-validated inputs, and a fluent output builder for all 28 hook events.

**Why use this instead of raw shell scripts?**  
Writing hook output JSON by hand is error-prone — field names, nesting, and event-specific shapes vary across 28 event types. This library validates your inputs at the boundary and produces the right output shapes via `HookOutputBuilder`, so you write logic, not plumbing.

It also ships session-processing CLIs: export sessions to clean markdown/JSONL, and tail a live session JSONL as structured blocks for downstream ingestion. Retained tool-result bodies are secret-redacted by default (API keys, tokens, passwords, URL credentials).

## Install

Runtime support targets Node.js 22 and newer. The library is developed, type-checked, and CI-tested on a Node 24 baseline so maintainers and contributors see the current typings/tooling surface without overstating the consumer runtime floor.

```bash
pnpm add @libar-dev/agent-harness-kit
pnpm add -D tsx          # to run .ts hooks directly without a build step
```

## Quick Start

Create `.claude/hooks/bash-guard.ts`:

```typescript
#!/usr/bin/env tsx

import { executeHook, outputJson, isDangerousCommand } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type PreToolUseInput } from '@libar-dev/agent-harness-kit/types';
import { validateBashToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PreToolUseInput): Promise<void> {
  if (input.tool_name !== 'Bash') return;
  const bash = validateBashToolInput(input);  // unknown → BashToolInput (typed)
  if (isDangerousCommand(bash.command)) {
    outputJson(HookOutputBuilder.permission('deny', `Blocked: ${bash.command}`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(hook);
}
```

Register it in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "tsx .claude/hooks/bash-guard.ts" }]
      }
    ]
  }
}
```

Test it without starting Claude Code:

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"s1","transcript_path":"/tmp/t.json","cwd":"/","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"tool_use_id":"tu_1"}' \
  | tsx .claude/hooks/bash-guard.ts
```

## What's Included

| Module | Contents |
|--------|----------|
| `@libar-dev/agent-harness-kit/types` | TypeScript types for all 28 events + `HookOutputBuilder` |
| `@libar-dev/agent-harness-kit/utils` | `executeHook`, `outputJson`, `isProtectedFile`, `isDangerousCommand`, logging |
| `@libar-dev/agent-harness-kit/validation` | Zod schemas, per-event validators, 15 tool-input validators, `validateHooksConfig` |
| `@libar-dev/agent-harness-kit/pre-tool-use` | Reference handlers: bash validator, file protector, ESLint-disable blocker |
| `@libar-dev/agent-harness-kit/post-tool-use` | Reference handlers: Prettier formatter, TypeScript checker |
| `@libar-dev/agent-harness-kit/lifecycle` | Reference handlers: session start/end, notifications, stop, subagents, elicitation |

## Documentation

- **[Getting Started](docs/guides/getting-started.md)** — install, sub-path imports, 5-minute walkthrough
- **[Writing Your First Hook](docs/guides/writing-your-first-hook.md)** — `executeHook` skeleton, validators, `permission()`, testing
- **[Configuring settings.json](docs/guides/configuring-settings-json.md)** — 5 handler types, matcher syntax, `if`/`timeout`/`async`
- **[Cookbook](docs/guides/cookbook.md)** — 10 copy-pasteable recipes
- **[Hook Events Reference](docs/reference/hook-events.md)** — all 28 events with input/output shapes
- **[HookOutputBuilder Reference](docs/reference/output-builder.md)** — every method with examples
- **[Validators Reference](docs/reference/validators.md)** — tool-input validators, type guards, config validators
- **[Environment Variables](docs/reference/environment-variables.md)** — all `CLAUDE_HOOK_*` vars
- **[Full docs index](docs/README.md)**

## Development

Use Node 24 for local development to match the repo's `@types/node` baseline and CI matrix. Published runtime support remains Node 22+.

```bash
pnpm install
pnpm run check        # type-check + lint
pnpm run test:run     # run all tests (no build needed)
pnpm run fix          # auto-fix lint/formatting
pnpm run build        # compile src/ → dist/ (publish only)
```

**Absolute rule:** no `any` types. Use `unknown` + a validator instead. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Version `0.1.0` is not yet published to npm. The public API is stable but may change before the first published release. Pin to a commit hash if you depend on this from another project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist, commit style, and architecture notes.

## License

[MIT](LICENSE) © Libar AI
