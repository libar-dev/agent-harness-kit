# @libar-dev/agent-harness-kit

> Claude Code hooks, plus attach-only Grok Build and OmO-native (senpi) observe adapters.
>
> This library validates hook I/O and reads on-disk session files. It does not start, drive, or Commit external engines, and it is not a desktop product integration. Cockpit is observe-only for OmO/Senpi: library mutation helpers exist for explicit owners, not for Cockpit product wiring. Claude-specific API names (event names, CLI binaries) remain stable and are not translated to Grok or Senpi.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/version-0.3.0-blue)](https://github.com/libar-dev/agent-harness-kit/releases)
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
| `@libar-dev/agent-harness-kit/grok` | Attach-only Grok Build hook validation, output builder, and runner |
| `@libar-dev/agent-harness-kit/grok/processing` | Grok session discovery, parse, tail, watch, and checkpoint commit |
| `@libar-dev/agent-harness-kit/senpi` | Attach-only OmO-native (senpi) hooks, trust inspect/grant/revoke, and consent-gated hooks.json register/inspect/unregister |
| `@libar-dev/agent-harness-kit/senpi/processing` | Senpi session discovery, projection, tail, watch, and checkpoint commit |
| `@libar-dev/agent-harness-kit/endpoint-discovery` | Validated hook-endpoint file contract and URL helpers |
| `@libar-dev/agent-harness-kit/forwarder` | Standalone forwarder asset paths plus the managed POSIX wrapper string |}

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

## Senpi / OmO (third harness)

`@libar-dev/agent-harness-kit/senpi` is an attach-only library surface. It can validate hook envelopes, inspect trust, and — only when a caller passes an explicit `{ consent: true, reason, target }` options object — write or remove `hooks.json` / `hooks-state.json`. Those writers never run at import and never default to `~/.omo`. The caller owns the target directory, the consent record, and any later uninstall.

That library capability is not a Cockpit product integration. **Cockpit is observe-only for OmO/Senpi:** it may resolve the agent home and read session files, but it must not register hooks, grant or revoke trust, install the Senpi forwarder, or enforce a Senpi Stop gate. See the [Senpi Adapter Reference](docs/reference/senpi-adapter.md).

Standalone assets live at `dist/standalone/hook-forwarder.mjs` (Claude) and `dist/standalone/hook-forwarder-senpi.mjs` (Senpi observe-only). `@libar-dev/agent-harness-kit/forwarder` exports those pack-relative paths plus `RUN_HOOK_WRAPPER_SH`. Shipping the bytes is not an install.

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

Version `0.3.0` is the public contract freeze: Claude hooks and processing, attach-only Grok and Senpi observe adapters, and standalone forwarders. Runtime support is Node.js 22 and newer. Publishing to npm with provenance is a separate owner-authorized step; see [Release 0.3.0](docs/internal/release-0.3.0.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist, commit style, and architecture notes.

## License

[MIT](LICENSE) © Libar AI
