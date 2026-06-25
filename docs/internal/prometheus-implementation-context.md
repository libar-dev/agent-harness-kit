# Prometheus Implementation Context

Context for implementation planning after the June 2026 upstream Claude Code docs refresh.

## What already changed on this branch

- Upstream mirrors are no longer maintained by copy-paste.
- `pnpm run docs:sync-upstream` now fetches canonical markdown directly from `https://code.claude.com/docs/en/*.md`.
- Mirrored sources now live in:
  - `docs/upstream/hooks-reference.md`
  - `docs/upstream/hooks-guide.md`
  - `docs/upstream/settings.md`
  - `docs/upstream/cli-reference.md`
  - `docs/upstream/headless.md`
- `tests/docs-round-trip.test.ts` was hardened to classify known non-JSON and known unsupported upstream examples by content rather than fragile block index.

## Why this matters for planning

The mirror is now trustworthy enough to use as implementation input. The docs refresh exposed a real API gap between the current library and the current Claude Code hook surface.

This is not a rewrite. The repo already covers many of the previously missing events and nested output schemas. The remaining work is concentrated in the hook types, Zod schemas, validators, builders, and tests.

## Confirmed implementation gaps

### Must-have for current hook parity

1. **Missing hook events**
   - `Setup`
   - `MessageDisplay`

2. **SessionStart is behind upstream docs**
   - `model` is currently required but upstream documents it as optional.
   - `session_title` input is missing.
   - output only supports `additionalContext`, but upstream also documents:
     - `initialUserMessage`
     - `sessionTitle`
     - `watchPaths`
     - `reloadSkills`

3. **Notification enum expansion**
   - upstream docs include more `notification_type` values than the library currently accepts.

4. **StopFailure enum expansion**
   - upstream docs include additional error values such as `overloaded`, `oauth_org_not_allowed`, and `model_not_found`.

### Strong should-have for output/config parity

5. **Command hook exec form**
   - upstream command hooks support `args` in addition to shell-form `command`.

6. **PostToolUse generic output replacement**
   - library currently models `updatedMCPToolOutput` only.
   - upstream now documents `updatedToolOutput` for all tool results, with `updatedMCPToolOutput` as the narrower MCP-only variant.

### Optional stricter parity work

7. **Event-specific hook config semantics**
   - upstream docs now document more event-specific restrictions than the current config validator enforces.
   - examples:
     - `SessionStart` / `Setup` only supporting certain hook handler types
     - `MessageDisplay` not supporting matchers
   - current config validation is primarily structural.

## Files most likely to matter

### Core implementation

- `src/types/index.ts`
- `src/validation/schemas.ts`
- `src/validation/validators.ts`
- `src/validation/index.ts`
- `src/utils/output-builder.ts`
- `src/lifecycle/index.ts`

### Likely new lifecycle entrypoints

- `src/lifecycle/setup.ts`
- `src/lifecycle/message-display.ts`

### Tests and fixtures

- `tests/test-utils.ts`
- `tests/validation.test.ts`
- `tests/hooks.test.ts`
- `tests/docs-round-trip.test.ts`

### Supporting docs that should move with code

- `README.md`
- `CLAUDE.md`
- `docs/README.md`
- `docs/reference/hook-events.md`
- `docs/reference/output-builder.md`
- `docs/reference/types.md`
- `docs/reference/validators.md`
- `docs/internal/api-update-checklist.md`

## Guardrails already in place

- `tests/docs-round-trip.test.ts` validates the upstream `Setup` and `MessageDisplay` input/config examples alongside the other supported events; only the generic `PreToolUse` snippet that omits `tool_use_id` remains skipped.
- `pnpm run docs:sync-upstream` can be rerun at any time to refresh the canonical inputs before planning or implementation.

## DeepWiki usage policy

The DeepWiki rip under `/Users/darkomijic/dev-projects/deepwikis/claude-code-dw/` is worth using as a complementary planning resource, but it is not the authority for API correctness.

### Use DeepWiki for

- architecture and subsystem orientation
- progressive-disclosure exploration of adjacent Claude Code systems
- diagrams, concept maps, and implementation-neighbor discovery
- finding likely relevant upstream repo files and examples faster

### Do not use DeepWiki as the contract source for

- exact hook event inventory
- exact input/output field shapes
- enum values
- exact settings schema
- exact CLI/headless guarantees

### Source-of-truth order

1. `docs/upstream/hooks-reference.md`
2. other `docs/upstream/*.md` mirrors refreshed from `code.claude.com`
3. upstream repo files/examples when needed
4. DeepWiki for broader context and cross-system explanation

If DeepWiki makes a concrete claim that affects implementation behavior, re-check it against the upstream markdown mirrors before coding.

## Rough sizing

- **Core hook parity pass:** roughly 1 to 2 focused engineering days
- **Fuller parity including stricter config semantics:** roughly 2 to 3 days

The work is medium-sized because it spans several surfaces, but the surfaces are tightly related and mostly systematic.

## Planning guidance for Prometheus

- Treat `docs/upstream/hooks-reference.md` as the primary source of truth for hook surface updates.
- Prefer shipping core runtime/type/schema parity first.
- Decide explicitly whether config-validator semantic parity belongs in the same slice or a follow-up.
- Do not spend planning effort on the old manual docs refresh path; it has been replaced by `pnpm run docs:sync-upstream`.
