# Validators Reference

All exported validators from `@libar-dev/agent-harness-kit/validation`.

**Source:** [`src/validation/index.ts`](../../src/validation/index.ts) · [`src/validation/validators.ts`](../../src/validation/validators.ts)

---

## Tool-Input Validators

These functions extract a typed tool-input from a hook's `tool_input: Record<string, unknown>`. Each throws `HookValidationError` if the shape doesn't match.

```typescript
import { validateBashToolInput } from '@libar-dev/agent-harness-kit/validation';
import type { PreToolUseInput } from '@libar-dev/agent-harness-kit/types';

async function hook(input: PreToolUseInput): Promise<void> {
  const bash = validateBashToolInput(input); // BashToolInput — fully typed
  const command: string = bash.command;
}
```

| Function | Returns | Tool |
|----------|---------|------|
| `validateBashToolInput(input)` | `BashToolInput` | `Bash` |
| `validateWriteToolInput(input)` | `WriteToolInput` | `Write` |
| `validateEditToolInput(input)` | `EditToolInput` | `Edit` |
| `validateMultiEditToolInput(input)` | `MultiEditToolInput` | `MultiEdit` |
| `validateReadToolInput(input)` | `ReadToolInput` | `Read` |
| `validateGlobToolInput(input)` | `GlobToolInput` | `Glob` |
| `validateGrepToolInput(input)` | `GrepToolInput` | `Grep` |
| `validateWebFetchToolInput(input)` | `WebFetchToolInput` | `WebFetch` |
| `validateWebSearchToolInput(input)` | `WebSearchToolInput` | `WebSearch` |
| `validateAgentToolInput(input)` | `AgentToolInput` | `Agent` |
| `validateAskUserQuestionToolInput(input)` | `AskUserQuestionToolInput` | `AskUserQuestion` |
| `validateExitPlanModeToolInput(input)` | `ExitPlanModeToolInput` | `ExitPlanMode` |
| `validateTodoWriteToolInput(input)` | `TodoWriteToolInput` | `TodoWrite` |
| `validateMCPToolInput(input)` | `MCPToolInput` | Any MCP tool |
| `validateTaskToolInput(input)` | `TaskToolInput` | `Task` |

The generic form works for any tool name:

```typescript
import { validateToolInput } from '@libar-dev/agent-harness-kit/validation';
const typed = validateToolInput('Bash', input);
```

---

## Generic Hook-Input Validators

### `validateHookInput(data)`

```typescript
validateHookInput(data: unknown): HookInputSchema
```

Validates any hook input. Throws a Zod error if the shape is invalid. Used internally by `executeHook()`.

### `safeValidateHookInput(data)`

```typescript
safeValidateHookInput(data: unknown): HookInputSchema | null
```

Same as `validateHookInput` but returns `null` instead of throwing. Use when you want to handle invalid input gracefully.

---

## Per-Event Input Validators

Validate a hook input and narrow its type to a specific event. Throws `HookValidationError` if the event name doesn't match.

```typescript
import { validatePreToolUseInput } from '@libar-dev/agent-harness-kit/validation';
const typedInput = validatePreToolUseInput(input); // PreToolUseInput
```

| Function | Returns |
|----------|---------|
| `validatePreToolUseInput(input)` | `PreToolUseInput` |
| `validatePostToolUseInput(input)` | `PostToolUseInput` |
| `validateUserPromptExpansionInput(input)` | `UserPromptExpansionInput` |
| `validatePermissionDeniedInput(input)` | `PermissionDeniedInput` |
| `validatePostToolBatchInput(input)` | `PostToolBatchInput` |
| `validateTaskCreatedInput(input)` | `TaskCreatedInput` |
| `validateStopFailureInput(input)` | `StopFailureInput` |
| `validateInstructionsLoadedInput(input)` | `InstructionsLoadedInput` |
| `validateConfigChangeInput(input)` | `ConfigChangeInput` |
| `validateCwdChangedInput(input)` | `CwdChangedInput` |
| `validateFileChangedInput(input)` | `FileChangedInput` |
| `validateWorktreeCreateInput(input)` | `WorktreeCreateInput` |
| `validateWorktreeRemoveInput(input)` | `WorktreeRemoveInput` |
| `validatePostCompactInput(input)` | `PostCompactInput` |
| `validateElicitationInput(input)` | `ElicitationInput` |
| `validateElicitationResultInput(input)` | `ElicitationResultInput` |

---

## Type Guards

Check a hook input's event type without throwing:

```typescript
import { isPreToolUseInput } from '@libar-dev/agent-harness-kit/validation';

if (isPreToolUseInput(input)) {
  // input is PreToolUseInput here
}
```

| Guard | Narrows to |
|-------|-----------|
| `isPreToolUseInput(input)` | `PreToolUseInput` |
| `isPostToolUseInput(input)` | `PostToolUseInput` |
| `isPermissionRequestInput(input)` | `PermissionRequestInput` |
| `isPermissionDeniedInput(input)` | `PermissionDeniedInput` |
| `isPostToolUseFailureInput(input)` | `PostToolUseFailureInput` |
| `isPostToolBatchInput(input)` | `PostToolBatchInput` |
| `isUserPromptSubmitInput(input)` | `UserPromptSubmitInput` |
| `isUserPromptExpansionInput(input)` | `UserPromptExpansionInput` |
| `isSessionStartInput(input)` | `SessionStartInput` |
| `isSessionEndInput(input)` | `SessionEndInput` |
| `isNotificationInput(input)` | `NotificationInput` |
| `isStopInput(input)` | `StopInput` |
| `isStopFailureInput(input)` | `StopFailureInput` |
| `isSubagentStartInput(input)` | `SubagentStartInput` |
| `isSubagentStopInput(input)` | `SubagentStopInput` |
| `isTeammateIdleInput(input)` | `TeammateIdleInput` |
| `isTaskCreatedInput(input)` | `TaskCreatedInput` |
| `isTaskCompletedInput(input)` | `TaskCompletedInput` |
| `isInstructionsLoadedInput(input)` | `InstructionsLoadedInput` |
| `isConfigChangeInput(input)` | `ConfigChangeInput` |
| `isCwdChangedInput(input)` | `CwdChangedInput` |
| `isFileChangedInput(input)` | `FileChangedInput` |
| `isWorktreeCreateInput(input)` | `WorktreeCreateInput` |
| `isWorktreeRemoveInput(input)` | `WorktreeRemoveInput` |
| `isPreCompactInput(input)` | `PreCompactInput` |
| `isPostCompactInput(input)` | `PostCompactInput` |
| `isElicitationInput(input)` | `ElicitationInput` |
| `isElicitationResultInput(input)` | `ElicitationResultInput` |

---

## Content Validators

### `validateBashCommand(command, rules?)`

```typescript
validateBashCommand(
  command: string,
  rules?: BashValidationRule[]
): { issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; suggestion?: string }> }
```

Validates a Bash command against safety rules. Returns an object with an `issues` array. An empty array means the command is clean.

```typescript
const result = validateBashCommand('rm -rf /');
// result.issues[0] = { severity: 'error', message: 'rm -rf detected', suggestion: 'Use a safer delete command' }
```

### `DEFAULT_BASH_RULES`

```typescript
const DEFAULT_BASH_RULES: BashValidationRule[]
```

The built-in rule set covering: `rm -rf`, `sudo`, `chmod 777`, `dd`, and `mkfs` (errors), plus performance suggestions.

Pass custom rules as the second argument to `validateBashCommand`:

```typescript
const myRules: BashValidationRule[] = [
  { pattern: /git push --force/, severity: 'error', message: 'Force push is not allowed' },
];
validateBashCommand(command, [...DEFAULT_BASH_RULES, ...myRules]);
```

### `containsSecrets(text)`

```typescript
containsSecrets(text: string): boolean
```

Returns `true` if the text appears to contain an API key, token, or password pattern.

### `validateFileSyntax(filePath, content)`

```typescript
validateFileSyntax(filePath: string, content: string): void
```

Validates file content against expected syntax for common extensions (JSON, TypeScript). Throws on syntax errors.

### `validateSafeFilePath(filePath)`

```typescript
validateSafeFilePath(filePath: string): void
```

Throws if the path contains `..` (path traversal) or other unsafe patterns.

### `normalizeFilePath(path)` (re-exported from utils)

```typescript
normalizeFilePath(path: string): string
```

Cross-platform path normalization (Windows backslashes → forward slashes, trailing slash removal, case normalization on win32).

---

## Config Validators

Validate hook configuration objects from `settings.json`.

### `validateHooksConfig(data)`

```typescript
validateHooksConfig(data: unknown): HooksConfig
```

Validates the full `hooks` block (or entire settings object). Throws a Zod error if invalid.

```typescript
const raw = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
const config = validateHooksConfig(raw); // HooksConfig
```

### `validateHookHandler(data)`

```typescript
validateHookHandler(data: unknown): HookHandler
```

Validates a single handler object. Returns the discriminated-union type.

### `validateMatcherGroup(data)`

```typescript
validateMatcherGroup(data: unknown): MatcherGroup
```

Validates a single matcher group `{ matcher?, hooks[] }`.

---

## HookValidationError

Thrown by all `validate*` functions on validation failure.

```typescript
import { HookValidationError } from '@libar-dev/agent-harness-kit/validation';

try {
  validateBashToolInput(input);
} catch (err) {
  if (err instanceof HookValidationError) {
    console.error('Validation failed:', err.message);
    // err.issues contains the Zod issue array
  }
}
```
