# Context

The checked-in Claude Code documentation mirrors were last refreshed in June 2026, while `docs/internal/api-update-checklist.md` is a closed February 2026 migration log that still describes a 14-event API. The library has since grown to 30 hook events and additional handler/output surfaces, so the mirrors, exported TypeScript contracts, Zod schemas, bundled handlers, tests, and project-authored documentation need a fresh authoritative audit.

The intended result is parity with the current Claude Code APIs that this hooks library actually exposes: hook event I/O, hook-specific settings/handlers, hook-provided environment variables, modeled tool inputs, output builders/reference handlers, and existing transcript-processing contracts. Full unrelated Claude Code settings, general CLI flag parsing, and headless stream protocols remain audit-only unless they affect an existing exported API.

## Implementation Plan

1. **Run the task through a dynamic Workflow controller.**
   - Use Workflow phases for baseline/sync, parallel gap analysis, sequential implementation, verification, and final adversarial review.
   - Dynamically add focused audit/repair agents only for categories changed by the refreshed docs.
   - Keep all workflow findings in the harness; do not create or commit scratch reports, plans, or agent-context files.
   - Do not commit or push unless separately requested.

2. **Guard the baseline and refresh all upstream mirrors.**
   - Confirm the working tree has no unexpected changes before mutation.
   - Run `pnpm run docs:sync-upstream`, using `scripts/sync-upstream-docs.mjs` unchanged unless it fails to retrieve the official Markdown endpoints.
   - Validate the complete five-file set before analysis:
     - `docs/upstream/hooks-reference.md`
     - `docs/upstream/hooks-guide.md`
     - `docs/upstream/settings.md`
     - `docs/upstream/cli-reference.md`
     - `docs/upstream/headless.md`
   - Treat a partial fetch as invalid; resolve and rerun the full sync before continuing.

3. **Build a post-sync delta matrix and enforce scope.**
   - Compare the refreshed docs with their previous git versions and with current exported contracts.
   - Audit in parallel by category: hook I/O, hook settings/handler restrictions, modeled tool inputs, hook environment variables, output builders/reference handlers, transcript/headless overlap, and project-doc drift.
   - Classify each finding as implementation, documentation-only, audit-only, or out of scope.
   - Implement only claims substantiated by the refreshed official docs. Initial queries include common fields such as `prompt_id`; Notification literals/output semantics; Stop/SubagentStop background task, cron, and context fields; current Agent/ExitPlanMode tool inputs; `disableAllHooks`; event-specific handler support; hook-provided variables such as `CLAUDE_PLUGIN_DATA`, `CLAUDE_EFFORT`, and `CLAUDE_CODE_BRIDGE_SESSION_ID`; and timeout/matcher behavior.
   - Do not model the entire settings schema, every Claude CLI flag, or non-persisted headless stream events without an existing library surface.

4. **Update public manual contracts first.**
   - Modify `src/types/index.ts` for every confirmed hook/tool/settings/environment delta.
   - Preserve optionality for version-gated fields so older valid Claude Code payloads remain accepted.
   - Reuse shared exported interfaces for repeated structures rather than duplicating inline object types.
   - Preserve broad public `HookHandler` and `MatcherGroup` primitives while adding event-aware helper types if the current docs restrict handler kinds per event.
   - Preserve existing exported symbols when correcting their shape, and add API-contract JSDoc to every new or changed public declaration.

5. **Mirror the contract exactly in runtime validation.**
   - Update `src/validation/schemas.ts` in lockstep with the manual interfaces, including event collections, tool schemas, hook settings, and output schemas.
   - Retain default Zod strip behavior for hook/tool/settings contracts; do not add broad `.passthrough()` because it breaks the manual/Zod structural contract. Keep loose schemas only where transcript forward preservation is intentional.
   - If event-specific handler restrictions are confirmed, keep standalone `hookHandlerSchema`/`matcherGroupSchema` broad but make `hooksConfigSchema` validate handlers against the selected event.
   - Review `src/validation/validators.ts`, `src/validation/index.ts`, and `src/index.ts` for changed validators, inferred types, guards, and exports; rely on existing schema dispatch where no dedicated code is needed.

6. **Restore builder and reference-handler parity.**
   - Update `src/utils/output-builder.ts` only for confirmed output contracts, using distinct helpers for semantically different outputs rather than misleading casts or reused event names.
   - Audit `src/lifecycle/stop-handler.ts`, `src/lifecycle/subagent-stop.ts`, `src/lifecycle/notification-handler.ts`, and any other directly affected handler.
   - Keep compatibility aliases where practical, document their actual behavior, and avoid unrelated lifecycle refactors.

7. **Strengthen regression coverage.**
   - Update `tests/test-utils.ts`, `tests/validation.test.ts`, `tests/output-builder.test.ts`, lifecycle/hook tests, and package-export tests for all confirmed deltas and compatibility cases.
   - Add focused bidirectional `expectTypeOf` checks between manual interfaces and `z.infer` contracts for changed public shapes.
   - Enhance `tests/docs-round-trip.test.ts` so it:
     - validates hook input examples,
     - validates hook-specific output examples with section context,
     - validates hook-related settings snippets from `settings.md`,
     - compares the official lifecycle event inventory with `hookEventNameSchema.options`, and
     - retains explicit, self-invalidating skip rules only for intentionally abbreviated or non-JSON examples.
   - Do not validate unrelated full-settings examples or add stream-only records to persisted transcript types without evidence.

8. **Refresh project documentation and the maintainer checklist.**
   - Audit and update representative public docs: `docs/guides/configuring-settings-json.md`, `docs/reference/{hook-events,types,validators,output-builder,environment-variables}.md`, `README.md`, `CLAUDE.md`, and `CHANGELOG.md` when the public API changes.
   - Fix known stale claims such as the settings guide’s 28-event inventory and ensure all event/tool counts are consistent with the canonical schemas.
   - Replace `docs/internal/api-update-checklist.md` with a current repeatable audit document containing:
     - audit date and sync command/source URLs,
     - explicit in-scope and excluded surfaces,
     - canonical event/tool/handler inventory,
     - confirmed delta/status table,
     - compatibility decisions,
     - verification results, and
     - the next-audit procedure: sync → diff → classify → implement → verify.
   - Rely on git history for the obsolete February phase narrative rather than retaining it as the active checklist.

## Verification

1. Run targeted tests for docs round-trip, validation/type parity, output builders, affected lifecycle handlers, processing contracts if touched, and package exports.
2. Run the full gates:
   - `pnpm run test:run`
   - `pnpm run type-check`
   - `pnpm run lint`
   - `pnpm run build`
3. Inspect generated declarations under `dist/types` and `dist/validation` after the build; do not hand-edit `dist`.
4. Run `git diff --check` and search project-authored docs for stale event/tool counts or removed contract claims.
5. Use a final workflow review to verify that every implemented field is supported by the refreshed official docs, every changed manual type matches its Zod schema, and no unrelated full-settings/CLI/headless scope or ephemeral workflow artifacts entered the diff.
