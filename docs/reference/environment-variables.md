# Environment Variables Reference

This page separates three different surfaces:

1. variables read by this library's `getConfig()`
2. Claude Code variables supplied to hook processes
3. variables read directly by bundled reference handlers

Processing-CLI variables are separate. `CLAUDE_TAIL_MARKER_ROOTS`, for example, is documented in [Session tailing](../internal/tail-session.md), and library callers should prefer `allowedMarkerRoots`.

## `getConfig()` inputs

**Source:** [`src/utils/index.ts`](../../src/utils/index.ts)

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_DEBUG` | `false` | Enables library debug logging when exactly `true`. |
| `DEBUG` | unset | Also enables library debug logging when exactly `true`. |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | unset | `verbose` enables library debug logging and Claude Code matcher diagnostics. |
| `CLAUDE_HOOK_TIMEOUT` | `60` seconds | Default timeout value in this library's `HookConfig`. It does not override Claude Code settings handler defaults. |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | `1500` ms | Total SessionEnd budget; invalid/non-positive values fall back to 1500 and values above 60000 are capped. |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | `false` | Enables synchronous plugin install handling when exactly `true`. |
| `CLAUDE_HOOK_PROTECTED_FILES` | `.env,.env.local,.env.production,.git/**,package-lock.json,yarn.lock` | Comma-separated patterns used by `isProtectedFile()`. |
| `CLAUDE_HOOK_DANGEROUS_COMMANDS` | `rm -rf,sudo,chmod 777,dd,mkfs` | Comma-separated substrings used by `isDangerousCommand()`. |
| `CLAUDE_HOOK_AUTO_FORMAT` | `.ts,.tsx,.js,.jsx,.json,.css,.md` | Comma-separated extensions used by `shouldAutoFormat()` and the formatter. |
| `CLAUDE_PROJECT_DIR` | required by `getProjectDir()` | Project root for path checks. This is not necessarily the event input's current `cwd`. |

## Claude Code hook-process environment

These variables are supplied by Claude Code rather than parsed by `getConfig()`:

| Variable | Availability and meaning |
|---|---|
| `CLAUDE_PROJECT_DIR` | Project root used for path placeholders and hook environment access. |
| `CLAUDE_CODE_REMOTE` | `true` in remote web environments; unset locally. |
| `CLAUDE_CODE_BRIDGE_SESSION_ID` | Active Remote Control bridge session identifier. |
| `CLAUDE_ENV_FILE` | Available to `SessionStart`, `Setup`, `CwdChanged`, and `FileChanged`; append `export NAME=value` lines to persist variables for later Bash commands. |
| `CLAUDE_EFFORT` | Effective `low`, `medium`, `high`, `xhigh`, or `max` effort for the active turn. |
| `CLAUDE_PLUGIN_ROOT` | Installed plugin root for plugin hooks. |
| `CLAUDE_PLUGIN_DATA` | Persistent plugin data directory. |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | `verbose` enables additional Claude Code hook diagnostics. |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | Overrides the SessionEnd total timeout budget, capped at 60000 ms. |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | Requests plugin installation completion before the first turn. |

The public `HookEnvironmentVars` type models this process-supplied surface.

## Reference hook configuration

The following variables are read directly by bundled example/reference handlers. Boolean defaults below reflect the code's comparison, including opt-out flags that are enabled unless set to `false`.

### File protection

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_STRICT_PROTECTION` | `false` | Enables strict protected-file blocking. |
| `CLAUDE_HOOK_EXTRA_PROTECTED` | empty | Comma-separated additional path substrings. |
| `CLAUDE_HOOK_READ_ONLY` | `package.json,tsconfig.json,convex/schema.ts,CLAUDE.md` | Comma-separated files that may be read but not modified. Despite the singular-looking name, the value is a list, not a boolean. |
| `CLAUDE_HOOK_AUTO_APPROVE_READS` | `true` | Set to `false` to stop auto-approving unprotected reads. |

### Formatting and post-tool validation

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_DISABLE_PRETTIER` | `false` | `true` disables Prettier. |
| `CLAUDE_HOOK_DISABLE_ESLINT` | `false` | `true` disables ESLint. |
| `CLAUDE_HOOK_FORMAT_TIMEOUT` | `30` seconds | Formatter subprocess timeout. |
| `CLAUDE_HOOK_FAIL_ON_FORMAT_ERROR` | `false` | `true` makes format failures blocking. |
| `CLAUDE_HOOK_STRICT_POST_VALIDATION` | `false` | Enables the stricter aggregate post-tool path. |

### TypeScript validation

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_TS_FULL_CHECK` | `false` | Runs a full-project check. |
| `CLAUDE_HOOK_CONVEX_VALIDATION` | `true` | Set to `false` to disable Convex-specific checks. |
| `CLAUDE_HOOK_TS_TIMEOUT` | `60` seconds | TypeScript validation timeout. |
| `CLAUDE_HOOK_TS_BLOCK_ON_ERROR` | `false` | Blocks when compiler errors are found. |
| `CLAUDE_HOOK_TS_STRICT_FILES` | `convex/schema.ts,convex/toolkit/,src/types/` | Comma-separated strict-path list. |

### Notifications

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_DESKTOP_NOTIFICATIONS` | `true` | Set to `false` to disable desktop delivery. |
| `CLAUDE_HOOK_CONSOLE_NOTIFICATIONS` | `true` | Set to `false` to disable console delivery. |
| `CLAUDE_HOOK_NOTIFICATIONS_IN_CI` | `false` | `true` enables notifications in CI. |
| `CLAUDE_HOOK_NOTIFICATION_COMMAND` | unset | Custom notification command. |
| `CLAUDE_HOOK_SLACK_WEBHOOK` | unset | Slack webhook destination. |
| `CLAUDE_HOOK_EMAIL_TO` | unset | Enables email delivery. |
| `CLAUDE_HOOK_EMAIL_FROM` | `claude-code@localhost` | Sender when email is enabled. |
| `CLAUDE_HOOK_SMTP_SERVER` | unset | SMTP server. |

### Session start

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_SESSION_GIT` | `true` | Set to `false` to omit git context. |
| `CLAUDE_HOOK_SESSION_DEPS` | `true` | Set to `false` to omit dependency context. |
| `CLAUDE_HOOK_SESSION_CHANGES` | `true` | Set to `false` to omit recent changes. |
| `CLAUDE_HOOK_SESSION_DEV_STATUS` | `true` | Set to `false` to omit development-server status. |
| `CLAUDE_HOOK_SESSION_MAX_COMMITS` | `5` | Maximum commits included. |
| `CLAUDE_HOOK_SESSION_MAX_CHANGES` | `10` | Maximum changed files included. |
| `CLAUDE_HOOK_CONTEXT_FILES` | `README.md,CLAUDE.md,DEVELOPMENT.md,package.json` | Comma-separated context files. |

### Session end

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_CLEANUP_TEMP` | `true` | Set to `false` to skip temporary-file cleanup. |
| `CLAUDE_HOOK_SAVE_STATS` | `true` | Set to `false` to skip session statistics. |
| `CLAUDE_HOOK_GENERATE_SUMMARY` | `true` | Set to `false` to skip summaries; also used by PreCompact. |
| `CLAUDE_HOOK_ARCHIVE_TRANSCRIPT` | `false` | `true` archives the transcript. |
| `CLAUDE_HOOK_SEND_NOTIFICATIONS` | `false` | `true` sends SessionEnd completion notifications. |
| `CLAUDE_HOOK_MAX_TEMP_AGE` | `24` hours | Temporary-file age limit. |

### User prompt validation

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_CHECK_SECRETS` | `true` | Set to `false` to disable secret checks. |
| `CLAUDE_HOOK_ADD_CONTEXT` | `true` | Set to `false` to disable built-in context enrichment. This is a boolean toggle, not a context string. |
| `CLAUDE_HOOK_VALIDATE_STRUCTURE` | `false` | `true` enables structural validation. |
| `CLAUDE_HOOK_CHECK_INJECTION` | `true` | Set to `false` to disable injection-pattern checks. |
| `CLAUDE_HOOK_MAX_PROMPT_LENGTH` | `10000` characters | Prompt length limit. |
| `CLAUDE_HOOK_BLOCK_INJECTION` | `false` | `true` upgrades injection warnings to blocks. |

### Stop and SubagentStop

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_CHECK_TASKS` | `true` | Set to `false` to skip task checks. |
| `CLAUDE_HOOK_CHECK_GIT` | `true` | Set to `false` to skip git checks. |
| `CLAUDE_HOOK_CHECK_TESTS` | `true` | Set to `false` to skip test checks. |
| `CLAUDE_HOOK_MAX_CONTINUATIONS` | `3` | Main-session continuation limit. |
| `CLAUDE_HOOK_VALIDATE_SUBAGENT` | `true` | Set to `false` to skip completion validation. |
| `CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS` | `true` | Set to `false` to skip transcript error checks. |
| `CLAUDE_HOOK_LOG_SUBAGENT_METRICS` | `false` | `true` logs subagent metrics. |
| `CLAUDE_HOOK_SUBAGENT_MAX_RETRIES` | `2` | Subagent retry limit. |

### PreCompact

| Variable | Default | Effect |
|---|---:|---|
| `CLAUDE_HOOK_SAVE_CONTEXT` | `true` | Set to `false` to skip important-context extraction. |
| `CLAUDE_HOOK_GENERATE_SUMMARY` | `true` | Set to `false` to skip status summary generation. |
| `CLAUDE_HOOK_EXTRACT_DECISIONS` | `true` | Set to `false` to skip decision extraction. |
| `CLAUDE_HOOK_CREATE_BACKUP` | `false` | `true` creates a transcript backup. |
| `CLAUDE_HOOK_MAX_CONTEXT_SIZE` | `10000` characters | Maximum extracted context size. |

## CI detection helpers

`isCI()` also reads `CI`, `GITHUB_ACTIONS`, and `TRAVIS`. These are environment-detection inputs, not hook configuration variables.
