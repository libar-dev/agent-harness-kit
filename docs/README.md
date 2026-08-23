# Documentation

`@libar-dev/agent-harness-kit` developer documentation.

## Guides — Start Here

| Guide | What it covers |
|-------|----------------|
| [Getting Started](guides/getting-started.md) | Install, sub-path imports, first hook in 5 minutes |
| [Writing Your First Hook](guides/writing-your-first-hook.md) | `executeHook`, `validateBashToolInput`, `permission()` — end-to-end walkthrough |
| [Configuring settings.json](guides/configuring-settings-json.md) | 5 handler types, matcher syntax, `if`/`timeout`/`async` fields |
| [Cookbook](guides/cookbook.md) | 10 copy-pasteable recipes for common hook patterns |
| [Troubleshooting](guides/troubleshooting.md) | Hook not firing, exit codes, debug logging, Zod errors |

## API Reference

| Reference | What it covers |
|-----------|----------------|
| [Hook Events](reference/hook-events.md) | All 30 events — input fields, output shape, builder method |
| [HookOutputBuilder](reference/output-builder.md) | Every method with signature and examples |
| [Validators](reference/validators.md) | Tool-input validators, type guards, content validators, config validators |
| [Types](reference/types.md) | Full type catalogue — inputs, outputs, tools, config |
| [Environment Variables](reference/environment-variables.md) | Every `CLAUDE_HOOK_*` variable with type, default, and description |
| [Grok Adapter](reference/grok-adapter.md) | Grok Build envelopes, settings, and session processing (attach-only) |
| [Senpi Adapter](reference/senpi-adapter.md) | OmO-native (senpi) envelopes, settings, trust gate, and session processing (attach-only) |

## Architecture & Internal

| Doc | Audience |
|-----|----------|
| [API Update Checklist](internal/api-update-checklist.md) | Maintainer checklist for tracking Claude Code API changes |
| [Export Sessions Script](internal/export-sessions.md) | How the export-sessions utility works |
| [Session Tailing](internal/tail-session.md) | CLI and library APIs, marker offsets, multi-source session discovery, and live polling |
| [Release 0.3.0](internal/release-0.3.0.md) | Public contract, Node `>=22`, provenance publish steps (owner-gated) |

## Upstream Reference (Mirrored)

Official Claude Code documentation mirrored for offline development use. Always check the [official docs](https://code.claude.com/docs/en/overview) for the canonical, up-to-date version.

| Doc | Source |
|-----|--------|
| [Hooks Reference](upstream/hooks-reference.md) | Claude Code Hooks Reference |
| [Hooks Guide](upstream/hooks-guide.md) | Claude Code Hooks Guide |
| [Settings Reference](upstream/settings.md) | Claude Code Settings Reference |
| [CLI Reference](upstream/cli-reference.md) | Claude Code CLI Reference |
| [Headless Mode](upstream/headless.md) | Claude Code Headless Mode |
