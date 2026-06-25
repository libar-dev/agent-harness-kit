# HookOutputBuilder Reference

`HookOutputBuilder` is a static object that produces correctly-shaped JSON output for every hook event. Import it from `@libar-dev/agent-harness-kit/types`.

**Source:** [`src/utils/output-builder.ts`](../../src/utils/output-builder.ts)

```typescript
import { HookOutputBuilder } from '@libar-dev/agent-harness-kit/types';
import { outputJson } from '@libar-dev/agent-harness-kit/utils';

outputJson(HookOutputBuilder.permission('allow', 'Approved'));
```

---

## Universal Methods

These methods work for any hook event.

### `success(message?)`

```typescript
success(message?: string): BaseHookOutput
```

Returns a clean success response. With no message, sets `suppressOutput: true` (stdout hidden from transcript). With a message, includes it as `systemMessage`.

```typescript
// Silent success (most common — just return without calling outputJson)
outputJson(HookOutputBuilder.success());

// Success with a visible message
outputJson(HookOutputBuilder.success('Hook ran successfully'));
```

---

### `error(reason, stopExecution?)`

```typescript
error(reason: string, stopExecution?: boolean): BaseHookOutput
```

Returns an error response. If `stopExecution` is `true`, sets `continue: false` and `stopReason`.

```typescript
outputJson(HookOutputBuilder.error('Something went wrong')); // non-blocking
outputJson(HookOutputBuilder.error('Cannot proceed', true)); // stops Claude
```

---

## PreToolUse

### `permission(decision, reason, options?)`

```typescript
permission(
  decision: 'allow' | 'deny' | 'ask' | 'defer',
  reason: string,
  options?: {
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  }
): PreToolUseOutput
```

The primary PreToolUse method. Produces `hookSpecificOutput.permissionDecision`.

| Decision | Effect |
|----------|--------|
| `'allow'` | Bypasses the permission system entirely — tool runs without user prompt |
| `'deny'` | Blocks the tool call — reason shown to Claude |
| `'ask'` | Prompts the user with your reason message |
| `'defer'` | Falls through to normal permission handling |

```typescript
// Allow
outputJson(HookOutputBuilder.permission('allow', 'Safe command'));

// Deny
outputJson(HookOutputBuilder.permission('deny', 'rm -rf is not allowed here'));

// Ask (prompts user)
outputJson(HookOutputBuilder.permission('ask', 'This command looks risky. Proceed?'));

// Allow with modified input
outputJson(HookOutputBuilder.permission('allow', 'Redirected to safe path', {
  updatedInput: { file_path: '/project/output/result.json' },
}));

// Allow with additional context for Claude
outputJson(HookOutputBuilder.permission('allow', 'Approved', {
  additionalContext: 'Note: this command may take a while',
}));
```

---

## PostToolUse

### `feedback(reason, additionalContext?, updatedMCPToolOutput?, updatedToolOutput?)`

```typescript
feedback(
  reason: string,
  additionalContext?: string,
  updatedMCPToolOutput?: unknown,
  updatedToolOutput?: unknown
): PostToolUseOutput
```

Sends feedback to Claude after a tool executes. Sets `decision: 'block'` internally so the reason is shown to Claude. Use for formatter output, type-check results, or any observation Claude should act on.

`updatedMCPToolOutput` replaces an MCP tool's return value. `updatedToolOutput` replaces general tool output when you need to return a different result body.

```typescript
outputJson(HookOutputBuilder.feedback('Formatted file with Prettier'));
outputJson(HookOutputBuilder.feedback('TypeScript errors found', tscStderr));
outputJson(HookOutputBuilder.feedback('MCP result overridden', undefined, { status: 'ok' }));
outputJson(HookOutputBuilder.feedback('Tool output replaced', undefined, undefined, { summary: 'cleaned output' }));
```

---

## PermissionRequest

### `allowPermission(options?)`

```typescript
allowPermission(options?: {
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdateEntry[];
}): PermissionRequestOutput
```

Auto-approves a permission request. Pass `updatedPermissions` to apply "always allow" rules.

```typescript
outputJson(HookOutputBuilder.allowPermission());
outputJson(HookOutputBuilder.allowPermission({
  updatedInput: { file_path: '/safe/path.txt' },
}));
```

---

### `denyPermission(options?)`

```typescript
denyPermission(options?: {
  message?: string;
  interrupt?: boolean;
}): PermissionRequestOutput
```

Auto-denies a permission request. `message` is shown to Claude. `interrupt: true` stops Claude immediately.

```typescript
outputJson(HookOutputBuilder.denyPermission({ message: 'Not allowed outside /project' }));
outputJson(HookOutputBuilder.denyPermission({ interrupt: true }));
```

---

### `permissionRequestSetMode(mode, destination?)`

```typescript
permissionRequestSetMode(
  mode: PermissionMode,
  destination?: 'session' | 'localSettings' | 'projectSettings' | 'userSettings'
): PermissionRequestOutput
```

Changes the permission mode as part of allowing a request. Equivalent to the user selecting a mode in the permission dialog.

```typescript
outputJson(HookOutputBuilder.permissionRequestSetMode('auto', 'session'));
outputJson(HookOutputBuilder.permissionRequestSetMode('acceptEdits', 'projectSettings'));
```

`PermissionMode` values: `'default'`, `'plan'`, `'acceptEdits'`, `'auto'`, `'dontAsk'`, `'bypassPermissions'`.

---

### `permissionDeniedRetry(retry)`

```typescript
permissionDeniedRetry(retry: boolean): PermissionDeniedOutput
```

For `PermissionDenied` events — tells Claude whether it may retry the denied tool call.

```typescript
outputJson(HookOutputBuilder.permissionDeniedRetry(true));  // allow retry
outputJson(HookOutputBuilder.permissionDeniedRetry(false)); // no retry
```

---

## UserPromptSubmit

### `blockPrompt(reason)`

```typescript
blockPrompt(reason: string): UserPromptSubmitOutput
```

Blocks the prompt from reaching Claude. The `reason` is shown to the user but is **not** added to context.

```typescript
outputJson(HookOutputBuilder.blockPrompt('Prompt appears to contain an API key'));
```

---

### `addContext(context)`

```typescript
addContext(context: string): UserPromptSubmitOutput
```

Adds a string to Claude's context before the prompt is processed.

```typescript
outputJson(HookOutputBuilder.addContext(`Current date: ${new Date().toISOString().split('T')[0]}`));
```

---

### `sessionTitle(title)`

```typescript
sessionTitle(title: string): UserPromptSubmitOutput
```

Sets the session title visible in the Claude Code UI.

```typescript
outputJson(HookOutputBuilder.sessionTitle('Feature: user authentication'));
```

---

## SessionStart

### `sessionStartContext(context)`

```typescript
sessionStartContext(context: string): SessionStartOutput
```

Injects a string into the session's system context at startup.

```typescript
const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
outputJson(HookOutputBuilder.sessionStartContext(`Branch: ${branch}`));
```

---

## Subagent

### `subagentContext(context)`

```typescript
subagentContext(context: string): SubagentStartOutput
```

Injects context into a subagent's system prompt when it starts.

```typescript
outputJson(HookOutputBuilder.subagentContext('This subagent operates in read-only mode'));
```

---

### `subagentStopContext(reason)`

```typescript
subagentStopContext(reason: string): StopOutput
```

Sets `decision: 'block'` with a reason. Used for `Stop` and `SubagentStop` hooks to prevent stopping and provide guidance.

```typescript
outputJson(HookOutputBuilder.subagentStopContext('Check the error log and fix the issue'));
```

---

## Lifecycle Stop

### `taskBlock(reason, hookEventName?)`

```typescript
taskBlock(
  reason: string,
  hookEventName?: 'TaskCreated' | 'TaskCompleted'
): LifecycleStopOutput
```

Blocks task creation or completion. Sets `continue: false` and `stopReason`.

```typescript
outputJson(HookOutputBuilder.taskBlock('Task subject is too vague', 'TaskCreated'));
outputJson(HookOutputBuilder.taskBlock('Task was not completed correctly', 'TaskCompleted'));
```

---

### `teammateStop(reason)`

```typescript
teammateStop(reason: string): LifecycleStopOutput
```

Blocks a teammate from going idle (sets `continue: false` for `TeammateIdle`).

```typescript
outputJson(HookOutputBuilder.teammateStop('Teammate has pending work'));
```

---

## PostToolBatch

### `batchBlock(reason)`

```typescript
batchBlock(reason: string): PostToolBatchOutput
```

Blocks the agentic loop before the next model call after a tool batch. Sets `decision: 'block'` and injects `reason` as `additionalContext`.

```typescript
outputJson(HookOutputBuilder.batchBlock('Batch produced unexpected file changes — review before continuing'));
```

---

## Elicitation

### `elicitation(action, content?, hookEventName?)`

```typescript
elicitation(
  action: ElicitationAction,
  content?: Record<string, unknown>,
  hookEventName?: 'Elicitation' | 'ElicitationResult'
): ElicitationOutput
```

Programmatically responds to or overrides an MCP elicitation request.

`action` values: `'accept'`, `'decline'`, `'cancel'`.

```typescript
// Auto-accept a form elicitation
outputJson(HookOutputBuilder.elicitation('accept', { confirmed: true }));

// Decline an elicitation
outputJson(HookOutputBuilder.elicitation('decline'));

// Override an ElicitationResult
outputJson(HookOutputBuilder.elicitation('accept', { value: 'overridden' }, 'ElicitationResult'));
```

---

## CwdChanged / FileChanged

### `watchPaths(paths)`

```typescript
watchPaths(paths: string[]): WatchPathsOutput
```

Returns a new set of absolute paths for the file watcher to monitor. Used in `CwdChanged` and `FileChanged` hooks.

```typescript
outputJson(HookOutputBuilder.watchPaths([
  '/project/src',
  '/project/config',
]));
```

---

## WorktreeCreate

### `worktreePath(absolutePath)`

```typescript
worktreePath(absolutePath: string): WorktreeCreateOutput
```

Returns a custom absolute path for the new worktree. Any non-zero exit code overrides this and fails the creation.

```typescript
import * as path from 'path';
import * as os from 'os';
outputJson(HookOutputBuilder.worktreePath(path.join(os.homedir(), 'worktrees', input.name)));
```

---

## StopFailure

### `stopFailureLog(systemMessage?)`

```typescript
stopFailureLog(systemMessage?: string): BaseHookOutput
```

Logs a system message for observability on API failures. Delegates to `success(systemMessage)`.

```typescript
outputJson(HookOutputBuilder.stopFailureLog(`API error: ${input.error}`));
```
