# grok-adapter - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** This package learns to understand Grok Build as a second agent harness, alongside Claude: it can validate and answer Grok's hook calls (approve/deny tool runs, react to session events), and it can read and follow Grok's on-disk session logs to reconstruct conversations and live agent activity.

**Why this approach:** Grok's real contract is its published Rust source, not its user guide — so we pin that source into the repo with an automatic drift alarm, and we build a Grok-native layer beside the Claude code instead of forcing one shared abstraction that fits neither.

**What it will NOT do:** It will not start or drive Grok sessions (attach-only), will not translate Claude hook scripts to Grok, and will not claim feature parity across all 30 Claude hook events.

**Effort:** Large
**Risk:** Medium - Grok's public source tree can lag the shipped binary; mitigated by pinning plus tolerant parsing of unknown event variants.
**Decisions to sanity-check:** one package (not two); Grok session data gets its own change-based model (upsert/delete) rather than reusing Claude's block model; five Rust source files are vendored into the repo under Apache-2.0 attribution.

**What we learned:** Attach-only, no Claude-to-Grok translator. Rewind keeps later chunks on the kept prompt; `fromStart` after reset must advance generation. Unknown tags stay in the tail. Archive finished plans under `.plans/`; leave evidence packets optional and runtime out of the public tree.

Your next move: this plan is archived. For a fresh run, copy it back to `.omo/plans/grok-adapter.md` with boxes unchecked and delete boulder/runtime first.

---

> TL;DR (machine): Large, Medium risk; src/grok/ hook+settings+session tail adapter with vendored upstream pin; ./grok exports; momus review required before handoff.

## Scope
### Must have
- Grok-native hook support in this package: types + Zod validation + output builder (allow/deny; Stop block/approve/force-stop/additionalContext) + `executeGrokHook` runner, ported from `/tmp/grok-build/crates/codegen/xai-grok-hooks` at HEAD `e5fd4816d43260c15ba785f103990c1ed6cea230` / `SOURCE_REV` `ea094a8c369475f97c85540d01730baec0dce5d6`. All 15 wire events plus legacy `subagent_end`.
- Grok settings validation: JSON + TOML hook config (command/http handlers, matcher groups, event-key aliases), with the JSON-fail-fast vs TOML-skip-bad-event semantic difference.
- Grok session discovery (`GROK_HOME` ?? `~/.grok`, URL-encoded cwd with blake3 slug fallback >255 bytes, `.cwd` file) and parse/tail of `updates.jsonl` (ACP + xAI `sessionUpdate` unions) and `events.jsonl` (`Event` union, schema_version 1.0).
- Grok-native normalized change model (upsert/delete blocks + activities with provenance) inside `src/grok/processing/` — no Claude `SessionBlock` unification, but rewind-capable.
- Upstream pin: vendored `event.rs`, `result.rs`, `runner/mod.rs`, session-events `types.rs`, plugins-types `lib.rs`, and `session-update-enum.txt` (SessionUpdate enum extract from notification.rs) under `docs/upstream/grok/` with Apache-2.0 NOTICE, pin manifest (HEAD, SOURCE_REV, `grok --version` 1.0.3), maintainer refresh script, drift tests.
- Public exports `./grok` and `./grok/processing`; root `"."` and all Claude exports byte-identical.
- Docs: Grok vs Claude incompatibilities reference; no 30-event parity claims.
- Forward compatibility: unknown `sessionUpdate`/event tags preserved as unknown native records, never fatal; malformed known variants reported as invalid, never downgraded.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No edits to existing Claude files except: package.json exports (additive), tests/package-exports test expectations (additive), docs index links. `HookOutputBuilder`, `executeHook`, `validateHookInput`, `hooksConfigSchema`, `src/processing/*` stay untouched.
- No ACP/Agent-SDK hook transport; no driving `grok -p` or `grok agent`; no cockpit/HTTP forwarder for Grok.
- No mcp_tool/prompt/agent handler types; no porting the 17 Claude-only events; no `ask`/`defer`/`updatedInput` outputs (Grok ignores them).
- No Claude↔Grok translator; document "write a Grok script" instead.
- No new CLI bins in v1 (library surface only; QA via Vitest).
- No git submodule, no CI network fetch of grok-build, no vendoring beyond the six contract files, no npm dependency on Rust crates.
- No committing `plans/grok-adapter/brief.md` or any planning scratch.
- No `any`; strict TS flags already in tsconfig apply (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, NodeNext `.js` suffix imports).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD where the artifact is a contract (Zod schemas, parsers, output builder, cursor); tests-after for wiring (exports, docs). Framework: Vitest (`pnpm run test:run`), type-check `pnpm run type-check`, lint `pnpm run lint`.
- Fixtures: small redacted dumps from `~/.grok/sessions/%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit/` stored under `tests/fixtures/grok/`; re-dump procedure documented in the pin manifest.
- Evidence: .omo/evidence/task-<N>-grok-adapter.<ext>

## Execution strategy
### Parallel execution waves
Wave 1 (foundations, independent): todos 1, 2, 6, 8.
Wave 2 (contract consumers): todos 3, 4, 5, 7, 9.
Wave 3 (integration): todos 10, 11.
Wave 4 (surface): todos 12, 13 (13 after 12), then final verification wave.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 upstream pin | — | 2, 7, 9 (drift tests) | 2, 6, 8 |
| 2 hook types+schemas | 1 (drift test) | 3, 4, 12 | 1, 6, 8 |
| 3 output builder | 2 | 12 | 4, 5, 7, 9 |
| 4 runner | 2 | 12 | 3, 5, 7, 9 |
| 5 settings validation | 1 | 12 | 3, 4, 7, 9 |
| 6 discovery | — | 10 | 1, 2, 8 |
| 7 updates parser | 1 | 10 | 3, 4, 5, 9 |
| 8 jsonl cursor | — | 10 | 1, 2, 6 |
| 9 events parser | 1 | 10 | 3, 4, 5, 7 |
| 10 tail+checkpoint | 6, 7, 8, 9 | 13 | 11 |
| 11 normalized model+reducer | 7, 9 | 10 (co-developed), 13 | 10 |
| 12 package exports | 2, 3, 4, 5, 10, 11 | 13 | — |
| 13 docs | 12 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Vendor Grok upstream contract files + pin manifest + refresh script
  Recommended task executor category: quick
  What to do / Must NOT do: Create `docs/upstream/grok/` containing verbatim copies from `/tmp/grok-build` (HEAD e5fd4816d43260c15ba785f103990c1ed6cea230): `event.rs` and `result.rs` (crates/codegen/xai-grok-hooks/src/), `runner-mod.rs` (crates/codegen/xai-grok-hooks/src/runner/mod.rs, renamed to avoid directory nesting), `session-events-types.rs` (crates/codegen/xai-grok-session-events/src/types.rs), `plugins-types-lib.rs` (crates/codegen/xai-hooks-plugins-types/src/lib.rs), and `session-update-enum.txt` (the full `SessionUpdate` enum text extracted from crates/codegen/xai-grok-shell/src/extensions/notification.rs — the enum body including serde attributes and variant fields, since todo 7 ports it and the whole 900-line file need not be vendored). Add `docs/upstream/grok/NOTICE` (Apache-2.0 attribution to xAI, grok-build, license text pointer to /tmp/grok-build/LICENSE content copied as LICENSE-APACHE). Add `docs/upstream/grok/pin.json`: `{ "repo": "https://github.com/xai-org/grok-build", "head": "e5fd4816d43260c15ba785f103990c1ed6cea230", "sourceRev": "ea094a8c369475f97c85540d01730baec0dce5d6", "grokVersion": "1.0.3", "pinnedAt": "2026-08-13", "files": { "<local name>": { "upstreamPath": "...", "sha256": "..." } }, "fixtureRedump": "copy small redacted updates.jsonl/events.jsonl from ~/.grok/sessions/<encoded-cwd>/<id>/ into tests/fixtures/grok/" }`. Add `scripts/sync-upstream-grok.mjs` (mirrors scripts/sync-upstream-docs.mjs conventions): given a local checkout path arg, copies the five Rust files and re-extracts the SessionUpdate enum from notification.rs (match from `pub enum SessionUpdate` to its closing brace at column 0, verifying balance), recomputes sha256, updates pin.json, prints diff summary; no network by default (optional --from-github uses pinned raw URLs at `head`). Must NOT: vendor other files; edit Claude upstream docs; add CI network steps.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2, 7, 9
  References (executor has NO interview context - be exhaustive): plans/grok-adapter/brief.md §3.1/§8; /tmp/grok-build/{crates/codegen/xai-grok-hooks/src/event.rs,crates/codegen/xai-grok-hooks/src/result.rs,crates/codegen/xai-grok-hooks/src/runner/mod.rs,crates/codegen/xai-grok-session-events/src/types.rs,crates/codegen/xai-hooks-plugins-types/src/lib.rs,LICENSE}; scripts/sync-upstream-docs.mjs; docs/upstream/README.md
  Acceptance criteria (agent-executable): `node scripts/sync-upstream-grok.mjs /tmp/grok-build --check` exits 0 on a fresh vendor (idempotent); `sha256sum docs/upstream/grok/*.rs` matches pin.json; NOTICE and pin.json parse (`node -e "JSON.parse(require('fs').readFileSync('docs/upstream/grok/pin.json'))"`).
  QA scenarios (name the exact tool + invocation): happy: run `node scripts/sync-upstream-grok.mjs /tmp/grok-build` then `--check` → 0. failure: corrupt one vendored file, `--check` exits non-zero naming the drifted file; run with a nonexistent checkout path → clear error, non-zero. Evidence .omo/evidence/task-1-grok-adapter.txt
  Commit: Y | chore(upstream): pin grok-build hook and session contract files

- [x] 2. Grok hook types + Zod envelope/payload schemas + validators
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/types.ts` (TypeScript types inferred from Zod, per repo schema-first rule) and `src/grok/validation.ts`. Implement `grokHookInputSchema`: `z.discriminatedUnion('hookEventName', [...])` with one `z.looseObject` branch per event; shared envelope fields `sessionId/cwd/workspaceRoot/timestamp` (required strings), `transcriptPath/clientIdentifier/promptId/permissionMode` (optional); per-event payload fields exactly per vendored event.rs — 15 wire events (`session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `permission_denied`, `stop`, `stop_failure`, `notification`, `subagent_start`, `subagent_stop`, `subagent_end`, `pre_compact`, `post_compact`, `session_end`) with the exact field sets from the exploration ledger in .omo/drafts/grok-adapter.md (e.g. pre_tool_use: toolName, toolUseId, toolInput: unknown, toolInputTruncated: boolean, subagentType?; stop: reason, stopHookActive, lastAssistantMessage?, backgroundTasks?, sessionCrons? with camelCase nested objects; stop_failure error enum rate_limit|authentication_failed|invalid_request|server_error|max_output_tokens|unknown; subagent_stop phase gate|observe). Export `GrokHookEventName` const array, per-event input types, `validateGrokHookInput(input: unknown)`. Write the drift test here: `tests/grok-upstream-drift.test.ts` parses the vendored event.rs `hook_events!` table + serde attributes and asserts the TS event-name list and wire values match exactly. TDD: tests first in `tests/grok-validation.test.ts` using Grok-envelope fixture factories in `tests/grok-test-utils.ts` (new file; do NOT extend tests/test-utils.ts). Must NOT: touch src/types, src/validation; use z.catch; accept PascalCase event values on stdin (aliases are config-side only).
  Parallelization: Wave 1 | Blocked by: 1 (drift test only) | Blocks: 3, 4, 12
  References: docs/upstream/grok/event.rs (vendored in todo 1); .omo/drafts/grok-adapter.md findings; src/validation/schemas.ts (style: discriminated unions, looseObject boundaries); src/validation/validators.ts:152-166 (validator style); tests/test-utils.ts (factory style)
  Acceptance criteria: `pnpm exec vitest run tests/grok-validation.test.ts tests/grok-upstream-drift.test.ts` green; `pnpm run type-check` clean; envelope fixtures in tests/fixtures/grok/hook-envelopes/ (one JSON per event) validate. Fixture provenance: hand-authored field-by-field from the vendored docs/upstream/grok/event.rs (the wire authority — upstream's own tests serialize structs in code, no JSON literals exist to copy); the drift test guarantees the schema tracks event.rs. Additionally document an optional maintainer capture procedure in docs/upstream/grok/pin.json notes: install a tee-all command hook under ~/.grok/hooks/, run any grok session, redact, and commit captures — NOT required for tests/CI.
  QA scenarios: happy: validate each of 15 event envelopes (fixtures). failure: wrong-case `hookEventName: "PreToolUse"` → ZodError; missing toolInputTruncated → ZodError; unknown event → ZodError; extra unknown fields → accepted (looseObject). Evidence .omo/evidence/task-2-grok-adapter.txt
  Commit: Y | feat(grok): add hook envelope types and Zod validation

- [x] 3. GrokHookOutputBuilder (gate + stop outputs only)
  Recommended task executor category: unspecified-high
  What to do / Must NOT do: Create `src/grok/output-builder.ts`: `GrokHookOutputBuilder` plain object (mirrors HookOutputBuilder shape, src/utils/output-builder.ts) with exactly: `gateAllow()` → `{decision:'allow'}`; `gateDeny(reason?)` → `{decision:'deny', reason?}`; `stopBlock(reason?)`, `stopApprove()`, `stopForce(stopReason?)` → `{continue:false, stopReason?}`; `stopContext(additionalContext)` → `{hookSpecificOutput:{additionalContext}}`; plus `success(message?)`/`error(reason)` universal helpers. All outputs typed via Zod schemas in src/grok/validation.ts (`grokGateOutputSchema`, `grokStopOutputSchema`) matching vendored runner-mod.rs GateHookJson/StopHookJson. JSDoc must state: observe-gate events ignore stdout decisions; blank deny reason falls back to stderr/default upstream. Must NOT: add ask/defer/updatedInput/permissionRequest/elicitation/worktree methods; reuse Claude output types.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 12
  References: docs/upstream/grok/runner-mod.rs (GateHookJson, StopHookJson, gate_json_to_decision); docs/upstream/grok/result.rs (HookDecision, StopHookOutcome); src/utils/output-builder.ts (object-of-factories convention, JSDoc contract style)
  Acceptance criteria: `pnpm exec vitest run tests/grok-output-builder.test.ts` green: every builder output round-trips through its Zod schema; type-check clean.
  QA scenarios: happy: each factory emits schema-valid JSON. failure: stopContext("") rejects or omits blank context (assert chosen semantics match upstream nonblank rule); unknown decision literal fails schema. Evidence .omo/evidence/task-3-grok-adapter.txt
  Commit: Y | feat(grok): add Grok hook output builder

- [x] 4. Grok hook runner: readGrokStdinJson + executeGrokHook
  Recommended task executor category: unspecified-high
  What to do / Must NOT do: Create `src/grok/execute.ts`: `readGrokStdinJson()` (implement a Grok-local stdin reader inside src/grok/execute.ts — do NOT import `readStdin`: it calls `getConfig().debug` at src/utils/index.ts:50 and `getConfig` reads CLAUDE_* env; duplicate the ~15 lines: chunk collect, 30s timeout with logError + exit(1), utf-8 concat; then `validateGrokHookInput`), `executeGrokHook<T>(handler)` mirroring executeHook control flow but Grok fail-open semantics: handler-thrown/block errors print `{decision:'deny', reason}` for pre_tool_use and `{decision:'block', reason}` for stop gates and exit 2; unexpected errors exit 1 with stderr log (fail-open upstream means exit 1 does not block — JSDoc must say so). Export `outputGrokJson` (typed Grok outputs; reuses the same stdout write). Add one minimal executable example `examples/grok/pre-tool-use-guard.ts` following the existing TS example style (examples/ contains TS examples and is type-checked per tsconfig). Must NOT: modify executeHook/readStdinJson/outputJson; sniff envelopes across harnesses; import CLAUDE_* config into the Grok path — concretely: no `getConfig`, `getProjectDir`, or `logDebug` calls from src/grok/** (they read CLAUDE_* env); use `logError`/`logInfo` only, plus an optional `GROK_HOOK_DEBUG`-style local flag if debug logging is wanted.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 12
  References: src/utils/index.ts (executeHook, readStdin, readStdinJson, outputJson, logging); docs/upstream/grok/runner-mod.rs + command.rs semantics recorded in .omo/drafts/grok-adapter.md (exit codes, fail-open); src/grok/validation.ts + output-builder.ts (todos 2-3)
  Acceptance criteria: `pnpm exec vitest run tests/grok-execute.test.ts` green (stdin/stdout mock pattern from tests/test-utils.ts:createStdinMock/createStdoutMock, duplicated as Grok variants in tests/grok-test-utils.ts); type-check clean.
  QA scenarios: happy: valid pre_tool_use envelope → handler runs, allow JSON on stdout, exit 0. failure: malformed JSON stdin → exit 1, stderr log; handler throws with BLOCK message on pre_tool_use → deny JSON + exit 2; on observe event (notification) → exit 1 semantics documented and asserted. Evidence .omo/evidence/task-4-grok-adapter.txt
  Commit: Y | feat(grok): add Grok hook runner

- [x] 5. Grok settings/config validation (JSON + TOML)
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/settings.ts`: Zod schemas for Grok hook config — `grokHooksConfigSchema` (top-level `{hooks: {<eventKey>: MatcherGroup[]}}`), `grokMatcherGroupSchema` (`{matcher?: string, hooks: RawHandler[]}`), `grokHandlerSchema` (`{type:'command'|'http', command?, url?, timeout?: number(seconds), env?: Record<string,string>|null}` with refinement: command required iff type command, url iff http). Accept all documented event-key spellings: PascalCase, snake_case, and the alias table (beforeSubmitPrompt→UserPromptSubmit, beforeShellExecution/beforeMCPExecution/beforeReadFile→PreToolUse, afterShellExecution/afterMCPExecution/afterFileEdit/afterAgentResponse/afterAgentThought→PostToolUse, camelCase variants, subagentEnd; full list in .omo/drafts/grok-adapter.md). Export `validateGrokHooksConfig(json: unknown)` (fail-fast: any malformed recognized event group rejects the file) and `validateGrokHooksToml(parsedToml: unknown)` (skip malformed event groups, keep valid ones — return `{config, skipped: string[]}`). TOML parsing itself stays the consumer's job (no new dependency; document that `smol-toml` or similar is expected input). Must NOT: add mcp_tool/prompt/agent; reuse hooksConfigSchema; add a TOML parser dependency.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 12
  References: /tmp/grok-build/crates/codegen/xai-grok-hooks/src/config.rs (RawHandler, build_one_spec, HooksMap::from_value/from_toml_value, GroupErrorPolicy); .omo/drafts/grok-adapter.md (alias table); src/validation/schemas.ts (hooksConfigSchema event-aware pattern to mirror, not reuse)
  Acceptance criteria: `pnpm exec vitest run tests/grok-settings.test.ts` green: JSON fail-fast vs TOML skip-bad-group asserted; alias normalization asserted for every alias; type-check clean.
  QA scenarios: happy: real-world-shaped JSON config with aliases validates and normalizes to canonical event keys. failure: handler missing command for type command → rejection (JSON) / skipped group (TOML); unknown event key → skipped (both), asserted. Evidence .omo/evidence/task-5-grok-adapter.txt
  Commit: Y | feat(grok): add Grok settings validation

- [x] 6. Grok session discovery
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/discovery.ts`: `getGrokHome(env?: NodeJS.ProcessEnv): string` (GROK_HOME ?? ~/.grok, no caching across env overrides in tests), `encodeGrokCwdDirname(cwd: string): string` (urlencoding-equivalent encode; if encoded >255 bytes → `<slug-of-basename>-<first16hex blake3(cwd)>`; implement blake3 via a tiny dependency ONLY if repo already allows deps — check package.json; if not, implement SHA-256-based fallback is WRONG: must match upstream, so add `@noble/hashes` blake3 or vendor a minimal blake3 — decide: use `@noble/hashes` (audited, ESM) and record in pin.json notes), `findGrokSessionDirs(cwd)` and `listGrokSessions(cwd)` reading `summary.json` (Zod `grokSummarySchema`: required info/session_summary/created_at/updated_at/num_messages/current_model_id, looseObject rest), and `.cwd` file fallback for hashed dirs. Must NOT: scan subagents/ or parse updates.jsonl here; share code with src/processing/discovery.ts (Claude, untouched).
  Parallelization: Wave 1 | Blocked by: — | Blocks: 10
  References: /tmp/grok-build/crates/codegen/xai-grok-config/src/paths.rs:113-140 (grok_home, encode_cwd_dirname, decode), /tmp/grok-build/crates/codegen/xai-grok-shared/src/session/mod.rs (session_dir), /tmp/grok-build/crates/codegen/xai-grok-shell/src/session/persistence.rs (Summary); src/processing/discovery.ts:48-53 (Claude analogue, style only)
  Acceptance criteria: `pnpm exec vitest run tests/grok-discovery.test.ts` green incl. a >255-byte cwd case whose expected dirname is computed by an independent blake3 in the test; resolves the real `~/.grok/sessions/%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit/` dir when present (skip-guarded if absent).
  QA scenarios: happy: encode this repo's cwd → `%2FUsers%2F...` and locate sessions. failure: missing GROK_HOME dir → empty list, not throw; malformed summary.json → validation error surfaced, other sessions still listed. Evidence .omo/evidence/task-6-grok-adapter.txt
  Commit: Y | feat(grok): add Grok session discovery

- [x] 7. updates.jsonl parser (ACP + xAI sessionUpdate unions)
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/updates.ts`: `grokUpdateEnvelopeSchema` (`{timestamp: number(unix secs), method: 'session/update'|'_x.ai/session/update', params: {sessionId, update, _meta?: unknown}}`), ACP union (`z.discriminatedUnion('sessionUpdate', looseObject branches)`: user_message_chunk, agent_message_chunk, agent_thought_chunk (content blocks), tool_call, tool_call_update (camelCase fields toolCallId/title/kind/status/content/locations/rawInput/rawOutput), plan, available_commands_update, current_mode_update) and the xAI union subset pinned by fixtures + exploration ledger (turn_completed, response_started, response_completed, reasoning_completed, subagent_spawned, subagent_progress, subagent_finished, rewind_marker, auto_compact_*, hook_execution, hooks_changed, workflow_updated, goal_updated, task_*, scheduled_task_*, monitor_event, model_*, tool_call_delta_chunk, memory_*, session_recap*, feedback_request, diff_review, retry_state, image_*, pending_interaction, interaction_resolved, last_turn_summary, compaction_checkpoint, plugin_*, session_summary_generated, auto_recovery_*, auto_continue_completed, memory_files, relay_sync_status, session_recap_unavailable — exact fields from .omo/drafts/grok-adapter.md and the vendored `docs/upstream/grok/session-update-enum.txt` from todo 1). Tag-peek dispatch `parseGrokSessionUpdate(raw): {kind:'known'|'unknown'|'invalid', ...}` — never throw on unknown tags; `.catch()` forbidden. Fixtures: dump small redacted updates.jsonl from the live session into tests/fixtures/grok/updates.sample.jsonl. Must NOT: parse chat_history.jsonl (derived cache); filter/sort/dedup (upstream export preserves file order).
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 10
  References: /tmp/grok-build/crates/codegen/xai-grok-shell/src/session/storage/mod.rs (SessionUpdateEnvelope), extensions/notification.rs:456 (tag attr) and full SessionUpdate enum, session/export.rs (no-filter behavior), wire_tags.rs; .omo/drafts/grok-adapter.md
  Acceptance criteria: `pnpm exec vitest run tests/grok-updates.test.ts` green: fixture parses with zero invalid lines; every fixture tag is classified known or explicitly unknown; type-check clean.
  QA scenarios: happy: real fixture → all lines parsed, ACP vs xAI split by method. failure: unknown sessionUpdate tag → kind 'unknown' with raw preserved; known tag missing required field → kind 'invalid' with message; truncated `_meta` blob → accepted as unknown. Evidence .omo/evidence/task-7-grok-adapter.txt
  Commit: Y | feat(grok): add updates.jsonl session update parser

- [x] 8. Generic JSONL cursor primitive
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/jsonl-cursor.ts` (internal, not exported from ./grok barrel): `JsonlCursor`, `readJsonlDelta(path, cursor|null, {maxLineBytes=16MiB})` implementing: open-then-fstat identity (device/inode), size snapshot, reset on inode change/shrink/head-or-boundary digest mismatch (generation++), bounded chunked scanning, emit only newline-terminated lines with lineNumber+byteStart+byteEnd, hold uncommitted partial tail, skip-and-diagnose oversized lines (streaming discard). Pure I/O — no Grok/Claude types. Must NOT: modify src/processing/tail.ts; allocate full-file buffers.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 10
  References: src/processing/tail.ts (readTranscriptRecordsFromMarker, recordsStartingAtOrAfter — behavioral reference only); tests/session-raw-tail-snapshot.test.ts + tests/tail.test.ts (partial-line and snapshot semantics to mirror); /tmp/grok-build/crates/codegen/xai-grok-pager-pty-harness/src/leader.rs (parse_update_payloads tolerance)
  Acceptance criteria: `pnpm exec vitest run tests/grok-jsonl-cursor.test.ts` green: append, partial-line-then-complete, truncate-regrow same inode, inode replacement, oversized line skip, mid-run append after snapshot deferred to next pass.
  QA scenarios: happy: append 3 lines → delta returns 3, cursor advances; partial write then completion → single parse. failure: file replaced (rename) → generation++ rescan from 0; 17MiB line → oversized diagnostic, cursor advances past it; file missing → empty delta, cursor retained. Evidence .omo/evidence/task-8-grok-adapter.txt
  Commit: Y | feat(grok): add bounded JSONL cursor primitive

- [x] 9. events.jsonl parser + drift test
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/events.ts`: `grokEventSchema` — `z.discriminatedUnion('type', looseObject branches)` over the full Event union (~60 variants; snake_case type tags and fields; `ts` writer-added field required on parse; schema_version literal '1.0' only on turn_started; exact skip-serializing rules per .omo/drafts/grok-adapter.md ledger, e.g. mcp_oauth_discovery_timeout explicit rename). Same tag-peek known/unknown/invalid policy as todo 7. Extend tests/grok-upstream-drift.test.ts: parse vendored session-events-types.rs enum variants + serde renames and assert the TS branch set matches exactly. Fixture: tests/fixtures/grok/events.sample.jsonl from the live session. Must NOT: coalesce or drop high-volume variants at parse time (phase_changed etc. stay parseable; reduction belongs to todo 10/11).
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 10
  References: docs/upstream/grok/session-events-types.rs (vendored, todo 1); .omo/drafts/grok-adapter.md (variant field ledger)
  Acceptance criteria: `pnpm exec vitest run tests/grok-events.test.ts tests/grok-upstream-drift.test.ts` green; fixture parses with zero invalid lines.
  QA scenarios: happy: fixture → known variants with fields typed. failure: unknown type tag → unknown record; turn_started without schema_version → invalid; drift test fails when a variant is renamed in the vendored file (simulate in test by parsing a mutated copy). Evidence .omo/evidence/task-9-grok-adapter.txt
  Commit: Y | feat(grok): add events.jsonl event parser

- [x] 10. Grok session tail: two-source checkpointed tailing
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/tail.ts`: `tailGrokSession(sessionDir, options?)`, `commitGrokSessionCheckpoint(sessionDir, checkpoint, options?)`, `watchGrokSession(sessionDir, options?)` (async generator on fs.watch with debounce; no fixed sleeps in tests — subscribe to fs events). Compose: jsonl-cursor (todo 8) over updates.jsonl + events.jsonl, parsers (todos 7, 9), reducer (todo 11). One revisioned marker (sessionPathDigest, baseRevision, per-source cursors) committed only after both reads succeed; per-source reset events; missing events.jsonl → status 'missing', not error; timestamps: params._meta.agentTimestampMs ?? outer timestamp (updates), ts (events); tie-break source kind → generation → byte offset. Options: markerDir, allowedMarkerRoots (per-call, NOT env), fromStart, checkpointMode automatic|manual, maxLineBytes, includeActivities. Must NOT: read CLAUDE_TAIL_MARKER_ROOTS; reuse Claude tail functions; block on human input.
  Parallelization: Wave 3 | Blocked by: 6, 7, 8, 9 (co-developed with 11) | Blocks: 13
  References: src/processing/tail.ts (tailRawTranscriptSessionRecords, commitRawTranscriptSessionCheckpoint — revisioned multi-source marker precedent); .omo/drafts/grok-adapter.md (failure policy table); AGENTS.md (CLAUDE_TAIL_MARKER_ROOTS exclusion)
  Acceptance criteria: `pnpm exec vitest run tests/grok-tail.test.ts` green: two-file interleave ordering, crash-resume from checkpoint, manual checkpoint mode, rewind deletes surfaced, rotation reset; no timing-flaky sleeps.
  QA scenarios: happy: copy fixture session to tmpdir, tail fromStart → deterministic change list; append new lines via fs, watch yields batch (await fs.watch event, bounded timeout). failure: events.jsonl absent → missing status; updates.jsonl truncated mid-line → partial held, completed next pass; IO error → no checkpoint commit (assert marker unchanged). Evidence .omo/evidence/task-10-grok-adapter.txt
  Commit: Y | feat(grok): add checkpointed Grok session tailing

- [x] 11. Grok normalized change model + reducer
  Recommended task executor category: deep
  What to do / Must NOT do: Create `src/grok/processing/blocks.ts`: `GrokRecordOrigin` (harness:'grok', stream:'conversation'|'activity', sourceId, nativeType, generation, byteStart, byteEnd), `GrokSessionBlock` (user_text|assistant_text|thinking|tool_use|tool_result|agent_boundary — Grok-owned types, not Claude SessionBlock), `GrokBlockChange` (upsert|delete), `GrokActivity` (category turn|phase|tool|permission|lifecycle). Reducer maps per the verified mapping: user/agent_message_chunk→text upserts (accumulate by messageId ?? promptId+streamStart fallback), agent_thought_chunk→thinking, tool_call→tool_use, tool_call_update input/title→re-upsert tool_use, terminal tool_call_update→tool_result, subagent_spawned/finished→agent_boundary, rewind_marker→deletes after target_prompt_index, events.jsonl→activities coalesced to current state per correlation id (never one block per phase_changed). Full-export reducer folds changes to final blocks. Must NOT: edit src/processing/types.ts (SessionBlockBase.origin unification is deferred per approved Q3 decision); emit blocks for turn_completed (activity only).
  Parallelization: Wave 3 | Blocked by: 7, 9 | Blocks: 10 (co-developed), 13
  References: .omo/drafts/grok-adapter.md (ultrabrain mapping table); src/processing/block-decomposition.ts + blocks.ts (stable-ID/upsert precedent, style only); /tmp/grok-build/crates/codegen/xai-grok-shell/src/session/helpers/replay.rs (rewind filter reference)
  Acceptance criteria: `pnpm exec vitest run tests/grok-blocks.test.ts` green: chunk accumulation produces single upserted block per message; rewind_marker emits deletes exactly for later-prompt blocks; phase stream coalesces.
  QA scenarios: happy: fixture updates → expected block sequence snapshot. failure: rewind beyond start → no negative deletes; duplicate tool_call_update → idempotent upsert (same ID). Evidence .omo/evidence/task-11-grok-adapter.txt
  Commit: Y | feat(grok): add Grok session block change model

- [x] 12. Package exports wiring for ./grok
  Recommended task executor category: quick
  What to do / Must NOT do: Add to package.json exports: `"./grok"` → dist/grok/index.js(+d.ts), `"./grok/processing"` → dist/grok/processing/index.js; create `src/grok/index.ts` (re-export types, validation, output-builder, execute, settings) and `src/grok/processing/index.ts` (discovery, updates, events, tail, blocks — NOT jsonl-cursor internal). Update tests/package-exports.test.ts expectations additively. Verify `pnpm run build` emits dist/grok and `node -e "import('@libar-dev/agent-harness-kit/grok')"` resolves via `pnpm pack` dry run or exports test. Must NOT: change root `.` or any existing export; move Claude symbols; add bin entries.
  Parallelization: Wave 4 | Blocked by: 2, 3, 4, 5, 10, 11 | Blocks: 13
  References: package.json:14-44 (exports map), tests/package-exports.test.ts, tsconfig.build.json (src/** inclusion), scripts/fix-imports.js
  Acceptance criteria: `pnpm run build` exit 0; `pnpm exec vitest run tests/package-exports.test.ts` green; root barrel remains processing-free per existing test.
  QA scenarios: happy: import both new subpaths from a packed tarball layout. failure: import a non-exported grok internal (jsonl-cursor) → resolution error asserted. Evidence .omo/evidence/task-12-grok-adapter.txt
  Commit: Y | feat(grok): expose grok subpath exports

- [x] 13. Docs: Grok adapter reference + incompatibility matrix
  Recommended task executor category: writing
  What to do / Must NOT do: Add `docs/reference/grok-adapter.md`: event list (15 + subagent_end), envelope/stdout contract tables, settings discovery+aliases summary, session layout + parse/tail API surface, pin/drift policy, and the Grok-vs-Claude incompatibility matrix (from brief §4.2, corrected against findings: camelCase envelope, allow/deny-only, command/http-only, 5s/600s timeouts, fail-open). Update README.md with one short section ("Grok (second harness)") linking the doc and stating attach-only scope; update AGENTS.md module list with src/grok entries. State explicitly: no 30-event parity, no translator, Claude scripts will not run correctly under Grok without a Grok-native entrypoint. Must NOT: claim unimplemented features (CLI bins, forwarder, SessionBlock unification); commit plans/ or .omo/ files; edit docs/upstream/hooks-*.md.
  Parallelization: Wave 4 | Blocked by: 10, 11, 12 | Blocks: —
  References: plans/grok-adapter/brief.md §4.2/§5/§6; .omo/drafts/grok-adapter.md findings; README.md structure; AGENTS.md "Key modules"
  Acceptance criteria: `pnpm run check` clean; doc code snippets that are JSON parse (extend tests/docs-round-trip.test.ts pattern ONLY if it already globs docs/reference — check first; otherwise manual node -e JSON.parse per snippet); README/AGENTS links resolve (test: file exists for each relative link).
  QA scenarios: happy: render doc, every referenced symbol exists in src/grok (script grep). failure: doc mentions a removed/renamed API → grep check fails (run once against a deliberately wrong name to prove the check works, then revert). Evidence .omo/evidence/task-13-grok-adapter.txt
  Commit: Y | docs(grok): add Grok adapter reference and incompatibility matrix

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Verify every Must have exists and every Must NOT have held: run `ls docs/upstream/grok/` (expect exactly the six pinned files + NOTICE + pin.json + LICENSE-APACHE), `git diff --stat origin/main -- src/types src/validation src/utils src/processing` (expect empty), `git status --porcelain plans/ .omo/` (expect untracked/ignored only, never staged), `grep -rn "ask\|defer\|updatedInput" src/grok/` (expect no builder methods emitting them). APPROVE only if all checks pass; report as .omo/evidence/f1-grok-adapter.txt.
- [x] F2. Code quality review
  Run `pnpm run check` (type-check + lint) and `pnpm run build`; review `src/grok/**` diff for: no `any`, .js-suffix imports, JSDoc on all exports, comment-style rules from AGENTS.md (no temporal/migration phrasing), no Claude-file edits beyond the allowed additive set. APPROVE only if all commands exit 0 and review finds no violations; report as .omo/evidence/f2-grok-adapter.txt.
- [x] F3. Real manual QA
  Agent-executed end-to-end against the real machine state: (1) validate the committed hook-envelope fixtures (todo 2, provenance: derived from vendored event.rs) through `validateGrokHookInput` via `pnpm exec tsx -e` snippet; (2) run `tailGrokSession` with `fromStart` on a tmp copy of the real session dir `~/.grok/sessions/%2FUsers%2Fdarkomijic%2Fdev-libar%2Flibar-agent-harness-kit/<newest-id>/`, assert zero invalid lines and deterministic block count across two runs; (3) `node scripts/sync-upstream-grok.mjs /tmp/grok-build --check` exits 0. APPROVE only if all three pass; report as .omo/evidence/f3-grok-adapter.txt.
- [x] F4. Scope fidelity
  Diff the plan's Must have list against delivered artifacts one by one (each maps to a committed todo); confirm no out-of-scope additions landed: `git diff --stat origin/main` shows only expected files (src/grok/**, tests/grok-*, tests/fixtures/grok/**, docs/upstream/grok/**, docs/reference/grok-adapter.md, scripts/sync-upstream-grok.mjs, examples/grok/**, package.json, pnpm-lock.yaml, README.md, AGENTS.md, tests/package-exports.test.ts). APPROVE only if the file set matches exactly; report as .omo/evidence/f4-grok-adapter.txt.

## Commit strategy
One commit per todo, conventional commits as listed per todo (`feat(grok): ...`, `chore(upstream): ...`, `docs(grok): ...`). Branch `feat/grok-adapter` from `origin/main` @ 6a08ff3. Never commit: `plans/grok-adapter/brief.md`, `.omo/**`, `.omo/evidence/**`. After the final verification wave passes and before PR handoff, run the Greptile local review per AGENTS.md (`greptile review -b main --json`) and triage P0/P1.

## Success criteria
- `pnpm run test:run`, `pnpm run type-check`, `pnpm run lint`, `pnpm run build` all exit 0 with the new Grok suites included.
- `@libar-dev/agent-harness-kit/grok` and `/grok/processing` import cleanly; root and Claude exports unchanged (package-exports test).
- Drift test pins all 15+1 hook events and the full events.jsonl union to vendored files at e5fd481/ea094a8.
- Real-session fixtures (updates.jsonl, events.jsonl) parse with zero invalid lines; tail of a copied live session is deterministic and resumable.
- Docs state the incompatibility matrix; no parity overclaims.
- Momus high-accuracy review receipt recorded in .omo/drafts/grok-adapter.md before handoff.
