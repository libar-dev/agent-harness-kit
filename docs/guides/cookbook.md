# Cookbook

Ten copy-pasteable recipes. Each shows the hook script, the `settings.json` registration, and relevant `HookOutputBuilder` methods. All examples assume `tsx` for running TypeScript hooks directly.

---

## 1. Deny dangerous Bash commands

**Event:** `PreToolUse` | **Handler type:** `command`

Blocks commands matching dangerous patterns before they run.

```typescript
// .claude/hooks/bash-guard.ts
#!/usr/bin/env tsx

import { executeHook, outputJson, isDangerousCommand } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type PreToolUseInput } from '@libar-dev/agent-harness-kit/types';
import { validateBashToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PreToolUseInput): Promise<void> {
  if (input.tool_name !== 'Bash') return;
  const bash = validateBashToolInput(input);
  if (isDangerousCommand(bash.command)) {
    outputJson(HookOutputBuilder.permission('deny', `Dangerous command blocked: ${bash.command}`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(hook);
}
```

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "tsx .claude/hooks/bash-guard.ts" }] }]
  }
}
```

**Builder method:** [`permission('deny', reason)`](../reference/output-builder.md#permission)

---

## 2. Protect sensitive files from Write/Edit

**Event:** `PreToolUse` | **Handler type:** `command`

Prevents Claude from overwriting `.env`, lock files, and `.git/**`.

```typescript
// .claude/hooks/file-protector.ts
#!/usr/bin/env tsx

import { executeHook, outputJson, isProtectedFile } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type PreToolUseInput } from '@libar-dev/agent-harness-kit/types';
import { validateWriteToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PreToolUseInput): Promise<void> {
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return;
  const write = validateWriteToolInput(input);
  if (isProtectedFile(write.file_path)) {
    outputJson(HookOutputBuilder.permission('deny', `${write.file_path} is protected`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(hook);
}
```

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "tsx .claude/hooks/file-protector.ts" }] }]
  }
}
```

Default protected patterns: `.env`, `.env.local`, `.env.production`, `.git/**`, `package-lock.json`, `yarn.lock`. Override with `CLAUDE_HOOK_PROTECTED_FILES=.env,.secrets/**`.

**Builder method:** [`permission('deny', reason)`](../reference/output-builder.md#permission)

---

## 3. Inject project context at SessionStart

**Event:** `SessionStart` | **Handler type:** `command`

Adds a system-level context string to every session — useful for project conventions, API keys status, or git branch info.

```typescript
// .claude/hooks/session-start.ts
#!/usr/bin/env tsx

import { execSync } from 'child_process';
import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type SessionStartInput } from '@libar-dev/agent-harness-kit/types';

async function hook(input: SessionStartInput): Promise<void> {
  const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  const context = `Project: my-app | Branch: ${branch} | Node: ${process.version}`;
  outputJson(HookOutputBuilder.sessionStartContext(context));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<SessionStartInput>(hook);
}
```

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/session-start.ts" }] }]
  }
}
```

**Builder method:** [`sessionStartContext(context)`](../reference/output-builder.md#sessionstartcontext)

---

## 4. Auto-format edited files on PostToolUse

**Event:** `PostToolUse` | **Handler type:** `command`

Runs Prettier after Claude writes or edits a file. The `feedback()` response tells Claude what happened.

```typescript
// .claude/hooks/format-code.ts
#!/usr/bin/env tsx

import { execSync } from 'child_process';
import { executeHook, outputJson, shouldAutoFormat } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type PostToolUseInput } from '@libar-dev/agent-harness-kit/types';
import { validateWriteToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PostToolUseInput): Promise<void> {
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return;
  const write = validateWriteToolInput(input);
  if (!shouldAutoFormat(write.file_path)) return;

  try {
    execSync(`npx prettier --write "${write.file_path}"`, { stdio: 'pipe' });
    outputJson(HookOutputBuilder.feedback(`Formatted ${write.file_path} with Prettier`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputJson(HookOutputBuilder.feedback(`Prettier failed on ${write.file_path}: ${msg}`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(hook);
}
```

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "tsx .claude/hooks/format-code.ts" }] }]
  }
}
```

**Builder method:** [`feedback(reason, additionalContext?)`](../reference/output-builder.md#feedback)

---

## 5. TypeScript-check edited files on PostToolUse

**Event:** `PostToolUse` | **Handler type:** `command`

Runs `tsc --noEmit` on the changed file and feeds errors back to Claude.

```typescript
// .claude/hooks/ts-check.ts
#!/usr/bin/env tsx

import { execSync } from 'child_process';
import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type PostToolUseInput } from '@libar-dev/agent-harness-kit/types';
import { validateWriteToolInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: PostToolUseInput): Promise<void> {
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return;
  const write = validateWriteToolInput(input);
  if (!write.file_path.endsWith('.ts') && !write.file_path.endsWith('.tsx')) return;

  try {
    execSync(`npx tsc --noEmit --strict`, { stdio: 'pipe' });
  } catch (err) {
    const output = err instanceof Error && 'stderr' in err
      ? (err as NodeJS.ErrnoException & { stderr: Buffer }).stderr?.toString()
      : String(err);
    outputJson(HookOutputBuilder.feedback(
      `TypeScript errors after editing ${write.file_path}`,
      output
    ));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(hook);
}
```

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "tsx .claude/hooks/ts-check.ts", "timeout": 60 }] }]
  }
}
```

**Builder method:** [`feedback(reason, additionalContext?)`](../reference/output-builder.md#feedback)

---

## 6. Block prompts containing secrets

**Event:** `UserPromptSubmit` | **Handler type:** `command`

Prevents the user from accidentally including API keys or tokens in prompts.

```typescript
// .claude/hooks/secret-guard.ts
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type UserPromptSubmitInput } from '@libar-dev/agent-harness-kit/types';
import { containsSecrets } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: UserPromptSubmitInput): Promise<void> {
  if (containsSecrets(input.prompt)) {
    outputJson(HookOutputBuilder.blockPrompt(
      'Your prompt appears to contain a secret (API key, token, or password). Remove it before sending.'
    ));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<UserPromptSubmitInput>(hook);
}
```

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/secret-guard.ts" }] }]
  }
}
```

**Builder method:** [`blockPrompt(reason)`](../reference/output-builder.md#blockprompt)

---

## 7. Add context to every user prompt

**Event:** `UserPromptSubmit` | **Handler type:** `command`

Injects a standard context string before every user message — e.g., current date, active feature flag, or environment name.

```typescript
// .claude/hooks/prompt-context.ts
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type UserPromptSubmitInput } from '@libar-dev/agent-harness-kit/types';

async function hook(_input: UserPromptSubmitInput): Promise<void> {
  const context = `Current date: ${new Date().toISOString().split('T')[0]}. Environment: production.`;
  outputJson(HookOutputBuilder.addContext(context));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<UserPromptSubmitInput>(hook);
}
```

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/prompt-context.ts" }] }]
  }
}
```

**Builder method:** [`addContext(context)`](../reference/output-builder.md#addcontext)

---

## 8. Custom worktree path for WorktreeCreate

**Event:** `WorktreeCreate` | **Handler type:** `command`

Returns a custom absolute path for the new git worktree. Useful when worktrees should live outside the repo (e.g., on a RAM disk or a fixed path convention).

```typescript
// .claude/hooks/worktree-path.ts
#!/usr/bin/env tsx

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type WorktreeCreateInput } from '@libar-dev/agent-harness-kit/types';
import * as path from 'path';
import * as os from 'os';

async function hook(input: WorktreeCreateInput): Promise<void> {
  // Place worktrees in ~/worktrees/<name>
  const worktreePath = path.join(os.homedir(), 'worktrees', input.name);
  outputJson(HookOutputBuilder.worktreePath(worktreePath));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<WorktreeCreateInput>(hook);
}
```

```json
{
  "hooks": {
    "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/worktree-path.ts" }] }]
  }
}
```

> **Note:** Any non-zero exit code from a `WorktreeCreate` hook is treated as a creation failure.

**Builder method:** [`worktreePath(absolutePath)`](../reference/output-builder.md#worktreepath)

---

## 9. Respond to MCP Elicitation programmatically

**Event:** `Elicitation` | **Handler type:** `command`

Auto-accepts form-mode elicitation requests from a known MCP server instead of prompting the user.

```typescript
// .claude/hooks/elicitation-auto.ts
#!/usr/bin/env tsx
// Based on examples/elicitation-responder.ts

import { executeHook, outputJson } from '@libar-dev/agent-harness-kit/utils';
import { HookOutputBuilder, type ElicitationInput } from '@libar-dev/agent-harness-kit/types';
import { validateElicitationInput } from '@libar-dev/agent-harness-kit/validation';

async function hook(input: ElicitationInput): Promise<void> {
  const elicitation = validateElicitationInput(input);

  // Only auto-respond to a specific MCP server's form-mode requests
  if (elicitation.mcp_server_name !== 'my_trusted_server') return;
  if (elicitation.mode !== 'form') return;

  outputJson(HookOutputBuilder.elicitation('accept', { confirmed: true }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<ElicitationInput>(hook);
}
```

```json
{
  "hooks": {
    "Elicitation": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/elicitation-auto.ts" }] }]
  }
}
```

**Builder method:** [`elicitation(action, content?, hookEventName?)`](../reference/output-builder.md#elicitation)

---

## 10. Send a desktop notification when Claude stops

**Event:** `Stop` | **Handler type:** `command`

Fires an OS notification when Claude finishes responding — useful when running long tasks in the background.

```typescript
// .claude/hooks/notify-done.ts
#!/usr/bin/env tsx

import { execSync } from 'child_process';
import { executeHook } from '@libar-dev/agent-harness-kit/utils';
import type { StopInput } from '@libar-dev/agent-harness-kit/types';

async function hook(_input: StopInput): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'display notification "Claude finished" with title "Claude Code"'`);
    } else if (process.platform === 'linux') {
      execSync(`notify-send "Claude Code" "Claude finished"`);
    }
  } catch {
    // Notification failure is non-critical — don't block
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<StopInput>(hook);
}
```

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "tsx .claude/hooks/notify-done.ts", "async": true }] }]
  }
}
```

Using `"async": true` so Claude doesn't wait for the notification before continuing.

---

## See Also

- [HookOutputBuilder Reference](../reference/output-builder.md) — full method signatures
- [Hook Events Reference](../reference/hook-events.md) — all 30 events with input shapes
- [Validators Reference](../reference/validators.md) — all tool-input validators
- [Environment Variables](../reference/environment-variables.md) — configure defaults without code changes
