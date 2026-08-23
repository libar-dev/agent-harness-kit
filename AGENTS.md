# Agent harness kit

`@libar-dev/agent-harness-kit` is a TypeScript library for Claude Code hooks, session export/tail CLIs, and attach-only Grok Build and OmO-native (senpi) observe adapters. Claude Code has 30 hook events. `CLAUDE.md` is a symlink to this file. Edit this file.

## `any`

Forbidden. Take `unknown` and run a validator. `noImplicitAny` is on in every tsconfig, including `tsconfig.emergency.json`. ESLint `@typescript-eslint/no-explicit-any` is `error`. Leave both in place.

Schema-first: define the Zod schema, infer the type with `z.infer`, validate at the boundary.

Imports use `.js` extensions (NodeNext).

## Open when

| Open | When |
|---|---|
| [docs/README.md](docs/README.md) | you need the guide and reference index |
| [docs/reference/hook-events.md](docs/reference/hook-events.md) | event input, output, or builder method |
| [docs/reference/output-builder.md](docs/reference/output-builder.md) | `HookOutputBuilder` signatures |
| [docs/reference/validators.md](docs/reference/validators.md) | tool-input or config validators |
| [docs/reference/environment-variables.md](docs/reference/environment-variables.md) | `CLAUDE_HOOK_*` / `CLAUDE_CODE_*` |
| [docs/guides/configuring-settings-json.md](docs/guides/configuring-settings-json.md) | handler types, matcher, `if` / `once` / `timeout` |
| [docs/guides/writing-your-first-hook.md](docs/guides/writing-your-first-hook.md) | `executeHook` module pattern |
| [docs/reference/grok-adapter.md](docs/reference/grok-adapter.md) | Grok envelopes, settings, or processing |
| [docs/internal/tail-session.md](docs/internal/tail-session.md) | tail markers or `CLAUDE_TAIL_MARKER_ROOTS` |
| [docs/upstream/hooks-reference.md](docs/upstream/hooks-reference.md) | mirrored official hook contract |
| [tests/docs-round-trip.test.ts](tests/docs-round-trip.test.ts) | changing JSON examples in `docs/upstream/hooks-*.md` |

Scripts live in `package.json`. The quality gate is `pnpm run check`. The full suite is `pnpm run test:run`. Vitest runs `.ts` directly. Tests import helpers from `tests/test-utils.ts` and send inputs through Zod.

## Gotchas

Hook I/O is JSON on stdin and stdout. Exit 0 succeeds, 1 is a non-blocking error, 2 blocks. `WorktreeCreate` treats any non-zero exit as a creation failure. `StopFailure` ignores output and exit code. `HookOutputBuilder.stopFailureLog()` is a deprecated no-op.

`PermissionRequest` decisions nest under `hookSpecificOutput.decision` with `behavior: "allow" | "deny"`. Emit that shape, not a top-level allow/deny.

Grok is attach-only. It does not share Claude's 30-event contract, and Claude hook scripts are not a Grok entrypoint.

`getConfig()` reads debug, timeout, session-end timeout, plugin-install sync, protected files, dangerous commands, and auto-format extensions. Other `CLAUDE_HOOK_*` vars are read by the hook that uses them. Tail library callers pass `allowedMarkerRoots`. `CLAUDE_TAIL_MARKER_ROOTS` is a CLI concern and is outside `getConfig()`.

`MessageDisplay` handler types stay generic. Upstream does not classify them.

## Comments

Keep JSDoc that names parameters, returns, thrown errors, and consumer-visible behavior on every export. Keep a comment that records an invariant, a compatibility constraint, a security edge, or a regression reason. Cut temporal, migration, and marketing words. One blank line between logical blocks.

## Review

Greptile reviews this public repo. After a commit: `greptile review -b main --json`. Findings still exit 0. Non-zero means the run failed. Triage `securityIssue`, then P0 / P1 / P2. Fetch PR bot comments with `gh`, not the Greptile CLI. Greptile is the source of truth here.

## Public tree

Keep scratch out of the index: `prometheus-implementation-context.md`, `.omo/notepads/`, `.omo/senpi-task/`, `.omo/start-work/`, `.omo/run-continuation/`, `boulder.json`, root `plans/`, `.grok/`. Product law goes in `docs/` or `docs/decisions/`.

`.omo/` is live. At most one unchecked plan in `.omo/plans/`. Archive to `.plans/NN-slug.md`. Workstation copy: `~/.agents/AGENTS.md` (skill `omo-workspace-state`).

## This workstation

Unslop every reply, commit message, PR body, and new doc. Skill: `~/.agents/skills/unslop/SKILL.md`.

Commits are recovery boundaries. A plan's commit strategy authorizes commits on that work branch. Otherwise ask. Push only when asked. No `git stash`.

Push over the existing remote and protocol - HTTPS + gh token works here. Treat SSH + key checks as a fallback only when HTTPS/token auth fails (the old ssh-first rule came from a Fedora machine where tokens kept breaking, not this one). Ask before changing remotes or credentials.

The user owns `~/dev-admin/oh-my-openagent` and `~/.omo/omo.jsonc`. Inspect and report. Do not checkout, pull, build, install, or edit OmO unless asked.
