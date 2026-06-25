# Troubleshooting

## Hook didn't fire

**1. Check the event name.** Verify the key in `settings.json` is spelled exactly as one of the 30 event names (case-sensitive: `PreToolUse`, not `pre_tool_use`).

**2. Check the matcher.** The `matcher` field is a regex applied to `tool_name` (for tool events) or equivalent primary identifier. An empty matcher or omitting it matches everything. Test your regex:

```bash
node -e "console.log(/Write|Edit/.test('Write'))"  # true
```

**3. Check settings file location.** Claude Code loads settings from:
- `~/.claude/settings.json` (user-level)
- `.claude/settings.json` in the project root (project-level)
- `.claude/settings.local.json` (local overrides, not committed)

Hooks in a project settings file only fire when Claude Code is run from that project's directory.

**4. Check the `if` field.** If your handler has an `if` condition, it only fires when the condition matches. Remove it temporarily to confirm the hook runs at all.

**5. Check for JSON syntax errors.** A malformed `settings.json` silently disables hooks. Validate it:

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json', 'utf8'))" && echo "Valid"
```

---

## Hook fired but produced no effect

**1. Check the exit code.** Exit code 0 means success. Exit codes 1 and 2 signal errors (see below). If your script exits non-zero, Claude Code may ignore its output.

**2. Check that output goes to stdout.** `outputJson()` writes to stdout. `logError()`, `logWarning()`, and `logInfo()` write to stderr. Claude Code reads hook output from stdout only.

**3. Verify the JSON shape.** Misconfigured output (wrong field names, wrong nesting) is silently ignored. Use the manual test approach to inspect the raw output:

```bash
echo '<input json>' | tsx .claude/hooks/my-hook.ts | jq .
```

---

## Exit code semantics

| Exit code | Meaning | Effect |
|-----------|---------|--------|
| `0` | Success | JSON output (if any) is processed |
| `1` | Non-blocking error | Shown to user; Claude continues |
| `2` | Blocking error | Shown to Claude; current turn stops |

`WorktreeCreate` treats **any non-zero** exit code as a worktree creation failure regardless of the output.

`executeHook()` maps thrown errors automatically:
- Errors with `BLOCK` or `DENY` in the message → exit code 2
- All other errors → exit code 1

---

## Enabling verbose logging

Set one of these before running Claude Code:

```bash
CLAUDE_HOOK_DEBUG=true claude
# or
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose claude
```

With debug enabled, the library logs:
- Received hook input (to stderr)
- Sent hook output (to stderr)
- Read byte counts

You can also capture your hook's stderr directly:

```bash
echo '<input json>' | tsx .claude/hooks/my-hook.ts 2>&1
```

---

## Zod validation errors

When a hook input fails schema validation, `executeHook` throws with a message like:

```
Failed to parse hook input JSON: [
  { code: 'invalid_type', path: ['tool_use_id'], message: 'Required' }
]
```

The `path` field tells you which field is wrong. Common causes:

- Testing with a hand-crafted JSON that omits required fields (e.g., `tool_use_id` for `PreToolUse`).
- Pointing the hook at the wrong event type (e.g., a PostToolUse hook registered under PreToolUse).
- Using an outdated version of the library against a newer Claude Code that added new required fields.

Use `safeValidateHookInput` if you want validation failures to return `null` instead of throwing.

---

## "No `any` types" TypeScript build failure

The library enforces `noImplicitAny: true`. If you see errors like:

```
error TS7006: Parameter 'data' implicitly has an 'any' type.
```

Use a typed validator instead of accessing `tool_input` directly:

```typescript
// Wrong
const command = (input.tool_input as any).command;

// Right
const bash = validateBashToolInput(input);
const command = bash.command; // string
```

See [Validators Reference](../reference/validators.md) for all available validators.

---

## Hook times out

Default timeout is **60 seconds** for command and HTTP hooks. If your hook does slow work (network calls, large TypeScript checks), increase it:

```json
{ "type": "command", "command": "tsx .claude/hooks/slow-hook.ts", "timeout": 120 }
```

Or override the default globally with `CLAUDE_HOOK_TIMEOUT=120`.

For `SessionEnd`, the total budget for all hooks combined defaults to **1500 ms** (hard cap: 60000 ms). Increase with `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=30000`.

---

## Circular continuation (Stop hook loops)

A `Stop` hook that returns `decision: 'block'` causes Claude to continue. If Claude then stops again and the hook fires again, you can get infinite loops. Guard against this with `stop_hook_active`:

```typescript
async function hook(input: StopInput): Promise<void> {
  if (input.stop_hook_active) return; // already continuing due to a stop hook
  // ...
}
```
