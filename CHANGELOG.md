# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Categories per release: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

---

## [Unreleased]

### Changed

- Published Claude Code API parity notes now cover `Setup` and `MessageDisplay`.
- Documented `SessionStart` input/output parity updates.
- Documented `Notification` and `StopFailure` enum expansions.
- Documented support for `CommandHookHandler.args`, `PostToolUseOutput.updatedToolOutput`, `PostToolUseInput.duration_ms`, `PostToolUseFailureInput.duration_ms`, `BaseHookInput.effort`, and `BaseHookOutput.terminalSequence`.
- Documented `PostToolUseOutput.updatedMCPToolOutput` widening to `unknown`.

## [0.1.0] - 2026-06-24

This is the first release candidate under the new `agent-harness-kit` identity.
The package was renamed from `@libar-dev/claude-code-hooks` to
`@libar-dev/agent-harness-kit`.

### Added

- Added support for image content blocks in transcript processing.

### Changed

- Package name changed from `@libar-dev/claude-code-hooks` to `@libar-dev/agent-harness-kit`.
- Normalized npm bin paths in package metadata.
- Updated the repository URL to the public GitHub location.
- Added `publishConfig.access: public` for npm publishing.

---

## Pre-publication

### [1.0.0] - 2026-06-05

> **Note:** This version was never published to npm. It represents the
> pre-publication development milestone under the old `@libar-dev/claude-code-hooks`
> package name.

Development milestone for `@libar-dev/claude-code-hooks` before the first public npm release.

### Added

- Full TypeScript coverage of all 28 Claude Code hook events (SessionStart through
  ElicitationResult).
- `HookOutputBuilder` with methods for every output pattern across all hook types.
- Zod-based validation: per-event input/output schemas, tool-input schemas for 15 tools,
  hook-config schema (5 handler types: command, http, mcp_tool, prompt, agent).
- Reference hook implementations: bash validator, file protector, auto-formatter,
  TypeScript checker, session start/end, notification handler, and more.
- `executeHook()` runner with structured error handling and exit-code semantics.
- Environment-variable driven configuration (`CLAUDE_HOOK_*` prefix).
- `examples/` directory with settings.json templates (starter, comprehensive, HTTP,
  TypeScript-direct).
- Raw transcript tailing: `tailRawTranscriptRecords`, `watchRawTranscriptRecords`, and
  `readRawSessionFiles` for incremental, exact-record ingestion of growing session files.
- `claude-session-tail` CLI gains `--format raw-records`, gated behind an explicit
  `--unsafe-raw-unredacted` opt-in, alongside the default redacted `blocks` output.
- New package export subpaths: `./validation`, `./pre-tool-use`, `./post-tool-use`,
  and `./lifecycle` index entrypoints.
- `prepare` build script so the package compiles on install from a git/source checkout.
- Community-health files: `SECURITY.md` and `CODE_OF_CONDUCT.md`.
- GitHub Actions CI: a test workflow (type-check, lint, tests) plus an inert release
  workflow scaffold.
- `.nvmrc` pinning the development Node version.
- Full developer documentation tree: getting-started guide, hook-writing walkthrough,
  settings.json configuration reference, cookbook, troubleshooting guide, and a complete
  API reference (all 28 hook events, `HookOutputBuilder` methods, validator catalogue,
  public type catalogue, and environment variable reference).

### Changed

- Session JSONL parsing is now Zod-validated and reports structured diagnostics
  (per-line invalid-JSON / invalid-shape / skipped counts).
- Migrated all built-in module imports to the `node:` protocol, enforced by ESLint.
- Raised the Node engines floor from `>=18` to `>=22`.
- Bumped the development toolchain: ESLint 9, typescript-eslint 8, Vitest 4, and
  `@types/node` 24.
- Replaced locale-sensitive string sorts with deterministic codepoint ordering so
  block and record ordering is stable across environments.
- Repository organization renamed from `libar-ai` to `libar-dev`.

### Removed

- **BREAKING:** the `./processing` entrypoint no longer re-exports the internal helpers
  `parseJsonlContent`, `parseSessionContent`, `mergeTimeline`, `readMarker`, `writeMarker`,
  and `getMarkerPath`. These are now internal-only.

### Security

- Secret redaction of retained tool-result bodies and error strings: API keys, tokens,
  passwords, and URL-embedded credentials are replaced with `[REDACTED:*]` placeholders.
- Redaction regexes are ReDoS-hardened to avoid catastrophic backtracking on hostile input.
- Exact `--format raw-records` payloads and `rawLine` bytes are gated behind the explicit
  `--unsafe-raw-unredacted` opt-in; without it, raw records are redacted.

[0.1.0]: https://github.com/libar-dev/agent-harness-kit/releases/tag/v0.1.0
