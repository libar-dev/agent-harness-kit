# omo-native-adapter - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** A complete attach adapter for OmO-native (senpi-engine) coding sessions inside this library: it can discover and list every session across all your projects, read a session's real conversation history correctly even though sessions branch like a git tree, follow live sessions as they grow, validate and run senpi's native command hooks, and - only with explicit consent - register hook integrations for a desktop observer app.

**Why this approach:** Senpi stores conversations as branching trees, not linear logs - so the one load-bearing decision is that this library (not any consumer) converts each tree into the correct linear history, including compaction checkpoints; and every wire format is copied byte-for-byte from a pinned, checksum-verified copy of the engine's own contract files, so upstream changes are caught by tests before they bite.

**What it will NOT do:** It never drives, spawns, or controls senpi sessions - observe only. It never reads credentials or telemetry state. It never grants hook trust silently - trust is written only through an explicit consent operation. It does not unify with the Claude or Grok adapters' internals.

**Effort:** Large
**Risk:** Medium - tree-linearization correctness is the hard part; mitigated by golden fixtures from real transcripts and two-way drift tests against the pinned engine artifacts.
**Decisions to sanity-check:** Pin to senpi 2026.8.19; no new runtime npm dependencies (internal file locking); Windows support is best-effort non-goal for v1; the kit PR merges only after the Cockpit integration phase is tested against it.

Your next move: approve to start execution via /start-work, or request changes. Full execution detail follows below.

---

> TL;DR (machine): Large/Medium-risk; 23 todos in 5 waves + 4 final verifiers; deliverables: src/senpi adapter (/senpi + /senpi/processing), vendored 2026.8.19 pin + drift tests, tree-linear tail/watch/discovery, 7-event hooks library with consent-gated trust writer, reference doc, cockpit Phase-C brief.

## Scope
### Must have

- `src/senpi/` attach adapter with two exact barrel subpaths `/senpi` and `/senpi/processing` (no wildcards), ESM NodeNext, Zod-validated, zero runtime dependency on the senpi engine or OmO.
- Session v3 contract: Zod schemas for header + the 9 known non-header entry tags (message, model_change, thinking_level_change, compaction, branch_summary, custom, custom_message, label, session_info), 7-role AgentMessage union, text/image/thinking/toolCall content blocks, usage/cost.
- Agent-home resolution: `OMO_CODING_AGENT_DIR`/`SENPI_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR` env → `<home>/.omo/agent` (sentinel settings.json) → legacy flat `<home>/.omo` → `<home>/.senpi/agent`, injectable env/homeDir/exists.
- Observe processing: discovery (top-level *.jsonl only; skip `*-artifacts/` dirs and per-cwd `extensions/`; verify header cwd — never trust dash-encoded dirname), `listSenpiSessions(cwd)`, `listAllSenpiSessions(agentHome?)` with SessionInfo-parity fields MINUS allMessagesText, `parseSenpiEntry` known/unknown/invalid policy, pure tree projection (`resolveSenpiLeaf`, `projectSenpiBranch`) honoring latest-compaction `retainedTail`/legacy `firstKeptEntryId`, internal jsonl cursor, senpi-prefixed checkpoint marker filenames, `tailSenpiSession` with revisioned suffix-splice mutations, `watchSenpiSession` (watch = wakeup hint; quiescence = configurable stable-cursor window, default 30s), Senpi-native block reduce/fold.
- Hooks library: `validateSenpiHooksConfig` (exactly 7 events, command handlers only, pinned diagnostic-code vocabulary), `hook-wire` schemas for HookInputWire/HookOutputWire with camelCase primaries + snake_case aliases, `executeSenpiHook` runner (exit 2 = block with stderr reason; stdout JSON otherwise), `SenpiHookOutputBuilder`, read-only trust state inspection + pure `hookTrustId`/`hashCommandHook` parity.
- Phase D groundwork: consent-gated `trust-writer` (explicit API, file lock, atomic replacement, preserves unknown entries, fail-closed on malformed state), forwarder asset variant + hooks.json registration helper that never writes trust state implicitly.
- Vendored contract artifacts under `docs/upstream/senpi/` (session-format.md + hooks dist .d.ts files, MIT NOTICE) with sha256 `pin.json` ({engineVersion: "2026.8.19", files, fixtureRedump, notes}) and tarball-based `scripts/sync-upstream-senpi.mjs --check` + two-way drift tests.
- Sanitized real-transcript fixtures from ~/.omo/agent/sessions plus synthetic edge-case fixtures under tests/fixtures/senpi/.
- Platform/runtime constraints: runtime floor Node >=22 (kit `engines`); zod ^4 API surface; NO new runtime npm dependencies (internal mkdir/O_EXCL locking instead of proper-lockfile); Windows is best-effort non-goal for v1 (runner honors commandWindows; cursor inode/device identity assumes POSIX); macOS/Linux CI is the supported matrix.
- docs/reference/senpi-adapter.md mirroring docs/reference/grok-adapter.md.
- Cross-repo Cockpit Phase C execution brief at plans/omo-native-adapter/cockpit-phase-c.md (spec only; cockpit code is a separate effort in that repo).

### Must NOT have (guardrails, anti-slop, scope boundaries)

- No runtime import of `@code-yeongyu/senpi`, `oh-my-openagent`, or any OmO package.
- No import from `src/grok/*` or Claude `src/processing/*` internals; no changes to Claude-path files, markers, block types, or root exports.
- No shared SessionBlock / hook-event / decision unification across adapters.
- No http/prompt/agent/mcp_tool hook handler types; no extension-API (in-process ExtensionAPI) surface.
- No reads of auth.json; no use of omo-senpi telemetry state as session contract.
- No drive/RPC/spawn control plane (attach-observe only); no multi-home auto-merge (extra stores reachable only via env/option).
- No silent trust-state writes outside the consent-gated writer; no trust writes from runner/settings/install paths.
- No wildcard `/senpi/*` exports; cursor/checkpoint internals stay unbarreled.
- No new runtime npm dependencies (dev/test deps follow existing policy).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + vitest (repo standard); every todo runs `pnpm run check` (type-check + lint) and targeted `pnpm run test:run -- tests/<area>` before commit.
- Contract truth: vendored pin artifacts are the wire authority; drift test must pass both directions (vendored→Zod, Zod→vendored) plus a mutation-detection case.
- Runtime proof: tail of a sanitized REAL transcript fixture must reproduce the expected linear leaf-path history (golden snapshot), including one branch-switch splice and both compaction forms.
- Evidence: every todo's `Evidence <evidence-root>/task-<N>-....log` path resolves against evidence-root = currentAttemptDir from 'omo-agent-toolkit ulw-loop status --json' (.omo/evidence/ulw/<session>/<goalId>/a<attempt>) when running under ulw-loop, else .omo/evidence/.
- CI wiring decision: `sync-upstream-senpi.mjs --check` is deliberately NOT wired into CI (grok precedent - it needs the tarball); the drift TESTS are vendored-artifact-only and DO run in CI on every push.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1 — Contracts & pins: todos 1-5.
- Wave 2 — Processing core + fixtures: todos 6-10 and 14.
- Wave 3 — Integration & observe surface: todos 11-13 and 15.
- Wave 4 — Hooks library & docs: todos 16-20.
- Wave 5 — Managed-hooks groundwork & cross-repo brief: todos 21-24.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 4, 5, 16, 19 | 2, 3 |
| 2 | — | 5, 6, 7, 10, 11, 14 | 1, 3 |
| 3 | — | 11 | 1, 2 |
| 4 | 1 | 5, 15 | 2, 3 |
| 5 | 1, 2, 4 | 16, 23 | — |
| 6 | 2 | 7, 12, 15 | 8, 14 |
| 7 | 2, 6, 14 | 10, 12 | 8, 9 |
| 8 | — | 9, 12, 15 | 6, 7, 14 |
| 9 | 8 | 12, 15 | 6, 7, 10, 14 |
| 10 | 2, 7 | 12, 15 | 8, 9 |
| 11 | 2, 3 | 12, 15 | 13 |
| 12 | 6, 7, 8, 9, 10, 11 | 13, 15, 23 | — |
| 13 | 12 | 15 | 11 |
| 14 | 2 | 7, 12 | 6, 8, 9 |
| 15 | 4, 6-13 | 16-22, 24 | — |
| 16 | 1, 5, 15 | 17, 18, 20 | 19 |
| 17 | 15, 16 | 20, 22 | 18, 19 |
| 18 | 15, 16 | 20 | 17, 19 |
| 19 | 1, 15 | 20, 21 | 16, 17, 18 |
| 20 | 15, 16, 17, 18, 19, 24 | — | 21, 22, 23 |
| 21 | 15, 19 | 22 | 20, 23 |
| 22 | 15, 17, 21 | — | 20, 23 |
| 23 | 5, 12, 15 | — | 20, 21, 22 |
| 24 | 15, 16, 17, 18, 19, 21 | 20 | 22, 23 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. Vendor senpi contract artifacts, pin.json, and tarball sync script
  Recommended task executor category: unspecified-low - multi-file mechanical vendoring + script
  What to do / Must NOT do: Fetch the artifact of record: `npm pack @code-yeongyu/senpi@2026.8.19` (record the registry integrity sha512 in pin.json notes). Extract EXACTLY: docs/session-format.md, docs/settings.md, docs/environment-variables.md; ALL 21 hooks .d.ts files from dist/core/extensions/builtin/hooks/ (types, index, schema, trust, trust-storage, config-loader, command-runner, dispatcher, output-parser, output-bounds, safety, matcher, command, handler, diagnostics, plugin-loader, plugin-manifest, lifecycle-adapter, tool-adapter, stop-adapter, prompt-adapter - count must equal 21); AND the implementation files needed because .d.ts signatures alone are insufficient: hooks/trust.js (hash algorithm), hooks/output-parser.js (SYSTEM_MESSAGE_EVENTS, output parsing incl. decision "allow"), hooks/trust-storage.js (lock + scope paths), hooks/output-bounds.js, hooks/types.js. Store under docs/upstream/senpi/ preserving relative names (hooks files under docs/upstream/senpi/hooks/). Write NOTICE (MIT, code-yeongyu/senpi) - no Apache file. Write pin.json: {engineVersion:"2026.8.19", pinnedAt:<today>, source:"npm", registryIntegrity, files:{<name>:{upstreamPath, sha256}}, fixtureRedump, notes[]} with per-file sha256 of the vendored bytes. The pin is COMPLETE at this todo; later todos must never add vendored files post-hoc. Write scripts/sync-upstream-senpi.mjs accepting `node scripts/sync-upstream-senpi.mjs --tarball <path> [--check]`: re-extract, re-hash, compare to pin.json; --check writes nothing and exits non-zero printing `Senpi upstream vendor drift detected: <file>` on any mismatch; success prints `Senpi upstream vendor is in sync.` Must NOT fetch at test time or import engine code.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4, 5, 16, 19
  References (executor has NO interview context - be exhaustive): docs/upstream/grok/pin.json (schema shape); scripts/sync-upstream-grok.mjs:53-89,324-389 (CLI + drift contract); plans/omo-native-adapter/planning-brief.md "Contract source of truth"; local reference copy: ~/dev-admin/oh-my-openagent/node_modules/@code-yeongyu/senpi (verify version 2026.8.19 in its package.json; tarball is the artifact of record).
  Acceptance criteria (agent-executable): `node scripts/sync-upstream-senpi.mjs --tarball <tarball> --check` exits 0 printing the in-sync line; corrupting one vendored byte makes it exit non-zero naming that file; pin.json covers every vendored file with matching sha256.
  QA scenarios (name the exact tool + invocation): happy - run --check against pristine tarball, capture exit 0, Evidence <evidence-root>/task-1-check.log; failure - flip one byte in a vendored .d.ts copy, rerun, capture named-file drift error and non-zero exit, Evidence <evidence-root>/task-1-drift.log
  Commit: Y | feat(senpi): vendor senpi 2026.8.19 contract artifacts with pin and sync script

- [ ] 2. Session v3 Zod schemas in src/senpi/types.ts
  Recommended task executor category: unspecified-high - core contract schemas need strictness care
  What to do / Must NOT do: Define Zod schemas + z.infer exports for: entry base {type,id,parentId:string|null,timestamp}; session header {type:"session",version,id,timestamp,cwd,parentSession?}; the EXACTLY 9 known non-header entry tags (message, model_change, thinking_level_change, compaction, branch_summary, custom, custom_message, label, session_info) with payloads: message{message:AgentMessage}; model_change{provider,modelId}; thinking_level_change{thinkingLevel}; compaction{summary,tokensBefore,retainedTail?:AgentMessage[],firstKeptEntryId?,usage?,details?,fromHook?}; branch_summary{fromId,summary,...}; custom{customType,data?}; custom_message{customType,content,display,details?}; label{targetId,label}; session_info{name}; AgentMessage union user/assistant/toolResult/bashExecution/custom/branchSummary/compactionSummary with content blocks text/image/thinking{startedAt?,endedAt?}/toolCall and usage{input,output,cacheRead,cacheWrite,totalTokens,cost{input,output,cacheRead,cacheWrite,total}}. Use z.looseObject for additive forward-compat on all entry/message objects. No filesystem access, no hook schemas, no tree logic in this file.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 5,6,7,8,10,14
  References: vendored docs/upstream/senpi/session-format.md (field authority); src/grok/validation.ts:1-226 (zod conventions: looseObject, discriminatedUnion); tsconfig.json:31-62 strictness (noUncheckedIndexedAccess, exactOptionalPropertyTypes).
  Acceptance criteria: `pnpm run check` passes; every cleanly-parsing JSON example fence in vendored session-format.md round-trips (assert >=10 fences yield >=10 parsed entries so silent under-extraction fails; skip `usage:{...}` ellipsis placeholder fences, which are intentionally invalid JSON); unknown extra fields survive parse. Zod floor: repo pins zod ^4.3.6 - looseObject/discriminatedUnion are zod-v4 APIs.
  QA scenarios: happy - fence-parse unit tests/senpi-types.test.ts with >=10-parsed-entries assertion, Evidence <evidence-root>/task-2-types.log; failure - compaction missing `summary` parses as kind:'invalid', never throws, same evidence file
  Commit: Y | feat(senpi): session v3 entry and message schemas

- [ ] 3. Agent-home resolution in src/senpi/home.ts
  Recommended task executor category: quick - single small pure module
  What to do / Must NOT do: Implement `resolveSenpiAgentHome(options?: {env?, homeDir?, exists?}): string` with exact precedence: first non-empty of OMO_CODING_AGENT_DIR, SENPI_CODING_AGENT_DIR, PI_CODING_AGENT_DIR (resolved absolute); `<homeDir>/.omo/agent` if it contains settings.json; `<homeDir>/.omo` if it contains settings.json; else `<homeDir>/.senpi/agent`. Pure/injectable. Also export AGENT_HOME_SENTINEL="settings.json" and AGENT_DIR_ENV_NAMES. No session discovery here.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 11
  References: ~/dev-admin/oh-my-openagent/packages/omo-senpi/src/components/agent-home/resolve-agent-home.ts (semantic authority); src/grok/processing/discovery.ts getGrokHome (per-call evaluation convention).
  Acceptance criteria: vitest table test covering env-wins, sentinel detection, flat fallback, senpi fallback, homeDir injection passes.
  QA scenarios: happy - precedence matrix assertions green, Evidence <evidence-root>/task-3-home.log; failure - empty-string env value skipped not returned, same evidence
  Commit: Y | feat(senpi): agent-home resolution

- [ ] 4. Hooks config validator in src/senpi/settings.ts
  Recommended task executor category: unspecified-high - diagnostic vocabulary parity is contract-critical
  What to do / Must NOT do: `validateSenpiHooksConfig(json: unknown): SenpiHooksConfig` validating: hooks record keyed by EXACTLY the 7 supported events (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, PreCompact, PostCompact, Stop); handler groups {matcher?, hooks:[{type:"command", command, commandWindows?, timeout?, statusMessage?}]}; unknown event keys and unsupported handler types (http/prompt/agent/mcp_tool) produce typed diagnostics from the pinned HookDiagnosticCode vocabulary in vendored hooks/types.d.ts + diagnostics.d.ts (invalid_root, invalid_hooks, invalid_event_config, invalid_matcher, invalid_handler_group, invalid_handler_list, invalid_handler, invalid_command, invalid_command_windows, invalid_command_target, missing_command_target, invalid_timeout, invalid_status_message, unknown_event, unsupported_event, unsupported_field, unsupported_handler_type, unsupported_async_handler, unsupported_command_variant). Return {executableHandlers, diagnostics} mirroring ParsedHookConfig. No file discovery, no TOML, no execution.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,15
  References: vendored docs/upstream/senpi/hooks/types.d.ts (CommandHookConfig, SupportedHookEvent, UNSUPPORTED_* consts, HookDiagnosticCode); vendored hooks/schema.d.ts + config-loader.d.ts (config sources: <agentHome>/hooks.json, <cwd>/.senpi/hooks.json, settings.json hooks keys); src/grok/settings.ts:1-214 (superRefine/transform style).
  Acceptance criteria: vitest: valid 7-event config parses; every diagnostic code reproducible by a dedicated malformed input; snake_case/camelCase event keys rejected as unknown_event (config-side takes only the 7 canonical names - unlike Grok aliases).
  QA scenarios: happy - full-valid config round-trip, Evidence <evidence-root>/task-4-settings.log; failure - one http handler yields unsupported_handler_type diagnostic, not throw, same evidence
  Commit: Y | feat(senpi): hooks configuration validator with pinned diagnostics

- [ ] 5. Upstream drift tests in tests/senpi-upstream-drift.test.ts
  Recommended task executor category: unspecified-high - two-way extraction logic against vendored sources
  What to do / Must NOT do: Parse vendored artifacts, assert BOTH directions against our code: (a) extract SUPPORTED_HOOK_EVENTS / UNSUPPORTED_KNOWN_HOOK_EVENTS / UNSUPPORTED_HANDLER_TYPES from hooks/types.d.ts and compare element-for-element with constants exported from src/senpi; (b) CREATE src/senpi/hook-contract.ts exporting HOOK_INPUT_BRANCHES (per-event required-field manifests copied VERBATIM from the HookInputWire union in vendored types.d.ts - e.g. SessionStart requires camelCase sessionId; permission_mode appears only on UserPromptSubmit; PreCompact has no accepted field; PostToolUse has no transcript_path) plus HOOK_DECISIONS = ["approve","block","deny","ask","allow"]; task 16 implements schemas strictly against this manifest; (c) extract entry `type` literals from vendored session-format.md json fences (regex-based, JSON.parse-independent) and compare with src/senpi/types.ts known-entry tags; (d) assert the vendored hooks .d.ts count equals 21; (e) include one mutation-detection case (tampered string makes the test fail with a named diff). Must NOT read the npm package at test time.
  Parallelization: Wave 1 | Blocked by: 1,2,4 | Blocks: 16,23
  References: tests/grok-upstream-drift.test.ts:1-145 (both-directions + mutation pattern); tests/docs-round-trip.test.ts:8-61 (md json-fence extraction).
  Acceptance criteria: `pnpm run test:run -- tests/senpi-upstream-drift.test.ts` green; renaming one Zod key intentionally makes it fail naming the mismatch.
  QA scenarios: happy - green run log, Evidence <evidence-root>/task-5-drift.log; failure - mutation case red with named mismatch, same evidence
  Commit: Y | test(senpi): two-way drift tests against vendored 2026.8.19 artifacts

- [ ] 6. Entry parser in src/senpi/processing/parse.ts
  Recommended task executor category: quick - single-file parser with fully specified policy
  What to do / Must NOT do: `parseSenpiEntry(raw: unknown): SenpiEntryParseResult` returning {kind:'known', entry} for the 9 known non-header tags (message, model_change, thinking_level_change, compaction, branch_summary, custom, custom_message, label, session_info) plus the session header; {kind:'unknown', tag, entry, raw} for any other tag whose base {type,id,parentId,timestamp} validates (unknown entries are tree participants); {kind:'invalid', error, raw} for malformed known tags or base-invalid lines. Tag-peek dispatch per grok policy. No ordering/tree/IO logic.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 7,12,15
  References: src/grok/processing/events.ts:1-320 (parse policy); src/senpi/types.ts (task 2).
  Acceptance criteria: vitest truth table over known/unknown/invalid samples incl. unknown-tag-with-valid-base joining the tree; zero throws on any JSON-decoded input.
  QA scenarios: happy - truth table green, Evidence <evidence-root>/task-6-parse.log; failure - malformed compaction returns invalid with message, never throws, same evidence
  Commit: Y | feat(senpi): known/unknown/invalid entry parser

- [ ] 7. Tree projection in src/senpi/processing/projection.ts
  Recommended task executor category: deep - one cohesive hard algorithmic problem, keep whole
  What to do / Must NOT do: Implement the approved design: SenpiTreeIndex {byId,parentById,childrenByParent,appendOrder,leafId,structuralLeaves,sessionName,labelsByTargetId}; index rules (reject duplicate id without overwrite; require parent already indexed; leaf = last accepted physical entry regardless of type); `resolveSenpiLeaf`; `projectSenpiBranch(entries, leafId, opts?)` -> root-to-leaf path records with stable keys; latest-compaction handling (retainedTail incl. [] authoritative, synthetic keys retained:<compaction-id>:<index>; legacy firstKeptEntryId range excluding older compactions; missing/off-path firstKept => warn + incomplete); off-path records disposition off_branch|summarized; cycle/missing-parent guards; warnings array. Pure helper `computeProjectionMutation(prevKeys, nextRecords)` returning {index,deleteCount,records,removedRecordKeys} | null via longest-common-prefix. Pure module: no IO.
  Parallelization: Wave 2 | Blocked by: 2,6,14 | Blocks: 10,12
  References: approved algorithm recorded in .omo/drafts/omo-native-adapter.md Findings (ULTRABRAIN design, full interface + edge table); vendored session-format.md "Tree Structure" + "Context Building" sections; fixtures from task 14.
  Acceptance criteria: golden tests over synthetic fixtures cover at least 20 design-table edge cases (branch switch, duplicate id, orphan parent, multiple roots, retainedTail:[], dangling tool ref, nested compactions, unicode ids, out-of-order timestamps); LCP mutation property test passes.
  QA scenarios: happy - golden snapshot of projected linear history matches expected for the branch-switch fixture, Evidence <evidence-root>/task-7-projection.log; failure - cycle input yields invalid result with cycle diagnostic, no hang, same evidence
  Commit: Y | feat(senpi): v3 tree index, leaf resolution, compaction-aware projection

- [ ] 8. Internal JSONL cursor in src/senpi/processing/jsonl-cursor.ts
  Recommended task executor category: unspecified-high - concurrency/digest edge cases across a file reader
  What to do / Must NOT do: Model on grok's cursor but senpi-owned: byte-offset scanning (0x0a), complete-line-only decode, partial-line deferral, inode/device identity, SHA-256 head+boundary digests, generation counter, oversized-line stream-discard diagnostic. Internal only - NOT exported from any barrel.
  Parallelization: Wave 2 | Blocked by: — | Blocks: 9,12
  References: src/grok/processing/jsonl-cursor.ts:7-260 (behavioral template); tests/grok-jsonl-cursor.test.ts (edge-case inventory to replicate).
  Acceptance criteria: replicated edge cases pass: append mid-line, truncate+regrow same inode, inode swap, oversized line, CRLF, multibyte boundary.
  QA scenarios: happy - cursor suite green, Evidence <evidence-root>/task-8-cursor.log; failure - same-size rewrite detected via boundary digest mismatch, same evidence
  Commit: Y | feat(senpi): internal bounded jsonl cursor

- [ ] 9. Checkpoint marker in src/senpi/processing/checkpoint.ts
  Recommended task executor category: quick - small marker module, fully specified
  What to do / Must NOT do: Senpi marker schema {sessionPathDigest, sessionId, device, inode, generation, offset, lineNumber, headDigest, boundaryDigest, revision, leafId, projectedRecordKeys[], markerVersion}; senpi-prefixed marker filenames; allowedMarkerRoots validation mirroring src/processing/tail.ts:1817-1870 gate semantics but independently implemented; atomic write via temp+rename under file lock; `commitSenpiSessionCheckpoint`; pure invalidation predicate. Never parses entries or decides branches.
  Parallelization: Wave 2 | Blocked by: 8 | Blocks: 12
  References: src/grok/processing/tail.ts:740-820 (grok marker-independence precedent); src/processing/tail.ts:96-104,1817-1870 (root-gate semantics to mirror).
  Acceptance criteria: marker round-trip; tampered/malformed marker reports invalid, not throw; custom markerDir outside allowed roots rejected.
  QA scenarios: happy - commit+reread equality, Evidence <evidence-root>/task-9-checkpoint.log; failure - offset-not-at-line-boundary forces invalidate=true, same evidence
  Commit: Y | feat(senpi): revisioned checkpoint markers with root gating

- [ ] 10. Block model + fold in src/senpi/processing/blocks.ts
  Recommended task executor category: unspecified-high - native block model + reduce/fold semantics
  What to do / Must NOT do: SenpiSessionBlock native model (role, entryId, parentId, branch status, origin entry|retained_tail, content blocks, usage, isError, timestamps, customType passthrough for custom/custom_message metadata blocks); `reduceSenpiProjection(previous, current)` producing upserts/deletes driven by projection mutations; `foldSenpiBlockChanges(changes): SenpiSessionBlock[]`. Stable block ids = entryId (+:<content-block-index> where split). Unknown/custom payloads stay metadata. No Claude/Grok type sharing.
  Parallelization: Wave 2 | Blocked by: 2,7 | Blocks: 12
  References: src/grok/processing/blocks.ts:1-165,166-410 (reduce/fold shape); planning-brief.md risk 2 (neutral custom density, O(n) fold).
  Acceptance criteria: reduce over a branch-splice fixture yields correct upsert+delete sets matching removedRecordKeys; fold is idempotent.
  QA scenarios: happy - splice reduction golden, Evidence <evidence-root>/task-10-blocks.log; failure - dense custom stream (1000 senpi.todo-state entries) folds in O(n) within test timeout, same evidence
  Commit: Y | feat(senpi): native block reduction and folding

- [ ] 11. Discovery + listing in src/senpi/processing/discovery.ts and listing.ts
  Recommended task executor category: unspecified-high - discovery + header-verified listing
  What to do / Must NOT do: discovery.ts: `getSenpiSessionsRoot(agentHome?)`, dash-encoded cwd dirname encoder (path with / replaced by -; document ambiguity, never decode), `findSenpiSessionDirs(projectCwd, agentHome?)` scanning `<agentHome>/sessions/` for candidate dirs; candidate generation may over-match (encoding ambiguity) because listing verifies headers. Skip `*-artifacts/` directories and per-cwd `extensions/` subdirs. listing.ts: `listSenpiSessions(projectCwd, agentHome?)` and `listAllSenpiSessions(agentHome?)` returning SenpiSessionInfo {path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage} (deliberate engine-parity minus allMessagesText) parsed from validated headers; firstMessage from the first user message; messageCount from a streaming full scan that is O(store) time and O(1) memory per file (bounded, no retention) - acceptable for a ~100 MB store; per-file failure isolation returning {kind:'valid'}|{kind:'invalid', error} entries; verify header cwd matches projectCwd for the per-project variant. No folding, no tailing.
  Parallelization: Wave 3 | Blocked by: 2,3 | Blocks: 12
  References: src/grok/processing/discovery.ts:10-133 (valid/invalid listing pattern); engine parity shape SessionManager.listAll -> SessionInfo (vendored session-format.md + plans/omo-native-adapter/planning-brief.md); resolveSenpiAgentHome (task 3).
  Acceptance criteria: vitest over temp-dir stores: per-project listing returns only header-cwd-matching sessions; listAll returns all; -artifacts and extensions/ excluded; invalid JSONL file surfaces as invalid entry, not throw.
  QA scenarios: happy - store with 3 projects lists correctly per-project and all (Evidence <evidence-root>/task-11-discovery.log); failure - ambiguous dirname (a-b vs a/b) resolved by header cwd check, same evidence
  Commit: Y | feat(senpi): session discovery and listing with header verification

- [ ] 12. Tail orchestration in src/senpi/processing/tail.ts
  Recommended task executor category: deep - integration of cursor/projection/blocks, shared insight
  What to do / Must NOT do: `tailSenpiSession(file, opts?)` integrating cursor scan -> parseSenpiEntry -> index update -> resolveSenpiLeaf -> projectSenpiBranch -> computeProjectionMutation vs prior projectedRecordKeys -> reduceSenpiProjection -> SenpiSessionTailResult {records, mutations(0..1 splice), offPath, diagnostics, leaf, previousByteOffset, nextByteOffset, fileSize, generation, revision, reset, checkpoint}. Automatic checkpoint mode persists only after full successful parse+projection; manual mode returns checkpoint for caller commit. Checkpoint invalidation per task 9 predicate (inode, size<offset, header/digest change, boundary, fromStart, malformed marker); cold rebuild replays [0,offset) without emitting and emits full splice from index 0. Terminal malformed line => leaf resolution invalid. Never expose cursor/marker types in the result.
  Parallelization: Wave 3 | Blocked by: 6,7,8,9,10,11 | Blocks: 13,15,23
  References: approved algorithm + interfaces in .omo/drafts/omo-native-adapter.md Findings; src/grok/processing/tail.ts:120-337 (orchestration shape); fixtures from tasks 11+14.
  Acceptance criteria: integration test over branch-switch fixture: first tail emits full path; append cross-branch entry => exactly one splice mutation with correct index/deleteCount; compaction append => splice or append per LCP; reset scenarios emit splice from 0 with reset=true; `pnpm run check` green.
  QA scenarios: happy - live-append sequence (write, tail, append, tail) golden log (Evidence <evidence-root>/task-12-tail.log); failure - truncated final line is deferred and reread next pass, same evidence
  Commit: Y | feat(senpi): leaf-linear session tail with splice mutations

- [ ] 13. Watch + quiescence in src/senpi/processing/watch.ts
  Recommended task executor category: unspecified-high - watch + injected-clock quiescence
  What to do / Must NOT do: async-generator `watchSenpiSession(file, opts?)`: fs.watch events are wake-up hints only; every wake reconciles via tailSenpiSession; initial readiness yield; quiescence signal after configurable stable-cursor window (option quiescenceMs, default 30000) using injected clock (no fixed sleeps in tests); abort-signal cleanup; missing file retains prior checkpoint, no reset until replacement observed. Never duplicate projection/checkpoint logic.
  Parallelization: Wave 3 | Blocked by: 12 | Blocks: 15
  References: src/grok/processing/tail.ts watch section (generator shape); planning-brief.md risk 4 (no SessionEnd; quiescence recipe); vitest fake-timer conventions in tests/grok-tail.test.ts.
  Acceptance criteria: injected-clock test: append -> wake -> result; silence for quiescenceMs -> terminal quiescent yield; abort cleans watcher without leaks (handle count assertion).
  QA scenarios: happy - append-then-quiet sequence emits quiescence exactly once (Evidence <evidence-root>/task-13-watch.log); failure - watch-event storm coalesces to one tail per quiet interval, same evidence
  Commit: Y | feat(senpi): watch generator with stable-cursor quiescence

- [ ] 14. Fixtures: sanitized real transcripts + synthetic edge cases
  Recommended task executor category: unspecified-low - mechanical redaction + synthetic fixtures
  What to do / Must NOT do: Build tests/fixtures/senpi/: (a) 2-3 sanitized real session JSONL files copied from ~/.omo/agent/sessions (pick sessions with branch traffic and compaction; REDACT per category: message text content, tool arguments/outputs, cwd/home paths, session ids AND user-visible strings in every entry type - session_info.name, label.label strings, custom.data payloads replaced with type-preserving synthetic stubs (todo-state content leaks user text) - keep structure, entry types, tree shape, customType density); record redaction script tests/fixtures/senpi/redact.mjs so fixtures are reproducible; (b) synthetic fixtures: branch-switch, retainedTail compaction, legacy firstKeptEntryId compaction, duplicate-id, orphan-parent, multi-root, header-only, empty, unicode cwd. Manifest README.md documenting provenance. Must NOT commit unredacted personal data.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 7,12
  References: docs/upstream/grok/pin.json fixtureRedump note (redaction precedent); real store ~/.omo/agent/sessions/<--encoded-cwd-->/*.jsonl; entry format from vendored session-format.md.
  Acceptance criteria: redact.mjs rerun produces byte-identical fixtures from the same source; every fixture parses with parseSenpiEntry with zero invalid except the intentionally-corrupt ones; privacy gate is a MULTI-SAMPLE grep set, not one substring: machine username, the literal $HOME path prefix, and at least 3 distinct substrings sampled per redaction category (message text, custom.data, session_info.name, label strings) must all return zero matches across every fixture.
  QA scenarios: happy - fixtures parse + redaction idempotence log (Evidence <evidence-root>/task-14-fixtures.log); failure - privacy grep finds no original substrings (assertion passes = failure scenario avoided; document the negative check), same evidence
  Commit: Y | test(senpi): sanitized real and synthetic session fixtures

- [ ] 15. Processing barrel, package export map, and export-surface tests (initial surface)
  Recommended task executor category: quick - barrels + export-map edits + test extension
  What to do / Must NOT do: Create src/senpi/processing/index.ts (/senpi/processing barrel: types, parse, discovery/listing, projection, tail/watch/checkpoint commit, blocks) and an INITIAL src/senpi/index.ts exporting ONLY what exists after Wave 1-3 (home, session types re-export if desired, settings validator, hook-contract manifest, SenpiHookEventName consts - NO hook wire/runner/builder/trust modules; those land via todo 24). Cursor + marker internals NOT exported. Add exact package.json exports entries "./senpi" and "./senpi/processing" (no wildcards). Extend tests/package-exports.test.ts: exact export lists, cursor absence assertions, root barrel stays senpi-processing-free. Do not re-export from src/index.ts.
  Parallelization: Wave 3 | Blocked by: 4,6,7,8,9,10,11,12,13 | Blocks: 16,17,18,19,20,21,22,23,24
  References: package.json exports map (root + subpath entries); src/grok/index.ts:13-58 + src/grok/processing/index.ts:3-57 barrel shape; tests/package-exports.test.ts:116-218 (exact-list + absence assertion pattern, verified).
  Acceptance criteria: `pnpm run check` and `pnpm run test:run` green; importing '@libar-dev/agent-harness-kit/senpi/processing' resolves in a vitest smoke import; exported-name snapshot matches approved list exactly.
  QA scenarios: happy - export snapshot test green for the initial surface (Evidence <evidence-root>/task-15-exports.log); failure - the exact-list assertion rejects any name not in the approved list, including wildcard subpath entries, same evidence
  Commit: Y | feat(senpi): public barrels and package export surface

- [ ] 16. Hook wire schemas in src/senpi/hook-wire.ts
  Recommended task executor category: unspecified-high - wire union parity with vendored types
  What to do / Must NOT do: Single canonical source for the hook wire: INPUT side = 7-event discriminated union whose per-branch fields are copied VERBATIM from the vendored HookInputWire union in hooks/types.d.ts and validated against HOOK_INPUT_BRANCHES from src/senpi/hook-contract.ts (note the asymmetries: SessionStart requires camelCase sessionId; permission_mode only on UserPromptSubmit; PreCompact has no accepted field; PostToolUse has no transcript_path). Accept camelCase primaries AND snake_case aliases (hook_event_name, session_id, tool_name, tool_input, tool_response, tool_use_id, will_retry, custom_instructions), normalizing once at this boundary. OUTPUT side = sourced from vendored output-parser.js / ParsedHookOutput["output"], NOT from types.d.ts HookOutputWire (which has only 6 fields): decision accepts "allow" as well as approve/block/deny/ask; reason, additionalContext, updatedInput, updatedToolOutput, continue; stopReason/suppressOutput/systemMessage are parser-level universal fields gated by SYSTEM_MESSAGE_EVENTS; hookSpecificOutput handled per vendored output-parser.js behavior. Export senpiHookInputSchema/senpiHookOutputSchema, validateSenpiHookInput, z.infer types. No settings/trust/IO.
  Parallelization: Wave 4 | Blocked by: 1,5,15 | Blocks: 17,18,20
  References: vendored docs/upstream/senpi/hooks/types.d.ts (HookInputWire/HookOutputWire authority); src/grok/validation.ts:1-226 (looseObject + discriminatedUnion conventions); drift manifest from task 5.
  Acceptance criteria: every wire branch round-trips; alias inputs normalize to primary fields; unknown extra fields pass through; drift manifest assertions green.
  QA scenarios: happy - per-event fixture envelope validation (hand-authored one JSON per event under tests/fixtures/senpi/hook-inputs/), Evidence <evidence-root>/task-16-hook-wire.log; failure - PostToolUse with tool_response alias parses to toolOutput, same evidence
  Commit: Y | feat(senpi): hook input/output wire schemas with alias normalization

- [ ] 17. Runner in src/senpi/execute.ts
  Recommended task executor category: unspecified-high - runner exit semantics parity
  What to do / Must NOT do: `readSenpiStdinJson(options?)` (bounded stdin read, 30s cap like grok), `outputSenpiJson(output)`, `executeSenpiHook(handler, options?)` with injectable stdin/stdout/exit seams. Semantics per VENDORED output-parser.js: exit 2 => {decision:'block', reason:<stderr-trimmed>}; otherwise stdout JSON parsed (universal fields continue/stopReason/suppressOutput/systemMessage event-gated to the 5-event SYSTEM_MESSAGE_EVENTS set; hookSpecificOutput per parser behavior); malformed/non-object stdout => diagnostic no-op exit 0; validation failure exit 1 with stderr log. Platform: win32 selects handler.commandWindows when present (mirror selectCommandForPlatform) via injectable platform option; POSIX is the tested path. Never read CLAUDE_* env, never reuse executeHook, never grant trust.
  Parallelization: Wave 4 | Blocked by: 15,16 | Blocks: 20,22
  References: vendored hooks/output-parser.js (authoritative: SYSTEM_MESSAGE_EVENTS set, exit-2 rule, allow decision, hookSpecificOutput handling); src/grok/execute.ts:47-76,134-246 (runner shape + seams).
  Acceptance criteria: vitest over injected seams: exit-2 block, valid JSON pass-through, malformed stdout no-op, observe events ignore decision JSON; `node -e` pipe smoke test mirrors package.json hook:test pattern.
  QA scenarios: happy - scripted stdin/stdout round-trip per event (Evidence <evidence-root>/task-17-execute.log); failure - oversized stdin beyond cap truncates per documented policy without hang, same evidence
  Commit: Y | feat(senpi): hook command runner with senpi exit semantics

- [ ] 18. Output builder in src/senpi/output-builder.ts
  Recommended task executor category: quick - pure factory module
  What to do / Must NOT do: `SenpiHookOutputBuilder` pure factories returning schema-valid objects: approve(), block(reason?), deny(reason?), ask(reason?), context(additionalContext), updatedInput(input), updatedToolOutput(output), forceStop(stopReason?), systemMessage(text) (event-gated note in JSDoc), success(message?), error(reason). Every output round-trips senpiHookOutputSchema. No IO, no dispatch.
  Parallelization: Wave 4 | Blocked by: 15,16 | Blocks: 20
  References: src/grok/output-builder.ts:24-125 (factory surface style); vendored hooks/types.d.ts HookOutputWire.
  Acceptance criteria: every factory output passes senpiHookOutputSchema; JSDoc on every export naming params/returns/consumer-visible behavior.
  QA scenarios: happy - factory/schema round-trip table (Evidence <evidence-root>/task-18-builder.log); failure - empty deny reason falls back per engine rule (documented in JSDoc + test), same evidence
  Commit: Y | feat(senpi): typed hook output builder

- [ ] 19. Trust state read + pure hash parity in src/senpi/trust.ts
  Recommended task executor category: unspecified-low - read-only module + golden hash
  What to do / Must NOT do: Read/validate HookTrustState v1 from <agentHome>/hooks-state.json and <cwd>/.senpi/hooks-state.json (scope global|project): {version:1, hooks:{<id>:{enabled,trustedHash?,scope,sourcePath,matcher?,commandPreview,updatedAt}}}; pure `senpiHookTrustId(handler)` and `senpiHashCommandHook(handler, opts?)` reproducing the algorithm in VENDORED hooks/trust.js exactly (the .d.ts has signatures only; the js is already pinned by task 1 - canonical-JSON sha256 ids of form hk_<sourceKeyHash>_<event>_<g>_<h>; platform-dependent hash input takes an INJECTED platform option, defaulting process.platform); `readSenpiHookTrustState(path)` with fail-closed malformed handling; `isSenpiCommandHookTrusted(handler, state)`. READ-ONLY: no writes anywhere in this module.
  Parallelization: Wave 4 | Blocked by: 1,15 | Blocks: 20,21
  References: vendored hooks/trust.d.ts + trust-storage.d.ts (state shape, scope rules); vendored hooks/trust.js (algorithm authority, pinned by task 1).
  Acceptance criteria: golden hash parity test computes id+hash for a fixture handler with a FIXED injected platform value (cross-machine deterministic - never default process.platform in the golden) and asserts the recorded golden; malformed state file => fail-closed result object.
  QA scenarios: happy - golden hash parity (Evidence <evidence-root>/task-19-trust.log); failure - corrupted hooks-state.json yields fail-closed, not throw, same evidence
  Commit: Y | feat(senpi): read-only trust state inspection and hash parity

- [ ] 20. Reference doc docs/reference/senpi-adapter.md
  Recommended task executor category: writing - reference documentation
  What to do / Must NOT do: Write the full adapter reference mirroring docs/reference/grok-adapter.md structure: scope (attach-only), 7-event table with gate kinds and stdout honored fields, envelope contract (aliases), stdout contract + exit codes, runner, settings validation + config sources + trust gate, session layout + processing APIs table, tree/compaction semantics (persisted-leaf rule, splice mutations, checkpoint fields), pin/drift policy (npm tarball, engineVersion), OmO-vs-senpi naming note (OmO native = branded distribution; engine is senpi), Cockpit seam note. Update docs/README.md index. No prose pinning by tests beyond machine-checkable values.
  Parallelization: Wave 4/5 boundary | Blocked by: 15,16,17,18,19,24 | Blocks: —
  References: docs/reference/grok-adapter.md (structure template); plans/omo-native-adapter/planning-brief.md; final exported API from tasks 15-19.
  Acceptance criteria: doc references only real exported names (spot-checked by grep against barrels); docs/README.md links it; `pnpm run check` green (docs not type-checked but lint may apply).
  QA scenarios: happy - link/name audit script passes (Evidence <evidence-root>/task-20-docs.log); failure - any exported name in doc missing from barrels is caught by audit grep, same evidence
  Commit: Y | docs(senpi): adapter reference

- [ ] 21. Consent-gated trust writer in src/senpi/trust-writer.ts
  Recommended task executor category: unspecified-high - locking/atomic write safety
  What to do / Must NOT do: Exported from the /senpi barrel as `writeSenpiHookTrustEntry(opts)` (todo 15's exact-list includes it) performing an EXPLICIT, caller-authorized write of one trust entry to the scoped hooks-state.json: file lock implemented INTERNALLY (mkdir/O_EXCL retry lock - NO new runtime npm dependency such as proper-lockfile), read-modify-write preserving ALL unrelated/unknown entries, atomic temp+rename, 0600 permissions, fail-closed on malformed existing state, requires an explicit `consent: true` option plus a `reason` string recorded in the entry. Never called from runner/settings/install code paths; no auto-trust. Export type documents that calling it IS the approval act.
  Parallelization: Wave 5 | Blocked by: 15,19 | Blocks: 22
  References: vendored hooks/trust-storage.js (scope path logic + lock semantics to replicate internally: <agentDir>/hooks-state.json, <cwd>/.senpi/hooks-state.json); planning-brief.md risk 3 (managed grant = consent-gated write).
  Acceptance criteria: write preserves pre-existing unrelated entries byte-for-byte where untouched; concurrent-writer test (two locked writers) serializes; malformed existing state aborts with no write.
  QA scenarios: happy - grant then isSenpiCommandHookTrusted true (Evidence <evidence-root>/task-21-trust-writer.log); failure - consent:false rejects with typed error, no file mutation (mtime assert), same evidence
  Commit: Y | feat(senpi): consent-gated hook trust writer

- [ ] 22. Forwarder asset variant + hooks.json registration helper
  Recommended task executor category: unspecified-high - asset bundling + registration writer
  What to do / Must NOT do: (a) senpi forwarder asset: a silent command-hook script (modeled on src/forwarder/hook-forwarder.ts) that reads HookInputWire stdin and POSTs to a configured endpoint, exit 0 always (observe-only; never emits gate JSON); esbuild-bundled like dist/standalone/hook-forwarder.mjs (check src/forwarder/assets.ts + package.json build step and mirror) with --target=node22 (kit runtime floor is Node >=22; do not copy the legacy node18 target). (b) `buildSenpiHooksRegistration(events, command)` producing a hooks.json document for the 7 events (command type only), plus `writeSenpiHooksConfig(path, doc)` atomic write. Must NOT write trust state or enable gates (observe-only registration).
  Parallelization: Wave 5 | Blocked by: 15,17,21 | Blocks: 23
  References: src/forwarder/hook-forwarder.ts + src/forwarder/assets.ts + package.json build esbuild step; vendored config-loader.d.ts (hooks.json shape); planning-brief.md hooks surface section.
  Acceptance criteria: registration document validates through validateSenpiHooksConfig; forwarder smoke: pipe fixture envelope, assert HTTP POST received by local test server, exit 0.
  QA scenarios: happy - end-to-end pipe->local-server capture (Evidence <evidence-root>/task-22-forwarder.log); failure - endpoint unreachable still exits 0 silently (observe-only guarantee), same evidence
  Commit: Y | feat(senpi): observe forwarder asset and hooks registration helper

- [ ] 23. Cockpit Phase C cross-repo execution brief at plans/omo-native-adapter/cockpit-phase-c.md
  Recommended task executor category: writing - cross-repo execution brief
  What to do / Must NOT do: Write the execution brief for the libar-cockpit observe adapter (executed in THAT repo under its own planning; this is a spec deliverable in this repo): mirror of src/main/services/grok/* file set (grokDiscovery/grokIngest/grokNormalize/grokRuntime/grokSessionFs/grokIngestSerializer/grokIngestError/grokProcessing + daemonComposition/grokSessionProcessing) mapped to senpi equivalents; harness id decision `omo` in shared schemas; lossy block map from SenpiSessionBlock; dynamic ESM import of /senpi + /senpi/processing; session-end via watch quiescence (no SessionEnd); ADR requirement (cockpit ADR equivalent of 0003) listed as prerequisite; merge-gate note: harness-kit PR merges only after Phase C integration tested. Must NOT include cockpit code changes in this repo.
  Parallelization: Wave 5 | Blocked by: 5,12,15 | Blocks: —
  References: /Users/darkomijic/dev-libar/libar-cockpit/docs/hooks-contract.md (seam contract); cockpit src/main/services/grok/* (file inventory listed in planning-brief.md Phase C section); planning-brief.md Phase C.
  Acceptance criteria: brief names every cockpit file to create/modify with its senpi counterpart and the DaemonSessionSummary mapping; prerequisite ADR + merge gate sections present.
  QA scenarios: happy - completeness checklist in brief self-verified against cockpit file listing (Evidence <evidence-root>/task-23-phase-c-brief.log); failure - any cockpit grok file without a senpi mapping is listed in a gaps section rather than silently dropped, same evidence
  Commit: Y | docs(senpi): cockpit phase-c cross-repo execution brief

- [ ] 24. Finalize /senpi barrel with hooks library exports
  Recommended task executor category: quick - extend barrel + exact-list test once hooks modules exist
  What to do / Must NOT do: Extend src/senpi/index.ts to its FINAL approved surface: hook wire schemas+validators (16), execute runner + stdin/stdout helpers (17), output builder (18), trust read/pure hash (19), consent-gated writeSenpiHookTrustEntry (21). Update tests/package-exports.test.ts exact list to the final names; keep cursor/marker internals absent. No behavior changes to any module; no wildcard exports.
  Parallelization: Wave 5 | Blocked by: 15,16,17,18,19,21 | Blocks: 20
  References: src/senpi/index.ts (initial surface from todo 15); tests/package-exports.test.ts exact-list pattern; approved export list in planning-brief.md hooks surface section.
  Acceptance criteria: `pnpm run test:run -- tests/package-exports.test.ts` green against the final name list; smoke import of '@libar-dev/agent-harness-kit/senpi' resolves every exported symbol.
  QA scenarios: happy - final export snapshot green (Evidence <evidence-root>/task-24-barrel.log); failure - removing one approved name fails the exact-list assertion, same evidence
  Commit: Y | feat(senpi): finalize public hooks barrel surface

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  Recommended task executor category: unspecified-high - structural audit scripting
  Re-run the structural grammar check (column-zero `- [ ] N.`/`- [ ] F<n>.` rows, category line on every implementation row, numbering continuity, dependency-matrix consistency derived mechanically from Depends-on edges, no cycles) over .omo/plans/omo-native-adapter.md; verify every Success-criteria statement maps to an existing artifact path. Evidence <evidence-root>/final-f1-compliance.log. APPROVE only when every check passes with zero manual waivers.
- [ ] F2. Code quality review
  Recommended task executor category: unspecified-high - adversarial code review
  Run `pnpm run check` + full `pnpm run test:run`; then spawn a FRESH unspecified-high adversarial reviewer over `git diff <base>...HEAD` limited to src/senpi/**, scripts/sync-upstream-senpi.mjs, tests/senpi-*, docs/upstream/senpi/**: verify no-explicit-any, JSDoc on every export, NodeNext .js imports, no dead code. Evidence <evidence-root>/final-f2-quality.log. APPROVE only with zero error-severity findings unresolved.
- [ ] F3. Real manual QA (agent-executed, read-only)
  Recommended task executor category: deep - live-system proof
  Against the REAL store ~/.omo/agent/sessions (read-only, nothing copied into the repo): pick one real session with branch traffic; run tailSenpiSession from scratch and after a marker checkpoint; independently recompute expected linear history with a throwaway python jsonl leaf-walk and diff against the kit output; assert first/last user messages and message counts match. Then pipe each fixture envelope in tests/fixtures/senpi/hook-inputs/ through executeSenpiHook via node child process and assert exit codes/outputs match vendored semantics. Evidence <evidence-root>/final-f3-live-qa.log. APPROVE only on exact-match diffs.
- [ ] F4. Scope fidelity
  Recommended task executor category: unspecified-high - guardrail audit
  Grep audits over src/ and tests/: zero imports matching @code-yeongyu/senpi or oh-my-openagent; zero imports of src/grok inside src/senpi; zero reads of auth.json; package.json dependencies unchanged from base (no new runtime deps); exports map has exactly ./senpi and ./senpi/processing additions (no wildcards); root barrel untouched. Evidence <evidence-root>/final-f4-scope.log. APPROVE only when every grep returns empty/expected.

## Commit strategy

- Work branch: `senpi-adapter` off current default branch. This plan's commit strategy authorizes per-todo commits on that work branch (recovery boundaries), each after its QA gate passes.
- One commit per todo, message given in the todo row. No pushes; push only on explicit user request.
- MERGE GATE (owner decision): the kit PR must NOT be merged until Cockpit Phase C (brief = todo 23) is implemented and tested end-to-end in the cockpit repo against this branch.
- Never commit unredacted session data; task 14's privacy grep runs before its commit.

## Success criteria

1. `pnpm run check` and `pnpm run test:run` fully green with all new senpi tests.
2. `node scripts/sync-upstream-senpi.mjs --tarball <2026.8.19 tarball> --check` exits 0; drift test mutation case proves the check bites.
3. Golden integration proof: tail over a sanitized real fixture reproduces the expected linear leaf-path history including one cross-branch splice and both compaction forms.
4. Export surface exact: `/senpi` + `/senpi/processing` barrels match approved lists; cursor/marker internals absent; root barrel unchanged.
5. Hook contract parity: drift tests pass both directions against vendored artifacts; runner exit-code semantics match vendored output-parser behavior.
6. Trust safety: read-only paths cannot write; trust writer refuses without explicit consent; unrelated entries preserved.
7. Deliverables complete: reference doc indexed, cockpit Phase C brief written, no Must-NOT-have violations (final wave F4 audits).
