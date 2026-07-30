# Review: `feat/hook-api-parity` leftover work

**Date:** 2026-07-30  
**Branch reviewed:** `feat/hook-api-parity` @ `e67fb61`  
**Base:** `origin/main` @ `59ae9dd` (merged PR #1 `fix/publication-blockers`)  
**Scope of this document:** understanding + code review + finish plan. **No implementation.**

---

## 1. Executive summary

Yes: this leftover work is a **Claude Code hook API parity audit** against refreshed official docs. It is **largely complete as a design/docs/schema pass**, but **not shippable** — type-check fails, 11 tests fail, and a few areas show **intent vs implementation drift**.

| Question | Answer |
|---|---|
| What is the intention? | Re-sync library contracts with official Claude Code hooks docs (types, Zod, builders, reference handlers, project docs, maintainer checklist). |
| Is it “latest API” work? | Yes. Upstream mirrors were refreshed (audit dated **2026-07-12**) and contracts were updated from that snapshot. |
| Is it incomplete? | Yes — verification is red, several tests still encode pre-audit behavior, tool schemas are stricter than official examples in places, and one lifecycle path contradicts its own stated intent. |
| Is it safe as a branch? | Yes. Work is committed on `feat/hook-api-parity`; `plans/` remains untracked; no push/PR yet. |
| Should you open a draft PR now? | Only as WIP if you want remote backup. Prefer finishing verification first. |

**Bottom line:** treat this as a **mid-flight API-parity PR**, not random unfinished edits. The plan and checklist explain what it was trying to do; the failing gates show where it stopped short.

---

## 2. How this repo updates Claude Code (upstream) docs

This library does **not** invent the hook API. Official Claude Code docs are mirrored locally, then the library is audited against those mirrors.

### 2.1 Canonical sources

| Local mirror | Official URL |
|---|---|
| `docs/upstream/hooks-reference.md` | https://code.claude.com/docs/en/hooks.md |
| `docs/upstream/hooks-guide.md` | https://code.claude.com/docs/en/hooks-guide.md |
| `docs/upstream/settings.md` | https://code.claude.com/docs/en/settings.md |
| `docs/upstream/cli-reference.md` | https://code.claude.com/docs/en/cli-reference.md |
| `docs/upstream/headless.md` | https://code.claude.com/docs/en/headless.md |

Documented in `docs/upstream/README.md`.

### 2.2 Refresh command

```bash
pnpm run docs:sync-upstream
# → node scripts/sync-upstream-docs.mjs
```

The script:

1. Fetches each URL with `Accept: text/markdown`.
2. Writes the full markdown into `docs/upstream/<file>.md`.
3. Treats a non-markdown or failed fetch as an error (partial sync is invalid).

You can pass individual filenames, but the intended maintainer flow is a **full five-file sync**.

### 2.3 What mirrors are (and are not)

- **Inputs** for gap analysis. They are Anthropic content, not project-authored docs.
- **Not** the public API surface of this package.
- **Should not** be “edited by hand” to match the library; re-sync from the network instead.
- Project-authored docs live under `docs/guides/`, `docs/reference/`, `docs/internal/`, plus root `README.md` / `CLAUDE.md` / `CHANGELOG.md`.

### 2.4 Intended audit loop (maintainer procedure)

From the rewritten checklist on this branch (`docs/internal/api-update-checklist.md`) and the original plan (`plans/foamy-questing-catmull.md`):

1. **Sync** five upstream mirrors (`pnpm run docs:sync-upstream`).
2. **Diff** mirrors vs previous git version; extract deltas (events, common I/O, tool inputs, handlers, settings restrictions, env vars).
3. **Classify** each finding: implement / docs-only / audit-only / out of scope.
4. **Implement** only claims substantiated by the refreshed official docs:
   - `src/types/index.ts` (manual public contracts)
   - `src/validation/schemas.ts` + validators/exports (runtime validation in lockstep)
   - `src/utils/output-builder.ts` (typed helpers)
   - affected `src/lifecycle/*` reference handlers
   - tests (`validation`, builders, docs-round-trip, package-exports, hooks)
5. **Document** project-authored references/guides + CHANGELOG.
6. **Verify** `type-check`, `lint`, `test:run`, `build`, stale-claim search, declaration inspection.
7. **Update** `docs/internal/api-update-checklist.md` with date, inventory, decisions, and **real** verification results.

### 2.5 Scope boundaries (important)

In scope:

- Hook event I/O
- Hook-related settings/handler matrix fields
- Modeled tool inputs used by hooks
- Hook-related env surfaces this package documents/reads
- Output builders + bundled reference handlers
- Transcript processing only where it already overlaps exported contracts

Out of scope (unless it already has a library surface):

- Full Claude Code settings schema
- Every CLI flag
- Headless stream protocols as a full model

### 2.6 Automation that keeps docs honest

`tests/docs-round-trip.test.ts` parses JSON examples from mirrored docs and validates them against library schemas. This branch expands that test to:

- hook **input** examples
- hook-specific **output** examples
- hook-related **settings** snippets
- official lifecycle event inventory vs `hookEventNameSchema.options`

That is the mechanical guardrail against silent drift after the next sync.

---

## 3. Actual intention of *these* changes

### 3.1 Origin story

1. **PR #1** (`fix/publication-blockers`) was merged to `main` for v0.1.0 publication readiness (processing/tailing, packaging, etc.).
2. **Separately**, uncommitted work continued on the same local branch: a **July 2026 Claude Code API parity audit**.
3. That second body of work never shipped with PR #1. It is now isolated on `feat/hook-api-parity`.

The agent plan file `plans/foamy-questing-catmull.md` (untracked, should not be committed) states the goal plainly:

> mirrors, exported TypeScript contracts, Zod schemas, bundled handlers, tests, and project-authored documentation need a fresh authoritative audit.

### 3.2 What “parity” meant in practice

From `CHANGELOG.md` [Unreleased] and the new checklist inventory:

| Area | Intended delta |
|---|---|
| Common input | Optional UUID `prompt_id` |
| Notification | 8 types including `agent_needs_input` / `agent_completed`; **universal-only** output |
| Stop / SubagentStop input | `background_tasks`, `session_crons` registries |
| Stop / SubagentStop output | Distinct **block** vs **non-error additionalContext** modes; block `reason` required (empty string OK) |
| UserPromptSubmit | `suppressOriginalPrompt` on block |
| PostToolUseFailure | Dedicated `failureFeedback()` (no output replacement) |
| PermissionRequest | Six documented permission-update variants + `manual` setMode alias |
| Settings/handlers | `disableAllHooks`, event-aware handler matrix, `continueOnBlock`, timeout/restriction docs |
| Tool inputs | Agent `run_in_background` / isolation; ExitPlanMode injected `plan` + `planFilePath`; richer AskUserQuestion |
| Task / Teammate builders | Stop via `continue: false` + `stopReason` **without** event-named `hookSpecificOutput` |
| StopFailure | Side-effect-only; `stopFailureLog()` becomes no-op `{}` |
| Docs | Project docs + checklist rewritten against 2026-07-12 mirrors |

### 3.3 Secondary intention: reference-handler behavior

Beyond pure type parity, lifecycle handlers were adjusted to match official control semantics and practical compact/session flow:

| Handler | Intentional behavior change |
|---|---|
| `notification-handler.ts` | New agent notification types; safer desktop notification spawning (no shell-string interpolation) |
| `stop-handler.ts` | Remove local max-continuation counter (Claude Code itself caps consecutive Stop blocks at 8) |
| `subagent-stop.ts` | Prefer `agent_transcript_path`, blank-transcript fallback, use `subagentStopBlock()`, drop local max-retry loop |
| `pre-compact.ts` + new `pre-compact-context.ts` + `session-start.ts` | Stop relying on PreCompact `additionalContext` (not documented as a PreCompact context channel in the refreshed decision table); persist summary to temp and re-inject on SessionStart when `source === 'compact'` |
| `stop-failure.ts` | Align with “output ignored” semantics |

These handler changes are **library product behavior**, not just schema updates. They need deliberate review, not only “does Zod match the docs?”

---

## 4. Diff map (what landed)

**32 files**, roughly **+3630 / −2658** vs `origin/main`.

### 4.1 Layers

| Layer | Files | Role |
|---|---|---|
| Upstream mirrors | `docs/upstream/*` (5) | Refreshed official inputs for the audit |
| Public contracts | `src/types/index.ts` | Manual TS interfaces |
| Validation | `src/validation/{schemas,validators,index}.ts` | Zod + exports |
| Builders | `src/utils/output-builder.ts` | Public helper API |
| Reference hooks | `src/lifecycle/*` + new `pre-compact-context.ts` | Bundled examples/handlers |
| Tests | `tests/{validation,output-builder,hooks,docs-round-trip,package-exports}.test.ts` | Regression + docs round-trip |
| Project docs | guides/reference/README/CLAUDE/CHANGELOG + **rewritten** `api-update-checklist.md` | Human-facing parity |

### 4.2 What looks solid

These areas appear coherent and largely aligned with the refreshed upstream text:

- `prompt_id` optional UUID on base input (type + schema + tests).
- Notification enum expansion + notification handler titles/types.
- Discriminated `PermissionUpdateEntry` variants and `manual` mode alias.
- Stop/SubagentStop block vs context output types and dedicated builders.
- `failureFeedback()`, `stopFailureLog()` no-op, deprecated `subagentStopContext` alias.
- `taskBlock` / `teammateStop` reduced to `{ continue: false, stopReason }` — **matches** official Task/Teammate decision control.
- PreCompact **output schema** restricted to universal fields or `decision: "block"` — **matches** official decision table (no PreCompact `additionalContext` channel listed; only block).
- Event-aware handler matrix schemas and expanded docs-round-trip coverage.
- Project docs and checklist rewritten around a 30-event inventory and the deltas above.

### 4.3 What is not solid (current gates)

Verified on this branch after commit:

```text
pnpm run type-check  → FAIL (3 TS errors)
pnpm run test:run    → FAIL (11 failed / 1399 passed / 1410 total)
```

**Type-check**

1. `src/lifecycle/subagent-stop.ts` — unused `incrementSubagentRetryCount` (dead retry helper after removing max-retry behavior; `getSubagentRetryCount` is also effectively dead).
2. `tests/output-builder.test.ts` — expects `taskBlock(...).hookSpecificOutput`.
3. `tests/validation.test.ts` — expects `teammateStop(...).hookSpecificOutput`.

**Failing tests (clusters)**

| Cluster | Symptom | Likely root cause |
|---|---|---|
| Builder shape | `taskBlock` / `teammateStop` missing `hookSpecificOutput` | Implementation correctly follows upstream; **tests not fully updated** |
| PreCompact handler | No `hookSpecificOutput.additionalContext` | Handler intentionally moved to temp-file + `systemMessage` + SessionStart re-inject; **hooks test still expects old path** |
| SubagentStop empty transcript | JSON parse error / no block | Stated intent: include `last_assistant_message` in error scoring; **implementation only uses final message for warnings/size, not errors** |
| AskUserQuestion | Validation fails official-style fixtures | Schema requires `options[].description`, required `multiSelect`, min 2 options; **official examples use label-only options** |
| Agent via `validateToolInput` | Fails when only `prompt` provided | Branch makes `description` **required** on Agent; route test omits it (old Task-like optionality) |
| MCP name rejects | `mcp__server__tool__extra` and `mcp__server__tool!` accepted | Regex `/^mcp__[^_](?:.*?[^_])?__.+$/` is too loose vs test expectations |

---

## 5. Code review findings

### 5.1 High confidence: correct intentional API changes

1. **Task/Teammate stop builders without `hookSpecificOutput`**  
   Official decision table: TeammateIdle / TaskCreated / TaskCompleted use exit code 2 or JSON `{"continue": false, "stopReason": "..."}`. Removing the fake event-name envelope is correct. Tests lag.

2. **PreCompact no longer models `additionalContext` injection**  
   Official decision table lists PreCompact under top-level `decision: "block"` only. The old library path that injected PreCompact `hookSpecificOutput.additionalContext` was **ahead of / divergent from** the refreshed docs. Schema change is justified.

3. **StopFailure no-op**  
   Official docs: no decision control; side effects only. Deprecating `stopFailureLog` to `{}` is correct.

4. **Permission update discrimination**  
   Mirrors the documented `addRules` / `replaceRules` / `removeRules` / `setMode` / `addDirectories` / `removeDirectories` entries and `manual` alias for setMode.

5. **Stop/SubagentStop dual feedback modes**  
   Matches documented block vs non-error `additionalContext` split.

### 5.2 Medium confidence: good idea, incomplete finish

1. **PreCompact → SessionStart context handoff**  
   Design intent is reasonable: compaction destroys conversation context, so stash summary and re-inject on `SessionStart` `source: "compact"`.  
   Gaps:
   - hooks test still asserts PreCompact `additionalContext`
   - no dedicated unit tests for `pre-compact-context.ts` age/hash/consume behavior
   - failure path only emits `systemMessage` (user-visible), which is fine, but success path no longer feeds Claude via PreCompact (by design) — document this clearly in reference handler docs if not already

2. **SubagentStop transcript preference**  
   Preferring `agent_transcript_path`, treating blank files as unavailable, falling back to parent transcript is good.  
   **Contradiction:** CHANGELOG/checklist claim final message participates in **completion error scoring**, but code explicitly says final assistant prose contributes **warnings and size, not failure state**. Test `SubagentStop treats empty agent transcript plus error final message as failed` encodes the CHANGELOG claim and fails.

3. **Removing local Stop / SubagentStop retry counters**  
   Aligns with platform-level caps / simpler semantics. Finish by deleting dead helpers (`getSubagentRetryCount`, `incrementSubagentRetryCount`) and any env docs that still imply `CLAUDE_HOOK_SUBAGENT_MAX_RETRIES` / `CLAUDE_HOOK_MAX_CONTINUATIONS` drive runtime if those were removed.

4. **Checklist rewrite**  
   Replacing the Feb 2026 phase log with a repeatable audit record is the right maintainer move.  
   **Integrity issue:** verification section is checked green (`type-check` pass, `test:run` 1410 pass) but **current tree is red**. Treat those checkboxes as **stale/untrustworthy** until re-run.

### 5.3 High risk / likely over-strict vs official docs

These are the places where “parity” may have overshot into inventing stricter contracts than Claude Code actually emits:

| Contract | Branch strictness | Official/example evidence | Risk |
|---|---|---|---|
| `AgentToolInput.description` | required | Older library + route tests treat like Task (`description?`); docs emphasize `prompt` | May reject valid PreToolUse payloads |
| `AskUserQuestionOption.description` | required | Upstream PreToolUse example options are `{ "label": "React" }` only | Will reject real Claude payloads / doc examples |
| `AskUserQuestion` `multiSelect` | required boolean | Older schema optional | Possible false rejects |
| AskUserQuestion options min length | min 2 | Old schema min 1; docs often show 2+ but not proven min 2 always | Possible false rejects |
| MCP tool name pattern | loose accept of `tool__extra` and `tool!` while tests demand reject | Docs show `mcp__<server>__<tool>`; pattern needs a deliberate rule | Test/implementation mismatch; unclear official grammar |

**Recommendation:** for tool inputs, prefer **accepting what Claude Code sends** (optional fields, label-only options) unless the official schema explicitly marks required. Use docs examples as must-pass fixtures.

### 5.4 Process / hygiene findings

1. **`plans/foamy-questing-catmull.md`** is the original workflow plan. Repo hygiene says planning/agent scratch must not ship; keep untracked (already excluded from the commit).
2. **Local `main` ≠ `origin/main`.** Local `main` is still at an older history (`f59265a`). Always compare against `origin/main` for this work.
3. **Branch tracking:** `feat/hook-api-parity` was created from `origin/main` (good). Push with `-u origin feat/hook-api-parity` when ready.
4. **Audit age:** checklist date is **2026-07-12**; review day is **2026-07-30**. Before finishing, re-run `pnpm run docs:sync-upstream` and re-diff — Claude Code may have moved again.
5. **False confidence tests:** `preCompactOutputSchema.safeParse({ hookSpecificOutput: {...} })` can still “succeed” under Zod strip even though PreCompact no longer models that field. Prefer assertions that the schema **rejects** or that the typed output surface lacks the field.

### 5.5 Not a publication-blockers regression

This is **not** incomplete merge residue from PR #1. PR #1 is fully on `main`. This is **follow-on API parity work** that simply never got its own branch/PR before the merge.

---

## 6. Gap and implementation plan (to finish cleanly)

Work in this order. No coding performed in this review.

### Phase A — Re-establish truth (short)

1. Re-run `pnpm run docs:sync-upstream` on a clean worktree snapshot (or this branch) and `git diff docs/upstream`.
2. If mirrors moved since 2026-07-12, extend the delta matrix before more code changes.
3. Re-run gates and treat checklist verification as **unchecked** until green.

### Phase B — Finish contract consistency (core library)

1. **Builders / types already mostly right for Task/Teammate/StopFailure/Stop modes**  
   Update remaining tests to the new shapes (`taskBlock`, `teammateStop`).
2. **Tool schemas: decide strict vs accepting**
   - Prefer optional `Agent.description` unless official docs require it.
   - Prefer AskUserQuestion option `{ label }` minimum; make `description` / `preview` optional; keep max-4 questions if documented.
   - Align fixtures with official JSON examples used by docs-round-trip.
3. **MCP name grammar**  
   Define the intended regex/rules from official naming examples (`mcp__server__tool`, plugin scoped names) and make validators + tests agree.
4. **Exports**  
   Keep named Setup/MessageDisplay/background-task schema exports if they are part of the public validation barrel; package-export tests already expect them.

### Phase C — Finish reference handlers

1. **SubagentStop:** implement the *stated* last-assistant-message error policy **or** rewrite CHANGELOG/tests to match “warnings only”. Prefer implementing the stated policy if empty transcripts are common.
2. **Delete dead retry helpers** (type-check fix).
3. **PreCompact handoff:** keep the temp-file design if desired; update hooks tests to assert:
   - PreCompact emits user-facing `systemMessage` (and/or no Claude context channel)
   - SessionStart `source: "compact"` consumes stored context into `additionalContext`
4. Confirm env-var docs no longer describe removed counters as active if code removed them.

### Phase D — Docs and checklist integrity

1. Grep project-authored docs for stale claims (28 events, old builder shapes, PreCompact additionalContext recipes, live max-continuation counters).
2. Rewrite checklist verification section with **actual** command results after fixes.
3. Ensure CHANGELOG [Unreleased] matches final behavior (especially SubagentStop final-message scoring and PreCompact handoff).

### Phase E — Ship

1. `pnpm run type-check && pnpm run lint && pnpm run test:run && pnpm run build`
2. Inspect `dist/types` / `dist/validation` declarations for new public shapes.
3. Push `feat/hook-api-parity` and open a **draft PR** against `main` titled around “Claude Code hook API parity (July 2026 audit)”.
4. Do **not** include `plans/` in the PR.

### Estimated finish buckets

| Bucket | Effort sense | Notes |
|---|---|---|
| Test alignment for already-correct builders | Small | Mostly test edits |
| Dead code / type-check | Tiny | Delete unused retry helpers |
| Tool schema strictness | Medium | Risk of over-strict; re-check official examples |
| SubagentStop final-message policy | Medium | Intent/implementation conflict |
| PreCompact handoff tests/docs | Medium | Design OK; coverage incomplete |
| Re-sync upstream if docs moved | Variable | May add new deltas |

---

## 7. Suggested decision points for you

Because you touch this repo rarely, these are the only decisions that really matter:

1. **Is this PR “API parity only” or “parity + smarter reference handlers”?**  
   - Schema/types/builders/docs alone are one clean PR.  
   - PreCompact temp handoff + SubagentStop analysis policy are product behavior and can be split if you want a smaller review surface.

2. **Tool input strictness:** accept real Claude payloads (recommended) or enforce a stricter ideal schema?

3. **SubagentStop final message:** treat `Error: ...` prose as failure (CHANGELOG claim) or warnings-only (current code comment)?

4. **Draft PR now vs after green?**  
   - After green is cleaner.  
   - Draft now is fine for remote backup with a clear “verification red” note.

---

## 8. Current git state (for orientation)

```text
origin/main                          59ae9dd  Merge PR #1 publication-blockers
  └── feat/hook-api-parity           e67fb61  API parity commit (this review)
local fix/publication-blockers       a7500f5  old tip (remote branch deleted)
plans/                               untracked agent plan (keep out of git)
```

Working tree should be clean except untracked `plans/` (and OS junk if any).

---

## 9. Verdict

| Claim | Verdict |
|---|---|
| “This is latest Claude Code API update work” | **Yes** |
| “It is incomplete” | **Yes** — verification red; a few intent mismatches |
| “It is a mess / unknown changes” | **No** — coherent audit with a written plan and checklist |
| “Safe to throw away” | **No** — substantial correct work; finish rather than discard |
| “Safe to merge as-is” | **No** |
| “Ready for draft PR as WIP” | Optional; better after Phase B/C green |

**Recommended next coding session:** Phase A (re-sync if needed) → fix type-check dead code → align tests with correct builder/PreCompact semantics → resolve tool-schema strictness against official examples → resolve SubagentStop final-message policy → re-verify → draft PR.

---

## 10. References inside the repo

- Process: `docs/upstream/README.md`, `scripts/sync-upstream-docs.mjs`, `docs/internal/api-update-checklist.md`
- Original plan (untracked): `plans/foamy-questing-catmull.md`
- Public API targets: `src/types/index.ts`, `src/validation/schemas.ts`, `src/utils/output-builder.ts`
- Official mirrors used by this audit: `docs/upstream/hooks-reference.md` (primary), plus guide/settings/cli/headless
- Guardrail test: `tests/docs-round-trip.test.ts`
)
