# Comment Consistency Cleanup Plan

## TL;DR
> **Summary**: Fix the inconsistent comment state left by the partial remove-ai-slops pass. Restore a uniform JSDoc/file-comment policy across the public TypeScript API repo: keep API-contract comments, remove temporal/AI-workflow/migration/marketing language and heavy banners everywhere.
> **Deliverables**: Consistent comment style in `src/` and `tests/`, restored concise file-level headers for public modules, removed slop phrases, green quality gates.
> **Effort**: Medium
> **Parallel**: YES — 4 waves
> **Critical Path**: Wave 1 (policy + banned-phrase sweep) → Wave 2 (source headers) ‖ Wave 3 (test headers) → Wave 4 (verification)

## Context
### Original Request
The user observed that the previous `/remove-ai-slops` execution:
1. Ran as execution without planning.
2. Used 5 deep agents with large context windows to review a small set of files each.
3. Removed some JSDoc/file-level comments while leaving 90% of identical comments in place, creating inconsistency.
4. Left temporal-reference comments such as the `tests/eslint-disable-blocker.test.ts` header intact.
5. The user wants to plan fixing these inconsistencies and establish whether JSDoc comments are slop in a public API repo.

### Interview Summary
- User intent: **inconsistency is the biggest slop**. The repo must have a uniform comment style.
- User opinion: JSDoc comments are **not slop** for a public API product.
- User wants a plan first, not immediate execution.

### Metis Review (gaps addressed)
- Distinguish comment audience: public API contract, CLI operational contract, internal implementation note, test regression rationale.
- Avoid overzealous word bans that delete valid API behavior words (e.g., "automatic" as behavior vs. "automatically generated").
- Decide which modules deserve file-level headers: package entrypoints, CLIs, public reference handlers, complex processing modules.
- In long files, replace heavy banners with short separators or better `describe` structure rather than removing all structure.
- Standardize public field comments in `src/types/index.ts` rather than only deleting prose.

## Decision: Target Comment Style
**Recommended default**: **Library-grade explicit** for public API comments.

This means:
1. **Keep** JSDoc on all exported types, interfaces, functions, classes, methods, and public module entry points. Public consumers and IDEs depend on these.
2. **Keep** concise file-level headers that describe what the module does and its I/O contract (especially CLIs and reference handlers).
3. **Remove** temporal/AI-workflow/migration/marketing language everywhere:
   - Banned phrases: `Following ... pattern`, `incremental`, `one test at a time`, `Phase`, `Post-Phase`, `recent`, `recently`, `parent project`, `ported from`, `moved to`, `will`, `currently`, `now`, `new`, `modern`, `legacy`, `comprehensive`, `designed for`, `automatically` (when used as filler), `supports` (when redundant).
4. **Remove or simplify** heavy visual banners (`// =====`, `// ---------------------------------------------------------------------------`, `// ----`) to single blank-line separators. Keep only where a file is genuinely long and the separator aids navigation.
5. **Keep** regression-test rationale comments that explain **why** a test exists.
6. **Keep** internal comments that prevent likely bugs or explain non-obvious edge cases.

> **Decision confirmed**: Use **library-grade explicit** comments for this repo. Public API JSDoc is preserved; temporal/AI-workflow/migration/marketing language is removed.

### Banned phrase verification rule
The banned-phrase list targets **comments only**, not runtime code strings, variable names, or test data. Some terms (e.g., `new`, `will`, `supports`, `automatically`) can be legitimate API-behavior descriptions. The cleanup agent must:
- Review every grep match in a comment before changing or removing it.
- Preserve the comment if the word is describing actual runtime behavior (e.g., "automatically formats" for the format-code hook if that is the hook's documented behavior).
- Remove or rewrite the comment if the word is filler, temporal, or migration context (e.g., "Following parent project's pattern", "incremental", "Phase 2").
- Final gate: **zero unreviewed banned-phrase matches remain in comments** in `src/` and `tests/`.

## Work Objectives
### Core Objective
Establish a uniform, professional comment style across `src/` and `tests/` that is appropriate for a public TypeScript API library, eliminating the partial-cleanup inconsistency.

### Deliverables
1. A documented comment policy (added to `AGENTS.md`).
2. Cleaned source files (`src/**/*.ts`) with consistent JSDoc and no unreviewed slop language in comments.
3. Cleaned test files (`tests/**/*.ts`) with consistent headers and no unreviewed slop language in comments.
4. Green quality gates: `pnpm run check`, `pnpm run test:run`, `pnpm run build`.

### Definition of Done (verifiable conditions with commands)
- `pnpm run test:run` passes with **1201 tests**, 0 failures.
- `pnpm run check` (type-check + lint) passes with 0 errors.
- `pnpm run build` produces `dist/` without errors.
- A grep for banned temporal/AI phrases returns **zero unreviewed matches in comments** in `src/` and `tests/` (except documented opt-outs).
- All `src/` files have a consistent comment style (manual sample review passes).
- All `tests/` files have a consistent comment style (manual sample review passes).

### Scope Boundaries
- **IN scope**: `src/**/*.ts`, `tests/**/*.ts`, and `AGENTS.md` (only to document the comment policy).
- **OUT of scope**: Markdown docs (`docs/**/*.md`, `README.md`, `CHANGELOG.md`, etc.), `package.json`, build scripts, upstream mirrors. These were already addressed in the previous cleanup pass.
- **Runtime behavior**: no changes allowed.

### Must Have
- Uniform JSDoc policy across all public exports.
- Removal of temporal/AI-workflow/migration/marketing language from comments.
- Restoration of concise file-level headers where they were stripped from public modules.
- No functional code changes.

### Must NOT Have (guardrails)
- Do not remove API-contract JSDoc from exported public types/functions.
- Do not change any runtime behavior, type signatures, or public API names.
- Do not introduce new abstractions or dependencies.
- Do not delete regression-rationale comments.
- Do not leave heavy visual banners in some files and not others.

## Verification Strategy
> All routine verification is agent-executed. The mandatory Final Verification Wave presents consolidated results to the user and waits for explicit "okay" before the work is marked complete.
- Test decision: Existing tests already cover behavior; no new tests needed for comment-only changes.
- QA policy: Every task has agent-executed verification scenarios.
- Evidence: screenshots/diffs captured in PR review; automated grep reports.
- Banned-phrase grep: agents use grep to find candidates, then manually review each match to confirm it is inside a comment and is not a documented API-behavior opt-out before removing or rewriting it.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave.

#### Wave 1: Document the policy and run banned-phrase sweep
- Add a short "Comment Style" section to `AGENTS.md` documenting the library-grade explicit policy.
- Run a banned-phrase grep across `src/` and `tests/` to produce the cleanup target list.

#### Wave 2: Source file cleanup (split by domain)
- Group 1: Core types/schemas/validation/builder (`src/types/index.ts`, `src/validation/*.ts`, `src/utils/output-builder.ts`).
- Group 2: Lifecycle handlers (`src/lifecycle/*.ts`).
- Group 3: Pre-tool-use / post-tool-use handlers (`src/pre-tool-use/*.ts`, `src/post-tool-use/*.ts`).
- Group 4: Processing modules (`src/processing/*.ts`).
- Group 5: CLI entrypoints (`src/cli/*.ts`).

#### Wave 3: Test file cleanup
- Group 1: Validation/output-builder/lifecycle tests.
- Group 2: Processing/tail/docs-round-trip tests.
- Group 3: Hooks/content-validators/eslint-disable-blocker tests.
- Group 4: Test utilities.

#### Wave 4: Verification and consistency check
- Run banned-phrase grep again; must return zero unreviewed matches in comments.
- Run `pnpm run check`, `pnpm run test:run`, `pnpm run build`.
- Manual spot-check of representative files from each group.

### Dependency Matrix
- Wave 2 groups are independent.
- Wave 3 groups are independent.
- Wave 4 depends on Waves 1-3.

### Agent Dispatch Summary
- Wave 1: 1 agent (policy + grep).
- Wave 2: 5 parallel agents (source groups).
- Wave 3: 4 parallel agents (test groups).
- Wave 4: 1 agent (verification).

## TODOs
- [ ] 1. Document comment-style policy in `AGENTS.md`

  **What to do**: Add a `## Comment Style` section to `AGENTS.md` that records the library-grade explicit policy: keep API-contract JSDoc, strip temporal/AI-workflow/migration/marketing language, avoid heavy banners.

  **Must NOT do**: Do not make this section longer than necessary; do not add process instructions that belong in a runbook.

  **Recommended Agent Profile**:
  - Category: `writing`
  - Skills: none needed
  - Omitted: `remove-ai-slops` — this is policy writing, not slop removal.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2-10] | Blocked By: none

  **References**:
  - Current `AGENTS.md` — append before `## Compatibility Notes`.

  **Acceptance Criteria**:
  - [ ] `AGENTS.md` contains a concise `## Comment Style` section.
  - [ ] Section explicitly bans temporal/AI-workflow/migration/marketing phrases.
  - [ ] Section states JSDoc on public exports must be preserved.

  **QA Scenarios**:
  ```
  Scenario: Policy is readable and complete
    Tool: Read
    Steps: Read `AGENTS.md` `## Comment Style` section.
    Expected: Section exists, is concise, and covers API JSDoc, banned phrases, and banners.
    Evidence: .omo/evidence/comment-policy.md
  ```

  **Commit**: YES | Message: `docs(agents): document library-grade explicit comment style` | Files: `AGENTS.md`

- [ ] 2. Run banned-phrase grep and produce target list

  **What to do**: Search `src/` and `tests/` for banned phrases and heavy banner patterns. Produce a structured report (file, line, comment text, suggested action).

  **Must NOT do**: Do not edit files in this task; do not flag valid API-behavior words used in non-comment contexts.

  **Recommended Agent Profile**:
  - Category: `explore`
  - Skills: none needed

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [3-10] | Blocked By: [1]

  **References**:
  - Banned phrase list from the plan decision section.

  **Acceptance Criteria**:
  - [ ] Report lists every `src/` and `tests/` file containing candidate banned-phrase matches in comments or heavy comment banners.
  - [ ] Report distinguishes API-contract JSDoc from slop language.
  - [ ] Report is saved to `.omo/evidence/banned-phrase-report.md`.

  **QA Scenarios**:
  ```
  Scenario: Report is complete and structured
    Tool: Bash
    Steps: ls .omo/evidence/banned-phrase-report.md && head -50 .omo/evidence/banned-phrase-report.md
    Expected: File exists and contains file paths, line numbers, and suggested actions.
    Evidence: .omo/evidence/banned-phrase-report.md
  ```

  **Commit**: NO

- [ ] 3. Clean core source comments: types, schemas, validators, builder

  **What to do**: Edit `src/types/index.ts`, `src/validation/schemas.ts`, `src/validation/validators.ts`, `src/validation/index.ts`, `src/utils/output-builder.ts` to:
  - Restore concise file-level headers where they were stripped.
  - Remove temporal/AI/marketing language from field/method JSDoc.
  - Standardize on `/** Brief description. */` for fields; multi-line only when needed.
  - Remove or simplify heavy section banners.

  **Must NOT do**: Do not delete public API contract information; do not change any runtime behavior or types.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`
  - Omitted: none

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `src/types/index.ts:1-50` — restore concise header.
  - `src/validation/schemas.ts:1-50` — header was replaced; ensure new header is clean.
  - `src/validation/validators.ts` — function JSDoc remains; strip temporal language.

  **Acceptance Criteria**:
  - [ ] Each edited file has a concise file-level header.
  - [ ] Zero unreviewed banned-phrase matches remain in comments in edited files; documented API-behavior opt-outs allowed.
  - [ ] `pnpm run type-check` passes.

  **QA Scenarios**:
  ```
  Scenario: Core source files are consistent
    Tool: Bash
    Steps: grep -RniE "(Following|incremental|Phase|recently|parent project|comprehensive|designed for)" src/types/index.ts src/validation/*.ts src/utils/output-builder.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/core-source-grep.txt

  Scenario: Type-check passes
    Tool: Bash
    Steps: pnpm run type-check
    Expected: exit 0, no errors.
    Evidence: .omo/evidence/core-source-typecheck.txt
  ```

  **Commit**: YES | Message: `style(src): standardize comments in types, validation, and builder` | Files: `src/types/index.ts`, `src/validation/*.ts`, `src/utils/output-builder.ts`

- [ ] 4. Clean lifecycle handler comments

  **What to do**: Edit `src/lifecycle/*.ts` to:
  - Standardize file headers: keep concise "{Event} Hook Handler — {one-line purpose}" headers.
  - Remove "reference handler" boilerplate where it is repetitive and uninformative.
  - Remove "Use cases:" bullet lists that duplicate the handler's purpose.
  - Keep meaningful one-line JSDoc for helper functions.

  **Must NOT do**: Do not delete I/O contract descriptions for CLI handlers; do not change handler behavior.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `src/lifecycle/index.ts` — header was removed; restore a concise one.
  - `src/lifecycle/notification-handler.ts` — heavy function JSDoc removed previously; ensure remaining code is clean.
  - `src/lifecycle/session-start.ts` — same as above.

  **Acceptance Criteria**:
  - [ ] All `src/lifecycle/*.ts` files have consistent headers.
  - [ ] Zero unreviewed banned-phrase matches remain in comments.
  - [ ] `pnpm run type-check` passes.

  **QA Scenarios**:
  ```
  Scenario: Lifecycle files are consistent
    Tool: Bash
    Steps: grep -RniE "(reference handler|Use cases:|Following|incremental|recently)" src/lifecycle/*.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/lifecycle-grep.txt
  ```

  **Commit**: YES | Message: `style(src): standardize lifecycle handler comments` | Files: `src/lifecycle/*.ts`

- [ ] 5. Clean pre-tool-use / post-tool-use handler comments

  **What to do**: Edit `src/pre-tool-use/*.ts` and `src/post-tool-use/*.ts` to:
  - Keep concise "{Purpose} Hook" headers.
  - Remove redundant bullet lists that repeat what the code does.
  - Remove marketing language like "automatically", "supports", "comprehensive".

  **Must NOT do**: Do not delete CLI I/O contract notes; do not change tool behavior.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `src/pre-tool-use/bash-validator.ts`, `src/pre-tool-use/file-protector.ts`, `src/post-tool-use/format-code.ts`.

  **Acceptance Criteria**:
  - [ ] Headers are concise and consistent.
  - [ ] Zero unreviewed banned-phrase matches remain in comments; documented API-behavior opt-outs allowed.
  - [ ] `pnpm run type-check` passes.

  **QA Scenarios**:
  ```
  Scenario: Tool-use files are consistent
    Tool: Bash
    Steps: grep -RniE "(automatically|comprehensive|supports|Following|incremental)" src/pre-tool-use/*.ts src/post-tool-use/*.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/tool-use-grep.txt
  ```

  **Commit**: YES | Message: `style(src): standardize pre-tool-use and post-tool-use comments` | Files: `src/pre-tool-use/*.ts`, `src/post-tool-use/*.ts`

- [ ] 6. Clean processing module comments

  **What to do**: Edit `src/processing/*.ts` to:
  - Restore concise file-level headers where stripped (e.g., `src/processing/index.ts`).
  - Remove or simplify heavy section banners.
  - Strip temporal language ("incremental", "new format", "now", "recently").

  **Must NOT do**: Do not delete function-level JSDoc that describes public processing API contracts.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `src/processing/index.ts` — header was removed.
  - `src/processing/denoiser.ts` — banners were removed.
  - `src/processing/tail.ts` — contains "incremental" and "Designed for".
  - `src/processing/parser.ts` — contains "new format".

  **Acceptance Criteria**:
  - [ ] Concise file-level headers restored where appropriate.
  - [ ] Zero unreviewed banned-phrase matches remain in comments.
  - [ ] `pnpm run type-check` passes.

  **QA Scenarios**:
  ```
  Scenario: Processing files are consistent
    Tool: Bash
    Steps: grep -RniE "(incremental|Designed for|new format|recently|now)" src/processing/*.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/processing-grep.txt
  ```

  **Commit**: YES | Message: `style(src): standardize processing module comments` | Files: `src/processing/*.ts`

- [ ] 7. Clean CLI entrypoint comments

  **What to do**: Edit `src/cli/*.ts` to:
  - Keep concise headers describing CLI purpose and I/O contract.
  - Remove temporal/marketing language.
  - Simplify section banners.

  **Must NOT do**: Do not delete CLI usage/contract documentation.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `src/cli/export-sessions.ts`, `src/cli/tail-session.ts`.

  **Acceptance Criteria**:
  - [ ] CLI files have consistent headers.
  - [ ] Zero unreviewed banned-phrase matches remain in comments.
  - [ ] `pnpm run type-check` passes.

  **QA Scenarios**:
  ```
  Scenario: CLI files are consistent
    Tool: Bash
    Steps: grep -RniE "(Following|incremental|recently|designed for|automatically)" src/cli/*.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/cli-grep.txt
  ```

  **Commit**: YES | Message: `style(src): standardize CLI entrypoint comments` | Files: `src/cli/*.ts`

- [ ] 8. Clean validation/output-builder/lifecycle test comments

  **What to do**: Edit `tests/validation.test.ts`, `tests/output-builder.test.ts`, `tests/lifecycle.test.ts` to:
  - Remove temporal/phase/test-order comments.
  - Remove or simplify heavy section banners.
  - Keep concise file headers.
  - Preserve regression-rationale comments.

  **Must NOT do**: Do not delete test intent or regression rationale; do not change test assertions.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `tests/validation.test.ts` — phase banners removed previously; finish cleanup.
  - `tests/output-builder.test.ts` — ensure header consistency.
  - `tests/lifecycle.test.ts` — same.

  **Acceptance Criteria**:
  - [ ] Zero unreviewed banned-phrase matches remain in comments.
  - [ ] `pnpm run test:run tests/validation.test.ts tests/output-builder.test.ts tests/lifecycle.test.ts` passes.

  **QA Scenarios**:
  ```
  Scenario: Test group 1 is consistent
    Tool: Bash
    Steps: grep -niE "(Phase|FIRST TEST|Following|incremental|recently)" tests/validation.test.ts tests/output-builder.test.ts tests/lifecycle.test.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/test-group-1-grep.txt
  ```

  **Commit**: YES | Message: `style(tests): standardize validation, builder, and lifecycle test comments` | Files: `tests/validation.test.ts`, `tests/output-builder.test.ts`, `tests/lifecycle.test.ts`

- [ ] 9. Clean processing/tail/docs-round-trip test comments

  **What to do**: Edit `tests/processing.test.ts`, `tests/tail.test.ts`, `tests/docs-round-trip.test.ts` to:
  - Remove temporal/test-step comments ("Append a second message", "Round 1", etc.).
  - Remove historical/migration comments ("ported from", "webui-derived").
  - Simplify or remove heavy banners.
  - Preserve regression-rationale comments.

  **Must NOT do**: Do not change test behavior or assertions.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `tests/processing.test.ts` — some banners already removed.
  - `tests/tail.test.ts` — inline step comments removed previously; finish cleanup.
  - `tests/docs-round-trip.test.ts` — ensure header consistency.

  **Acceptance Criteria**:
  - [ ] Zero unreviewed banned-phrase matches remain in comments.
  - [ ] `pnpm run test:run tests/processing.test.ts tests/tail.test.ts tests/docs-round-trip.test.ts` passes.

  **QA Scenarios**:
  ```
  Scenario: Test group 2 is consistent
    Tool: Bash
    Steps: grep -niE "(ported from|webui-derived|Round [0-9]|Append a|Initial:|Truncate)" tests/processing.test.ts tests/tail.test.ts tests/docs-round-trip.test.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/test-group-2-grep.txt
  ```

  **Commit**: YES | Message: `style(tests): standardize processing, tail, and docs-round-trip test comments` | Files: `tests/processing.test.ts`, `tests/tail.test.ts`, `tests/docs-round-trip.test.ts`

- [ ] 10. Clean remaining test comments

  **What to do**: Edit `tests/hooks.test.ts`, `tests/content-validators.test.ts`, `tests/eslint-disable-blocker.test.ts`, `tests/package-exports.test.ts`, `tests/processing-core-hardening.test.ts`, `tests/tool-result-redaction.test.ts`, `tests/test-utils.ts` to:
  - Remove temporal/AI-workflow/migration language from headers.
  - Keep concise file headers and regression rationale.
  - Simplify heavy banners.

  **Must NOT do**: Do not delete regression-rationale comments; do not change test behavior.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [11] | Blocked By: [2]

  **References**:
  - `tests/eslint-disable-blocker.test.ts` — example user cited; header contains "Following parent project's incremental testing pattern".
  - `tests/content-validators.test.ts` — contains "Phase 2D.6".
  - `tests/test-utils.ts` — heavy banners and helper JSDoc were already stripped; verify consistency.

  **Acceptance Criteria**:
  - [ ] Zero unreviewed banned-phrase matches remain in comments in these files.
  - [ ] `pnpm run test:run` passes for the affected test files.

  **QA Scenarios**:
  ```
  Scenario: Remaining test files are consistent
    Tool: Bash
    Steps: grep -niE "(Following|incremental|Phase|parent project|moved to|ported from)" tests/hooks.test.ts tests/content-validators.test.ts tests/eslint-disable-blocker.test.ts tests/package-exports.test.ts tests/processing-core-hardening.test.ts tests/tool-result-redaction.test.ts tests/test-utils.ts
    Expected: Zero unreviewed matches in comments; documented API-behavior opt-outs allowed.
    Evidence: .omo/evidence/test-group-3-grep.txt
  ```

  **Commit**: YES | Message: `style(tests): standardize remaining test file comments` | Files: `tests/hooks.test.ts`, `tests/content-validators.test.ts`, `tests/eslint-disable-blocker.test.ts`, `tests/package-exports.test.ts`, `tests/processing-core-hardening.test.ts`, `tests/tool-result-redaction.test.ts`, `tests/test-utils.ts`

- [ ] 11. Final verification wave

  **What to do**:
  - Run the banned-phrase grep across all `src/` and `tests/` files; review each match to confirm it is either outside a comment or a documented API-behavior opt-out. Zero unreviewed slop matches may remain in comments.
  - Run `pnpm run check`.
  - Run `pnpm run test:run`.
  - Run `pnpm run build`.
  - Spot-check representative files from each group for visual consistency.
  - Delete `.omo/evidence/` and any planning artifacts before final commit (per Public Repository Hygiene guardrail).

  **Must NOT do**: Do not leave `.omo/` artifacts in the public repo.

  **Recommended Agent Profile**:
  - Category: `deep`
  - Skills: `remove-ai-slops`

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: none | Blocked By: [3-10]

  **References**:
  - `AGENTS.md` `## Public Repository Hygiene` section.

  **Acceptance Criteria**:
  - [ ] Banned-phrase grep returns zero unreviewed matches in comments.
  - [ ] `pnpm run check` passes.
  - [ ] `pnpm run test:run` passes with 1201 tests.
  - [ ] `pnpm run build` passes.
  - [ ] Working tree contains no `.omo/` artifacts.

  **QA Scenarios**:
  ```
  Scenario: All quality gates pass
    Tool: Bash
    Steps: pnpm run check && pnpm run test:run && pnpm run build
    Expected: All exit 0, tests pass.
    Evidence: .omo/evidence/final-gates.txt

  Scenario: Banned phrases eliminated
    Tool: Bash
    Steps: grep -RniE "(Following|incremental|Phase [0-9]|recently|parent project|ported from|moved to|comprehensive|designed for|Use cases:)" src/ tests/
    Expected: Zero unreviewed matches in comments (documented opt-outs only).
    Evidence: .omo/evidence/final-banned-grep.txt
  ```

  **Commit**: YES | Message: `chore(repo): verify comment consistency and clean work artifacts` | Files: all changed files; delete `.omo/evidence/`

## Final Verification Wave (MANDATORY)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
- [ ] F1. Plan Compliance Audit — oracle: verify the cleanup followed the documented policy and no API-contract JSDoc was removed.
- [ ] F2. Code Quality Review — unspecified-high: review a sample of source files for consistent style.
- [ ] F3. Real Manual QA — unspecified-high: run the banned-phrase grep and full test suite.
- [ ] F4. Scope Fidelity Check — deep: verify no runtime behavior changed and public API comments remain intact.

## Commit Strategy
- One commit per wave group (source groups, test groups) to keep diffs reviewable.
- Final verification commit combines gate evidence and deletes `.omo/evidence/`.
- Do not squash everything into one commit; comment-only changes should be bisectable.

## Success Criteria
- Every `src/` and `tests/` file follows the same comment style.
- Banned temporal/AI-workflow/migration/marketing phrases are eliminated from comments (with documented API-behavior opt-outs).
- Public API JSDoc is preserved and consistent.
- Quality gates are green.
- No `.omo/` work artifacts remain in the public repo.

## Remaining Risks / Deferred
- **Oversized modules**: splitting files >250 pure LOC is still deferred; this plan does not address module size.
- **Docs Markdown files**: this plan focuses on `src/` and `tests/` only. Markdown docs were already cleaned in the previous pass and are outside scope unless the user asks.
- **Subjectivity**: some phrases may be valid API behavior descriptions. The banned-phrase grep must be reviewed manually, not blindly applied.
