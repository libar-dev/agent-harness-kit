# Validators Reference

Runtime validation exports from `@libar-dev/agent-harness-kit/validation`.

**Sources:** [`src/validation/schemas.ts`](../../src/validation/schemas.ts), [`src/validation/validators.ts`](../../src/validation/validators.ts), [`src/validation/index.ts`](../../src/validation/index.ts)

## Hook input validation

### `validateHookInput(data)`

Validates unknown JSON by reading `hook_event_name`, selecting one of the 30 event schemas, and returning the inferred `HookInputSchema`. It throws `HookValidationError` for a non-object, a missing/invalid event name, an unsupported event, or a schema mismatch.

### `safeValidateHookInput(data)`

Returns a validated input or `null` instead of throwing.

### Type guards

The public guards cover every event:

`isSetupInput`, `isSessionStartInput`, `isUserPromptSubmitInput`, `isUserPromptExpansionInput`, `isPreToolUseInput`, `isPermissionRequestInput`, `isPermissionDeniedInput`, `isPostToolUseInput`, `isPostToolUseFailureInput`, `isPostToolBatchInput`, `isNotificationInput`, `isMessageDisplayInput`, `isSubagentStartInput`, `isSubagentStopInput`, `isTaskCreatedInput`, `isTaskCompletedInput`, `isStopInput`, `isStopFailureInput`, `isTeammateIdleInput`, `isInstructionsLoadedInput`, `isConfigChangeInput`, `isCwdChangedInput`, `isFileChangedInput`, `isWorktreeCreateInput`, `isWorktreeRemoveInput`, `isPreCompactInput`, `isPostCompactInput`, `isElicitationInput`, `isElicitationResultInput`, and `isSessionEndInput`.

### Event-specific throwing validators

The barrel exports:

- `validateSetupInput`
- `validatePreToolUseInput`
- `validatePostToolUseInput`
- `validateUserPromptExpansionInput`
- `validatePermissionDeniedInput`
- `validatePostToolBatchInput`
- `validateTaskCreatedInput`
- `validateStopFailureInput`
- `validateInstructionsLoadedInput`
- `validateConfigChangeInput`
- `validateCwdChangedInput`
- `validateFileChangedInput`
- `validateWorktreeCreateInput`
- `validateWorktreeRemoveInput`
- `validatePostCompactInput`
- `validateMessageDisplayInput`
- `validateElicitationInput`
- `validateElicitationResultInput`

Use `validateHookInput` plus a guard for events without a dedicated throwing helper.

## Tool input validation

Tool validators accept any tool-bearing hook input: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PermissionDenied`, or `PostToolUseFailure`.

| Function | Return type | Tool name |
|---|---|---|
| `validateBashToolInput` | `BashToolInputSchema` | `Bash` |
| `validateWriteToolInput` | `WriteToolInputSchema` | `Write` |
| `validateEditToolInput` | `EditToolInputSchema` | `Edit` |
| `validateReadToolInput` | `ReadToolInputSchema` | `Read` |
| `validateGlobToolInput` | `GlobToolInputSchema` | `Glob` |
| `validateGrepToolInput` | `GrepToolInputSchema` | `Grep` |
| `validateMultiEditToolInput` | `MultiEditToolInputSchema` | `MultiEdit` |
| `validateWebFetchToolInput` | `WebFetchToolInputSchema` | `WebFetch` |
| `validateWebSearchToolInput` | `WebSearchToolInputSchema` | `WebSearch` |
| `validateAgentToolInput` | `AgentToolInputSchema` | `Agent` |
| `validateTaskToolInput` | `TaskToolInputSchema` | compatibility `Task` |
| `validateAskUserQuestionToolInput` | `AskUserQuestionToolInputSchema` | `AskUserQuestion` |
| `validateExitPlanModeToolInput` | `ExitPlanModeToolInputSchema` | `ExitPlanMode` |
| `validateTodoWriteToolInput` | `TodoWriteToolInputSchema` | `TodoWrite` |
| `validateMCPToolInput` | `MCPToolInputSchema` | dynamic MCP names |

`Agent` and compatibility `Task` accept `prompt`, optional `description`, `subagent_type`, `model`, and `run_in_background`.

`ExitPlanMode` requires the injected `plan` and `planFilePath` fields. It may include deprecated `allowedPrompts: Array<{ tool, prompt }>` entries, which Claude Code accepts but ignores.

### Dynamic MCP routing

`validateToolInput(hookInput)` routes built-ins through `toolInputSchemas`. Unknown names matching `mcp__<server>__<tool>` use the generic record schema. The matcher permits hyphenated and underscore-separated server/tool segments, including plugin-scoped names such as `mcp__plugin_my-plugin_db__query`.

`validateMCPToolInput` validates the same `Record<string, unknown>` shape directly.

## Output schemas

`hookOutputSchemas` exposes an output schema for every event. Important strict contracts include:

- `notificationOutputSchema` is strict universal output only. Notification-specific fields and `additionalContext` are rejected.
- `stopOutputSchema` and `subagentStopOutputSchema` distinguish universal output, block mode, and non-error additional-context mode.
- Block mode requires `decision: 'block'` and a present `reason` string (empty string accepted).
- Non-error Stop/SubagentStop feedback requires a present `hookSpecificOutput.additionalContext` string and cannot be combined with top-level decision fields.
- `postToolUseFailureOutputSchema` does not accept PostToolUse output-replacement fields.
- `permissionRequestOutputSchema` validates the complete documented `PermissionUpdateEntry` union, including `manual` as a `setMode` alias.

## Settings validation

### `validateHooksConfig(data)`

Validates the settings-shaped hook contract:

- optional event-aware `hooks` map
- `disableAllHooks`
- `allowManagedHooksOnly`
- `allowedHttpHookUrls`
- `httpHookAllowedEnvVars`

Unknown event names are rejected. Event entries enforce the implemented handler matrix: all five handler types for decision-capable events, external handlers for observation/external events, and command/MCP-only handlers for `SessionStart` and `Setup`. `MessageDisplay` deliberately remains on the generic compatibility schema because upstream does not classify its handler types.

### `validateHookHandler(data)`

Validates one generic handler. It does not know which event will contain the handler; use `validateHooksConfig` to enforce event compatibility.

### `validateMatcherGroup(data)`

Validates a generic `{ matcher?, hooks }` group. Event-specific matcher support is runtime semantics, not a rejection rule: matchers on no-matcher events are accepted and ignored by Claude Code.

### Exported settings schemas

- `commandHookHandlerSchema`
- `httpHookHandlerSchema`
- `mcpToolHookHandlerSchema`
- `promptHookHandlerSchema`
- `agentHookHandlerSchema`
- `hookHandlerSchema`
- `decisionHookHandlerSchema`
- `externalHookHandlerSchema`
- `startupHookHandlerSchema`
- `matcherGroupSchema`
- `decisionMatcherGroupSchema`
- `externalMatcherGroupSchema`
- `startupMatcherGroupSchema`
- `hookEventNameSchema`
- `hooksConfigSchema`

Handler schemas accept common `timeout`, `statusMessage`, `once`, and `if` fields. Runtime significance is narrower: `once` is honored only in skill frontmatter, and `if` only on tool events. `continueOnBlock` is accepted only for prompt and agent handlers.

## Content validators

- `validateBashCommand(command, rules?)` returns safety issues.
- `DEFAULT_BASH_RULES` is the built-in command rule set.
- `containsSecrets(text)` checks common secret patterns.
- `validateFileSyntax(filePath, content)` validates supported file formats.
- `validateSafeFilePath(filePath)` rejects traversal patterns.
- `normalizeFilePath(path)` is re-exported from utilities.

## `HookValidationError`

`HookValidationError` exposes `code`, `context`, optional `zodError`, and `getDetailedMessage()`. Catch it when callers need stable error classification rather than raw Zod formatting.
