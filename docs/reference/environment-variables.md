# Environment Variables Reference

All `CLAUDE_HOOK_*` and relevant `CLAUDE_CODE_*` variables that control hook behavior. Set them before starting Claude Code or in your shell profile.

**Source:** [`src/utils/index.ts`](../../src/utils/index.ts) (`getConfig()`)

This reference is intentionally limited to variables loaded through
`getConfig()`. Processing CLI variables that live outside that config surface,
such as `CLAUDE_TAIL_MARKER_ROOTS` for `claude-session-tail --marker-dir`, are
documented in the [Tail Sessions internal doc](../internal/tail-session.md)
instead of here. (Library consumers should prefer the per-call
`allowedMarkerRoots` tail option over that env var; see the same doc.)

---

## Runtime / Core

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_PROJECT_DIR` | string | — | Set by Claude Code — current working directory. Read via `getProjectDir()`. |
| `CLAUDE_CODE_REMOTE` | `"true"` | unset | Set in remote web environments (Claude.ai web). Useful for detecting execution context. |
| `CLAUDE_ENV_FILE` | string | — | SessionStart only — path to a file where hooks can write `export VAR=value` lines to persist env vars for the session. |
| `CLAUDE_PLUGIN_ROOT` | string | — | Plugin root directory when hook is defined in a plugin's `hooks/hooks.json`. |
| `CLAUDE_HOOK_DEBUG` | `"true"` | `"false"` | Enable verbose debug logging to stderr. |
| `CLAUDE_HOOK_TIMEOUT` | number (seconds) | `60` | Default hook execution timeout. |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | `"verbose"` | unset | Enables additional hook matcher diagnostics when set to `verbose`. Also enables debug logging. |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | `"true"` | unset | Forces plugin install events to complete before the first turn. |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | number (ms) | `1500` | Total budget for all SessionEnd hooks combined. Capped at 60000 ms. |
| `DEBUG` | `"true"` | unset | Alternative to `CLAUDE_HOOK_DEBUG` — also enables debug logging. |

---

## File & Command Protection

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_PROTECTED_FILES` | comma-separated globs | `.env,.env.local,.env.production,.git/**,package-lock.json,yarn.lock` | File patterns protected from Write/Edit. Used by `isProtectedFile()`. |
| `CLAUDE_HOOK_DANGEROUS_COMMANDS` | comma-separated strings | `rm -rf,sudo,chmod 777,dd,mkfs` | Command substrings blocked by `isDangerousCommand()`. |
| `CLAUDE_HOOK_STRICT_PROTECTION` | `"true"` | `"false"` | Enable stricter file protection checks. |
| `CLAUDE_HOOK_EXTRA_PROTECTED` | comma-separated globs | — | Additional protected file patterns layered on top of defaults. |
| `CLAUDE_HOOK_READ_ONLY` | `"true"` | `"false"` | Treat all file-write operations as protected. |
| `CLAUDE_HOOK_AUTO_APPROVE_READS` | `"true"` | `"false"` | Auto-approve all Read tool calls without validation. |

---

## Auto-Formatting (PostToolUse)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_AUTO_FORMAT` | comma-separated extensions | `.ts,.tsx,.js,.jsx,.json,.css,.md` | File extensions that `shouldAutoFormat()` returns true for. |
| `CLAUDE_HOOK_DISABLE_PRETTIER` | `"true"` | `"false"` | Skip Prettier in the format-code reference hook. |
| `CLAUDE_HOOK_DISABLE_ESLINT` | `"true"` | `"false"` | Skip ESLint in the format-code reference hook. |
| `CLAUDE_HOOK_FORMAT_TIMEOUT` | number (seconds) | `30` | Timeout for format operations. |
| `CLAUDE_HOOK_FAIL_ON_FORMAT_ERROR` | `"true"` | `"false"` | Exit non-zero if formatting fails. |
| `CLAUDE_HOOK_STRICT_POST_VALIDATION` | `"true"` | `"false"` | Apply stricter post-tool validation checks. |

---

## TypeScript Validation (PostToolUse)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_TS_FULL_CHECK` | `"true"` | `"false"` | Run full `tsc` on the entire project instead of the changed file only. |
| `CLAUDE_HOOK_TS_BLOCK_ON_ERROR` | `"true"` | `"false"` | Exit with a blocking error (exit code 2) on TypeScript errors. |
| `CLAUDE_HOOK_TS_TIMEOUT` | number (seconds) | `60` | Timeout for `tsc` runs. |
| `CLAUDE_HOOK_TS_STRICT_FILES` | comma-separated globs | — | Only run TS validation on files matching these patterns. |
| `CLAUDE_HOOK_CONVEX_VALIDATION` | `"true"` | `"false"` | Enable Convex-specific TypeScript validation. |

---

## Notifications (Stop / Notification)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_DESKTOP_NOTIFICATIONS` | `"true"` | `"false"` | Send OS desktop notifications. |
| `CLAUDE_HOOK_CONSOLE_NOTIFICATIONS` | `"true"` | `"false"` | Log notifications to the console. |
| `CLAUDE_HOOK_NOTIFICATIONS_IN_CI` | `"true"` | `"false"` | Send notifications even when `CI=true`. |
| `CLAUDE_HOOK_NOTIFICATION_COMMAND` | string | — | Custom shell command to run for notifications (receives message as argument). |
| `CLAUDE_HOOK_SLACK_WEBHOOK` | string (URL) | — | Slack incoming webhook URL for notification delivery. |
| `CLAUDE_HOOK_EMAIL_TO` | string | — | Email address to send notification emails to. |
| `CLAUDE_HOOK_EMAIL_FROM` | string | — | Sender address for notification emails. |
| `CLAUDE_HOOK_SMTP_SERVER` | string | — | SMTP server for sending notification emails. |

---

## Session Context (SessionStart / SessionEnd)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_SESSION_GIT` | `"true"` | `"false"` | Include git status in session context. |
| `CLAUDE_HOOK_SESSION_DEPS` | `"true"` | `"false"` | Include dependency info in session context. |
| `CLAUDE_HOOK_SESSION_CHANGES` | `"true"` | `"false"` | Include uncommitted changes summary in session context. |
| `CLAUDE_HOOK_SESSION_DEV_STATUS` | `"true"` | `"false"` | Include development environment status. |
| `CLAUDE_HOOK_SESSION_MAX_COMMITS` | number | `10` | Max commits to include in session context git log. |
| `CLAUDE_HOOK_SESSION_MAX_CHANGES` | number | `50` | Max changed files to include in session context. |
| `CLAUDE_HOOK_CONTEXT_FILES` | comma-separated paths | — | Additional files whose content is injected into session context. |
| `CLAUDE_HOOK_CLEANUP_TEMP` | `"true"` | `"false"` | Clean up temp files on SessionEnd. |
| `CLAUDE_HOOK_SAVE_STATS` | `"true"` | `"false"` | Save session statistics on SessionEnd. |
| `CLAUDE_HOOK_GENERATE_SUMMARY` | `"true"` | `"false"` | Generate a session summary on SessionEnd. |
| `CLAUDE_HOOK_ARCHIVE_TRANSCRIPT` | `"true"` | `"false"` | Archive the transcript on SessionEnd. |
| `CLAUDE_HOOK_SEND_NOTIFICATIONS` | `"true"` | `"false"` | Send completion notifications on SessionEnd. |
| `CLAUDE_HOOK_MAX_TEMP_AGE` | number (hours) | `24` | Max age of temp files to clean up. |

---

## Prompt, Stop & Subagent

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_CHECK_SECRETS` | `"true"` | `"false"` | Run `containsSecrets()` on UserPromptSubmit. |
| `CLAUDE_HOOK_ADD_CONTEXT` | string | — | Static context string added to every UserPromptSubmit. |
| `CLAUDE_HOOK_VALIDATE_STRUCTURE` | `"true"` | `"false"` | Validate prompt structure on UserPromptSubmit. |
| `CLAUDE_HOOK_CHECK_INJECTION` | `"true"` | `"false"` | Check for prompt injection patterns. |
| `CLAUDE_HOOK_MAX_PROMPT_LENGTH` | number | — | Block prompts longer than this character count. |
| `CLAUDE_HOOK_BLOCK_INJECTION` | `"true"` | `"false"` | Block detected injection attempts (vs. just warn). |
| `CLAUDE_HOOK_CHECK_TASKS` | `"true"` | `"false"` | Check task state on Stop. |
| `CLAUDE_HOOK_CHECK_GIT` | `"true"` | `"false"` | Check git state on Stop. |
| `CLAUDE_HOOK_CHECK_TESTS` | `"true"` | `"false"` | Run tests on Stop. |
| `CLAUDE_HOOK_MAX_CONTINUATIONS` | number | — | Max times a Stop hook may continue before allowing termination. |
| `CLAUDE_HOOK_VALIDATE_SUBAGENT` | `"true"` | `"false"` | Validate subagent parameters on SubagentStart. |
| `CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS` | `"true"` | `"false"` | Check subagent transcript for errors on SubagentStop. |
| `CLAUDE_HOOK_LOG_SUBAGENT_METRICS` | `"true"` | `"false"` | Log subagent performance metrics on SubagentStop. |
| `CLAUDE_HOOK_SUBAGENT_MAX_RETRIES` | number | `3` | Max subagent retry count before giving up. |

---

## PreCompact

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_HOOK_SAVE_CONTEXT` | `"true"` | `"false"` | Save context to disk before compaction. |
| `CLAUDE_HOOK_EXTRACT_DECISIONS` | `"true"` | `"false"` | Extract key decisions from context before compaction. |
| `CLAUDE_HOOK_CREATE_BACKUP` | `"true"` | `"false"` | Create a backup of the transcript before compaction. |
| `CLAUDE_HOOK_MAX_CONTEXT_SIZE` | number (chars) | — | Block compaction if context exceeds this size. |

---

## Quick Debug Setup

```bash
export CLAUDE_HOOK_DEBUG=true
export CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose
claude
```

Hook stderr (including debug output) is captured by Claude Code and shown in verbose mode. To see it directly, pipe hook input manually:

```bash
CLAUDE_HOOK_DEBUG=true echo '<input json>' | tsx .claude/hooks/my-hook.ts 2>&1
```
