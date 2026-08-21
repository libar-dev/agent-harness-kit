---
slug: grok-adapter
status: review-passed
intent: clear
review_required: true
plan_path: .omo/plans/grok-adapter.md
plan_sha256: 31fd4248e955d8084778392bcd50fccec32a189edbb4a9f16b8c1d675a4cdbd9
review_round_id: 5
review_round_limit: 5
pending-action: none - handoff presented; execution starts only via explicit user start-work
review:
  momus:
    status: approved
    workspace_root: null
    runtime_home: null
    target: .omo/plans/grok-adapter.md
    round_id: 5
    plan_sha256: 31fd4248e955d8084778392bcd50fccec32a189edbb4a9f16b8c1d675a4cdbd9
    launch_id: st_019ff961
    session: null
    result: "[OKAY] - all references exist, every todo and final-verification item has executable QA"
approach: Grok-native adapter inside this package (types+Zod+output builder+runner, settings validation, session discovery, updates.jsonl/events.jsonl parse+tail, upstream pin with drift test). Layout/packaging, shared session-block model, translator, and pin strategy are owner-decisions pending at the gate.
---

# Draft: grok-adapter

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

Grok session wire schema (explore lane, /tmp/grok-build, SHA e5fd481):
- updates.jsonl: `{timestamp: unix-secs, method: "session/update"|"_x.ai/session/update", params: {sessionId, update, _meta?}}`; update is `#[serde(tag="sessionUpdate", rename_all="snake_case")]` over an ACP union (user/agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, ...) plus a large xAI extension union (~45 variants: auto_compact_*, subagent_*, hook_execution, workflow_updated, turn_completed, ...). Unknown tags -> `unknown` variant: forward-compat is native.
- events.jsonl: `Event` tagged `type` snake_case, schema_version "1.0" only on turn_started; ~60 variants (turn/phase/tool/permission/goal-classifier/mcp families).
- Export (export.rs) does NO filter/sort/dedup: file order preserved, wrapped back into method-tagged JSON.
- Tailer precedent (leader.rs parse_update_payloads): skip blanks and JSON failures, ignore torn trailing line, extract params.update only.
- Layout: `$GROK_HOME|~/.grok/sessions/<urlencode(cwd) | slug-blake3 for >255B>/<session-id>/`; `.cwd` file stores original for hashed dirs.
- chat_history.jsonl is a derived cache rebuilt from updates.jsonl — parse updates.jsonl as source of truth; summary.json is a pretty `Summary` object.

Grok hook contract (explore lane, from /tmp/grok-build xai-grok-hooks, SHA e5fd481):
- Envelope `HookEventEnvelope`: camelCase; `hookEventName` snake_case value; payload untagged+flattened (fields top-level). Common: hookEventName, sessionId, cwd, workspaceRoot, timestamp required; transcriptPath/clientIdentifier/promptId/permissionMode optional.
- 15 events + legacy `subagent_end` variant (canonicalizes to subagent_stop). Gates: Tool=PreToolUse only; Stop=Stop/SubagentStop/SubagentEnd; everything else Observe (stdout decisions ignored).
- PreToolUse stdout: `{decision: allow|deny, reason?}`; deny honored regardless of exit; allow ignored on exit 2.
- Stop stdout: decision block|approve, reason, continue:false force-stop, stopReason, hookSpecificOutput.additionalContext (nonblank only). Force-stop overrides blocks.
- Payload truncation: toolInput/toolResult capped at 128 KiB -> string + ` [truncated]`, paired boolean flag.
- Handlers: command/http only; fields type/command/url/timeout(s)/env; no field aliases. Timeouts 5s default, 600s Stop gates. Fail-open except explicit deny/exit-2.
- HTTP: HTTPS only, no redirects, private-IP blocked; gate honors valid deny JSON even on non-2xx; Stop requires 2xx.
- Discovery: $GROK_HOME/hooks/*.json + hooks-paths registry; compat ~/.claude/settings(.local).json, ~/.cursor/hooks.json; project .grok/hooks/ + .claude/.cursor (trusted only). TOML layers: requirements/config/managed_config. Dedup first-source-wins.
- Compat: CLAUDE_PROJECT_DIR always injected (reserved); matcher aliases Claude tool names (Bash->run_terminal_command); `[compat.claude] hooks` default true.

Repo conventions (explore lane, verified against files it opened):
- `HookOutputBuilder` (src/utils/output-builder.ts) is a plain object of event factories, Claude-hardcoded types/literals.
- `readStdinJson`/`executeHook` (src/utils/index.ts) validate via Claude `HookInputSchema`; Grok needs its own runner.
- Processing (src/processing/{parser,tail,types}.ts) assumes ~/.claude/projects and Claude JSONL; Grok slots as sibling `src/grok/` subtree.
- package.json exports explicit subpaths; add `"./grok"` subpath + bin like `grok-session-export`; tsconfig.build.json compiles all of src/.
- Tests: Vitest + tests/test-utils.ts factories; Grok gets its own fixtures, not Claude-named helpers.
- Strict TS: noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext ESM with .js import suffixes; no `any`.

## Decisions (with rationale)

## Decisions (with rationale)

Advisory recommendations (architect lane; claims verified against repo + grok-build sources; pending owner confirmation at gate):
- One package, `src/grok/` subtree + `./grok` subpath exports; root `"."` stays Claude-only (package-exports test pins the key set).
- Grok-native types/Zod/builder/runner; do NOT extend HookOutputBuilder/hooksConfigSchema/validateHookInput (vocabularies conflict: ask/defer vs allow/deny; snake_case vs camelCase envelopes).
- Isolate Grok session processing (own types, own discovery/tail); no shared SessionBlock unification in v1 — different vocabularies, idempotent-ID model absent on Grok.
- Fork executeHook/readStdinJson for Grok (fail-open semantics differ); share only generic helpers (readStdin, logging, isRecord).
- Pin strategy: vendor contract Rust files (event.rs, result.rs, session-events types.rs, handler enum) under docs/upstream/grok/ at SHA e5fd481/SOURCE_REV ea094a8 + Apache-2.0 NOTICE + drift test + maintainer refresh script; no submodule/CI-fetch.

## Scope IN

1. Grok hook types + Zod + output builder + executeHook variant ported from /tmp/grok-build xai-grok-hooks (event.rs, result.rs)
2. Settings/config validation for Grok JSON + TOML hook objects (command/http only)
3. Session discovery (~/.grok/sessions, GROK_HOME, URL-encoded cwd) + parse/tail of updates.jsonl and events.jsonl
4. Upstream pin of event.rs + types.rs at recorded SHA (e5fd481 / SOURCE_REV ea094a8) with drift test
5. Docs: Grok vs Claude incompatibilities

## Scope OUT (Must NOT have)

- Agent SDK / ACP as hook transport; driving grok like t3code
- Reusing Claude HookOutputBuilder methods Grok ignores (ask/defer, updatedInput)
- mcp_tool / prompt / agent handlers
- Porting the 17 Claude-only hook events
- Editing product code in this planning session
- Committing plans/grok-adapter/brief.md to the public package

## Open questions

From brief section 7 (owner-decisions):
1. Attach-only for v1 confirmed? (default per brief: yes)
2. One package with grok/ exports vs second package?
3. Shared session-block model now vs isolated Grok processing?
4. Claude->Grok translator vs document-only?
5. Pin strategy: submodule / vendored snippets / CI fetch script?
6. Compatibility floor (grok version / SOURCE_REV)?
7. Cockpit forwarder for Grok in v1 or hooks library + tail only?

## Momus review log
- Round 1 (st_019ff952): REJECT - vendored-file count contradiction (5 vs 6); F1-F4 lacked executable QA.
- Round 2 (st_019ff955): REJECT - readStdin pulls CLAUDE_* config into Grok path; F1 file set omitted LICENSE-APACHE.
- Round 3 (st_019ff956): REJECT - same readStdin contradiction restated; todo 12 dependency matrix omitted todos 6-11.
- Round 4 (st_019ff958): REJECT - no provenance for hook-envelope fixtures; F4 allowed-file list omitted examples/grok/** and pnpm-lock.yaml.
- All fixed in plan_sha256 31fd4248 (verified line-by-line on resume): six-file count consistent, F1 includes LICENSE-APACHE, F1-F4 executable, Grok-local stdin reader, todo 12 blocked by 2,3,4,5,10,11, fixture provenance hand-authored from vendored event.rs + optional capture procedure, F4 list includes examples/grok/** and pnpm-lock.yaml.
- Round 5 (st_019ff95b): lost to terminal crash mid-review (suspended: quit), no verdict. Respawned as a fresh momus in the resumed session.
- Round 5 respawn (st_019ff961): [OKAY] - referenced repo and upstream files exist and are relevant; every implementation todo and final verification item has executable QA with concrete commands and expected outcomes. Review complete, plan approved for handoff.

## Approval gate
status: approved (user okayed; plan written)
approach: one package, src/grok/ subtree, attach-only v1 (hooks + session parse/tail), vendored upstream pin with drift test.
next workflow action: none - review passed; handoff presented, execution starts separately on explicit user start-work.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
