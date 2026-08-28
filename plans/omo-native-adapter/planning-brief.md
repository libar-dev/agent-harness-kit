# Planning Brief — OmO Native adapter (senpi attach/observe + hooks)

Status: PROPOSED · 2026-08-21 · Companion to [investigation.md](investigation.md)
Scope: `@libar-dev/agent-harness-kit` only. Cockpit (Phase C) is the integration gate, not work done here.

## Decisions locked by product owner

| Question | Decision |
|---|---|
| Product name | **OmO native** (core team's term). Kit module stays engine-accurate: `src/senpi/`, subpaths `/senpi`, `/senpi/processing`. Cockpit-facing harness id: `omo`. No `omo-native`/`senpi` mixing within one layer. |
| MVP scope in this repo | Phases **A, B, D** (observe, hooks library, managed-hooks groundwork). **No PR merge in harness-kit until Phase C (Cockpit observe integration) is implemented and tested against this branch.** |
| Session listing | Must list **all sessions in all projects** from the common user-level store, and support opening sessions from any folder. This is the engine's native model — see "All-projects listing" below. No "extra roots" concept needed for MVP. |
| Hooks | **Essential, not optional.** Minimum: monitoring of active sessions via hooks. Full Cockpit hook surface documented in this brief, delivered later. |

## Contract source of truth

Engine pin: `@code-yeongyu/senpi` **2026.8.19** (the version OmO pins in `packages/omo-senpi/package.json`). OmO is a branded distribution; the engine owns storage, hooks, and session format. Kit never depends on `oh-my-openagent` at runtime.

Vendor under `docs/upstream/senpi/` with `pin.json` (version + per-file sha256) and `scripts/sync-upstream-senpi.mjs`:

- `docs/session-format.md`, `docs/settings.md`, `docs/environment-variables.md` (from the npm tarball; `docs/` ships in the published package)
- `dist/core/extensions/builtin/hooks/*.d.ts` — the hooks wire contract is **undocumented** in senpi's docs index; dist types are the only spec
- Drift tests assert our Zod schemas and event lists against the vendored types, mirroring `tests/grok-upstream-drift.test.ts`

## Resolved risks (previously open — now investigated in the pinned dist)

### 1. Tree tail + compaction (highest risk) — design

Session JSONL is a v3 tree (`id`/`parentId`, header `type:"session" version:3`). The kit owns linearization; consumers stay linear like the Claude path.

- `parseSenpiEntry(raw)` → `known | unknown | invalid` (Grok policy: unknown tags preserved, never fatal).
- `tailSenpiSession(file, {markerDir, allowedMarkerRoots, ...})` → incremental read since byte marker, then **leaf-path projection**: build parent map from all entries, resolve current leaf (last appended entry id is the engine's leaf; entries only append — branching re-parents new entries, never rewrites old lines), emit records ordered root→leaf along the active path. Entries not on the leaf path are emitted as `off-branch` metadata, not conversation blocks.
- Compaction: a `compaction` entry with `retainedTail` is a self-contained checkpoint — projection emits the compaction record and, for consumers that want full context, the retained tail; `firstKeptEntryId` (legacy) truncates the projected prefix.
- `parentSession` forks: header field only; cross-file lineage exposed as metadata (`parentSessionPath`), never followed during tail.
- Live-append safety: appends are line-atomic JSONL; marker format and inode-reset handling reuse the existing `jsonl-cursor` pattern from `src/grok/processing`.
- Fixtures: real transcripts from `~/.omo/agent/sessions/` (116 MB, dense trees, live `senpi.hooks.stop-state` / `omo-senpi:wake` traffic) copied into `tests/fixtures/senpi/` as sanitized subsets.

### 2. Custom-message density — neutral parse, lossy map

Real sessions carry heavy extension traffic: `senpi.todo-state` (×101), `senpi.hooks.stop-state` (×114), `goal-cache-warmup` (×117), `omo-senpi:wake` (×173), memory bindings, checkpoints. The kit parses and folds these **neutrally**: `custom`/`custom_message` entries become typed records with `customType` preserved and payload validated loosely (`unknown` data). Cockpit maps lossily to UI blocks exactly as it does for Grok's `system/info` fallback. No OmO product-surface awareness in kit v1. Volume guard: folding must be O(n) with no per-entry allocations retained for `custom` entries beyond the record itself.

### 3. Hook trust — mechanics now known, managed grant is a designed operation

- Trust state lives in `<agentHome>/hooks-state.json` (global) and `<cwd>/.senpi/hooks-state.json` (project), file-locked, `HookTrustState v1`: per-hook `enabled`, `trustedHash` (`hashCommandHook(handler)`), `commandPreview`, `updatedAt`.
- Untrusted or disabled handlers are **skipped with diagnostics** (`reason: "disabled" | "untrusted" | "unsafe"`), never run.
- Managed-install solution (Phase D): the kit computes the exact trust id + hash (`hookTrustId`, `hashCommandHook` are pure functions over handler config + platform) and writes the trust entry **only as an explicit, user-approved operation** (Cockpit consent UI or documented manual step). Writing `hooks-state.json` programmatically is semantically the user approving the hook — the kit treats it as such and never does it silently. This unblocks headless managed hooks without weakening the gate.

### 4. No `SessionEnd` — watch + quiescence

Supported events are exactly 7: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PreCompact`, `PostCompact`, `Stop`. Session-end detection for observe consumers:

- Primary: `watchSenpiSession` mtime quiescence on the JSONL (same pattern as Grok observe), plus `session_shutdown`-equivalent absence of new entries.
- Weak signal: a `Stop` hook with no follow-up within a bounded window.
- Documented explicitly as a divergence from the Claude lifecycle; Cockpit's SessionEnd-dependent features degrade, not break.

### 5. Stop loop / `continue` — semantics read, forwarding rules fixed

From `output-parser.js` / `stop-adapter.js` / the `loop-guard` builtin:

- Exit code **2** ⇒ `{decision: "block", reason: <stderr>}` regardless of stdout.
- Otherwise stdout JSON; `continue: false` on a Stop hook ⇒ `decision: "block"`; a Stop block without follow-up context produces an engine-side warning, and exit-2 blockers are excluded from user-facing messaging.
- The engine's `loop-guard` builtin owns the first veto so repeated calls never re-run hooks, and the Stop adapter persists turn state (`senpi.hooks.stop-state` custom entries) — loop protection exists upstream.
- Rule for v1: **Stop hooks are observe-only in kit examples and Cockpit wiring.** Forwarding Stop with block/continue semantics is Phase D+ and requires the trust story plus a written loop-safety rationale. The kit's output builder exposes the full `HookOutputWire` vocabulary (it is the wire contract), but documentation marks Stop-gate outputs as advanced.

### Exit-code / output semantics (complete, for the runner)

| Input | Behavior |
|---|---|
| exit 2 | block; reason = stderr |
| exit other, empty stdout | no-op |
| exit other, stdout JSON | parse universal fields (`continue`, `stopReason`, `suppressOutput`, `systemMessage`) + event-specific fields; `hookSpecificOutput` supported; malformed JSON or non-object ⇒ diagnostic, no-op |
| `systemMessage` | honored for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop` only |
| timeout / abort | killed process tree, `exitCode: null`, `timedOut`/`aborted` flags; bounded stdout/stderr captures |

### All-projects listing (owner question resolved)

"Extra roots" was about non-default storage locations — irrelevant for MVP. The engine's native model already does what Cockpit needs:

- Every session for every project lives under the **single user-level home** (`<agentHome>/sessions/<--encoded-cwd-->/`), resolved by `resolveAgentHome` semantics: `OMO_CODING_AGENT_DIR`/`SENPI_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR` env → `~/.omo/agent` (sentinel `settings.json`) → legacy flat `~/.omo` → `~/.senpi/agent`.
- Engine parity API: `SessionManager.listAll()` → `SessionInfo { path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage, allMessagesText }`.
- Kit exports `listAllSenpiSessions(agentHome?)` with the same shape (own implementation, no engine import) plus `listSenpiSessions(projectCwd)` for per-project filtering. Opening sessions "from other folders" is just opening any file in the store — senpi itself supports `--session <path|id>`; no special handling needed.
- Discovery filters: top-level `*.jsonl` only; skip `*-artifacts/` dirs and per-project `extensions/` subdirs; **verify header `cwd`** (dash-encoding is ambiguous: `a/b` vs `a-b`).

## Hooks surface (Phase B) — what "essential monitoring" means

Minimum viable hooks support for Cockpit-style monitoring:

1. `validateSenpiHooksConfig(json)` — parity with engine `parseHookConfig`: 7 events, `command` handlers only (http/prompt/agent/mcp_tool rejected with diagnostics), matchers, timeouts, `commandWindows`, the full `HookDiagnosticCode` vocabulary, config sources `<agentHome>/hooks.json` + `<cwd>/.senpi/hooks.json` + `hooks` keys in settings.json.
2. `senpiHookInputSchema` / `senpiHookOutputSchema` — Zod over `HookInputWire`/`HookOutputWire`, alias-tolerant (camelCase primaries, Claude-style snake_case aliases: `hook_event_name`, `session_id`, `transcript_path`, `tool_name`, `tool_input`, `tool_response`).
3. `executeSenpiHook(handler)` runner — stdin JSON, exit-2 block, stdout-JSON parse, bounded captures; matches `runCommandHook` semantics.
4. `SenpiHookOutputBuilder` — `decision approve|block|deny|ask`, `reason`, `additionalContext`, `updatedInput`, `updatedToolOutput`, `continue`, `stopReason`, `suppressOutput`, `systemMessage` (event-gated).
5. Trust read/inspect API: `readSenpiHookTrustState(path)`, `computeSenpiHookTrust(handler)` — read-only in Phase B; writing trust entries is Phase D's consent-gated operation.

**Full Cockpit hook surface (documented now, delivered later):** managed registration of a forwarding command hook (kit forwarder asset → Cockpit daemon endpoint, same pattern as Claude), trust consent flow, Stop-gate policy per risk 5, and the extension-API surface (`ExtensionAPI` in-process events) explicitly **out of scope** — that is an OmO-plugin concern, not a kit attach concern.

## Phases

### Phase A — observe adapter (this repo, first vertical slice)

- `src/senpi/`: `types.ts` (entry/message/block Zod unions), `home.ts` (`resolveSenpiAgentHome`), `processing/` (discovery, `listSenpiSessions`, `listAllSenpiSessions`, `parseSenpiEntry`, leaf-linear `tailSenpiSession`, `watchSenpiSession`, checkpoint commit, fold to block changes)
- Vendored pin artifacts + drift tests
- Fixtures from real `~/.omo/agent` transcripts (sanitized)
- Accept: `pnpm run check` + `pnpm run test:run` green; tail of a real fixture produces the same linear history the engine's `/resume` shows for that session (spot-verified)

### Phase B — hooks library (this repo)

- Config validator, wire schemas, runner, output builder, trust read/inspect
- Accept: contract tests against vendored dist types; round-trip tests; drift tests

### Phase C — Cockpit integration (gate for merging here)

- Cockpit observe adapter mirroring `src/main/services/grok/*`, harness id `omo`, lossy block map
- **This repo's PR stays unmerged until Phase C is implemented and tested end-to-end against this branch** (owner decision)

### Phase D — managed hooks groundwork (this repo, planning context)

- Consent-gated trust writer (`hooks-state.json`), forwarder asset variant for senpi wire, registration helper writing `hooks.json`
- Stop-gate forwarding policy doc; SessionEnd quiescence recipe for consumers

## Explicit non-goals

- No Claude `/processing` routing or shared `SessionBlock` unification (same refusal as Grok)
- No HTTP/prompt/agent/MCP hook handlers (engine rejects them)
- No reading `auth.json`; `omo-senpi/` telemetry state is not session contract
- No drive/RPC/spawn ("OmO native" means attach-observe; the engine's `rpc.md`/`app-server.md` control planes are out of scope)
- No OmO plugin/extension-API surface in the kit
- No multi-home auto-merge (a second store like `/Volumes/.../.omo` is reachable only via env/option, never merged by default)

## Open items (non-blocking for A/B)

1. Cockpit ADR equivalent of 0003 for OmO-native observe (Cockpit repo, before Phase C wiring).
2. Exact quiescence window + debounce for session-end detection (tune against live fixtures in Phase A tests).
3. Whether Cockpit wants `Stop` as a session-activity signal in C (observe-only is safe; gating is D).

## Bottom line

Phase A is implementable immediately from this brief: the wire contract is fully read (session format, hooks types, trust mechanics, exit codes, listAll), the pin target is fixed at `2026.8.19`, and the one genuinely hard component — leaf-linear tail with compaction — has a concrete design. The main discipline is keeping hooks at Phase-B scope and refusing to let "OmO native" drift into a control plane.
