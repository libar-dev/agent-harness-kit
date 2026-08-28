# Grok Build adapter — planning brief

**Branch:** `feat/grok-adapter` (from `origin/main` @ `6a08ff3`)
**Audience:** a planning session with no prior conversation context (read-only; do not clone or write)
**Status:** investigation complete; no implementation yet
**Do not merge this file.** Planning notes stay out of the public package. Delete before merge, or keep only if we promote a subset into `docs/`.

### Local Grok Build checkout (read this first)

A shallow clone is already on disk. **Do not clone again. Open these paths.**

| | |
|---|---|
| Checkout | `/tmp/grok-build` |
| Remote | `https://github.com/xai-org/grok-build` |
| Git `HEAD` | `e5fd4816d43260c15ba785f103990c1ed6cea230` (shallow, 2026-08-13, “Synced from monorepo”) |
| `SOURCE_REV` | `ea094a8c369475f97c85540d01730baec0dce5d6` (upstream monorepo SHA) |
| Clone shape | `git clone --depth 1` — no extra history |

If `/tmp/grok-build` is missing (reboot, `/tmp` wipe), recreate with:

```bash
git clone --depth 1 https://github.com/xai-org/grok-build.git /tmp/grok-build
```

Then re-record `HEAD` and `SOURCE_REV` before planning.

---

## 1. Decision to confirm first

This kit attaches to a harness the user already started. It does not spawn the agent.

| Product | Who starts the agent | What we do |
|---|---|---|
| This kit (Claude today) | User’s CLI / IDE / Desktop | Hooks + transcript tail |
| [t3code](https://github.com/pingdotgg/t3code) | t3code, via `@anthropic-ai/claude-agent-sdk` `query()` | Owns the session, streams UI |
| Claude Agent SDK | Our process | In-process callbacks on *our* `query()` |

The Agent SDK cannot join a live interactive Claude/Grok TUI. Resume starts a new process with old history. Official live-join for Claude is first-party Remote Control only.

Grok is the second **attach** harness, not a t3code clone and not “use the Agent SDK.” Reconstructing Claude hook I/O was the right call. For Grok we should **not** reconstruct from the user guide. The implementation is public.

---

## 2. Why Grok is viable as harness two

1. Same attach shape as Claude: command/HTTP hooks, JSON stdin/stdout, settings files, fail-open except explicit deny.
2. Session files on disk under `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`, append-only JSONL.
3. Source of truth exists: [xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0, periodic monorepo sync).
4. Grok already loads `~/.claude/settings.json` hooks when `[compat.claude] hooks = true` (default). Claude *scripts* still will not work unchanged (envelope and output differ).

---

## 3. Source of truth (use these, in this order)

### 3.1 Implementation — authoritative

Read the checkout at `/tmp/grok-build`. GitHub is only the origin; do not fetch in planning mode.

The public tree can lag the installed `grok` binary. This snapshot is `HEAD` `e5fd481` / `SOURCE_REV` `ea094a8`.

| Need | Absolute path |
|---|---|
| Hook stdin envelope, events, payloads | `/tmp/grok-build/crates/codegen/xai-grok-hooks/src/event.rs` |
| Hook crate overview (stale “four events” comment) | `/tmp/grok-build/crates/codegen/xai-grok-hooks/src/lib.rs` |
| Config / discovery / matcher / dispatch | `/tmp/grok-build/crates/codegen/xai-grok-hooks/src/config.rs`, `discovery.rs`, `dispatcher.rs`, `matcher.rs` |
| Allow/deny and Stop outcomes | `/tmp/grok-build/crates/codegen/xai-grok-hooks/src/result.rs` |
| HTTP / command runner | `/tmp/grok-build/crates/codegen/xai-grok-hooks/src/runner/` |
| Handler types (`command`, `http` only) | `/tmp/grok-build/crates/codegen/xai-hooks-plugins-types/src/lib.rs` |
| `events.jsonl` line schema | `/tmp/grok-build/crates/codegen/xai-grok-session-events/src/types.rs` (`Event`, `schema_version = "1.0"`) |
| Session export from `updates.jsonl` | `/tmp/grok-build/crates/codegen/xai-grok-shell/src/session/export.rs` |
| Persist/replay wire tags | `/tmp/grok-build/crates/codegen/xai-grok-shell/src/session/wire_tags.rs` |
| Replay `updates.jsonl` | `/tmp/grok-build/crates/codegen/xai-grok-shell/src/session/helpers/replay.rs` |
| On-disk envelope helper | `/tmp/grok-build/crates/codegen/xai-grok-pager-pty-harness/src/leader.rs` |
| ACP JSON-RPC types | `/tmp/grok-build/crates/codegen/xai-acp-lib/src/` |

`event.rs` is the real event list. Trust serde structs, not crate overview comments.

Do not: depend on the Rust crate from npm, vendor the whole tree, or send PRs (external contributions are rejected). Port types into Zod. Attribute if we copy substantial code (Apache-2.0).

### 3.2 User guide — behavior notes only

Prefer the checkout copy so planning does not depend on `~/.grok` being present:

| File | Use for |
|---|---|
| `/tmp/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md` | Discovery paths, trust, fail-open, Claude/Cursor aliases, Stop 8-continuation cap |
| `/tmp/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md` | Directory layout, `grok sessions list/search`, resume flags |
| `/tmp/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md` | `streaming-json` / `streaming-messages-json` if we *spawn* `grok -p` |
| `/tmp/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md` | ACP if we *drive* a session we own |
| `/tmp/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md` | `[compat.claude] hooks` |

Installed mirror (same content if this machine’s Grok is current): `~/.grok/docs/user-guide/`.

The user guide is incomplete as a contract: one PreToolUse example, “stdout ignored” for passive events, HTTP deny body unspecified, `events.jsonl` omitted, `updates.jsonl` wrapper omitted. Confirm every guide claim against the crates.

### 3.3 Live fixtures — lock the wire

Sample this machine: `~/.grok/sessions/%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit/<id>/`

Observed beyond the guide:

- `updates.jsonl` is `{ timestamp, method: "session/update", params: { sessionId, update } }`
- `sessionUpdate` includes undocumented `user_message_chunk` plus large `_meta`
- `events.jsonl` exists (`turn_started`, `loop_started`, `phase_changed`, `first_token`, …)
- Extra files: `hunk_records.jsonl`, `prompt_context.json`, `announcement_state.json`, `resources_state.json`

Keep a small fixture set in tests. Re-dump when `SOURCE_REV` or `grok --version` moves.

---

## 4. Hook contract (Grok vs Claude)

### 4.1 Events Grok actually fires

From `HookEventName` in `event.rs`:

SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Stop, StopFailure, Notification, SubagentStart, SubagentStop (alias SubagentEnd), PreCompact, PostCompact, SessionEnd.

**Not in Grok (do not port 1:1):** Setup, UserPromptExpansion, PermissionRequest, PostToolBatch, MessageDisplay, TaskCreated, TaskCompleted, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult, DirectoryAdded.

### 4.2 Wire vs Claude

| | Claude (this kit today) | Grok |
|---|---|---|
| Envelope keys | snake_case (`hook_event_name`) | camelCase (`hookEventName`); serde struct fields are snake_case |
| Event value on stdin | `PreToolUse` | `pre_tool_use` (`#[serde(rename_all = "snake_case")]`) |
| Config / settings keys | PascalCase | PascalCase; aliases accept camelCase and Cursor names |
| Tool I/O | `tool_input`, `tool_response` | `toolInput`, `toolResult` |
| Tool names | `Bash`, `Write`, `Edit` | `run_terminal_command`, `search_replace`, …; matchers alias Claude names |
| PreToolUse output | `hookSpecificOutput.permissionDecision`: allow/deny/ask/defer + `updatedInput` | `{ "decision": "allow" \| "deny", "reason" }` only |
| Stop output | block / additionalContext / continue | Same vocabulary; extra session-end Stop with `reason != "end_turn"` (observe-only) |
| Passive events | Many outputs honored | GateKind::Observe — stdout recorded, decisions ignored |
| Handlers | command, http, mcp_tool, prompt, agent | command, http |
| Fail policy | exit 2 blocks | Fail-open unless explicit deny / Stop JSON / exit 2 with no JSON |
| Timeouts | 600s typical command | 5s default; 600s Stop/SubagentStop |
| `transcript_path` | required on base input | optional `transcriptPath` on envelope (in source; omitted from user guide) |

`HookDecision` in `result.rs`: `Allow` | `Deny { reason, hook_name }`.
`StopHookOutcome`: `block_reason`, `additional_context`, `force_stop` (`continue: false` + `stopReason`).

### 4.3 What this means for our API

Do **not** reuse `PreToolUseInput` / `HookOutputBuilder.permission('ask' | 'defer')` on the Grok path.

Build a Grok-native layer:

- `GrokHookEventName`, `GrokHookEventEnvelope`, per-event payloads from `HookPayload`
- Zod from those structs
- `GrokHookOutputBuilder` with allow/deny + Stop block/context/force-stop only
- Shared `executeHook`-style runner that can parse either envelope **or** a Grok-only entry
- Map both harnesses into a small shared “session block” model for export/tail UI — do not unify hook types

Claude `settings.json` command hooks may *load* in Grok. They will mis-read fields and emit the wrong deny JSON unless we ship a thin translator or a second script.

---

## 5. Session parse / stream

### 5.1 On-disk (attach)

```
~/.grok/sessions/<url-encoded-cwd>/<session-id>/
  summary.json            # index
  updates.jsonl           # conversation (ACP session/update) — resume source
  chat_history.jsonl      # model-facing messages
  events.jsonl            # turn phases (undocumented in the guide; typed in session-events)
  plan.json, rewind_points.jsonl, signals.json, subagents/
```

Cwd encoding is URL-encoding (`%2FUsers%2F...`), not Claude’s dash encoding. `GROK_HOME` overrides `~/.grok`.

Suggested ingest:

- **Conversation / export:** `updates.jsonl` (need the JSON-RPC wrapper + `sessionUpdate` union)
- **Live “what is the agent doing”:** `events.jsonl` (`Event` in `types.rs`)
- **Optional raw model view:** `chat_history.jsonl` (no field-level guide; dump fixtures)

There is no official tail CLI. We watch files the same way as `claude-session-tail`.

### 5.2 Spawned stream (only if we own the process)

`grok -p --output-format streaming-json` is well specified (type-tagged ACP-derived lines). `streaming-messages-json` is Claude-like with listed fidelity holes. Approvals are not in that stream; they go through `grok agent` (ACP).

Out of scope for v1 attach unless the planning session chooses a cockpit-owned Grok process.

---

## 6. Suggested scope for v1

**In**

1. Grok hook types + Zod + output builder + `executeHook` variant, generated/ported from `event.rs` / `result.rs`.
2. Settings/config validation for Grok JSON + TOML hook objects (`command` / `http`).
3. Session discovery (`~/.grok/sessions`, `GROK_HOME`) + parse/tail of `updates.jsonl` and `events.jsonl`.
4. Upstream pin: script or `docs/upstream/grok/` copies of `event.rs` + `types.rs` at a recorded SHA; test fails on drift.
5. Docs: Grok vs Claude incompatibilities; do not claim 30-event parity.

**Out of v1**

- Agent SDK / ACP as the hook transport
- Reusing Claude `HookOutputBuilder` methods that Grok ignores
- mcp_tool / prompt / agent handlers
- Driving `grok` like t3code
- 17 missing Claude events

**Later**

- HTTP hook response contract for a cockpit forwarder (confirm against `dispatcher.rs`)
- Optional Claude→Grok stdin/stdout translator so one script works in both
- Headless `streaming-json` consumer if we spawn Grok

---

## 7. Planning-session questions

1. Confirm attach-only for v1 (hooks + JSONL), not a t3code-style driver.
2. One package with `grok/` exports vs a second package?
3. Shared session-block model now, or Grok processing isolated until a cockpit needs one UI?
4. Ship a Claude-compat translator, or document “write a Grok script”?
5. Pin strategy: git submodule (dev only), vendored rust snippets, or fetch script in CI?
6. Which `grok` / `SOURCE_REV` is the compatibility floor?
7. Cockpit forwarder for Grok in v1, or hooks library + tail only?

---

## 8. Risks

- Public repo lags the binary → pin SHA *and* record `grok --version`.
- Stale comments in `xai-grok-hooks` `lib.rs`.
- `updates.jsonl` `_meta` is large and unstable; parse the ACP `sessionUpdate` discriminant, ignore unknown `_meta`.
- Fail-open: a crashing guard does not block. Policy hooks must return explicit deny.
- Existing Claude reference hooks will not work on Grok without a translator.

---

## 9. Investigation inputs (this brief is derived from)

- Claude Agent SDK overview + hooks + TypeScript reference + sessions + Remote Control docs
- This kit: `README.md`, `src/types`, `src/forwarder`, `src/processing`, `docs/reference/hook-events.md`
- t3code: `docs/internals/overview.md`, `providers.md`, `ClaudeDriver.ts`, `ClaudeAdapter.ts` (`query()`, `canUseTool`, `settingSources`)
- Grok user guide: `10-hooks.md`, `17-sessions.md`, `14-headless-mode.md`, `15-agent-mode.md`, `05-configuration.md`
- grok-build: `xai-grok-hooks` (`event.rs`, `result.rs`, `lib.rs`), `xai-hooks-plugins-types`, `xai-grok-session-events` (`types.rs`)
- Live session dump under `~/.grok/sessions/%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit/`
