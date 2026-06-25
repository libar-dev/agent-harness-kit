# Plan: Close the Claude Code Hook API Gap

## TL;DR

> **Summary**: Bring `@libar-dev/agent-harness-kit` into parity with the current upstream Claude Code hook API by adding the two missing events (`Setup`, `MessageDisplay`), expanding `SessionStart` input/output, widening the `Notification` and `StopFailure` enums, supporting the command-hook exec form (`args`), adding the generic `PostToolUse` output replacement field, widening `updatedMCPToolOutput` to `unknown`, and adding `duration_ms` to both `PostToolUse` and `PostToolUseFailure`.
> **Deliverables**: Updated types, Zod schemas, validators, output builders, lifecycle handlers, tests, docs, and package metadata.
> **Effort**: Medium — roughly 1–2 focused engineering days.
> **Parallel**: YES — 5 implementation waves plus a mandatory final verification wave.
> **Critical Path**: Wave 1 (types/schemas) → Wave 2 (builders/validators/lifecycle) → Wave 3 (tests) → Wave 4 (docs) → Wave 5 (verification).

## Context

### Original Request

Plan the work to address the gap between this library and the updated Claude Code API, using the refreshed upstream mirrors in `docs/upstream/` and the prepared DeepWiki index.

### Interview Summary

- Source of truth for hook surface: `docs/upstream/hooks-reference.md`, confirmed by `docs/internal/prometheus-implementation-context.md`.
- Scope is **core runtime/type/schema parity**; stricter config-validator semantics are deferred to a follow-up slice.
- Test strategy: tests-after, building on the existing 245 Vitest tests and CI checks (`pnpm run test:run`, `pnpm run check`).

### Metis Review (gaps addressed)

- Included Metis-surfaced upstream fields: `effort` on base input, `terminalSequence` on base output, `duration_ms` on `PostToolUse` and `PostToolUseFailure` inputs, and `updatedToolOutput` on `PostToolUse` output.
- Confirmed `updatedToolOutput` should be typed as `unknown` to accommodate arbitrary tool-output shapes.
- Added explicit acceptance criteria for 30-event coverage and backward compatibility of `updatedMCPToolOutput`.

## Work Objectives

### Core Objective

Make the library accept, validate, and produce the same hook inputs/outputs that Claude Code currently sends/receives, so that the docs round-trip test no longer needs to skip `Setup` and `MessageDisplay` examples.

### Deliverables

1. `Setup` and `MessageDisplay` fully modeled as hook events.
2. `SessionStart` input/output aligned with upstream (optional `model`, `session_title`, and all output control fields).
3. `Notification` and `StopFailure` enums widened.
4. `CommandHookHandler` supports `args` exec form.
5. `PostToolUse` supports generic `updatedToolOutput`.
6. Common `effort`/`terminalSequence`, `PostToolUse.duration_ms`, `PostToolUseFailure.duration_ms`, and `PostToolUseOutput.updatedToolOutput`/`updatedMCPToolOutput` support.
7. Lifecycle handlers, tests, docs, and package metadata updated.

### Definition of Done

- `pnpm run test:run` passes with new regression tests.
- `pnpm run check` (type-check + lint) passes.
- `tests/docs-round-trip.test.ts` validates all upstream `Setup` and `MessageDisplay` input/config JSON examples without skips. (Output examples are covered by dedicated schema tests, not by the docs-round-trip harness.)
- README/CLAUDE.md/package.json and project docs no longer refer to "28" hook events.

### Must Have

- All 30 hook event names present in `HookEventName`, `hookEventNameSchema`, `hookInputSchemas`, `hookOutputSchemas`, and `hooksConfigSchema`.
- Types and schemas for `SetupInput`, `SetupOutput`, `MessageDisplayInput`, `MessageDisplayOutput`.
- `SessionStart.model` optional and `session_title` added.
- `SessionStartOutput` supports `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`.
- `Notification.notification_type` includes all 6 upstream values.
- `StopFailure.error` includes all 10 upstream values.
- `CommandHookHandler.args?: string[]` and matching Zod schema.
- `PostToolUseOutput` supports both `updatedToolOutput` and `updatedMCPToolOutput`; both typed as `unknown` (widened from `Record<string, unknown>`).
- `BaseHookInput.effort` and `BaseHookOutput.terminalSequence`.
- `PostToolUseInput.duration_ms` and `PostToolUseFailureInput.duration_ms` optional.
- Type guards, specific validators, and test factories for `Setup` and `MessageDisplay`.
- Reference lifecycle handlers for `Setup` and `MessageDisplay` wired into `src/lifecycle/index.ts`.
- Docs and package metadata updated.

### Must NOT Have

- No breaking removal of existing fields or builder signatures (additive-only).
- No stricter config-validator semantics (e.g., enforcing that `MessageDisplay` ignores `matcher` or that `SessionStart` only accepts certain handler types) in this slice.
- No changes to CLI flags, settings beyond `HooksConfig`, or Agent SDK packages.
- No `.passthrough()` on schemas (preserve existing `.strip()` behavior).
- No new `any` types.
- No version bump in `package.json`.

**Enforcement checks** (run as part of relevant task QA and the Final Verification Wave):
- No newly added `.passthrough()`: `git diff -- src/validation/schemas.ts | grep '^\+\s*\.passthrough()' | wc -l` outputs 0. (The repo already uses `.passthrough()` in `permissionUpdateEntrySchema` at `src/validation/schemas.ts:75`; do not remove it.)
- `pnpm run type-check` passes (catches new `any` or type errors).
- No new explicit `any` in changed TS files: `git diff -- src/ tests/ | grep -E '^\+.*\bany\b' | wc -l` outputs 0.
- `git diff package.json | grep '"version"'` returns empty.
- Changed files stay within the allowed set: `git diff --name-only | grep -vE '^(src/(types|validation|utils|lifecycle)/|tests/|docs/|README\.md|package\.json|CLAUDE\.md|CHANGELOG\.md)$' | wc -l` outputs 0.
- Upstream docs are untouched: `git diff --name-only -- docs/upstream | wc -l` outputs 0.
- No existing public exports removed: `git diff src/types/index.ts src/validation/index.ts src/utils/index.ts src/lifecycle/index.ts | grep -E '^-\s*(export|export type|export const)' | grep -v '^{' | wc -l` outputs 0.
- No stricter config semantics added: `git diff src/validation/schemas.ts src/validation/validators.ts | grep -E '^\+.*(allowedHandlerTypes|restrictTo|matcher.*Schema|handlerTypeRestriction)' | wc -l` outputs 0.

## Verification Strategy

- **Test decision**: Tests-after, extending existing Vitest suites.
- **QA policy**: Every implementation task has agent-executed happy-path and failure/edge-case scenarios.
- **Evidence**: `.omo/evidence/task-{N}-{slug}.txt` or `.png` as appropriate.

## Execution Strategy

### Parallel Execution Waves

Wave 1: Core types and schemas (foundation) — **sequential by file ownership** (`src/types/index.ts` then `src/validation/schemas.ts`); tasks 1–10 run as one chain to avoid merge conflicts.
Wave 2: Validators, builders, lifecycle handlers
Wave 3: Tests and fixtures
Wave 4: Documentation and package metadata
Wave 5: Final verification (mandatory)

### Dependency Matrix

| Task | Blocks | Blocked By |
|------|--------|------------|
| Wave 1 tasks | Wave 2, Wave 3 | — (internal chain: 1 → 2 → … → 10) |
| Wave 2 tasks | Wave 3 | Wave 1 |
| Wave 3 tasks | Wave 4 | Wave 1–2 |
| Wave 4 tasks | Wave 5 | Wave 1–3 |
| Wave 5 tasks | — | Wave 1–4 |

### Agent Dispatch Summary

| Wave | Task Count | Recommended Categories |
|------|------------|------------------------|
| Wave 1 | 10 (sequential) | `quick`, `unspecified-low` (systematic schema/types edits) |
| Wave 2 | 7 | `quick`, `unspecified-low` (builders, validators, lifecycle) |
| Wave 3 | 3 | `unspecified-low` (tests, fixtures) |
| Wave 4 | 2 | `writing`, `unspecified-low` (docs, metadata) |
| Wave 5 | 4 | `oracle`, `unspecified-high`, `deep` (verification) |

## TODOs

- [ ] 1. Expand `HookEventName` and `hookEventNameSchema` to 30 events

  **What to do**: Add `'Setup'` and `'MessageDisplay'` to the `HookEventName` union in `src/types/index.ts` and to the `hookEventNameSchema` enum in `src/validation/schemas.ts`. Keep the existing 28 events intact.

  **Must NOT do**: Reorder or remove existing events; change the config schema to require the new keys.

  **Recommended Agent Profile**:
  - Category: `quick` — small, mechanical enum expansion.
  - Skills: `git-master` (for atomic commit), `frontend-ui-ux` not needed.
  - Omitted: `security-research` — no security surface.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2 | Blocked By: —

  **References**:
  - Pattern: `src/types/index.ts:919-947` — `HookEventName` union.
  - Pattern: `src/validation/schemas.ts:1202-1231` — `hookEventNameSchema`.
  - External: `docs/upstream/hooks-reference.md` event table.

  **Acceptance Criteria**:
  - [ ] `HookEventName` evaluates to a union of 30 string literals.
  - [ ] `hookEventNameSchema.options` has length 30.
  - [ ] `pnpm run type-check` passes after this change.
  - [ ] No existing event names are removed or renamed.

  **QA Scenarios**:
  ```
  Scenario: Enum expansion compiles
    Tool: Bash
    Steps: pnpm run type-check
    Expected: exit 0, no TS errors
    Evidence: .omo/evidence/task-1-typecheck.txt

  Scenario: New events are enumerable
    Tool: Bash
    Steps: grep -E "'Setup'|'MessageDisplay'" src/types/index.ts src/validation/schemas.ts
    Expected: both files contain both literals
    Evidence: .omo/evidence/task-1-grep.txt

  Scenario: Old events still present
    Tool: Bash
    Steps: grep -E "'PreToolUse'|'SessionEnd'" src/types/index.ts src/validation/schemas.ts | wc -l
    Expected: count ≥ 4
    Evidence: .omo/evidence/task-1-no-removal.txt
  ```

  **Commit**: YES | Message: `feat(types): expand HookEventName to 30 events` | Files: `src/types/index.ts`, `src/validation/schemas.ts`

- [ ] 2. Add `Setup` TypeScript interfaces

  **What to do**: Add `SetupInput` and `SetupOutput` interfaces to `src/types/index.ts`. `SetupInput` extends `BaseHookInput` with `hook_event_name: 'Setup'` and `trigger: 'init' | 'maintenance'`. `SetupOutput` extends `BaseHookOutput` with `hookSpecificOutput?: { hookEventName: 'Setup'; additionalContext?: string }`.

  **Must NOT do**: Add decision/blocking fields; `Setup` only supports context injection.

  **Recommended Agent Profile**:
  - Category: `quick` — interface addition.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 3 | Blocked By: 1

  **References**:
  - Pattern: `src/types/index.ts:510-532` — `SessionStartInput`/`SessionStartOutput`.
  - External: `docs/upstream/hooks-reference.md:986-1030`.

  **Acceptance Criteria**:
  - [ ] `SetupInput` and `SetupOutput` are exported and compile.
  - [ ] `HookInput` and `HookOutput` unions include them.

  **QA Scenarios**:
  ```
  Scenario: Setup types compile
    Tool: Bash
    Steps: pnpm run type-check
    Expected: exit 0
    Evidence: .omo/evidence/task-2-typecheck.txt

  Scenario: SetupInput rejects wrong event name at compile time
    Tool: Bash
    Steps: cat > task-2-type-check.ts <<'EOF'
import type { SetupInput } from './src/types/index.js';
const bad: SetupInput = { session_id: 's', transcript_path: '/tmp/t.json', cwd: '/', hook_event_name: 'SessionStart', trigger: 'init' };
EOF
pnpm exec tsc --noEmit --skipLibCheck task-2-type-check.ts; STATUS=$?; rm task-2-type-check.ts; exit $STATUS
    Expected: exits non-zero with TS error on hook_event_name
    Evidence: .omo/evidence/task-2-invalid-event.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 3. Add `MessageDisplay` TypeScript interfaces

  **What to do**: Add `MessageDisplayInput` and `MessageDisplayOutput` interfaces to `src/types/index.ts`. `MessageDisplayInput` extends `BaseHookInput` with `hook_event_name: 'MessageDisplay'`, `turn_id`, `message_id`, `index`, `final`, and `delta`. `MessageDisplayOutput` extends `BaseHookOutput` with `hookSpecificOutput?: { hookEventName: 'MessageDisplay'; displayContent?: string }`.

  **Must NOT do**: Add matcher support or blocking fields; `MessageDisplay` is display-only.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4 | Blocked By: 2

  **References**:
  - Pattern: `src/types/index.ts:418-444` — `NotificationInput`/`NotificationOutput`.
  - External: `docs/upstream/hooks-reference.md:1178-1230`.

  **Acceptance Criteria**:
  - [ ] `MessageDisplayInput` and `MessageDisplayOutput` exported and compile.
  - [ ] `HookInput` and `HookOutput` unions include them.

  **QA Scenarios**:
  ```
  Scenario: MessageDisplay types compile
    Tool: Bash
    Steps: pnpm run type-check
    Expected: exit 0
    Evidence: .omo/evidence/task-3-typecheck.txt

  Scenario: MessageDisplayInput rejects wrong event name at compile time
    Tool: Bash
    Steps: cat > task-3-type-check.ts <<'EOF'
import type { MessageDisplayInput } from './src/types/index.js';
const bad: MessageDisplayInput = { session_id: 's', transcript_path: '/tmp/t.json', cwd: '/', hook_event_name: 'Setup', turn_id: '550e8400-e29b-41d4-a716-446655440000', message_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', index: 0, final: false, delta: 'x' };
EOF
pnpm exec tsc --noEmit --skipLibCheck task-3-type-check.ts; STATUS=$?; rm task-3-type-check.ts; exit $STATUS
    Expected: exits non-zero with TS error on hook_event_name
    Evidence: .omo/evidence/task-3-invalid-event.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 4. Add `Setup` Zod schemas

  **What to do**: Add `setupInputSchema` and `setupOutputSchema` to `src/validation/schemas.ts`. Input: `baseHookInputSchema.extend({ hook_event_name: z.literal('Setup'), trigger: z.enum(['init', 'maintenance']) })`. Output: extend `baseHookOutputSchema` with `hookSpecificOutput` containing `hookEventName: 'Setup'` and `additionalContext` optional.

  **Must NOT do**: Add `.passthrough()`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 5 | Blocked By: 3

  **References**:
  - Pattern: `src/validation/schemas.ts:181-192` — `sessionStartInputSchema`.
  - Pattern: `src/validation/schemas.ts:619-629` — `sessionStartOutputSchema`.
  - External: `docs/upstream/hooks-reference.md:1001-1030`.

  **Acceptance Criteria**:
  - [ ] `setupInputSchema.safeParse(validSetupInput).success === true`.
  - [ ] `setupOutputSchema.safeParse(validSetupOutput).success === true`.
  - [ ] `setupInputSchema.safeParse({ hook_event_name: 'Setup', trigger: 'invalid' }).success === false`.
  - [ ] No newly added `.passthrough()` in this task: `git diff -- src/validation/schemas.ts | grep '^\+\s*\.passthrough()' | wc -l` outputs 0.

  **QA Scenarios**:
  ```
  Scenario: Setup schema accepts valid input
    Tool: Bash
    Steps: tsx -e "import { setupInputSchema, setupOutputSchema } from './src/validation/schemas.js'; const input = { session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'Setup', trigger:'init' }; const output = { hook_event_name:'Setup', hookSpecificOutput:{ hookEventName:'Setup', additionalContext:'ctx' } }; console.log(setupInputSchema.safeParse(input).success, setupOutputSchema.safeParse(output).success);"
    Expected: outputs true true
    Evidence: .omo/evidence/task-4-schema.txt

  Scenario: Setup schema rejects invalid trigger
    Tool: Bash
    Steps: tsx -e "import { setupInputSchema } from './src/validation/schemas.js'; console.log(setupInputSchema.safeParse({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'Setup', trigger:'bogus' }).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-4-invalid-trigger.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 5. Add `MessageDisplay` Zod schemas

  **What to do**: Add `messageDisplayInputSchema` and `messageDisplayOutputSchema` to `src/validation/schemas.ts`. Input: `baseHookInputSchema.extend({ hook_event_name: z.literal('MessageDisplay'), turn_id: z.string().uuid(), message_id: z.string().uuid(), index: z.number().int().nonnegative(), final: z.boolean(), delta: z.string() })`. Output: extend `baseHookOutputSchema` with `hookSpecificOutput` containing `hookEventName: 'MessageDisplay'` and `displayContent` optional.

  **Must NOT do**: Add `.passthrough()`; require matcher field.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 6 | Blocked By: 4

  **References**:
  - Pattern: `src/validation/schemas.ts:210-226` — `notificationInputSchema`.
  - External: `docs/upstream/hooks-reference.md:1196-1230`.

  **Acceptance Criteria**:
  - [ ] `messageDisplayInputSchema.safeParse(upstreamExample).success === true`.
  - [ ] `messageDisplayOutputSchema.safeParse({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: 'x' } }).success === true`.
  - [ ] `messageDisplayInputSchema.safeParse({ hook_event_name: 'MessageDisplay', turn_id: 'not-a-uuid', message_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', index: 0, final: false, delta: 'x' }).success === false`.
  - [ ] No newly added `.passthrough()` in this task: `git diff -- src/validation/schemas.ts | grep '^\+\s*\.passthrough()' | wc -l` outputs 0.

  **QA Scenarios**:
  ```
  Scenario: MessageDisplay schema accepts valid input
    Tool: Bash
    Steps: tsx -e "import { messageDisplayInputSchema, messageDisplayOutputSchema } from './src/validation/schemas.js'; const input = { session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'MessageDisplay', turn_id:'550e8400-e29b-41d4-a716-446655440000', message_id:'6ba7b810-9dad-11d1-80b4-00c04fd430c8', index:0, final:false, delta:'hello' }; const output = { hook_event_name:'MessageDisplay', hookSpecificOutput:{ hookEventName:'MessageDisplay', displayContent:'hello' } }; console.log(messageDisplayInputSchema.safeParse(input).success, messageDisplayOutputSchema.safeParse(output).success);"
    Expected: outputs true true
    Evidence: .omo/evidence/task-5-schema.txt

  Scenario: MessageDisplay schema rejects non-UUID turn_id
    Tool: Bash
    Steps: tsx -e "import { messageDisplayInputSchema } from './src/validation/schemas.js'; console.log(messageDisplayInputSchema.safeParse({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'MessageDisplay', turn_id:'bad', message_id:'6ba7b810-9dad-11d1-80b4-00c04fd430c8', index:0, final:false, delta:'x' }).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-5-invalid-uuid.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 6. Update `HookInput`/`HookOutput` unions and schema collections

  **What to do**: Add `SetupInput`, `SetupOutput`, `MessageDisplayInput`, `MessageDisplayOutput` to the `HookInput` and `HookOutput` unions in `src/types/index.ts`. Add `Setup`, `MessageDisplay` entries to `hookInputSchemas` and `hookOutputSchemas` in `src/validation/schemas.ts`.

  **Must NOT do**: Remove existing union members.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 7 | Blocked By: 5

  **References**:
  - Pattern: `src/types/index.ts:748-799` — `HookInput`/`HookOutput` unions.
  - Pattern: `src/validation/schemas.ts:1005-1068` — schema collections.

  **Acceptance Criteria**:
  - [ ] `HookInput` includes 30 members.
  - [ ] `hookInputSchemas` and `hookOutputSchemas` have keys for `Setup` and `MessageDisplay`.
  - [ ] `validateHookInput` can route both new events.
  - [ ] `validateHookInput` rejects an input whose `hook_event_name` is `'UnknownEvent'`.

  **QA Scenarios**:
  ```
  Scenario: All 30 events route through validateHookInput
    Tool: Bash
    Steps: pnpm run test:run -- -t "routes"
    Expected: tests pass
    Evidence: .omo/evidence/task-6-routing.txt

  Scenario: validateHookInput rejects unknown event name
    Tool: Bash
    Steps: tsx -e "import { validateHookInput } from './src/validation/index.js'; console.log(validateHookInput({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'UnknownEvent' }));" 2>&1
    Expected: exits non-zero or throws
    Evidence: .omo/evidence/task-6-unknown-event.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 7. Update `SessionStart` input parity

  **What to do**: In `src/types/index.ts`, make `model?: string | undefined` in `SessionStartInput` and add `session_title?: string | undefined`. In `src/validation/schemas.ts`, update `sessionStartInputSchema` accordingly (`model: z.string().optional()`).

  **Must NOT do**: Keep `model` required.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 8 | Blocked By: 6

  **References**:
  - Pattern: `src/types/index.ts:513-521` — `SessionStartInput`.
  - Pattern: `src/validation/schemas.ts:184-192` — `sessionStartInputSchema`.
  - External: `docs/upstream/hooks-reference.md:893-905`.

  **Acceptance Criteria**:
  - [ ] `validateHookInput` accepts a `SessionStart` input without `model`.
  - [ ] `validateHookInput` accepts a `SessionStart` input with `session_title`.
  - [ ] `validateHookInput` rejects a `SessionStart` input with `session_title` of type number.

  **QA Scenarios**:
  ```
  Scenario: SessionStart without model validates
    Tool: Bash
    Steps: tsx -e "import { validateHookInput } from './src/validation/index.js'; validateHookInput({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'SessionStart', source:'clear' });"
    Expected: exit 0, no throw
    Evidence: .omo/evidence/task-7-sessionstart.txt

  Scenario: SessionStart rejects malformed session_title
    Tool: Bash
    Steps: tsx -e "import { validateHookInput } from './src/validation/index.js'; console.log(validateHookInput({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'SessionStart', source:'clear', session_title: 123 }));" 2>&1
    Expected: exits non-zero or throws
    Evidence: .omo/evidence/task-7-invalid-title.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 8. Update `SessionStart` output parity

  **What to do**: In `src/types/index.ts`, extend `SessionStartOutput.hookSpecificOutput` with `initialUserMessage?: string`, `sessionTitle?: string`, `watchPaths?: string[]`, `reloadSkills?: boolean`. Update `sessionStartOutputSchema` in `src/validation/schemas.ts` to match.

  **Must NOT do**: Break the existing `additionalContext` field.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 9 | Blocked By: 7

  **References**:
  - Pattern: `src/types/index.ts:526-532` — `SessionStartOutput`.
  - Pattern: `src/validation/schemas.ts:619-629` — `sessionStartOutputSchema`.
  - External: `docs/upstream/hooks-reference.md:908-927`.

  **Acceptance Criteria**:
  - [ ] `sessionStartOutputSchema.safeParse({ hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'x', watchPaths: ['/a'], reloadSkills: true, initialUserMessage: 'hi' } }).success === true`.
  - [ ] `sessionStartOutputSchema.safeParse({ hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'x', unknownField: 1 } }).success === true` (unknown nested fields are stripped by default Zod `.strip()` behavior).

  **QA Scenarios**:
  ```
  Scenario: SessionStart output accepts new fields
    Tool: Bash
    Steps: pnpm run test:run -- -t "SessionStart output"
    Expected: tests pass
    Evidence: .omo/evidence/task-8-output.txt

  Scenario: SessionStart output strips unknown nested fields
    Tool: Bash
    Steps: tsx -e "import { sessionStartOutputSchema } from './src/validation/schemas.js'; console.log(sessionStartOutputSchema.safeParse({ hook_event_name:'SessionStart', hookSpecificOutput:{ hookEventName:'SessionStart', sessionTitle:'x', unknownField:1 } }).success);"
    Expected: outputs true
    Evidence: .omo/evidence/task-8-strip.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 9. Expand `Notification` and `StopFailure` enums

  **What to do**: In `src/types/index.ts`, add `'elicitation_complete' | 'elicitation_response'` to `NotificationInput.notification_type`. In `src/validation/schemas.ts`, update `notificationInputSchema` enum. In `src/types/index.ts`, add `'overloaded' | 'oauth_org_not_allowed' | 'model_not_found'` to `StopFailureInput.error`. In `src/validation/schemas.ts`, update `stopFailureErrorSchema`.

  **Must NOT do**: Change existing enum ordering in a way that affects inferred types.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 10 | Blocked By: 8

  **References**:
  - Pattern: `src/types/index.ts:421-433` — `NotificationInput`.
  - Pattern: `src/validation/schemas.ts:36-44` — `stopFailureErrorSchema`.
  - External: `docs/upstream/hooks-reference.md:198-208` and `docs/upstream/hooks-reference.md:1878-1891`.

  **Acceptance Criteria**:
  - [ ] `notificationInputSchema` accepts `elicitation_response`.
  - [ ] `stopFailureInputSchema` accepts `oauth_org_not_allowed`.
  - [ ] `notificationInputSchema` rejects a value not in the enum.
  - [ ] `stopFailureErrorSchema` rejects a value not in the enum.

  **QA Scenarios**:
  ```
  Scenario: New enum values validate
    Tool: Bash
    Steps: pnpm run test:run -- -t "Notification|StopFailure"
    Expected: tests pass
    Evidence: .omo/evidence/task-9-enums.txt

  Scenario: Reject invalid enum values
    Tool: Bash
    Steps: tsx -e "import { notificationInputSchema, stopFailureErrorSchema } from './src/validation/schemas.js'; console.log(notificationInputSchema.shape.notification_type.safeParse('not_real').success, stopFailureErrorSchema.safeParse('not_real').success);"
    Expected: outputs false false
    Evidence: .omo/evidence/task-9-invalid-enum.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 10. Add common `effort`/`terminalSequence`, `PostToolUse.duration_ms`, and `PostToolUseOutput.updatedToolOutput`

  **What to do**: Add `effort?: { level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } | undefined` to `BaseHookInput` and `baseHookInputSchema`. Add `terminalSequence?: string | undefined` to `BaseHookOutput` and `baseHookOutputSchema`. Add `duration_ms?: number | undefined` to `PostToolUseInput` and `postToolUseInputSchema`, and to `PostToolUseFailureInput` and `postToolUseFailureInputSchema`. Add `updatedToolOutput?: unknown` to `PostToolUseOutput.hookSpecificOutput` in `src/types/index.ts` and to `postToolUseOutputSchema` in `src/validation/schemas.ts`. Widen `updatedMCPToolOutput` from `Record<string, unknown>` to `unknown` in `PostToolUseOutput` and from `z.record(z.string(), z.unknown())` to `z.unknown()` in `postToolUseOutputSchema`, keeping the field intact.

  **Must NOT do**: Make `effort` or `duration_ms` required; remove `updatedMCPToolOutput`; type `updatedToolOutput` as `Record<string, unknown>`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 11 | Blocked By: 9

  **References**:
  - Pattern: `src/types/index.ts:15-30` — `BaseHookInput`.
  - Pattern: `src/validation/schemas.ts:92-121` — base schemas.
  - Pattern: `src/types/index.ts:112-128` — `PostToolUseOutput`.
  - Pattern: `src/validation/schemas.ts:550-569` — `postToolUseOutputSchema`.
  - Pattern: `src/types/index.ts:695-720` — `PostToolUseFailureInput`.
  - Pattern: `src/validation/schemas.ts:770-790` — `postToolUseFailureInputSchema`.
  - External: `docs/upstream/hooks-reference.md:578-597` (common input), `docs/upstream/hooks-reference.md:714-720` (universal output), `docs/upstream/hooks-reference.md:1651-1653` (`PostToolUse.duration_ms`), `docs/upstream/hooks-reference.md:1715-1723` (`PostToolUseFailure.duration_ms`), `docs/upstream/hooks-reference.md:1655-1687` (`updatedToolOutput`/`updatedMCPToolOutput`).

  **Acceptance Criteria**:
  - [ ] `baseHookInputSchema` accepts `effort: { level: 'high' }`.
  - [ ] `baseHookInputSchema` rejects `effort: { level: 'invalid' }`.
  - [ ] `baseHookOutputSchema` accepts `terminalSequence: '\u001b]777;notify;x;y\u0007'`.
  - [ ] `postToolUseInputSchema` accepts `duration_ms: 12`.
  - [ ] `postToolUseFailureInputSchema` accepts `duration_ms: 4187`.
  - [ ] `postToolUseOutputSchema` accepts `hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { replaced: true } }`.
  - [ ] `postToolUseOutputSchema` accepts `hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: { arbitrary: ['array'] } }` (widened to `unknown`).
  - [ ] `baseHookInputSchema` rejects `effort: { level: 123 }`.

  **QA Scenarios**:
  ```
  Scenario: New common fields validate
    Tool: Bash
    Steps: pnpm run test:run -- -t "common fields"
    Expected: tests pass
    Evidence: .omo/evidence/task-10-common-fields.txt

  Scenario: Reject malformed effort level
    Tool: Bash
    Steps: tsx -e "import { baseHookInputSchema } from './src/validation/schemas.js'; console.log(baseHookInputSchema.safeParse({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'SessionStart', effort:{ level:123 } }).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-10-invalid-effort.txt

  Scenario: PostToolUseOutput accepts updatedToolOutput
    Tool: Bash
    Steps: tsx -e "import { postToolUseOutputSchema } from './src/validation/schemas.js'; console.log(postToolUseOutputSchema.safeParse({ hook_event_name:'PostToolUse', hookSpecificOutput:{ hookEventName:'PostToolUse', updatedToolOutput:{ replaced:true } } }).success);"
    Expected: outputs true
    Evidence: .omo/evidence/task-10-updated-tool-output.txt

  Scenario: PostToolUseFailureInput accepts duration_ms
    Tool: Bash
    Steps: tsx -e "import { postToolUseFailureInputSchema } from './src/validation/schemas.js'; console.log(postToolUseFailureInputSchema.safeParse({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'PostToolUseFailure', tool_name:'Bash', tool_input:{}, tool_use_id:'tu_1', error:'api_error', duration_ms:4187 }).success);"
    Expected: outputs true
    Evidence: .omo/evidence/task-10-failure-duration.txt

  Scenario: updatedMCPToolOutput accepts non-object values after widening
    Tool: Bash
    Steps: tsx -e "import { postToolUseOutputSchema } from './src/validation/schemas.js'; console.log(postToolUseOutputSchema.safeParse({ hook_event_name:'PostToolUse', hookSpecificOutput:{ hookEventName:'PostToolUse', updatedMCPToolOutput:'string value' } }).success);"
    Expected: outputs true
    Evidence: .omo/evidence/task-10-mcp-widened.txt
  ```

  **Commit**: NO (folded into Wave 1 commit)

- [ ] 11. Add `Setup`/`MessageDisplay` validators, type guards, and exports

  **What to do**: Add `isSetupInput`, `isMessageDisplayInput` type guards and `validateSetupInput`, `validateMessageDisplayInput` functions in `src/validation/validators.ts`. Export them from `src/validation/index.ts`. Update `validateHookInput` dispatch to route the new events.

  **Must NOT do**: Skip export updates; use `any`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 19 | Blocked By: 10

  **References**:
  - Pattern: `src/validation/validators.ts:866-925` — existing type guards.
  - Pattern: `src/validation/validators.ts:1122-1134` — `validatePreToolUseInput` pattern.
  - Pattern: `src/validation/index.ts:113-194` — re-export block.

  **Acceptance Criteria**:
  - [ ] `isSetupInput(validatedSetup)` narrows to `SetupInputSchema`.
  - [ ] `validateSetupInput(unknown)` returns `SetupInputSchema`.
  - [ ] `validateMessageDisplayInput(unknown)` returns `MessageDisplayInputSchema`.
  - [ ] `validateSetupInput` rejects an input missing `trigger`.
  - [ ] `grep -R " any" src/validation/validators.ts src/validation/index.ts` returns no new `any` usage after this task.

  **QA Scenarios**:
  ```
  Scenario: New type guards narrow correctly
    Tool: Bash
    Steps: pnpm run test:run -- -t "isSetupInput|isMessageDisplayInput"
    Expected: tests pass
    Evidence: .omo/evidence/task-11-guards.txt

  Scenario: validateSetupInput rejects missing trigger
    Tool: Bash
    Steps: tsx -e "import { validateSetupInput } from './src/validation/index.js'; validateSetupInput({ session_id:'s', transcript_path:'/tmp/t.json', cwd:'/', hook_event_name:'Setup' });" 2>&1
    Expected: exits non-zero or throws
    Evidence: .omo/evidence/task-11-missing-trigger.txt
  ```

  **Commit**: YES | Message: `feat(validation): add Setup and MessageDisplay validators` | Files: `src/validation/validators.ts`, `src/validation/index.ts`

- [ ] 12. Update `HookOutputBuilder` for new outputs and fields

  **What to do**: In `src/utils/output-builder.ts`:
  - Add `setupContext(context: string): SetupOutput` builder.
  - Add `messageDisplayContent(content: string): MessageDisplayOutput` builder.
  - Extend `sessionStartContext(options)` or add a new overload accepting `{ context?, initialUserMessage?, sessionTitle?, watchPaths?, reloadSkills? }` while preserving the existing `(context: string)` signature.
  - Extend `feedback()` to accept an optional `updatedToolOutput?: unknown` parameter (keep `updatedMCPToolOutput`).

  **Must NOT do**: Remove or break existing builder signatures; type `updatedToolOutput` as `Record<string, unknown>`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 14–16 | Blocked By: 2, 3, 7, 8, 10

  **References**:
  - Pattern: `src/utils/output-builder.ts:33-220` — existing builder methods.
  - External: `docs/upstream/hooks-reference.md:908-927`, `docs/upstream/hooks-reference.md:1222-1230`, `docs/upstream/hooks-reference.md:1655-1687`.

  **Acceptance Criteria**:
  - [ ] `HookOutputBuilder.setupContext('x')` returns valid `SetupOutput`.
  - [ ] `HookOutputBuilder.messageDisplayContent('y')` returns valid `MessageDisplayOutput`.
  - [ ] `HookOutputBuilder.sessionStartContext({ sessionTitle: 't', watchPaths: ['/a'], reloadSkills: true, initialUserMessage: 'hi' })` returns valid `SessionStartOutput`.
  - [ ] `HookOutputBuilder.feedback('r', 'ctx', undefined, { replaced: true })` includes `updatedToolOutput: { replaced: true }`.
  - [ ] `HookOutputBuilder.feedback('r', 'ctx')` still works when `updatedToolOutput` is omitted (backward compatibility).

  **QA Scenarios**:
  ```
  Scenario: New builders produce valid output
    Tool: Bash
    Steps: pnpm run test:run -- -t "HookOutputBuilder"
    Expected: tests pass
    Evidence: .omo/evidence/task-12-builder.txt

  Scenario: updatedToolOutput is accepted for built-in tools
    Tool: Bash
    Steps: pnpm run test:run -- -t "updatedToolOutput"
    Expected: tests pass
    Evidence: .omo/evidence/task-12-updated-tool-output.txt

  Scenario: Builder output fails validation when nested hookEventName is wrong
    Tool: Bash
    Steps: tsx -e "import { HookOutputBuilder } from './src/utils/output-builder.js'; import { setupOutputSchema } from './src/validation/schemas.js'; const out = HookOutputBuilder.setupContext('x'); out.hookSpecificOutput.hookEventName = 'WrongEvent'; console.log(setupOutputSchema.safeParse(out).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-12-invalid-output.txt
  ```

  **Commit**: YES | Message: `feat(utils): extend HookOutputBuilder for Setup, MessageDisplay, SessionStart, and updatedToolOutput` | Files: `src/utils/output-builder.ts`

- [ ] 13. Support command hook exec form `args`

  **What to do**: Add `args?: string[]` to `CommandHookHandler` in `src/types/index.ts`. Add `args: z.array(z.string()).optional()` to `commandHookHandlerSchema` in `src/validation/schemas.ts`.

  **Must NOT do**: Require `args`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 19 | Blocked By: —

  **References**:
  - Pattern: `src/types/index.ts:966-976` — `CommandHookHandler`.
  - Pattern: `src/validation/schemas.ts:1113-1124` — `commandHookHandlerSchema`.
  - External: `docs/upstream/hooks-reference.md:321-370`.

  **Acceptance Criteria**:
  - [ ] `validateHookHandler({ type: 'command', command: 'node', args: ['script.js'] })` succeeds.
  - [ ] TypeScript allows `args` on `CommandHookHandler`.
  - [ ] `commandHookHandlerSchema` rejects `args` containing a non-string element.

  **QA Scenarios**:
  ```
  Scenario: Command handler with args validates
    Tool: Bash
    Steps: pnpm run test:run -- -t "commandHookHandlerSchema"
    Expected: tests pass
    Evidence: .omo/evidence/task-13-args.txt

  Scenario: Command handler rejects invalid args
    Tool: Bash
    Steps: tsx -e "import { commandHookHandlerSchema } from './src/validation/schemas.js'; console.log(commandHookHandlerSchema.safeParse({ type:'command', command:'node', args:['ok', 123] }).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-13-invalid-args.txt
  ```

  **Commit**: NO (folded into Wave 2 commit)

- [ ] 14. Create `src/lifecycle/setup.ts` and wire into router

  **What to do**: Create a minimal reference handler `src/lifecycle/setup.ts` that reads `SetupInput` and outputs any `additionalContext` (or exits 0). Wire it into `src/lifecycle/index.ts` under the `'Setup'` case.

  **Must NOT do**: Implement complex logic; `Setup` cannot block.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 21 | Blocked By: 2, 4, 11

  **References**:
  - Pattern: `src/lifecycle/session-start.ts:1-30` — header and executeHook pattern.
  - Pattern: `src/lifecycle/index.ts:68-209` — switch router.

  **Acceptance Criteria**:
  - [ ] `src/lifecycle/setup.ts` exists and compiles.
  - [ ] `src/lifecycle/index.ts` routes `Setup` to the new handler.
  - [ ] The handler exits 0 on valid `Setup` input.

  **QA Scenarios**:
  ```
  Scenario: Setup handler runs via stdin
    Tool: Bash
    Steps: echo '{"hook_event_name":"Setup","session_id":"s","transcript_path":"/tmp/t.json","cwd":"/","trigger":"init"}' | tsx src/lifecycle/setup.ts
    Expected: exit 0, optional context JSON
    Evidence: .omo/evidence/task-14-setup-handler.txt

  Scenario: Setup handler rejects missing trigger
    Tool: Bash
    Steps: echo '{"hook_event_name":"Setup","session_id":"s","transcript_path":"/tmp/t.json","cwd":"/"}' | tsx src/lifecycle/setup.ts
    Expected: exit non-zero
    Evidence: .omo/evidence/task-14-missing-trigger.txt
  ```

  **Commit**: NO (folded into Wave 2 commit)

- [ ] 15. Create `src/lifecycle/message-display.ts` and wire into router

  **What to do**: Create a minimal reference handler `src/lifecycle/message-display.ts` that reads `MessageDisplayInput` and, when no transformation is applied, returns a `MessageDisplayOutput` whose `displayContent` equals the input `delta`. Wire it into `src/lifecycle/index.ts` under the `'MessageDisplay'` case.

  **Must NOT do**: Add blocking logic or matcher handling; require a non-empty `delta`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 21 | Blocked By: 3, 5, 11

  **References**:
  - Pattern: `src/lifecycle/notification-handler.ts:1-30`.
  - Pattern: `src/lifecycle/index.ts:68-209`.

  **Acceptance Criteria**:
  - [ ] `src/lifecycle/message-display.ts` exists and compiles.
  - [ ] `src/lifecycle/index.ts` routes `MessageDisplay` to the new handler.
  - [ ] Piping a valid `MessageDisplay` input with `delta: "hello"` yields an output with `displayContent: "hello"`.

  **QA Scenarios**:
  ```
  Scenario: MessageDisplay handler echoes delta as displayContent
    Tool: Bash
    Steps: echo '{"hook_event_name":"MessageDisplay","session_id":"s","transcript_path":"/tmp/t.json","cwd":"/","turn_id":"550e8400-e29b-41d4-a716-446655440000","message_id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","index":0,"final":false,"delta":"hello"}' | tsx src/lifecycle/message-display.ts
    Expected: exit 0, stdout contains JSON with hookSpecificOutput.displayContent === "hello"
    Evidence: .omo/evidence/task-15-message-display-handler.txt

  Scenario: MessageDisplay handler rejects invalid UUIDs
    Tool: Bash
    Steps: echo '{"hook_event_name":"MessageDisplay","session_id":"s","transcript_path":"/tmp/t.json","cwd":"/","turn_id":"bad","message_id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","index":0,"final":false,"delta":"hello"}' | tsx src/lifecycle/message-display.ts
    Expected: exit non-zero
    Evidence: .omo/evidence/task-15-invalid-uuid.txt
  ```

  **Commit**: NO (folded into Wave 2 commit)

- [ ] 16. Update existing lifecycle handlers for new fields/enums

  **What to do**: Update `src/lifecycle/session-start.ts` to handle optional `model` (default to `'unknown'` when logging). Export `classifyNotification` from `src/lifecycle/notification-handler.ts` and update its switch to handle `elicitation_complete` as `'info'` and `elicitation_response` as `'waiting'`.

  **Must NOT do**: Crash when `model` is absent; change classification of existing notification types.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 21 | Blocked By: 7, 9

  **References**:
  - Pattern: `src/lifecycle/session-start.ts:116-127` — uses `model`.
  - Pattern: `src/lifecycle/notification-handler.ts:158-191` — classify switch.

  **Acceptance Criteria**:
  - [ ] `pnpm run hook:test:session` still passes after `model` becomes optional.
  - [ ] `classifyNotification('', 'elicitation_complete')` returns `'info'`.
  - [ ] `classifyNotification('', 'elicitation_response')` returns `'waiting'`.
  - [ ] `classifyNotification` has an explicit `case` for every value in `notificationInputSchema.shape.notification_type.options`.

  **QA Scenarios**:
  ```
  Scenario: Session start handler tolerates missing model
    Tool: Bash
    Steps: echo '{"hook_event_name":"SessionStart","session_id":"s","transcript_path":"/tmp/t.json","cwd":"/","source":"clear"}' | tsx src/lifecycle/session-start.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-16-session-start.txt

  Scenario: New notification types classify correctly
    Tool: Bash
    Steps: tsx -e "import { classifyNotification } from './src/lifecycle/notification-handler.js'; console.log(classifyNotification('', 'elicitation_complete'), classifyNotification('', 'elicitation_response'));"
    Expected: outputs info waiting
    Evidence: .omo/evidence/task-16-classify.txt

  Scenario: Existing notification classifications are unchanged
    Tool: Bash
    Steps: tsx -e "import { classifyNotification } from './src/lifecycle/notification-handler.js'; console.log(classifyNotification('', 'permission_prompt'), classifyNotification('', 'idle_prompt'), classifyNotification('', 'auth_success'));"
    Expected: outputs permission waiting info
    Evidence: .omo/evidence/task-16-existing-classify.txt
  ```

  **Commit**: NO (folded into Wave 2 commit)

- [ ] 17. Export new inferred schema types

  **What to do**: Add `SetupInputSchema`, `SetupOutputSchema`, `MessageDisplayInputSchema`, `MessageDisplayOutputSchema` inferred type exports in `src/validation/schemas.ts` and re-export them from `src/validation/index.ts`.

  **Must NOT do**: Forget re-exports.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 18 | Blocked By: 4, 5

  **References**:
  - Pattern: `src/validation/schemas.ts:1410-1499` — inferred type exports.
  - Pattern: `src/validation/index.ts:195-297` — type re-exports.

  **Acceptance Criteria**:
  - [ ] `import type { SetupInputSchema, MessageDisplayOutputSchema } from '../src/validation/index.js'` succeeds.
  - [ ] All four new inferred types are exported from `src/validation/index.ts`.
  - [ ] No inferred type names collide with existing exports.

  **QA Scenarios**:
  ```
  Scenario: New inferred types are exported
    Tool: Bash
    Steps: pnpm run type-check
    Expected: exit 0
    Evidence: .omo/evidence/task-17-exports.txt

  Scenario: Reject duplicate export names
    Tool: Bash
    Steps: grep -E "export type (Setup|MessageDisplay)(Input|Output)Schema" src/validation/index.ts | wc -l
    Expected: outputs 4
    Evidence: .omo/evidence/task-17-export-count.txt
  ```

  **Commit**: NO (folded into Wave 2 commit)

- [ ] 18. Add/extend unit tests for new schemas and validators

  **What to do**: In `tests/`:
  - Extend `tests/docs-round-trip.test.ts` to stop skipping `Setup` and `MessageDisplay` input/config examples.
  - Add tests for `Setup`/`MessageDisplay` validation, `SessionStart` optional `model` and new output fields, `effort`, `terminalSequence`, `duration_ms` on both `PostToolUse` and `PostToolUseFailure`, `updatedToolOutput`, `updatedMCPToolOutput` widened to non-object values, and command `args` in `tests/validation.test.ts` and/or `tests/hooks.test.ts`.
  - Use helpers from `tests/test-utils.ts`.

  **Must NOT do**: Use `any`; leave skipped upstream examples for new events.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 19 | Blocked By: 1–17

  **References**:
  - Pattern: `tests/docs-round-trip.test.ts:22-89` — existing skip list and round-trip pattern.
  - Pattern: `tests/validation.test.ts` — existing schema/type tests.
  - Pattern: `tests/hooks.test.ts` — existing hook tests.
  - Pattern: `tests/test-utils.ts:45-90` — input factories.

  **Acceptance Criteria**:
  - [ ] `pnpm run test:run` passes.
  - [ ] No `Setup`/`MessageDisplay` entries remain in the docs-round-trip skip list.
  - [ ] New tests cover each new type/field at least once, including `PostToolUseFailure.duration_ms` and `updatedMCPToolOutput` widening.
  - [ ] `grep -R " any" tests/` returns no new `any` usage after this task.

  **QA Scenarios**:
  ```
  Scenario: Full test suite passes
    Tool: Bash
    Steps: pnpm run test:run
    Expected: exit 0
    Evidence: .omo/evidence/task-18-tests.txt

  Scenario: Docs round-trip covers all 30 input/config events
    Tool: Bash
    Steps: pnpm run test:run -- -t "docs round"
    Expected: tests pass, no skipped new events
    Evidence: .omo/evidence/task-18-roundtrip.txt

  Scenario: New tests reject invalid Setup input
    Tool: Bash
    Steps: pnpm run test:run -- -t "Setup"
    Expected: at least one test asserts rejection of invalid input
    Evidence: .omo/evidence/task-18-rejection.txt
  ```

  **Commit**: YES | Message: `test(hooks): cover Setup, MessageDisplay, SessionStart parity, and common fields` | Files: `tests/docs-round-trip.test.ts`, `tests/validation.test.ts`, `tests/hooks.test.ts`

- [ ] 19. Add output-builder tests for new methods and fields

  **What to do**: Add builder tests in `tests/hooks.test.ts` (or create `tests/output-builder.test.ts` if no existing builder tests) for `setupContext`, `messageDisplayContent`, extended `sessionStartContext`, and `feedback` with `updatedToolOutput`. Ensure outputs validate against their schemas.

  **Must NOT do**: Test with invalid/missing required fields.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: F2 | Blocked By: 12, 18

  **References**:
  - Pattern: `tests/hooks.test.ts` — existing hook/builder tests.
  - Pattern: `src/validation/schemas.ts` — output schemas (`setupOutputSchema`, `postToolUseOutputSchema`, etc.).

  **Acceptance Criteria**:
  - [ ] New builder outputs pass their corresponding output schema (e.g., `setupOutputSchema.safeParse(HookOutputBuilder.setupContext('x')).success === true`).
  - [ ] `feedback` with `updatedToolOutput` serializes correctly.
  - [ ] `feedback` without `updatedToolOutput` still works (backward compatibility).

  **QA Scenarios**:
  ```
  Scenario: Builder outputs validate
    Tool: Bash
    Steps: pnpm run test:run -- -t "HookOutputBuilder"
    Expected: tests pass
    Evidence: .omo/evidence/task-19-builder-tests.txt

  Scenario: Builder rejects invalid hookSpecificOutput at runtime
    Tool: Bash
    Steps: tsx -e "import { HookOutputBuilder } from './src/utils/output-builder.js'; import { setupOutputSchema } from './src/validation/schemas.js'; const out = HookOutputBuilder.setupContext('x'); out.hookSpecificOutput.hookEventName = 'WrongEvent'; console.log(setupOutputSchema.safeParse(out).success);"
    Expected: outputs false
    Evidence: .omo/evidence/task-19-invalid-output.txt
  ```

  **Commit**: NO (folded into task 18 commit or separate if a new builder test file is created)

- [ ] 20. Add lifecycle handler smoke tests

  **What to do**: Add minimal smoke tests in `tests/cli.test.ts` (or create `tests/lifecycle.test.ts` if no suitable existing file) for `src/lifecycle/setup.ts` and `src/lifecycle/message-display.ts` that pipe JSON via stdin, assert exit code 0, and assert expected stdout.

  **Must NOT do**: Block indefinitely; rely on `dist/`.

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: F3 | Blocked By: 14, 15

  **References**:
  - Pattern: `tests/cli.test.ts` — existing CLI/process tests.
  - Pattern: `package.json` `hook:test:*` scripts.

  **Acceptance Criteria**:
  - [ ] `pnpm run test:run` includes setup/message-display smoke tests.
  - [ ] Tests run against `src/` files via `tsx`.
  - [ ] Valid input yields exit code 0 and expected stdout string.
  - [ ] Invalid input yields exit code non-zero.

  **QA Scenarios**:
  ```
  Scenario: Setup handler smoke test
    Tool: Bash
    Steps: pnpm run test:run -- -t "setup handler"
    Expected: exit 0
    Evidence: .omo/evidence/task-20-smoke.txt

  Scenario: MessageDisplay handler rejects invalid UUIDs
    Tool: Bash
    Steps: pnpm run test:run -- -t "message-display handler invalid"
    Expected: test asserts non-zero exit
    Evidence: .omo/evidence/task-20-invalid-smoke.txt
  ```

  **Commit**: NO (folded into task 18 commit)

## Wave 4: Documentation and package metadata

- [ ] 21. Update hook-count references from 28 to 30 and add handler test scripts

  **What to do**: Search for "28 hook events" / "28 events" in `README.md`, `package.json` description, `CLAUDE.md`, and project docs under `docs/` (excluding `docs/upstream/`). Update to 30 and list `Setup` and `MessageDisplay` in summaries. Also add `hook:test:setup` and `hook:test:message-display` scripts to `package.json` alongside the existing `hook:test:*` scripts.

  **Must NOT do**: Update `docs/upstream/` (mirrored upstream; read-only).

  **Recommended Agent Profile**:
  - Category: `quick`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: F4 | Blocked By: 14, 15, 16

  **References**:
  - Pattern: `README.md:1-40`.
  - Pattern: `package.json:1-10` and `package.json:84-86`.
  - Pattern: `docs/README.md`, `docs/guides/*.md`, `docs/reference/*.md`.

  **Acceptance Criteria**:
  - [ ] `grep -R -E "28 (hook|event|events)|all 28" README.md package.json CLAUDE.md docs/ --exclude-dir=upstream || true` returns nothing.
  - [ ] `Setup` and `MessageDisplay` mentioned in supported events list in README and `docs/`.
  - [ ] `docs/upstream/` files are not modified (`git diff --name-only -- docs/upstream | wc -l` outputs 0).
  - [ ] `package.json` contains `hook:test:setup` and `hook:test:message-display` scripts.

  **QA Scenarios**:
  ```
  Scenario: Count references updated
    Tool: Bash
    Steps: grep -R -E "28 (hook|event|events)|all 28" README.md package.json CLAUDE.md docs/ --exclude-dir=upstream || true
    Expected: no matches
    Evidence: .omo/evidence/task-21-count.txt

  Scenario: New events listed in README
    Tool: Bash
    Steps: grep -E "Setup|MessageDisplay" README.md docs/README.md
    Expected: both strings appear in supported events lists
    Evidence: .omo/evidence/task-21-listed.txt

  Scenario: Upstream docs remain untouched
    Tool: Bash
    Steps: git diff --name-only -- docs/upstream | wc -l
    Expected: outputs 0
    Evidence: .omo/evidence/task-21-upstream-unchanged.txt

  Scenario: New handler test scripts exist and run
    Tool: Bash
    Steps: pnpm run hook:test:setup && pnpm run hook:test:message-display
    Expected: both exit 0
    Evidence: .omo/evidence/task-21-scripts.txt
  ```

  **Commit**: YES | Message: `docs: update hook count references to 30, list new events, and add handler test scripts` | Files: `README.md`, `package.json`, `CLAUDE.md`, `docs/README.md`, `docs/guides/getting-started.md`, `docs/guides/writing-your-first-hook.md`, `docs/guides/cookbook.md`, `docs/reference/hook-events.md`, `docs/reference/types.md`

- [ ] 22. Add CHANGELOG entry

  **What to do**: Add a `CHANGELOG.md` entry under the upcoming version with explicit bullets for: `Setup` and `MessageDisplay` events, `SessionStart` input/output parity, `Notification`/`StopFailure` enum expansions, `CommandHookHandler.args`, `PostToolUseOutput.updatedToolOutput`, `PostToolUseOutput.updatedMCPToolOutput` widened to `unknown`, `PostToolUseInput.duration_ms` and `PostToolUseFailureInput.duration_ms`, and `BaseHookInput.effort` / `BaseHookOutput.terminalSequence`.

  **Must NOT do**: Bump version.

  **Recommended Agent Profile**:
  - Category: `unspecified-low`.
  - Skills: none special.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: — | Blocked By: —

  **References**:
  - Pattern: `CHANGELOG.md:1-20`.

  **Acceptance Criteria**:
  - [ ] CHANGELOG entry contains the strings `Setup`, `MessageDisplay`, `SessionStart`, `updatedToolOutput`, `updatedMCPToolOutput`, `args`, `effort`, `terminalSequence`, `duration_ms`, and `PostToolUseFailure`.
  - [ ] `package.json` version is unchanged.

  **QA Scenarios**:
  ```
  Scenario: CHANGELOG updated with all user-visible changes
    Tool: Bash
    Steps: for term in Setup MessageDisplay SessionStart updatedToolOutput updatedMCPToolOutput args effort terminalSequence duration_ms PostToolUseFailure; do grep -q "$term" CHANGELOG.md && echo "$term OK"; done
    Expected: all terms report OK
    Evidence: .omo/evidence/task-22-changelog.txt

  Scenario: Version not bumped
    Tool: Bash
    Steps: git diff package.json | grep '"version"' || true
    Expected: no diff
    Evidence: .omo/evidence/task-22-version.txt
  ```

  **Commit**: YES | Message: `docs: add CHANGELOG entry for Claude Code API parity` | Files: `CHANGELOG.md`

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> Do NOT auto-proceed after verification. Wait for user's explicit approval.

- [ ] F1. Plan Compliance Audit — oracle

  **What to do**: Verify that every implementation task references an existing file path, every acceptance criterion is agent-executable, and no business-logic assumption remains ungrounded. Confirm that all 30 hook events are represented in the plan and that the scope boundaries (Must NOT Have) are respected.

  **Must NOT do**: Run code; this is a plan-only audit.

  **Recommended Agent Profile**:
  - Category: `unspecified-high`.
  - Agent: `oracle`.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: completion | Blocked By: 1–22

  **Acceptance Criteria**:
  - [ ] Verdict returned as `VERDICT: GO`.
  - [ ] Any NO-GO issues are fixed and re-verified before proceeding.

  **QA Scenarios**:
  ```
  Scenario: Oracle confirms plan completeness
    Tool: task(subagent_type="oracle")
    Steps: pass .omo/plans/claude-code-api-gap.md to oracle
    Expected: VERDICT: GO
    Evidence: .omo/evidence/F1-oracle.txt
  ```

- [ ] F2. Code Quality Review — unspecified-high

  **What to do**: After implementation, review changed source files for lint/type errors, adherence to the "no any" rule, consistent naming, and minimal diff size. Ensure new files follow the existing header/module pattern.

  **Must NOT do**: Skip checking `src/lifecycle/setup.ts`, `src/lifecycle/message-display.ts`, and `src/utils/output-builder.ts`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high`.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: completion | Blocked By: 1–22

  **Acceptance Criteria**:
  - [ ] `pnpm run check` passes.
  - [ ] No `any` types introduced.
  - [ ] Reviewer provides APPROVE verdict.

  **QA Scenarios**:
  ```
  Scenario: Static checks pass
    Tool: Bash
    Steps: pnpm run check
    Expected: exit 0
    Evidence: .omo/evidence/F2-check.txt
  ```

- [ ] F3. Real Manual QA — unspecified-high

  **What to do**: Run the full test suite, execute the new handler scripts via stdin with sample upstream JSON, and confirm `docs-round-trip.test.ts` no longer skips `Setup`/`MessageDisplay`.

  **Must NOT do**: Trust partial test runs.

  **Recommended Agent Profile**:
  - Category: `unspecified-high`.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: completion | Blocked By: 1–22

  **Acceptance Criteria**:
  - [ ] `pnpm run test:run` passes.
  - [ ] `pnpm run hook:test:session` passes.
  - [ ] New handler scripts exit 0 on valid input.

  **QA Scenarios**:
  ```
  Scenario: End-to-end tests pass
    Tool: Bash
    Steps: pnpm run test:run && pnpm run check
    Expected: exit 0
    Evidence: .omo/evidence/F3-tests.txt
  ```

- [ ] F4. Scope Fidelity Check — deep

  **What to do**: Compare the merged branch against the original request and the Must Have/Must NOT Have list. Run the concrete enforcement checks listed in the Must NOT Have section.

  **Must NOT do**: Approve scope creep.

  **Recommended Agent Profile**:
  - Category: `deep`.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: completion | Blocked By: 1–22

  **Acceptance Criteria**:
  - [ ] All Must Have items are addressed.
  - [ ] No Must NOT Have items are violated.
  - [ ] Changed files are within the allowed set (`git diff --name-only | grep -vE '^(src/(types|validation|utils|lifecycle)/|tests/|docs/|README\.md|package\.json|CLAUDE\.md|CHANGELOG\.md)$' | wc -l` outputs 0).
  - [ ] Upstream docs are untouched (`git diff --name-only -- docs/upstream | wc -l` outputs 0).
  - [ ] No new explicit `any` in changed TS files (`git diff -- src/ tests/ | grep -E '^\+.*\bany\b' | wc -l` outputs 0).
  - [ ] No newly added `.passthrough()` (`git diff -- src/validation/schemas.ts | grep '^\+\s*\.passthrough()' | wc -l` outputs 0).
  - [ ] `package.json` version is unchanged (`git diff package.json | grep '"version"'` returns empty).
  - [ ] Reviewer provides APPROVE verdict.

  **QA Scenarios**:
  ```
  Scenario: Scope diff check
    Tool: Bash
    Steps: |
      echo "Unexpected files:" && git diff --name-only | grep -vE '^(src/(types|validation|utils|lifecycle)/|tests/|docs/|README\.md|package\.json|CLAUDE\.md|CHANGELOG\.md)$' || true
      echo "Upstream docs changed:" && git diff --name-only -- docs/upstream | wc -l
      echo "New any count:" && git diff -- src/ tests/ | grep -E '^\+.*\bany\b' | wc -l
      echo "New passthrough count:" && git diff -- src/validation/schemas.ts | grep '^\+\s*\.passthrough()' | wc -l
    Expected: unexpected files = 0; upstream docs changed = 0; new any = 0; new passthrough = 0
    Evidence: .omo/evidence/F4-scope.txt
  ```

## Commit Strategy

- One commit per wave, each with a clean `type(scope): desc` message.
- Wave 1: `feat(types): add Setup, MessageDisplay, and upstream field parity`
- Wave 2: `feat(utils,validation,lifecycle): validators, builders, and handlers for new hook surface`
- Wave 3: `test(hooks): regression tests for 30-event API parity`
- Wave 4: `docs: update event counts and references for 30 hook events`
- Wave 5 verification results are reported but not committed.

## Success Criteria

- `pnpm run test:run` exits 0 with no skipped docs-round-trip examples.
- `pnpm run check` exits 0.
- All 30 hook event names are importable and valid in `HooksConfig`.
- `Setup` and `MessageDisplay` examples from `docs/upstream/hooks-reference.md` pass `validateHookInput`.
- Backward compatibility: existing callers of `HookOutputBuilder.permission`, `feedback`, `sessionStartContext`, and `sessionTitle` still compile.
