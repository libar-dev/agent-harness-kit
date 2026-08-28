# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Categories per release: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

---

## [Unreleased]

### Added

- Exported `byteCursorsEqual` from the Grok processing barrel so
  consumers can compare per-source cursors without an internal barrel.
  Contract tests pin `StaleCheckpointConflict` shape (`name`,
  constructor fields, and `isStaleCheckpointConflict`) as a cross-repo
  contract.

### Changed

- Relocated the shared JSONL cursor, incremental resume, watch scheduler,
  discovery primitives, and bounded-line reader into unbarreled
  `src/internal/`. Type-only `JsonlCursor` re-exports from the Grok and
  Senpi processing barrels keep the public surface unchanged.
- Timing-sensitive CLI, Senpi trust-writer, and lifecycle tests use
  injected clocks and fake timers instead of wall-clock waits. The
  trust writer accepts an optional `clock` so lock-budget assertions
  never sleep.

### Fixed

- Bound stdin to 1 MiB in Senpi execute, Grok execute, both hook
  forwarders, and Claude `readStdin`.
- Bound shared JSONL cursor scans to 32 MiB and 10_000 lines per pass.
  Senpi and Grok tail results expose additive `scanStatus` (`complete` or
  `limited`) when a pass stops early.
- Senpi tail reports `reset: false` on a first-ever scan, treats movement
  as cursor and projection position change, and skips complete blank lines
  so a trailing blank is not `terminalMalformed`.
- Senpi automatic checkpoint writes return additive `checkpointStatus`
  (`committed`, `unchanged`, `manual`, `failed`, or `deferred`) instead of
  throwing on write failure.
- Senpi watch quiesces on position stability. Reset, mtime, size beyond
  the cursor, and filesystem noise no longer count as movement or re-arm
  the quiet window.
- Grok watch wakes on null-filename `fs.watch` events and supports an
  optional `pollMs` backstop.
- Bound Grok discovery reads of `summary.json` (64 KiB) and `.cwd` (4 KiB).
  Oversized files take the existing invalid or diagnostic path.
- Senpi listing never yields or parses an unterminated final line. The
  newline commits the entry on the next listing pass.
- `listAllSenpiSessions` skips root-level `*-artifacts/` directories,
  matching the nested-directory filter.
- Senpi registration-document reads reject unknown hook-event keys,
  groups without handlers, empty commands, and arbitrary hooks objects.
  Inspect surfaces the existing malformed-shape read-error union.

### Security

- Senpi hook forwarder accepts only loopback `http`/`https` URLs
  (`127.0.0.1`, `localhost`, `::1`) unless
  `SENPI_HOOK_FORWARD_ALLOW_REMOTE=1` is set. Redirects are refused and
  stdin is capped at 1 MiB.
- Marker-root containment realpath-walks the candidate and allowed
  roots so a symlink inside a root that points outward is rejected.
  Write-path re-verification (`assertMarkerDirStillAllowed`) rejects a
  directory swapped for an outward symlink after resolve.
- Marker-lock stale reclamation writes `owner.json` `{ nonce }` after
  `mkdir` and re-checks `{dev, ino}` plus nonce immediately before
  unlink. A lock recreated between stat and rm is left intact.

## [0.3.0] - 2026-08-23

First public contract freeze. This release documents the Claude, Grok, and
Senpi library surfaces that ship in the package. It is not a desktop product
integration and does not publish itself; npm publication with provenance is a
separate owner-authorized step.

Supported runtime: Node.js `>=22.0.0`. Development and CI also run on Node 24.
Node 20 and Windows are not supported.

### Added

- Added the attach-only Grok Build surface on `/grok` (hook validation, output
  builder, runner, JSON/TOML settings) and `/grok/processing` (discovery, parse,
  tail, watch, checkpoint commit, block reduction).
- Added the attach-only OmO-native (senpi) surface on `/senpi` (agent-home
  resolution, hook wire/validation, output builder, runner, read-only trust
  inspection, consent-gated trust grant/revoke, observe-only hooks.json
  register/inspect/unregister) and `/senpi/processing` (discovery, listing,
  parse, projection, tail, watch, checkpoint commit, native block reduction).
  Mutating primitives require `{ consent: true, reason, target }` and never
  run at module import.
- Added the standalone Senpi hook forwarder at
  `dist/standalone/hook-forwarder-senpi.mjs` alongside the existing Claude
  forwarder at `dist/standalone/hook-forwarder.mjs`. `/forwarder` exports the
  pack-relative asset paths and `RUN_HOOK_WRAPPER_SH`; it does not install.
- Added a packed-tarball clean-consumer CI matrix on Node 22 and 24, plus a
  Node 20 engine-mismatch job that must surface `engines.node >=22.0.0`.
- Added Claude Code hook parity for optional `prompt_id`, eight Notification
  types, Stop/SubagentStop background-task and session-cron registries, six
  permission-update variants, the `manual` set-mode alias, `disableAllHooks`,
  `continueOnBlock`, Agent background execution input, and injected
  ExitPlanMode plan fields.
- Added event-aware hook-handler schemas and dedicated builder methods for
  PostToolUseFailure, Stop, and SubagentStop feedback modes.
- Added `UserPromptSubmitOutput.suppressOriginalPrompt` and
  `blockPrompt(reason, options?)` support for omitting the original prompt from
  block messages.
- Added `HookOutputBuilder.postToolUseContext()` for non-block PostToolUse
  context and tool-output replacement.
- Added `HookOutputBuilder.failureContext()` for non-block PostToolUseFailure
  context injection.

### Changed

- Package version is exact `0.3.0`. `publishConfig.provenance` is enabled so
  the owner-gated release workflow can attest the npm tarball.
- Notification output is restricted to universal hook fields.
- Stop and SubagentStop block outputs require a present `reason` string (empty
  string accepted) and remain distinct from non-error `additionalContext`
  feedback.
- SubagentStop analysis treats blank agent transcripts as unavailable and
  includes `last_assistant_message` when scoring completion errors.
- `stopFailureLog()` is a deprecated no-op compatibility shim because Claude
  Code ignores StopFailure output and exit code.
- Project-authored hook documentation was audited against refreshed official
  mirrors on 2026-07-12, including matcher semantics, handler support,
  timeout overrides, root restrictions, tool inputs, and environment defaults.
- `HookOutputBuilder.feedback()` and `failureFeedback()` are documented as the
  block-feedback paths; non-block replace/context helpers are separate.
- `preCompactOutputSchema` / `PreCompactOutput` reject PreCompact
  `hookSpecificOutput` injection (block or universal fields only).
- `exitPlanModeToolInputSchema` strips unknown keys like other tool-input
  schemas instead of using `.strict()`.
- `sessionStartContext(options)` preserves empty strings and empty `watchPaths`
  via presence checks rather than truthiness.

### Compatibility

- Runtime floor remains Node.js `>=22.0.0`. It is not raised and not broadened.
- Grok and Senpi are observe/attach contracts only. This library does not spawn,
  drive, Commit, or translate Claude hook scripts to those engines.
- Claude `/processing` stays the session parse/tail/export surface. Marker
  helpers remain public; JSONL cursor internals and Senpi marker-schema helpers
  stay unexported and resolve as `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- There is no public plugin ABI and no shared cross-harness `SessionBlock`.
- This package is a library. It does not ship a Cockpit (or any other) product
  integration, daemon, or UI. Cockpit is observe-only for OmO/Senpi and must
  not call kit hook/trust writers or install the Senpi forwarder.

### Fixed

- Canonicalized existing hook-event working directories before project-root
  filtering so symlinked paths still reach an open project's endpoint.
- Exercised the actual esbuild-bundled forwarder in subprocess tests, including
  its exit-zero, empty-output behavior for malformed stdin.
- PreCompact no longer overwrites detailed SessionStart restore context with the
  abbreviated systemMessage board; both are persisted in a single write.
- Custom notification commands again expand `{title}`, `{message}`, `{priority}`,
  and `{icon}` placeholders while still exporting `CLAUDE_NOTIFICATION_*` env vars.
- Notification placeholder expansion substitutes shell-safe env refs instead of
  interpolating raw title/message text into `sh -c` (command-injection fix), and
  is quote-aware so single-quoted legacy forms such as `'{title}'` still expand.

## [0.2.0] - 2026-07-12

### Added

- Added a validated endpoint-discovery file contract and helpers for process
  liveness, project-root filtering, and hook URL construction.
- Added a standalone, esbuild-bundled command-hook forwarder that silently
  opts out when its endpoint is absent, stale, unrelated, or unreachable.
- Added the managed POSIX wrapper asset for consumers that install the
  forwarder at a stable user path.

- Added the per-call `allowedMarkerRoots` tail option (`TailOptions`) so
  library consumers can validate a custom `markerDir` without mutating the
  process-global `CLAUDE_TAIL_MARKER_ROOTS` env var. When set (even empty) it
  takes precedence over the env var; when unset the env var remains the
  fallback, so the `claude-session-tail` CLI behavior is unchanged.
- Exported `getMarkerPath`, `readMarker`, and `writeMarker` from
  `@libar-dev/agent-harness-kit/processing` so consumers that pre-seed or
  inspect tail markers share the kit's marker file format instead of
  re-implementing it.

### Changed

- ExitPlanMode summaries use the plan's first Markdown heading so collapsed
  transcript rows remain meaningful.

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

- Full TypeScript coverage of all 30 Claude Code hook events (SessionStart through
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
  API reference (all 30 hook events, `HookOutputBuilder` methods, validator catalogue,
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

[Unreleased]: https://github.com/libar-dev/agent-harness-kit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/libar-dev/agent-harness-kit/releases/tag/v0.3.0
[0.2.0]: https://github.com/libar-dev/agent-harness-kit/releases/tag/v0.2.0
[0.1.0]: https://github.com/libar-dev/agent-harness-kit/releases/tag/v0.1.0
