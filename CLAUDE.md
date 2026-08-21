# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What This Is

A standalone TypeScript hooks library (`@libar-dev/agent-harness-kit`) for Claude Code. Hooks are command, HTTP, MCP tool, prompt, or agent handlers that run at lifecycle points. The library covers all 30 hook events in the current official docs.

Official docs (mirrored upstream): `docs/upstream/hooks-guide.md`, `docs/upstream/hooks-reference.md`

## Commands

```bash
pnpm run test:run       # Run all tests (no build needed - Vitest runs .ts directly)
pnpm run test           # Watch mode
pnpm run type-check     # TypeScript checking (strict, includes tests and TS examples)
pnpm run build          # Compile src/ -> dist/ (only needed for distribution)
pnpm run lint           # ESLint with caching
pnpm run lint:fix       # Auto-fix lint + formatting
pnpm run check          # type-check + lint combined
pnpm run fix            # lint:fix + type-check combined
pnpm run export-sessions # Export sessions as markdown and/or JSONL
pnpm run tail-session    # Tail session JSONL as structured blocks

# Test individual hooks manually
pnpm run hook:test              # Bash validator
pnpm run hook:test:notification # Notification handler
pnpm run hook:test:session      # Session start
```

## Absolute Rule: No `any` Types

`any` is forbidden. Use `unknown` with validation/type assertions instead. `noImplicitAny: true` is set in all tsconfig files. Do not weaken this.

```typescript
// WRONG
const data: any = input.tool_input;

// RIGHT
const bashInput = validateBashToolInput(input); // Returns typed BashToolInput
```

## Architecture

**Hook I/O protocol**: JSON in via stdin, JSON out via stdout. Exit codes: 0 (success), 1 (non-blocking error), 2 (blocking error). `WorktreeCreate` treats any non-zero exit as a creation failure.

**30 hook events**: Setup, SessionStart, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd.

**Key modules**:

- `src/types/index.ts` — Type definitions: hook I/O interfaces, tool input types, hook config types (`HookHandler`, `MatcherGroup`, `HooksConfig`), and `HookEnvironmentVars`
- `src/utils/index.ts` — Core I/O (`readStdinJson`, `outputJson`, `executeHook`), logging, config (`getConfig()` reads `CLAUDE_*` env vars)
- `src/utils/output-builder.ts` — `HookOutputBuilder` with methods for all output patterns
- `src/validation/` — Zod schemas (`schemas.ts`), validators (`validators.ts`), and re-exports (`index.ts`). Schema-first: define Zod schema -> infer types with `z.infer` -> validate at boundaries
- `src/pre-tool-use/` — PreToolUse and UserPromptExpansion reference hooks
- `src/post-tool-use/` — PostToolUse, PostToolUseFailure, and PostToolBatch reference hooks
- `src/lifecycle/` — Lifecycle, async, worktree, elicitation, config, and session reference hooks
- `src/processing/` — Session parsing, denoising, markdown export, structured block extraction, and tail-mode ingestion helpers
- `src/cli/` — Shipped CLIs for bulk export (`claude-session-export`) and live tailing (`claude-session-tail`)
- `src/grok/` — Grok Build adapter: hook envelope types and Zod validation (`types.ts`, `validation.ts`), `GrokHookOutputBuilder` (`output-builder.ts`), the `executeGrokHook` runner (`execute.ts`), and JSON/TOML settings validation (`settings.ts`)
- `src/grok/processing/` — Grok session discovery (`discovery.ts`), `updates.jsonl` and `events.jsonl` parsers (`updates.ts`, `events.ts`), checkpointed tailing (`tail.ts`), and the normalized block reducer (`blocks.ts`)

## HookOutputBuilder Methods

- `permission(decision, reason, options?)` — PreToolUse allow/deny/ask/defer with optional `updatedInput`, `additionalContext`
- `feedback(reason, additionalContext?, updatedMCPToolOutput?, updatedToolOutput?)` — PostToolUse block feedback with optional output replacement
- `postToolUseContext(options)` — PostToolUse non-block context and/or tool-output replacement
- `failureFeedback(reason, additionalContext?)` — PostToolUseFailure block feedback without output replacement
- `failureContext(additionalContext)` — PostToolUseFailure non-block context injection
- `allowPermission(options?)` / `denyPermission(options?)` — PermissionRequest decisions
- `permissionRequestSetMode(mode, destination?)` — PermissionRequest mode update helper, including the `manual` output alias
- `permissionDeniedRetry(retry)` — PermissionDenied retry guidance
- `elicitation(action, content?, hookEventName?)` — Elicitation and ElicitationResult action output
- `watchPaths(paths)` — CwdChanged/FileChanged watch list output
- `worktreePath(absolutePath)` — WorktreeCreate custom path output
- `taskBlock(reason, hookEventName?)` — TaskCreated/TaskCompleted stop output
- `teammateStop(reason)` — TeammateIdle stop output
- `batchBlock(reason)` — PostToolBatch block output
- `subagentContext(context)` — SubagentStart context injection
- `stopBlock(reason)` / `stopContext(context)` — blocking and non-error Stop feedback modes
- `subagentStopBlock(reason)` / `subagentStopAdditionalContext(context)` — blocking and non-error SubagentStop feedback modes
- `subagentStopContext(reason)` — deprecated blocking compatibility alias
- `setupContext(context)` / `messageDisplayContent(content)` — Setup and display-only output
- `sessionStartContext(contextOrOptions)` — SessionStart context, initial message, title, watch paths, and skill reload
- `addContext(context)` / `blockPrompt(reason, options?)` / `sessionTitle(title)` — UserPromptSubmit helpers (`options.suppressOriginalPrompt`)
- `stopFailureLog(systemMessage?)` — deprecated no-op because StopFailure ignores output and exit code
- `success(message?)` / `error(reason, stopExecution?)` — Universal helpers

## Hook Handler Types

Settings validation supports these handler types:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm run hook:bash-validator",
            "if": "Bash(git *)",
            "timeout": 60,
            "async": false,
            "asyncRewake": false,
            "shell": "bash"
          }
        ]
      }
    ]
  }
}
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8080/hooks/pre-tool-use",
            "headers": { "Authorization": "Bearer $MY_TOKEN" },
            "allowedEnvVars": ["MY_TOKEN"],
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "my_server",
            "tool": "security_scan",
            "input": { "file_path": "${tool_input.file_path}" }
          }
        ]
      }
    ]
  }
}
```

`prompt` handlers use `{ "type": "prompt", "prompt": "...", "model": "..." }`. `agent` handlers use `{ "type": "agent", "prompt": "...", "model": "..." }`.

## Standard Hook Module Pattern

```typescript
import { executeHook, HookOutputBuilder, outputJson } from '../utils/index.js';
import { PreToolUseInput } from '../types/index.js';

async function myHook(input: PreToolUseInput): Promise<void> {
  outputJson(HookOutputBuilder.permission('allow', 'Approved'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(myHook);
}
```

## Tool Input Validation

Use tool validators for type-safe access to `tool_input`:

```typescript
import { validateBashToolInput } from '../validation/index.js';
const bashInput = validateBashToolInput(input); // unknown -> BashToolInput
const command: string = bashInput.command;
```

Available tool validators: `validateBashToolInput`, `validateWriteToolInput`, `validateEditToolInput`, `validateReadToolInput`, `validateGlobToolInput`, `validateGrepToolInput`, `validateMultiEditToolInput`, `validateWebFetchToolInput`, `validateWebSearchToolInput`, `validateTaskToolInput`, `validateAskUserQuestionToolInput`, `validateExitPlanModeToolInput`, `validateAgentToolInput`, `validateTodoWriteToolInput`, `validateMCPToolInput`.

## Hook Configuration Validation

```typescript
import { validateHooksConfig } from '../validation/index.js';
const config = validateHooksConfig(parsed); // validates full settings hooks structure
```

Config supports common handler fields `if`, `timeout`, `statusMessage`, and `once`; prompt/agent handlers add `continueOnBlock`; command handlers add `args`, `async`, `asyncRewake`, and `shell`. Runtime semantics are narrower than validation: `if` only runs on tool events and `once` is honored only in skill frontmatter. Settings-root fields are `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, and `httpHookAllowedEnvVars`. Event-aware schemas enforce the handler support matrix; MessageDisplay deliberately remains generic because upstream does not classify its handler types.

## Build System

- `tsconfig.json`: Strict dev-time checking (includes `src/`, `tests/`, and TS examples; `noEmit: true`)
- `tsconfig.build.json`: Extends base for compilation (`src/` only -> `dist/`)
- ES modules: All imports use `.js` extensions. Build script (`scripts/fix-imports.js`) auto-fixes paths.
- Tests do not need `dist/`: Vitest + esbuild transpiles `.ts` directly.
- Session export CLI moved from `scripts/export-sessions.ts` to `src/cli/export-sessions.ts`; use the package bin or `pnpm run export-sessions` for local development.

## Testing

- Tests live in `tests/` and run against `.ts` source files via Vitest.
- Use test helpers from `tests/test-utils.ts` (`createPreToolUseInput`, `expectValidationError`, etc.).
- All test inputs should go through Zod validation.
- `tests/docs-round-trip.test.ts` validates parseable JSON hook examples from the mirrored official docs. It explicitly skips known pseudocode/commented JSON blocks and the generic official PreToolUse snippet that omits required `tool_use_id`.

## Config

Hook behavior is configurable through environment variables. The library reads:

- Core/runtime: `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_DEBUG_LOG_LEVEL`, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, `CLAUDE_HOOK_DEBUG`, `CLAUDE_HOOK_TIMEOUT`
- Protection and command policy: `CLAUDE_HOOK_PROTECTED_FILES`, `CLAUDE_HOOK_DANGEROUS_COMMANDS`, `CLAUDE_HOOK_STRICT_PROTECTION`, `CLAUDE_HOOK_EXTRA_PROTECTED`, `CLAUDE_HOOK_READ_ONLY`, `CLAUDE_HOOK_AUTO_APPROVE_READS`
- Formatting and post-tool checks: `CLAUDE_HOOK_AUTO_FORMAT`, `CLAUDE_HOOK_DISABLE_PRETTIER`, `CLAUDE_HOOK_DISABLE_ESLINT`, `CLAUDE_HOOK_FORMAT_TIMEOUT`, `CLAUDE_HOOK_FAIL_ON_FORMAT_ERROR`, `CLAUDE_HOOK_STRICT_POST_VALIDATION`
- TypeScript validation: `CLAUDE_HOOK_TS_FULL_CHECK`, `CLAUDE_HOOK_TS_BLOCK_ON_ERROR`, `CLAUDE_HOOK_TS_TIMEOUT`, `CLAUDE_HOOK_TS_STRICT_FILES`, `CLAUDE_HOOK_CONVEX_VALIDATION`
- Notifications: `CLAUDE_HOOK_DESKTOP_NOTIFICATIONS`, `CLAUDE_HOOK_CONSOLE_NOTIFICATIONS`, `CLAUDE_HOOK_NOTIFICATIONS_IN_CI`, `CLAUDE_HOOK_NOTIFICATION_COMMAND`, `CLAUDE_HOOK_SLACK_WEBHOOK`, `CLAUDE_HOOK_EMAIL_TO`, `CLAUDE_HOOK_EMAIL_FROM`, `CLAUDE_HOOK_SMTP_SERVER`
- Session context/end: `CLAUDE_HOOK_SESSION_GIT`, `CLAUDE_HOOK_SESSION_DEPS`, `CLAUDE_HOOK_SESSION_CHANGES`, `CLAUDE_HOOK_SESSION_DEV_STATUS`, `CLAUDE_HOOK_SESSION_MAX_COMMITS`, `CLAUDE_HOOK_SESSION_MAX_CHANGES`, `CLAUDE_HOOK_CONTEXT_FILES`, `CLAUDE_HOOK_CLEANUP_TEMP`, `CLAUDE_HOOK_SAVE_STATS`, `CLAUDE_HOOK_GENERATE_SUMMARY`, `CLAUDE_HOOK_ARCHIVE_TRANSCRIPT`, `CLAUDE_HOOK_SEND_NOTIFICATIONS`, `CLAUDE_HOOK_MAX_TEMP_AGE`
- Prompt/stop/subagent/pre-compact: `CLAUDE_HOOK_CHECK_SECRETS`, `CLAUDE_HOOK_ADD_CONTEXT`, `CLAUDE_HOOK_VALIDATE_STRUCTURE`, `CLAUDE_HOOK_CHECK_INJECTION`, `CLAUDE_HOOK_MAX_PROMPT_LENGTH`, `CLAUDE_HOOK_BLOCK_INJECTION`, `CLAUDE_HOOK_CHECK_TASKS`, `CLAUDE_HOOK_CHECK_GIT`, `CLAUDE_HOOK_CHECK_TESTS`, `CLAUDE_HOOK_VALIDATE_SUBAGENT`, `CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS`, `CLAUDE_HOOK_LOG_SUBAGENT_METRICS`, `CLAUDE_HOOK_SAVE_CONTEXT`, `CLAUDE_HOOK_EXTRACT_DECISIONS`, `CLAUDE_HOOK_CREATE_BACKUP`, `CLAUDE_HOOK_MAX_CONTEXT_SIZE`

Processing CLIs have a separate env surface that is not loaded through `getConfig()`, including `CLAUDE_TAIL_MARKER_ROOTS` for `claude-session-tail --marker-dir`. Keep hook env-var docs and processing CLI docs separate. Library consumers of the tail APIs should pass the per-call `allowedMarkerRoots` option instead of relying on that env var.

Set `CLAUDE_HOOK_DEBUG=true` or `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` for verbose library logging. `CLAUDE_HOOK_TIMEOUT` defaults this library's runner to 60 seconds; Claude Code settings handlers instead default to 600 seconds for command/HTTP/MCP, 30 for prompt, and 60 for agent, with 30-second UserPromptSubmit and 10-second MessageDisplay overrides. `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` defaults to 1500 ms and is capped at 60000 ms.

## Code review (Greptile)

This is a public OSS repo. **Greptile is available here permanently** (OSS free forever) for PR bot review and local CLI review. Prefer it as the primary automated reviewer for this repository.

**Local (pre-push):** Commit first, then review committed work against the base branch. Agents should use structured output.

```bash
greptile whoami                    # must be signed in (check text; exit 0 even when signed out)
greptile review -b main --json     # or omit -b for the repo default base
greptile review status --json      # whether HEAD already has a completed review
```

- Findings still exit `0`; non-zero means the review did not finish.
- Triage `securityIssue: true`, then `P0` / `P1` / `P2`. Aim for confidence `5` with zero comments when polishing a branch (`greploop` skill if iterating).
- PR bot comments are fetched with `gh` (`gh api repos/.../pulls/<n>/comments`), not with the Greptile CLI.

**Do not** treat CodeRabbit (or other review bots) as the source of truth on this repo when Greptile is configured.

## Public Repository Hygiene

Scratch planning and agent-runtime files stay out of the public tree: free-floating context docs such as `prometheus-implementation-context.md`, `.omo/notepads/*`, `.omo/senpi-task/`, `.omo/start-work/`, `.omo/run-continuation/`, `boulder.json`, repo-root `plans/`, and `.grok/`. Persistent product guidance belongs in user-facing docs or ADRs.

`.omo/` is the live scratchpad. Track at most one live plan under `.omo/plans/` (unchecked until the increment is accepted) and `.omo/rules/` when this repo injects rules. Archive a finished plan to `.plans/NN-slug.md`. Write learnings on that file; promote to `docs/` only when the public contract changes. Evidence is one dated packet force-added after a real increment, or omitted. Before merge or a fresh re-run: archive or restore the plan, then drop runtime and leftover drafts from the index. Inspect unfamiliar `.omo/` paths before deleting them. Workstation copy: `~/.agents/AGENTS.md` (skill `omo-workspace-state`).

## Working discipline

- **Unslop.** Always on. Read `~/.agents/skills/unslop/SKILL.md` and apply it to every reply, commit message, PR body, and new doc. Existing context files get a later dedicated pass.
- **OmO workspace state.** Follow the hygiene rules above. `.omo/plans/` is live only; `.plans/` is the archive.
- **Commits are recovery boundaries, not workflow gates.** An execution plan's explicit commit strategy counts as authorization on its work branch; otherwise ask before committing. Prefer a commit after a coherent logical unit and its relevant quality gate, but never force one per todo, create empty commits, absorb unrelated or pre-existing changes, or commit from an unsafe dirty baseline. When no clean boundary exists, preserve and account for the state in the tracked plan/draft rather than discarding it; commit at the next safe boundary. Push only on the user's explicit request; never use `git stash`.
- **GitHub transport on this workstation is SSH.** Use `git@github.com:<owner>/<repo>.git` remotes and confirm `gh auth status` reports `Git operations protocol: ssh` before a push. Do not switch remotes to HTTPS, replace SSH with token transport, or edit credential configuration unless the user explicitly requests that action.
- **Unreleased OmO installs are user-controlled.** The user switches the official `~/dev-admin/oh-my-openagent` clone to `dev` when needed and owns `~/.omo/omo.jsonc`. Agents may inspect and report that state, but must not checkout, pull, build, globally install, or edit the OmO configuration unless the user explicitly requests that action.

## Comment Style

- Preserve API-contract JSDoc on every exported type, interface, function, class, and method. Keep parameter, return, thrown-error, and behavior notes that public consumers rely on.
- Strip temporal, AI-workflow, migration, provenance, and marketing phrasing from comments. Avoid examples such as `Following ... pattern`, `incremental`, `Phase`, `recently`, `parent project`, `ported from`, `moved to`, `will`, `currently`, `now`, `new`, `modern`, `legacy`, `comprehensive`, and `designed for`.
- Treat filler wording as noise. Avoid `automatically` when it adds no technical detail, and avoid `supports` when the code, type, or API name already makes that clear.
- Keep comments that explain regression rationale, compatibility constraints, security-sensitive behavior, invariants, or non-obvious edge cases.
- Avoid heavy visual banners such as `// =====`, `// ----`, or long dashed separator lines. Prefer a single blank line between logical blocks.

## Compatibility Notes

`PermissionRequest` uses nested `hookSpecificOutput.decision` with `behavior: "allow" | "deny"` and the six documented permission-update variants. Stop and SubagentStop have separate block and non-error additional-context modes; block output requires a reason. Notification accepts only universal output. StopFailure is side-effect-only. The old top-level PermissionRequest allow/deny style should not be used.
