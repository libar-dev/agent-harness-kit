# HookOutputBuilder Reference

`HookOutputBuilder` creates event-safe hook output objects. Import it from `@libar-dev/agent-harness-kit/types`.

```typescript
import { HookOutputBuilder } from '@libar-dev/agent-harness-kit/types';
import { outputJson } from '@libar-dev/agent-harness-kit/utils';
```

**Source:** [`src/utils/output-builder.ts`](../../src/utils/output-builder.ts)

## Universal

### `success(message?)`

Returns `BaseHookOutput`. No message produces `{ suppressOutput: true }`; a message produces `{ suppressOutput: false, systemMessage: message }`.

### `error(reason, stopExecution?)`

Returns a visible `systemMessage`. With `stopExecution: true`, also sets `continue: false` and `stopReason`.

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

`allow` bypasses normal permission handling, `deny` blocks, `ask` prompts the user, and `defer` leaves the decision to normal permission handling.

```typescript
outputJson(HookOutputBuilder.permission('allow', 'Redirected', {
  updatedInput: { file_path: '/safe/output.txt' },
  additionalContext: 'The generated file belongs under /safe.'
}));
```

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

Builds top-level `decision: 'block'` feedback plus optional `hookSpecificOutput`. Both replacement arguments preserve any value other than `undefined`, including `false`, `0`, `''`, and `null`. Empty-string `additionalContext` is preserved when provided.

`updatedMCPToolOutput` is the compatibility field for MCP outputs. `updatedToolOutput` is the general tool-output replacement field.

Use this when Claude should receive block feedback. For replace/context-only output without a block decision, use `postToolUseContext`.

### `postToolUseContext(options)`

```typescript
postToolUseContext(options: {
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;
  updatedToolOutput?: unknown;
}): PostToolUseOutput
```

Builds non-block PostToolUse output: only `hookSpecificOutput` with optional context and tool-output replacements. Does not set top-level `decision` or `reason`. All provided values other than `undefined` are preserved, including falsy replacements and empty strings.

### `failureFeedback(reason, additionalContext?)`

```typescript
failureFeedback(
  reason: string,
  additionalContext?: string
): PostToolUseFailureOutput
```

Builds top-level `decision: 'block'` feedback after a failed tool execution. It deliberately does not accept `updatedMCPToolOutput` or `updatedToolOutput`: there is no successful tool result to replace. Empty-string `additionalContext` is preserved when provided.

Use this for block feedback. For context-only failure output, use `failureContext`.

### `failureContext(additionalContext)`

```typescript
failureContext(additionalContext: string): PostToolUseFailureOutput
```

Builds non-block PostToolUseFailure output: only `hookSpecificOutput.additionalContext`, with no top-level `decision` or `reason`.

## PermissionRequest and PermissionDenied

### `allowPermission(options?)`

```typescript
allowPermission(options?: {
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdateEntry[];
}): PermissionRequestOutput
```

Allows the request and may rewrite the input or apply one or more permission updates. `PermissionUpdateEntry` accepts:

- `addRules`, `replaceRules`, `removeRules`
- `setMode`
- `addDirectories`, `removeDirectories`

Rules use `{ toolName, ruleContent? }`, behavior `allow | deny | ask`, and destination `session | localSettings | projectSettings | userSettings`.

### `denyPermission(options?)`

```typescript
denyPermission(options?: {
  message?: string;
  interrupt?: boolean;
}): PermissionRequestOutput
```

Denies the request. `message` is returned to Claude; `interrupt: true` stops Claude.

### `permissionRequestSetMode(mode, destination?)`

```typescript
permissionRequestSetMode(
  mode: PermissionUpdateMode,
  destination?: PermissionUpdateDestination
): PermissionRequestOutput
```

Convenience wrapper around `allowPermission({ updatedPermissions: [...] })`. The destination defaults to `session`. `PermissionUpdateMode` accepts standard modes plus `manual`; input `permission_mode` still reports Manual as `default`.

### `permissionDeniedRetry(retry)`

Returns `hookSpecificOutput.retry` for `PermissionDenied`.

## Elicitation

### `elicitation(action, content?, hookEventName?)`

Builds an `Elicitation` or `ElicitationResult` response with action `accept`, `decline`, or `cancel`. The event name defaults to `Elicitation`.

## Watch paths and worktrees

### `watchPaths(paths)`

Returns `{ watchPaths: paths }` for `CwdChanged` or `FileChanged`.

### `worktreePath(absolutePath)`

Returns HTTP-style `WorktreeCreate` JSON with `hookSpecificOutput.worktreePath`. Command hooks normally print the path directly; any non-zero command exit fails creation.

## Team and batch control

### `taskBlock(reason, hookEventName?)`

Sets universal stop output `{ continue: false, stopReason }` for `TaskCreated` or `TaskCompleted`. The optional `hookEventName` argument is accepted for source compatibility but ignored; official task control does not use an event marker in JSON output.

### `teammateStop(reason)`

Sets universal stop output `{ continue: false, stopReason }` for `TeammateIdle`.

### `batchBlock(reason)`

Returns `decision: 'block'` and repeats the reason as `PostToolBatch.additionalContext` before the next model call.

## Setup and session start

### `setupContext(context)`

Injects Setup `additionalContext`.

### `sessionStartContext(contextOrOptions)`

```typescript
sessionStartContext(context: string): SessionStartOutput
sessionStartContext(options: {
  context?: string;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
}): SessionStartOutput
```

The string overload injects only context. The options overload exposes every implemented SessionStart output field.

## Message display

### `messageDisplayContent(content)`

Replaces only the currently displayed `MessageDisplay` delta. The transcript and Claude's context retain the original text.

## UserPromptSubmit

### `addContext(context)`

Injects `additionalContext` alongside the prompt.

### `sessionTitle(title)`

Sets the session title.

### `blockPrompt(reason, options?)`

Returns `decision: 'block'` with a reason shown to the user. Pass
`{ suppressOriginalPrompt: true }` to omit the original prompt text from the
block message shown to the user.

## Subagents and stopping

### `subagentContext(context)`

Injects context when a subagent starts.

### `stopBlock(reason)`

Returns `StopBlockOutput`. A block reason is required; the strict schema rejects `{ decision: 'block' }` without a `reason` field. Empty strings are accepted.

### `stopContext(context)`

Returns non-error Stop feedback through `hookSpecificOutput.additionalContext`. This continues the main conversation without a top-level block decision.

### `subagentStopBlock(reason)`

Returns `SubagentStopBlockOutput`. A reason string is required; empty strings are accepted.

### `subagentStopAdditionalContext(context)`

Returns non-error SubagentStop feedback through `hookSpecificOutput.additionalContext`, allowing the subagent to continue and act on factual feedback.

### `subagentStopContext(reason)`

Deprecated compatibility alias for `subagentStopBlock(reason)`. Despite its name, it emits the blocking mode, not the non-error additional-context mode.

## StopFailure compatibility

### `stopFailureLog(systemMessage?)`

Deprecated no-op shim that returns `{}`. Claude Code treats `StopFailure` as side-effect-only and ignores both output and exit code, so callers should log or notify directly rather than depend on hook JSON.
