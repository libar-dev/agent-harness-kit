# API Update Checklist

Tracking updates needed to align this library with the current Claude Code hooks API (as of Feb 2026).

Reference docs:
- `docs/upstream/hooks-reference.md` (canonical source of truth)
- `docs/upstream/hooks-guide.md`
- `docs/upstream/settings.md`

---

## Phase 1: Fix Critical Type/Schema Issues

These are breaking mismatches — the library will reject or misparse valid hook input.

### Types (`src/types/index.ts`)

- [x] **1.1** Add `permission_mode` to `BaseHookInput` ✅
- [x] **1.2** Fix `SessionStartInput` — added `model`, `agent_type` ✅
- [x] **1.3** Fix `SessionEndInput` — added `bypass_permissions_disabled` to reason union ✅
- [x] **1.4** Add `tool_use_id` to `PreToolUseInput` ✅
- [x] **1.5** Add `tool_use_id` to `PostToolUseInput` ✅
- [x] **1.6** Update `SubagentStopInput` — added `agent_id`, `agent_type`, `agent_transcript_path` ✅
- [x] **1.7** Update `NotificationInput` — added `title?`, `notification_type` ✅

### Zod Schemas (`src/validation/schemas.ts`)

- [x] **1.8** Add `permission_mode` to `baseHookInputSchema` ✅
- [x] **1.9** Fix `sessionStartInputSchema` — removed fabricated `sessionMetadata`, added `source`, `model`, `agent_type` ✅
- [x] **1.10** Fix `sessionEndInputSchema` — removed fabricated `sessionSummary`, added `reason` enum ✅
- [x] **1.11** Fix `userPromptSubmitInputSchema` — removed fabricated `context` field ✅
- [x] **1.12** Add `tool_use_id` to `preToolUseInputSchema` and `postToolUseInputSchema` ✅
- [x] **1.13** Add missing Zod schemas: `notificationInputSchema`, `stopInputSchema`, `subagentStopInputSchema`, `preCompactInputSchema` ✅
- [x] **1.14** Update `hookInputSchemas` collection — now includes all 9 event types ✅

### Tests

- [x] **1.15** Update existing tests + add new test block `'Updated Schema Validation (Phase 1)'` ✅
- [x] **1.16** Verify `pnpm run type-check` passes ✅
- [x] **1.17** Verify `pnpm run test:run` passes — 71/71 tests pass ✅

### Additional work discovered during Phase 1

- [x] **1.18** Fix `tests/hooks.test.ts` local helpers — missing `permission_mode` and `tool_use_id` ✅
- [x] **1.19** Add type guards for new events in `src/validation/validators.ts` — `isNotificationInput`, `isStopInput`, `isSubagentStopInput`, `isPreCompactInput`, `isSessionStartInput`, `isSessionEndInput`, `isUserPromptSubmitInput` ✅
- [x] **1.20** Update `src/validation/index.ts` re-exports for all new schemas, types, and type guards ✅
- [x] **1.21** Add test factories in `tests/test-utils.ts` — `createSessionStartInput`, `createSessionEndInput`, `createNotificationInput`, `createStopInput`, `createSubagentStopInput`, `createPreCompactInput` ✅
- [x] **1.22** Clean stale `.js`/`.js.map`/`.d.ts` files from `src/` — caused runtime resolution to bypass `.ts` sources ✅

### Phase 1 Notes

- **`.passthrough()` not used**: Initially planned to add `.passthrough()` to all schemas for forward-compatibility with unknown fields. However, Zod's `.passthrough()` adds `{ [k: string]: unknown }` index signatures to inferred types, which are structurally incompatible with the manual TypeScript interfaces in `src/types/index.ts`. Since hook implementations pass interface types to validators, this caused TS2345 errors across 8+ files. Decision: keep default `.strip()` behavior. Future work could unify the dual type system to remove this constraint.
- **Dual type system**: The library maintains both manual interfaces (`src/types/index.ts`) AND Zod-inferred types (`src/validation/schemas.ts`). These must stay in sync manually. Phase 2+ should consider whether to consolidate.
- **Pre-existing lint issues**: `pnpm run lint` shows 93 errors / 180 warnings, all pre-existing in files not modified by Phase 1 (e.g., `notification-handler.ts`, `pre-compact.ts`, `hooks.test.ts`). A dedicated lint cleanup pass is recommended.

---

## Phase 2: Add New Event Types

5 new hook events that don't exist in the library at all.

### `PermissionRequest` (fires when permission dialog appears)

- [x] **2.1** Add `PermissionRequestInput` interface ✅
  - Fields: `tool_name: string`, `tool_input: Record<string, unknown>`, `permission_suggestions?: Array<{ type: string; tool: string }>`
  - Note: no `tool_use_id` (unlike PreToolUse)

- [x] **2.2** Add `PermissionRequestOutput` interface ✅
  - Uses `hookSpecificOutput.decision` with `behavior: 'allow' | 'deny'`
  - Allow: optional `updatedInput`, `updatedPermissions`
  - Deny: optional `message: string`, `interrupt: boolean`

- [x] **2.3** Add Zod schemas for PermissionRequest input/output ✅
  - Uses `z.discriminatedUnion('behavior', ...)` for allow/deny variants

### `PostToolUseFailure` (fires when tool execution fails)

- [x] **2.4** Add `PostToolUseFailureInput` interface ✅
  - Fields: `tool_name`, `tool_input`, `tool_use_id`, `error: string`, `is_interrupt?: boolean`

- [x] **2.5** Add `PostToolUseFailureOutput` interface ✅
  - Uses top-level `decision`/`reason` + `hookSpecificOutput.additionalContext`

- [x] **2.6** Add Zod schemas for PostToolUseFailure input/output ✅

### `SubagentStart` (fires when subagent is spawned)

- [x] **2.7** Add `SubagentStartInput` interface ✅
  - Fields: `agent_id: string`, `agent_type: string`

- [x] **2.8** Add `SubagentStartOutput` interface ✅
  - Uses `hookSpecificOutput.additionalContext`

- [x] **2.9** Add Zod schemas for SubagentStart input/output ✅

### `TeammateIdle` (agent teams — fires when teammate about to go idle)

- [x] **2.10** Add `TeammateIdleInput` interface ✅
  - Fields: `teammate_name: string`, `team_name: string`
  - Decision: exit code only (no JSON decision control)

- [x] **2.11** Add Zod schema for TeammateIdle input ✅

### `TaskCompleted` (agent teams — fires when task marked complete)

- [x] **2.12** Add `TaskCompletedInput` interface ✅
  - Fields: `task_id: string`, `task_subject: string`, `task_description?: string`, `teammate_name?: string`, `team_name?: string`
  - Decision: exit code only (no JSON decision control)

- [x] **2.13** Add Zod schema for TaskCompleted input ✅

### Union types and tool inputs

- [x] **2.14** Update `HookInput` union to include all new input types ✅
- [x] **2.15** Update `HookOutput` union to include all new output types ✅
- [x] **2.16** Add missing tool input types: `WebFetchToolInput`, `WebSearchToolInput`, `TaskToolInput` ✅
- [x] **2.17** Add Zod schemas for new tool inputs ✅
- [x] **2.18** Update `hookInputSchemas` and `hookOutputSchemas` collections ✅
- [x] **2.19** Update `toolInputSchemas` collection ✅

### Additional work discovered during Phase 2

- [x] **2.20** Add 5 type guards: `isPermissionRequestInput`, `isPostToolUseFailureInput`, `isSubagentStartInput`, `isTeammateIdleInput`, `isTaskCompletedInput` ✅
- [x] **2.21** Add 3 tool input validators: `validateWebFetchToolInput`, `validateWebSearchToolInput`, `validateTaskToolInput` ✅
- [x] **2.22** Update `src/validation/index.ts` re-exports for all new schemas, types, guards, validators ✅
- [x] **2.23** Add 5 event factories + 3 tool input factories in `tests/test-utils.ts` ✅
- [x] **2.24** Add Phase 2 test suite (new event schemas, output schemas, type guards, tool validators) — 37 new tests ✅
- [x] **2.25** Verify `pnpm run type-check` passes ✅
- [x] **2.26** Verify `pnpm run test:run` passes — 174/174 tests pass ✅
- [x] **2.27** Verify `pnpm run lint` passes ✅

### Phase 2 Notes

- **PermissionRequest output structure** is unique among all events: uses a nested `decision` object inside `hookSpecificOutput` with a `behavior` discriminant (`'allow' | 'deny'`). Zod models this with `z.discriminatedUnion('behavior', ...)`.
- **TeammateIdle and TaskCompleted** use exit code only for decisions — no custom output schemas. They reference `baseHookOutputSchema` in `hookOutputSchemas` since they can still return the universal fields (`continue`, `stopReason`, etc.).
- **PostToolUseFailure** follows the same pattern as PostToolUse and Stop: top-level `decision: "block"` / `reason` + `hookSpecificOutput.additionalContext`.
- **Dual type system sync**: Manual interfaces in `types/index.ts` and Zod-inferred types in `schemas.ts` remain in sync. The Phase 1 constraint (no `.passthrough()`) still applies.
- **Pre-existing gap**: Glob, Grep, MultiEdit interfaces in `types/index.ts` still lack Zod schemas — not addressed in Phase 2.

---

## Phase 3: Update Output Types and HookOutputBuilder

Existing output types are missing new fields.

### PreToolUse output enhancements

- [x] **3.1** Add `updatedInput` to `PreToolUseOutput.hookSpecificOutput` ✅
  - Type: `Record<string, unknown>` — modifies tool params before execution

- [x] **3.2** Add `additionalContext` to `PreToolUseOutput.hookSpecificOutput` ✅
  - Type: `string` — added to Claude's context before tool executes

- [x] **3.3** Update PreToolUse Zod output schema ✅

### PostToolUse output enhancements

- [x] **3.4** Add `updatedMCPToolOutput` to `PostToolUseOutput.hookSpecificOutput` ✅
  - For MCP tools only: replaces the tool's output

- [x] **3.5** `additionalContext` already exists inside `PostToolUseOutput.hookSpecificOutput` ✅
  - Note: Original checklist said "top-level, alongside decision" but official reference shows it inside `hookSpecificOutput`. Current code was already correct.

- [x] **3.6** Update PostToolUse Zod output schema ✅

### Notification output

- [x] **3.7** Add `NotificationOutput` interface to `src/types/index.ts` and include in `HookOutput` union ✅
  - Note: Zod schema `notificationOutputSchema` already existed from Phase 2. This added the missing manual TypeScript interface.

### HookOutputBuilder updates

- [x] **3.8** Update `permission()` to accept optional `updatedInput` and `additionalContext` ✅
- [x] **3.9** Update `feedback()` to accept optional `updatedMCPToolOutput` ✅
- [x] **3.10** Add `allowPermission()` / `denyPermission()` builders for PermissionRequest decisions ✅
  - Split into two methods (not one `permissionRequest()`) because the allow/deny variants have different optional fields (discriminated union)
- [x] **3.11** Add `subagentContext()` builder for SubagentStart context injection ✅
- [x] **3.12** Add `sessionStartContext()` builder for SessionStart context injection ✅

### Tests

- [x] **3.13** Add Phase 3 test suite — 29 new tests (203 total, up from 174 after Phase 2) ✅
- [x] **3.14** Verify `pnpm run type-check` passes ✅
- [x] **3.15** Verify `pnpm run test:run` passes — 203/203 tests pass ✅
- [x] **3.16** Verify `pnpm run lint` passes ✅

### Phase 3 Notes

- **3.5 was already done**: The original checklist described `additionalContext` as "top-level" for PostToolUse, but the official docs (`docs/upstream/hooks-reference.md`) show it inside `hookSpecificOutput`. The existing code was already correct.
- **NotificationOutput dual system**: The Zod schema `notificationOutputSchema` existed from Phase 2, but the corresponding TypeScript interface was missing from `types/index.ts`. Phase 3 added it and included it in the `HookOutput` union.
- **Builder naming**: Used `allowPermission()` / `denyPermission()` instead of a single `permissionRequest()` method because the discriminated union makes a single method awkward (allow and deny have completely different option sets).
- **Backward compatibility**: All builder signature changes are additive (new optional parameters). Existing callers of `permission()` and `feedback()` continue to work without changes.

---

## Phase 4: Documentation and Cleanup

Several Phase 4 items were completed during Phase 2 and 3:
- **4.1** ✅ Done in Phase 2 — validators for all new event types added
- **4.2** ✅ N/A — `src/utils/validators.ts` does not exist as a `.ts` file (only stale `.d.ts.map`)
- **4.3** ✅ Done in Phase 2 (input schemas) and Phase 3 (output schemas)
- **4.4** ✅ Done in Phase 2 — type guard tests for all new validators
- **4.5** ✅ Done in Phase 2 — all factory functions added
- **4.6** ✅ Done in Phase 3 — 203/203 tests, type-check clean, lint clean

Remaining: None — all items complete.

- [x] **4.7** Update CLAUDE.md — reflect new event types, builder methods, and pattern changes ✅
- [x] **4.8** Update README.md — add new hooks to the available hooks section ✅

---

## Phase 5: Hook Handler Config Types (Optional, Can Defer)

Types for the hook configuration schema itself (what goes in settings.json).

- [x] **5.1** Add types for hook handler variants ✅
  - `CommandHookHandler`: `{ type: 'command'; command: string; async?: boolean; timeout?: number; statusMessage?: string; once?: boolean }`
  - `PromptHookHandler`: `{ type: 'prompt'; prompt: string; model?: string; timeout?: number; statusMessage?: string; once?: boolean }`
  - `AgentHookHandler`: `{ type: 'agent'; prompt: string; model?: string; timeout?: number; statusMessage?: string; once?: boolean }`

- [x] **5.2** Add types for matcher groups and hook config structure ✅
  - `HookEventName` (union of 14 string literals), `HookHandler` (discriminated union), `MatcherGroup`, `HooksConfig`

- [x] **5.3** Add Zod schemas for hook configuration validation ✅
  - `commandHookHandlerSchema`, `promptHookHandlerSchema`, `agentHookHandlerSchema`, `hookHandlerSchema` (discriminatedUnion)
  - `matcherGroupSchema`, `hookEventNameSchema`, `hooksConfigSchema`
  - `validateHooksConfig()`, `validateHookHandler()`, `validateMatcherGroup()` validators
  - 29 new tests for hook config schemas

- [x] **5.4** Document `$CLAUDE_CODE_REMOTE` env var ✅
  - Added `HookEnvironmentVars` interface to `src/types/index.ts` with JSDoc documentation

- [x] **5.5** Document `CLAUDE_ENV_FILE` ✅
  - Added to `HookEnvironmentVars` interface with documentation that it's SessionStart-only

### Additional work discovered during Phases 4–5

- [x] **5.6** Delete stale `src/utils/validators.d.ts.map` — build artifact missed during Phase 1 cleanup ✅
- [x] **5.7** Add Glob/Grep/MultiEdit Zod schemas — Phase 2 gap (interfaces existed but lacked schemas) ✅
  - `globToolInputSchema`, `grepToolInputSchema`, `multiEditToolInputSchema`
  - `validateGlobToolInput()`, `validateGrepToolInput()`, `validateMultiEditToolInput()` validators
  - 13 new tests for tool input schemas
- [x] **5.8** Fix `hooksConfigSchema` — initial `z.record(hookEventNameSchema, ...)` required ALL 14 keys; changed to `z.object` with dynamically generated optional keys ✅
- [x] **5.9** Verify full suite: type-check ✅, 245/245 tests ✅, lint ✅

---

## Completed

### Phases 4 & 5 — 2026-02-16

All Phase 4 items (2) and Phase 5 items (5) + 4 discovered items completed. Files modified:
- `src/utils/validators.d.ts.map` — Deleted stale build artifact
- `src/types/index.ts` — Added `HookEventName`, `CommandHookHandler`, `PromptHookHandler`, `AgentHookHandler`, `HookHandler`, `MatcherGroup`, `HooksConfig`, `HookEnvironmentVars`
- `src/validation/schemas.ts` — Added `globToolInputSchema`, `grepToolInputSchema`, `multiEditToolInputSchema`; added `commandHookHandlerSchema`, `promptHookHandlerSchema`, `agentHookHandlerSchema`, `hookHandlerSchema`, `matcherGroupSchema`, `hookEventNameSchema`, `hooksConfigSchema`; updated `toolInputSchemas` collection; added 10 inferred type exports
- `src/validation/validators.ts` — Added `validateGlobToolInput`, `validateGrepToolInput`, `validateMultiEditToolInput`, `validateHooksConfig`, `validateHookHandler`, `validateMatcherGroup`
- `src/validation/index.ts` — Updated re-exports for all new schemas, types, and validators
- `tests/validation.test.ts` — Added 42 new tests (245 total, up from 203 after Phase 3)
- `CLAUDE.md` — Rewritten to reflect 14 hook events, all builder methods, validation directory, hook config validation
- `README.md` — Updated project structure, added new event types section, fixed duplicate headers, updated examples

### Phase 3 — 2026-02-16

All 12 original items + 4 discovered items completed. Files modified:
- `src/types/index.ts` — Added `updatedInput`, `additionalContext` to PreToolUseOutput; added `updatedMCPToolOutput` to PostToolUseOutput; added `NotificationOutput` interface; updated `HookOutput` union
- `src/validation/schemas.ts` — Updated `preToolUseOutputSchema` (added `updatedInput`, `additionalContext`); updated `postToolUseOutputSchema` (added `updatedMCPToolOutput`)
- `src/utils/output-builder.ts` — Updated `permission()` with options param; updated `feedback()` with `updatedMCPToolOutput` param; added `allowPermission()`, `denyPermission()`, `subagentContext()`, `sessionStartContext()`
- `tests/validation.test.ts` — Added 29 new tests (203 total, up from 174 after Phase 2)

### Phase 2 — 2026-02-16

All 19 original items + 8 discovered items completed. Files modified:
- `src/types/index.ts` — Added 5 input interfaces, 3 output interfaces, 3 tool input interfaces, updated HookInput/HookOutput unions
- `src/validation/schemas.ts` — Added 5 input schemas, 3 output schemas, 3 tool input schemas, updated all 3 collections, added 11 inferred types, updated HookInputSchema/ToolInputSchema unions
- `src/validation/validators.ts` — Added 5 type guards, 3 tool input validators
- `src/validation/index.ts` — Updated re-exports for all new schemas, types, guards, validators
- `tests/test-utils.ts` — Added 5 event factories, 3 tool input factories
- `tests/validation.test.ts` — Added 37 new tests (174 total, up from 71 after Phase 1)

### Phase 1 — 2026-02-16

All 17 original items + 5 discovered items completed. Files modified:
- `src/validation/schemas.ts` — Fixed base schema, 3 event schemas, added 4 new schemas, updated collections + type exports
- `src/types/index.ts` — Added/fixed fields on 7 interfaces
- `src/validation/validators.ts` — Added 7 type guard functions
- `src/validation/index.ts` — Updated re-exports for all new schemas, types, guards
- `tests/test-utils.ts` — Fixed 3 factories, added 6 new factories
- `tests/validation.test.ts` — Added 9 new tests for updated schemas
- `tests/hooks.test.ts` — Fixed local helpers for new required fields
- `src/**/*.js` + `src/**/*.d.ts` — Deleted stale compiled files that shadowed `.ts` sources
