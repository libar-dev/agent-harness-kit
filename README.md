# @libar-dev/agent-harness-kit

> **Today: a Claude Code toolkit. Future: harness-agnostic.**
>
> This library currently targets [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks). The long-term goal is to generalize the harness layer so the same validators, builders, and session tooling work across multiple agent platforms. Claude-specific API names (event names, CLI binaries) will remain stable.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/libar-dev/agent-harness-kit/releases)
[![Node ≥22](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

TypeScript library for [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) with strict types, Zod-validated inputs, and a fluent output builder for all 30 hook events.

**Why use this instead of raw shell scripts?**  
Writing hook output JSON by hand is error-prone: field names, nesting, and event-specific shapes vary across 30 event types. This library validates inputs at the boundary and produces the right output shapes via `HookOutputBuilder`, so you write logic, not plumbing.

It also ships session-processing CLIs: export sessions to clean markdown/JSONL, and tail a live session JSONL as structured blocks for downstream ingestion. Retained tool-result bodies are secret-redacted by default (API keys, tokens, passwords, URL credentials).

## Install

Runtime support targets Node.js 22 and newer. Development, type-checking, and CI use a Node 24 baseline without raising the consumer runtime floor.

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
| `@libar-dev/agent-harness-kit/types` | TypeScript types for all 30 events, event-aware settings types, and `HookOutputBuilder` |
| `@libar-dev/agent-harness-kit/utils` | `executeHook`, `outputJson`, `isProtectedFile`, `isDangerousCommand`, logging |
| `@libar-dev/agent-harness-kit/validation` | Zod schemas for all 30 events, tool-input validators, output schemas, and event-aware `validateHooksConfig` |
| `@libar-dev/agent-harness-kit/pre-tool-use` | Reference handlers: bash validator, file protector, ESLint-disable blocker |
| `@libar-dev/agent-harness-kit/post-tool-use` | Reference handlers: Prettier formatter, TypeScript checker |
| `@libar-dev/agent-harness-kit/lifecycle` | Reference handlers: setup, session start/end, notifications, message display, stop, subagents, elicitation |
| `@libar-dev/agent-harness-kit/processing` | Session parsing, full-history reads, structured exports, and multi-source raw transcript tailing |

## Documentation

- **[Getting Started](docs/guides/getting-started.md)** — install, sub-path imports, 5-minute walkthrough
- **[Writing Your First Hook](docs/guides/writing-your-first-hook.md)** — `executeHook` skeleton, validators, `permission()`, testing
- **[Configuring settings.json](docs/guides/configuring-settings-json.md)** — handler matrix, matcher semantics, accepted/inert fields, timeouts, and root restrictions
- **[Cookbook](docs/guides/cookbook.md)** — 10 copy-pasteable recipes
- **[Hook Events Reference](docs/reference/hook-events.md)** — all 30 events with exact implemented input/output contracts
- **[HookOutputBuilder Reference](docs/reference/output-builder.md)** — every implemented method, including distinct Stop/SubagentStop feedback modes
- **[Validators Reference](docs/reference/validators.md)** — input/output schemas, tool routing, type guards, and event-aware config validation
- **[Environment Variables](docs/reference/environment-variables.md)** — `getConfig()`, Claude Code process vars, and direct reference-handler configuration
- **[Session tailing](docs/internal/tail-session.md)** — CLI and public library APIs for live transcript ingestion
- **[Full docs index](docs/README.md)**

## Grok (second harness)

The package also attaches to Grok Build through the `@libar-dev/agent-harness-kit/grok` and `/grok/processing` subpaths: Grok-native hook validation, output building, and a runner for Grok's 15 hook events (14 wire events plus the legacy `subagent_end` alias), settings validation for JSON and TOML hook config, and discovery, parsing, and tailing of Grok's on-disk session files. Scope is attach-only; the library answers hook calls and reads session logs but never starts or drives Grok. Claude hook scripts do not run correctly under Grok; write a Grok-native entrypoint instead. See the [Grok Adapter Reference](docs/reference/grok-adapter.md) for the event list, wire contracts, and the Grok-vs-Claude incompatibility matrix.

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

Version `0.1.0` is the initial npm release candidate. The public API is stable but may change before the first published release. Pin to a commit hash if you depend on this from another project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist, commit style, and architecture notes.

## License

[MIT](LICENSE) © Libar AI
