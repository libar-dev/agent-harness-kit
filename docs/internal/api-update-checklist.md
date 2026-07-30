# Claude Code Hook API Audit

## Audit metadata

- Audit date: 2026-07-12
- Scope baseline: working-tree source and tests on `fix/publication-blockers`
- Official mirrors refreshed in the working tree; mirrors are inputs to this audit and are not project-authored edits
- Canonical implementation files: `src/types/index.ts`, `src/validation/schemas.ts`, `src/validation/validators.ts`, `src/utils/output-builder.ts`

Official source URLs:

1. https://code.claude.com/docs/en/hooks.md
2. https://code.claude.com/docs/en/hooks-guide.md
3. https://code.claude.com/docs/en/settings.md
4. https://code.claude.com/docs/en/cli-reference.md
5. https://code.claude.com/docs/en/headless.md

## Scope and exclusions

Audited project-authored documentation:

- `README.md`
- `CLAUDE.md`
- `CHANGELOG.md`
- `docs/guides/configuring-settings-json.md`
- `docs/reference/hook-events.md`
- `docs/reference/types.md`
- `docs/reference/validators.md`
- `docs/reference/output-builder.md`
- `docs/reference/environment-variables.md`
- this audit record

Excluded from edits:

- `docs/upstream/**` mirrors
- `plans/foamy-questing-catmull.md`
- source and tests already changed by the contract implementation work
- a git commit

## Canonical inventory

- 30 hook event names and 30 input schemas
- universal input fields including optional UUID `prompt_id`
- universal output fields including `terminalSequence`
- eight Notification types with strict universal-only output
- Stop/SubagentStop background-task and session-cron registries
- exclusive Stop/SubagentStop universal, block, and additional-context output modes
- required block reason for Stop/SubagentStop (presence required; empty string accepted)
- six permission update variants and output-only `manual` set-mode alias
- five handler variants with event-aware handler groups
- `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars`
- prompt/agent `continueOnBlock`
- Agent/Task `run_in_background`
- ExitPlanMode `plan`, `planFilePath`, and deprecated accepted `allowedPrompts`
- MCP dynamic tool-input routing and separate MCP hook-handler server naming
- builder coverage for PostToolUseFailure, Stop, SubagentStop, Setup, SessionStart, and MessageDisplay
- StopFailure side-effect-only compatibility behavior

## Confirmed delta and status

| Area | Confirmed delta | Implementation status | Documentation status |
|---|---|---|---|
| Event count | Earlier project docs contained 28-event history | 30-event unions/maps present | Current docs use 30; changelog historical claims corrected |
| Prompt correlation | `prompt_id` optional UUID | Type and schema present | Documented in base input/types/events |
| Notification | Two agent notifications added; output has no event-specific fields | Eight-value enum; strict base output | Documented with all eight and base-only output |
| Stop/SubagentStop input | Background task and session cron registries added | Types and loose metadata schemas present | Documented for both events |
| Stop/SubagentStop output | Blocking and non-error feedback are distinct | Strict unions; block reason required (empty accepted) | Documented with separate builders and deprecated alias |
| UserPromptSubmit output | `suppressOriginalPrompt` parity gap | Type, schema, and `blockPrompt` option present | Documented; previous caveat removed |
| PostToolUseFailure | Separate feedback contract | Dedicated schema and `failureFeedback()` | Distinguished from PostToolUse replacement output |
| Permission updates | Documented discriminated variants replace open record | Six variants; `manual` alias accepted | Variants, fields, destinations, and alias documented |
| Settings root | `disableAllHooks` added; restriction semantics clarified | Schema/type present | Hierarchy, empty/undefined allowlists, merging, intersections documented |
| Handler matrix | Event-specific handler support published | Event-aware schemas present | Matrix documented; MessageDisplay caveat recorded |
| Handler fields | `continueOnBlock`; accepted-but-inert fields; new timeout defaults | Schemas present | Runtime significance and timeout overrides documented |
| Tool inputs | Agent background flag; injected ExitPlanMode plan | Types/schemas/validators present | Fields and compatibility behavior documented |
| MCP naming | Tool-event names differ from `mcp_tool.server` names | Dynamic matcher/validator pattern present | Both naming systems documented |
| StopFailure | Output and exit code ignored | no-op compatibility builder | Side-effect-only behavior documented |
| Environment variables | Earlier categories/defaults did not match direct reads | No implementation change in this audit | Split by `getConfig`, process-supplied, and direct-handler surfaces; defaults corrected |

## Compatibility decisions

- Preserve deprecated `subagentStopContext(reason)` as a blocking alias; direct users to `subagentStopBlock()` or `subagentStopAdditionalContext()`.
- Preserve deprecated `stopFailureLog()` as a no-op returning `{}`; do not imply that its argument is displayed.
- Preserve `TaskToolInput` and `validateTaskToolInput()` as compatibility names alongside official `Agent` naming.
- Accept deprecated ExitPlanMode `allowedPrompts` but document that Claude Code ignores it.
- Keep MessageDisplay on the generic five-handler validation schema because the official handler-support list omits it while documenting only no-matcher and timeout behavior.
- Keep common `if` and `once` fields accepted in generic handler schemas while documenting that `if` is runtime-active only on tool events and `once` only in skill frontmatter.
- Keep `CLAUDE_HOOK_TIMEOUT` described as a library runner setting, separate from Claude Code handler defaults.

## Verification checklist

- [x] Inspected current source diff
- [x] Inspected current test diff
- [x] Inspected refreshed official mirror diff
- [x] Updated the scoped project-authored documentation files
- [x] Run stale-claim/content searches after edits
- [ ] Run documentation-link checks; no repository link-check command exists
- [x] Run `pnpm run type-check` — pass
- [x] Run `pnpm run lint` — pass
- [x] Run `pnpm run test:run` — pass (34 files, 1410 tests)
- [x] Run `pnpm run build` — pass (`tsc --project tsconfig.build.json` + esbuild forwarder bundle)
- [x] Inspect generated `dist/types` and `dist/validation` declaration files — `suppressOriginalPrompt` present on `UserPromptSubmitOutput`; Setup/MessageDisplay named schemas re-exported from `dist/validation/index.d.ts`; `blockPrompt(reason, options?)` present in `dist/utils/output-builder.d.ts`
- [x] Run `git diff --check` — pass (no whitespace errors)
- [x] Review final git diff. Upstream mirror modifications remain the pre-existing refreshed audit inputs; `plans/foamy-questing-catmull.md` was not edited

Do not mark pending checks complete until their commands finish successfully in this working tree.

## Next-audit procedure

1. Refresh each of the five official mirrors without editing project-authored docs in the same step.
2. Diff the mirrors and extract changes to event names, common input/output, event schemas, matcher targets, handler fields, handler support, settings restrictions, CLI tool inputs, and environment variables.
3. Compare those deltas with `src/types/index.ts`, `src/validation/schemas.ts`, `src/validation/validators.ts`, `src/utils/output-builder.ts`, and focused tests.
4. Record compatibility choices before changing public types or validators.
5. Update source/tests first, then audit the project-authored docs listed in Scope.
6. Run targeted stale-term searches, type-check, lint, tests, and any documentation checks.
7. Update this record's date, source URLs, inventory, delta table, decisions, and actual verification results. Do not preserve obsolete phase logs or unverified success claims.
