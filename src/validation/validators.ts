/**
 * Zod-based validators for Claude Code hooks
 *
 * CRITICAL: Always use .safeParse() at system boundaries
 * Never bypass runtime validation - this prevents silent data corruption
 *
 * Following established patterns:
 * - Two-step type assertion: unknown → validate → assert
 * - Custom error types for better debugging
 * - Never use 'any' types
 */

import type { z } from 'zod';
import {
  hookInputSchemas,
  toolInputSchemas,
  mcpToolInputSchema,
  hooksConfigSchema,
  hookHandlerSchema,
  matcherGroupSchema,
  rawHistoryLineSchema,
  rawTranscriptPayloadMetadataSchema,
  type HookInputSchema,
  type ToolInputSchema,
  type PreToolUseInputSchema,
  type PostToolUseInputSchema,
  type PermissionRequestInputSchema,
  type PermissionDeniedInputSchema,
  type PostToolUseFailureInputSchema,
  type PostToolBatchInputSchema,
  type UserPromptSubmitInputSchema,
  type UserPromptExpansionInputSchema,
  type SetupInputSchema,
  type SessionStartInputSchema,
  type SessionEndInputSchema,
  type NotificationInputSchema,
  type MessageDisplayInputSchema,
  type StopInputSchema,
  type StopFailureInputSchema,
  type SubagentStartInputSchema,
  type SubagentStopInputSchema,
  type TeammateIdleInputSchema,
  type TaskCreatedInputSchema,
  type TaskCompletedInputSchema,
  type InstructionsLoadedInputSchema,
  type ConfigChangeInputSchema,
  type CwdChangedInputSchema,
  type FileChangedInputSchema,
  type WorktreeCreateInputSchema,
  type WorktreeRemoveInputSchema,
  type PreCompactInputSchema,
  type PostCompactInputSchema,
  type ElicitationInputSchema,
  type ElicitationResultInputSchema,
  type HooksConfigSchema,
  type HookHandlerSchema,
  type MatcherGroupSchema,
  type RawHistoryLineSchema,
  type RawTranscriptPayloadMetadataSchema,
  type TranscriptParseDiagnosticsSchema,
  type TranscriptParseIssueSchema,
} from './schemas.js';

type ToolBearingHookInput =
  | PreToolUseInputSchema
  | PostToolUseInputSchema
  | PermissionRequestInputSchema
  | PermissionDeniedInputSchema
  | PostToolUseFailureInputSchema;

const MCP_TOOL_NAME_PATTERN = /^mcp__[^_]+__[^_]+/;

// =============================================================================
// Custom Error Types
// =============================================================================

/**
 * Custom error class for hook validation failures
 * Provides structured error information for debugging
 */
export class HookValidationError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;
  public readonly zodError?: z.ZodError;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    zodError?: z.ZodError
  ) {
    super(message);
    this.name = 'HookValidationError';
    this.code = code;
    this.context = context;
    if (zodError) {
      this.zodError = zodError;
    }

    // Maintain proper stack trace in V8
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, HookValidationError);
    }
  }

  /**
   * Create a detailed error message including Zod validation details
   */
  public getDetailedMessage(): string {
    let message = `${this.message} (Code: ${this.code})`;

    if (this.zodError) {
      const issues = this.zodError.issues
        .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      message += `\nValidation Issues:\n${issues}`;
    }

    if (Object.keys(this.context).length > 0) {
      message += `\nContext: ${JSON.stringify(this.context, null, 2)}`;
    }

    return message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// =============================================================================
// Hook Input Validation
// =============================================================================

/**
 * Validate hook input using the two-step type assertion pattern
 *
 * @param input - Unknown input data from Claude Code
 * @returns Validated and typed hook input
 * @throws HookValidationError if validation fails
 */
export function validateHookInput(input: unknown): HookInputSchema {
  // Step 1: Basic structure validation
  if (!isRecord(input)) {
    throw new HookValidationError(
      'Hook input must be a non-null object',
      'INVALID_INPUT_TYPE',
      { inputType: typeof input }
    );
  }

  // Step 2: Extract hook event name
  const hookEventName = input['hook_event_name'];
  if (
    hookEventName === null ||
    hookEventName === undefined ||
    typeof hookEventName !== 'string'
  ) {
    throw new HookValidationError(
      'Missing or invalid hook_event_name',
      'MISSING_HOOK_EVENT_NAME',
      { hookEventName, inputKeys: Object.keys(input) }
    );
  }

  switch (hookEventName) {
    case 'Setup':
      return validateSetupInput(input);
    case 'MessageDisplay':
      return validateMessageDisplayInput(input);
    default:
      return validateHookInputByEventName(input, hookEventName);
  }
}

function validateHookInputByEventName(
  input: unknown,
  hookEventName: string
): HookInputSchema {
  // Step 3: Get appropriate schema
  const schema = (
    hookInputSchemas as Record<
      string,
      (typeof hookInputSchemas)[keyof typeof hookInputSchemas] | undefined
    >
  )[hookEventName];
  if (schema === undefined) {
    throw new HookValidationError(
      `Unsupported hook event: ${hookEventName}`,
      'UNSUPPORTED_HOOK_EVENT',
      { hookEventName, supportedEvents: Object.keys(hookInputSchemas) }
    );
  }

  // Step 4: Validate using Zod schema
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HookValidationError(
      `Hook input validation failed for ${hookEventName}`,
      'HOOK_VALIDATION_FAILED',
      { hookEventName, input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate tool input from PreToolUse or PostToolUse hooks
 *
 * @param hookInput - Validated hook input (PreToolUse or PostToolUse)
 * @returns Validated and typed tool input
 * @throws HookValidationError if validation fails
 */
export function validateToolInput(
  hookInput: ToolBearingHookInput
): ToolInputSchema {
  const toolName = hookInput.tool_name;

  // Get appropriate schema for the tool
  const schema = (
    toolInputSchemas as Record<
      string,
      (typeof toolInputSchemas)[keyof typeof toolInputSchemas] | undefined
    >
  )[toolName];
  if (schema === undefined) {
    if (MCP_TOOL_NAME_PATTERN.test(toolName)) {
      const result = mcpToolInputSchema.safeParse(hookInput.tool_input);
      if (!result.success) {
        throw new HookValidationError(
          `MCP tool input validation failed for ${toolName}`,
          'MCP_TOOL_VALIDATION_FAILED',
          { toolName, toolInput: hookInput.tool_input },
          result.error
        );
      }

      return result.data;
    }

    throw new HookValidationError(
      `Unsupported tool: ${toolName}`,
      'UNSUPPORTED_TOOL',
      { toolName, supportedTools: Object.keys(toolInputSchemas) }
    );
  }

  // Validate tool input using Zod schema
  const result = schema.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      `Tool input validation failed for ${toolName}`,
      'TOOL_VALIDATION_FAILED',
      { toolName, toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

// =============================================================================
// Specific Tool Validators (Convenience Functions)
// =============================================================================

/**
 * Validate and extract Bash tool input with proper typing
 */
export function validateBashToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Bash> {
  if (hookInput.tool_name !== 'Bash') {
    throw new HookValidationError(
      `Expected Bash tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Bash', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Bash.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Bash tool input validation failed',
      'BASH_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Write tool input with proper typing
 */
export function validateWriteToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Write> {
  if (hookInput.tool_name !== 'Write') {
    throw new HookValidationError(
      `Expected Write tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Write', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Write.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Write tool input validation failed',
      'WRITE_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Edit tool input with proper typing
 */
export function validateEditToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Edit> {
  if (hookInput.tool_name !== 'Edit') {
    throw new HookValidationError(
      `Expected Edit tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Edit', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Edit.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Edit tool input validation failed',
      'EDIT_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Read tool input with proper typing
 */
export function validateReadToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Read> {
  if (hookInput.tool_name !== 'Read') {
    throw new HookValidationError(
      `Expected Read tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Read', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Read.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Read tool input validation failed',
      'READ_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract WebFetch tool input with proper typing
 */
export function validateWebFetchToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.WebFetch> {
  if (hookInput.tool_name !== 'WebFetch') {
    throw new HookValidationError(
      `Expected WebFetch tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'WebFetch', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.WebFetch.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'WebFetch tool input validation failed',
      'WEBFETCH_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract WebSearch tool input with proper typing
 */
export function validateWebSearchToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.WebSearch> {
  if (hookInput.tool_name !== 'WebSearch') {
    throw new HookValidationError(
      `Expected WebSearch tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'WebSearch', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.WebSearch.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'WebSearch tool input validation failed',
      'WEBSEARCH_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Glob tool input with proper typing
 */
export function validateGlobToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Glob> {
  if (hookInput.tool_name !== 'Glob') {
    throw new HookValidationError(
      `Expected Glob tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Glob', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Glob.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Glob tool input validation failed',
      'GLOB_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Grep tool input with proper typing
 */
export function validateGrepToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Grep> {
  if (hookInput.tool_name !== 'Grep') {
    throw new HookValidationError(
      `Expected Grep tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Grep', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Grep.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Grep tool input validation failed',
      'GREP_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract MultiEdit tool input with proper typing
 */
export function validateMultiEditToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.MultiEdit> {
  if (hookInput.tool_name !== 'MultiEdit') {
    throw new HookValidationError(
      `Expected MultiEdit tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'MultiEdit', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.MultiEdit.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'MultiEdit tool input validation failed',
      'MULTIEDIT_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Task tool input with proper typing
 */
export function validateTaskToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Task> {
  if (hookInput.tool_name !== 'Task') {
    throw new HookValidationError(
      `Expected Task tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Task', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Task.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Task tool input validation failed',
      'TASK_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract Agent tool input with proper typing
 */
export function validateAgentToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.Agent> {
  if (hookInput.tool_name !== 'Agent') {
    throw new HookValidationError(
      `Expected Agent tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'Agent', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.Agent.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'Agent tool input validation failed',
      'AGENT_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract AskUserQuestion tool input with proper typing
 */
export function validateAskUserQuestionToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.AskUserQuestion> {
  if (hookInput.tool_name !== 'AskUserQuestion') {
    throw new HookValidationError(
      `Expected AskUserQuestion tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'AskUserQuestion', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.AskUserQuestion.safeParse(
    hookInput.tool_input
  );
  if (!result.success) {
    throw new HookValidationError(
      'AskUserQuestion tool input validation failed',
      'ASK_USER_QUESTION_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract ExitPlanMode tool input with proper typing
 */
export function validateExitPlanModeToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.ExitPlanMode> {
  if (hookInput.tool_name !== 'ExitPlanMode') {
    throw new HookValidationError(
      `Expected ExitPlanMode tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'ExitPlanMode', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.ExitPlanMode.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'ExitPlanMode tool input validation failed',
      'EXIT_PLAN_MODE_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract TodoWrite tool input with proper typing
 */
export function validateTodoWriteToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof toolInputSchemas.TodoWrite> {
  if (hookInput.tool_name !== 'TodoWrite') {
    throw new HookValidationError(
      `Expected TodoWrite tool, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'TodoWrite', actual: hookInput.tool_name }
    );
  }

  const result = toolInputSchemas.TodoWrite.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'TodoWrite tool input validation failed',
      'TODOWRITE_VALIDATION_FAILED',
      { toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

/**
 * Validate and extract generic MCP tool input with proper typing
 */
export function validateMCPToolInput(
  hookInput: ToolBearingHookInput
): z.infer<typeof mcpToolInputSchema> {
  if (!MCP_TOOL_NAME_PATTERN.test(hookInput.tool_name)) {
    throw new HookValidationError(
      `Expected MCP tool name, got ${hookInput.tool_name}`,
      'WRONG_TOOL_TYPE',
      { expected: 'mcp__<server>__<tool>', actual: hookInput.tool_name }
    );
  }

  const result = mcpToolInputSchema.safeParse(hookInput.tool_input);
  if (!result.success) {
    throw new HookValidationError(
      'MCP tool input validation failed',
      'MCP_TOOL_VALIDATION_FAILED',
      { toolName: hookInput.tool_name, toolInput: hookInput.tool_input },
      result.error
    );
  }

  return result.data;
}

// =============================================================================
// Transcript Validators
// =============================================================================

export type SafeTranscriptValidationResult<T> =
  | { success: true; data: T }
  | { success: false; diagnostics: TranscriptParseDiagnosticsSchema };

function buildTranscriptParseDiagnostics(
  summary: string,
  error: z.ZodError
): TranscriptParseDiagnosticsSchema {
  const issues = flattenTranscriptIssues(error.issues);

  return {
    summary,
    issueCount: issues.length,
    issues,
  };
}

function flattenTranscriptIssues(
  issues: readonly z.ZodIssue[],
  parentPath: readonly (string | number)[] = []
): TranscriptParseIssueSchema[] {
  const flattened: TranscriptParseIssueSchema[] = [];

  for (const issue of issues) {
    const combinedPath = [
      ...parentPath,
      ...issue.path.map(segment =>
        typeof segment === 'number' ? segment : String(segment)
      ),
    ];

    if (
      issue.code === 'invalid_union' &&
      'errors' in issue &&
      Array.isArray(issue.errors)
    ) {
      if (issue.errors.length === 0) {
        // No nested branch errors to recurse into (e.g. a discriminated-union
        // drop where the discriminator value matched no member). Fold the
        // `discriminator`/`note` the issue carries into the message so the
        // diagnostic explains *why* an unknown line type was dropped instead
        // of emitting a bare 'Invalid input'.
        flattened.push({
          code: issue.code,
          path: combinedPath,
          message: augmentUnionMessage(issue),
        });
        continue;
      }

      for (const unionBranchIssues of issue.errors) {
        flattened.push(
          ...flattenTranscriptIssues(unionBranchIssues, combinedPath)
        );
      }
      continue;
    }

    flattened.push({
      code: issue.code,
      path: combinedPath,
      message: issue.message,
    });
  }

  return flattened;
}

/**
 * Read an optional non-empty string property off a Zod issue without using
 * `any`. Both `discriminator` and `note` are optional/non-standard on union
 * issues, so they are accessed defensively (they may be absent).
 */
function readIssueString(
  issue: z.ZodIssue,
  key: 'discriminator' | 'note'
): string | undefined {
  if (!(key in issue)) return undefined;
  const view = issue as unknown;
  if (!isRecord(view)) return undefined;
  const value = view[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build a self-explanatory message for an `invalid_union` issue that carries no
 * nested branch errors, folding in optional `discriminator` and/or `note` so the
 * diagnostic names the offending value instead of a bare 'Invalid input'.
 */
function augmentUnionMessage(issue: z.ZodIssue): string {
  const discriminator = readIssueString(issue, 'discriminator');
  const note = readIssueString(issue, 'note');

  const annotations: string[] = [];
  if (discriminator !== undefined) {
    annotations.push(`discriminator: ${discriminator}`);
  }
  if (note !== undefined) {
    annotations.push(note);
  }

  if (annotations.length === 0) return issue.message;
  return `${issue.message} (${annotations.join('; ')})`;
}

export function safeValidateRawTranscriptPayloadMetadata(
  input: unknown
): SafeTranscriptValidationResult<RawTranscriptPayloadMetadataSchema> {
  const result = rawTranscriptPayloadMetadataSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    diagnostics: buildTranscriptParseDiagnostics(
      'Raw transcript payload metadata validation failed',
      result.error
    ),
  };
}

export function validateRawTranscriptPayloadMetadata(
  input: unknown
): RawTranscriptPayloadMetadataSchema {
  const result = safeValidateRawTranscriptPayloadMetadata(input);
  if (!result.success) {
    throw new HookValidationError(
      'Raw transcript payload metadata validation failed',
      'RAW_TRANSCRIPT_PAYLOAD_METADATA_VALIDATION_FAILED',
      { diagnostics: result.diagnostics }
    );
  }

  return result.data;
}

export function safeValidateRawHistoryLine(
  input: unknown
): SafeTranscriptValidationResult<RawHistoryLineSchema> {
  const result = rawHistoryLineSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    diagnostics: buildTranscriptParseDiagnostics(
      'Raw history line validation failed',
      result.error
    ),
  };
}

export function validateRawHistoryLine(input: unknown): RawHistoryLineSchema {
  const result = safeValidateRawHistoryLine(input);
  if (!result.success) {
    throw new HookValidationError(
      'Raw history line validation failed',
      'RAW_HISTORY_LINE_VALIDATION_FAILED',
      { diagnostics: result.diagnostics }
    );
  }

  return result.data;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Safe validation that returns success/error result instead of throwing
 * Useful for hooks that want to handle validation errors gracefully
 */
export function safeValidateHookInput(input: unknown): {
  success: boolean;
  data?: HookInputSchema;
  error?: HookValidationError;
} {
  try {
    const data = validateHookInput(input);
    return { success: true, data };
  } catch (error) {
    if (error instanceof HookValidationError) {
      return { success: false, error };
    }
    // Convert unexpected errors to HookValidationError
    return {
      success: false,
      error: new HookValidationError(
        'Unexpected validation error',
        'UNEXPECTED_ERROR',
        { originalError: String(error) }
      ),
    };
  }
}

/**
 * Validate that input is specifically a PreToolUse hook
 * Type guard function for narrowing types
 */
export function isPreToolUseInput(
  input: HookInputSchema
): input is PreToolUseInputSchema {
  return input.hook_event_name === 'PreToolUse';
}

/**
 * Validate that input is specifically a PostToolUse hook
 * Type guard function for narrowing types
 */
export function isPostToolUseInput(
  input: HookInputSchema
): input is PostToolUseInputSchema {
  return input.hook_event_name === 'PostToolUse';
}

/**
 * Type guard for PermissionDenied hook input
 */
export function isPermissionDeniedInput(
  input: HookInputSchema
): input is PermissionDeniedInputSchema {
  return input.hook_event_name === 'PermissionDenied';
}

/**
 * Type guard for PostToolBatch hook input
 */
export function isPostToolBatchInput(
  input: HookInputSchema
): input is PostToolBatchInputSchema {
  return input.hook_event_name === 'PostToolBatch';
}

/**
 * Type guard for UserPromptSubmit hook input
 */
export function isUserPromptSubmitInput(
  input: HookInputSchema
): input is UserPromptSubmitInputSchema {
  return input.hook_event_name === 'UserPromptSubmit';
}

/**
 * Type guard for UserPromptExpansion hook input
 */
export function isUserPromptExpansionInput(
  input: HookInputSchema
): input is UserPromptExpansionInputSchema {
  return input.hook_event_name === 'UserPromptExpansion';
}

export function isSetupInput(input: HookInputSchema): input is SetupInputSchema {
  return input.hook_event_name === 'Setup';
}

/**
 * Type guard for SessionStart hook input
 */
export function isSessionStartInput(
  input: HookInputSchema
): input is SessionStartInputSchema {
  return input.hook_event_name === 'SessionStart';
}

/**
 * Type guard for SessionEnd hook input
 */
export function isSessionEndInput(
  input: HookInputSchema
): input is SessionEndInputSchema {
  return input.hook_event_name === 'SessionEnd';
}

/**
 * Type guard for Notification hook input
 */
export function isNotificationInput(
  input: HookInputSchema
): input is NotificationInputSchema {
  return input.hook_event_name === 'Notification';
}

export function isMessageDisplayInput(
  input: HookInputSchema
): input is MessageDisplayInputSchema {
  return input.hook_event_name === 'MessageDisplay';
}

/**
 * Type guard for Stop hook input
 */
export function isStopInput(input: HookInputSchema): input is StopInputSchema {
  return input.hook_event_name === 'Stop';
}

/**
 * Type guard for StopFailure hook input
 */
export function isStopFailureInput(
  input: HookInputSchema
): input is StopFailureInputSchema {
  return input.hook_event_name === 'StopFailure';
}

/**
 * Type guard for SubagentStop hook input
 */
export function isSubagentStopInput(
  input: HookInputSchema
): input is SubagentStopInputSchema {
  return input.hook_event_name === 'SubagentStop';
}

/**
 * Type guard for PreCompact hook input
 */
export function isPreCompactInput(
  input: HookInputSchema
): input is PreCompactInputSchema {
  return input.hook_event_name === 'PreCompact';
}

/**
 * Type guard for PostCompact hook input
 */
export function isPostCompactInput(
  input: HookInputSchema
): input is PostCompactInputSchema {
  return input.hook_event_name === 'PostCompact';
}

/**
 * Type guard for PermissionRequest hook input
 */
export function isPermissionRequestInput(
  input: HookInputSchema
): input is PermissionRequestInputSchema {
  return input.hook_event_name === 'PermissionRequest';
}

/**
 * Type guard for PostToolUseFailure hook input
 */
export function isPostToolUseFailureInput(
  input: HookInputSchema
): input is PostToolUseFailureInputSchema {
  return input.hook_event_name === 'PostToolUseFailure';
}

/**
 * Type guard for SubagentStart hook input
 */
export function isSubagentStartInput(
  input: HookInputSchema
): input is SubagentStartInputSchema {
  return input.hook_event_name === 'SubagentStart';
}

/**
 * Type guard for TeammateIdle hook input
 */
export function isTeammateIdleInput(
  input: HookInputSchema
): input is TeammateIdleInputSchema {
  return input.hook_event_name === 'TeammateIdle';
}

/**
 * Type guard for TaskCompleted hook input
 */
export function isTaskCompletedInput(
  input: HookInputSchema
): input is TaskCompletedInputSchema {
  return input.hook_event_name === 'TaskCompleted';
}

/**
 * Type guard for TaskCreated hook input
 */
export function isTaskCreatedInput(
  input: HookInputSchema
): input is TaskCreatedInputSchema {
  return input.hook_event_name === 'TaskCreated';
}

/**
 * Type guard for InstructionsLoaded hook input
 */
export function isInstructionsLoadedInput(
  input: HookInputSchema
): input is InstructionsLoadedInputSchema {
  return input.hook_event_name === 'InstructionsLoaded';
}

/**
 * Type guard for ConfigChange hook input
 */
export function isConfigChangeInput(
  input: HookInputSchema
): input is ConfigChangeInputSchema {
  return input.hook_event_name === 'ConfigChange';
}

/**
 * Type guard for CwdChanged hook input
 */
export function isCwdChangedInput(
  input: HookInputSchema
): input is CwdChangedInputSchema {
  return input.hook_event_name === 'CwdChanged';
}

/**
 * Type guard for FileChanged hook input
 */
export function isFileChangedInput(
  input: HookInputSchema
): input is FileChangedInputSchema {
  return input.hook_event_name === 'FileChanged';
}

/**
 * Type guard for WorktreeCreate hook input
 */
export function isWorktreeCreateInput(
  input: HookInputSchema
): input is WorktreeCreateInputSchema {
  return input.hook_event_name === 'WorktreeCreate';
}

/**
 * Type guard for WorktreeRemove hook input
 */
export function isWorktreeRemoveInput(
  input: HookInputSchema
): input is WorktreeRemoveInputSchema {
  return input.hook_event_name === 'WorktreeRemove';
}

/**
 * Type guard for Elicitation hook input
 */
export function isElicitationInput(
  input: HookInputSchema
): input is ElicitationInputSchema {
  return input.hook_event_name === 'Elicitation';
}

/**
 * Type guard for ElicitationResult hook input
 */
export function isElicitationResultInput(
  input: HookInputSchema
): input is ElicitationResultInputSchema {
  return input.hook_event_name === 'ElicitationResult';
}

// =============================================================================
// Hook-Type-Specific Validators
// =============================================================================

/**
 * Validate that the input is a valid PreToolUse hook
 * Uses Zod validation internally with better error messages
 */
export function validatePreToolUseInput(input: unknown): PreToolUseInputSchema {
  const validated = validateHookInput(input);

  if (!isPreToolUseInput(validated)) {
    throw new HookValidationError(
      `Expected PreToolUse hook, got ${validated.hook_event_name}`,
      'WRONG_HOOK_TYPE',
      { expected: 'PreToolUse', actual: validated.hook_event_name }
    );
  }

  return validated;
}

/**
 * Validate that the input is a valid PostToolUse hook
 * Uses Zod validation internally with better error messages
 */
export function validatePostToolUseInput(
  input: unknown
): PostToolUseInputSchema {
  const validated = validateHookInput(input);

  if (!isPostToolUseInput(validated)) {
    throw new HookValidationError(
      `Expected PostToolUse hook, got ${validated.hook_event_name}`,
      'WRONG_HOOK_TYPE',
      { expected: 'PostToolUse', actual: validated.hook_event_name }
    );
  }

  return validated;
}

function validateHookInputType(
  input: unknown,
  eventName: 'Setup'
): SetupInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'UserPromptExpansion'
): UserPromptExpansionInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'PermissionDenied'
): PermissionDeniedInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'PostToolBatch'
): PostToolBatchInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'TaskCreated'
): TaskCreatedInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'StopFailure'
): StopFailureInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'InstructionsLoaded'
): InstructionsLoadedInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'ConfigChange'
): ConfigChangeInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'CwdChanged'
): CwdChangedInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'FileChanged'
): FileChangedInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'WorktreeCreate'
): WorktreeCreateInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'WorktreeRemove'
): WorktreeRemoveInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'PostCompact'
): PostCompactInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'Elicitation'
): ElicitationInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'MessageDisplay'
): MessageDisplayInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: 'ElicitationResult'
): ElicitationResultInputSchema;
function validateHookInputType(
  input: unknown,
  eventName: string
): HookInputSchema {
  const validated = validateHookInputByEventName(input, eventName);

  if (validated.hook_event_name !== eventName) {
    throw new HookValidationError(
      `Expected ${eventName} hook, got ${validated.hook_event_name}`,
      'WRONG_HOOK_TYPE',
      { expected: eventName, actual: validated.hook_event_name }
    );
  }

  return validated;
}

export function validateSetupInput(input: unknown): SetupInputSchema {
  return validateHookInputType(input, 'Setup');
}

export function validateUserPromptExpansionInput(
  input: unknown
): UserPromptExpansionInputSchema {
  return validateHookInputType(input, 'UserPromptExpansion');
}

export function validatePermissionDeniedInput(
  input: unknown
): PermissionDeniedInputSchema {
  return validateHookInputType(input, 'PermissionDenied');
}

export function validatePostToolBatchInput(
  input: unknown
): PostToolBatchInputSchema {
  return validateHookInputType(input, 'PostToolBatch');
}

export function validateTaskCreatedInput(
  input: unknown
): TaskCreatedInputSchema {
  return validateHookInputType(input, 'TaskCreated');
}

export function validateStopFailureInput(
  input: unknown
): StopFailureInputSchema {
  return validateHookInputType(input, 'StopFailure');
}

export function validateInstructionsLoadedInput(
  input: unknown
): InstructionsLoadedInputSchema {
  return validateHookInputType(input, 'InstructionsLoaded');
}

export function validateConfigChangeInput(
  input: unknown
): ConfigChangeInputSchema {
  return validateHookInputType(input, 'ConfigChange');
}

export function validateCwdChangedInput(input: unknown): CwdChangedInputSchema {
  return validateHookInputType(input, 'CwdChanged');
}

export function validateFileChangedInput(
  input: unknown
): FileChangedInputSchema {
  return validateHookInputType(input, 'FileChanged');
}

export function validateWorktreeCreateInput(
  input: unknown
): WorktreeCreateInputSchema {
  return validateHookInputType(input, 'WorktreeCreate');
}

export function validateWorktreeRemoveInput(
  input: unknown
): WorktreeRemoveInputSchema {
  return validateHookInputType(input, 'WorktreeRemove');
}

export function validatePostCompactInput(
  input: unknown
): PostCompactInputSchema {
  return validateHookInputType(input, 'PostCompact');
}

export function validateMessageDisplayInput(
  input: unknown
): MessageDisplayInputSchema {
  return validateHookInputType(input, 'MessageDisplay');
}

export function validateElicitationInput(
  input: unknown
): ElicitationInputSchema {
  return validateHookInputType(input, 'Elicitation');
}

export function validateElicitationResultInput(
  input: unknown
): ElicitationResultInputSchema {
  return validateHookInputType(input, 'ElicitationResult');
}

// =============================================================================
// Hook Configuration Validators
// =============================================================================

/**
 * Validate a full hooks configuration block (e.g., parsed from settings.json)
 */
export function validateHooksConfig(data: unknown): HooksConfigSchema {
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new HookValidationError(
      'Hooks config must be a non-null object',
      'INVALID_CONFIG_TYPE',
      { dataType: typeof data }
    );
  }

  const result = hooksConfigSchema.safeParse(data);
  if (!result.success) {
    throw new HookValidationError(
      'Invalid hooks configuration',
      'INVALID_HOOKS_CONFIG',
      {},
      result.error
    );
  }

  return result.data;
}

/**
 * Validate a single hook handler object
 */
export function validateHookHandler(data: unknown): HookHandlerSchema {
  const result = hookHandlerSchema.safeParse(data);
  if (!result.success) {
    throw new HookValidationError(
      'Invalid hook handler',
      'INVALID_HOOK_HANDLER',
      {},
      result.error
    );
  }

  return result.data;
}

/**
 * Validate a matcher group object
 */
export function validateMatcherGroup(data: unknown): MatcherGroupSchema {
  const result = matcherGroupSchema.safeParse(data);
  if (!result.success) {
    throw new HookValidationError(
      'Invalid matcher group',
      'INVALID_MATCHER_GROUP',
      {},
      result.error
    );
  }

  return result.data;
}

// =============================================================================
// Content Validators
// =============================================================================

/**
 * Validation rules for bash commands
 */
export interface BashValidationRule {
  pattern: RegExp;
  message: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}

/**
 * Default bash command validation rules
 */
export const DEFAULT_BASH_RULES: BashValidationRule[] = [
  {
    pattern: /\bgrep\b(?!.*\|)/,
    message: "Use 'rg' (ripgrep) instead of 'grep' for better performance",
    severity: 'warning',
    suggestion: 'Replace grep with rg for faster searches',
  },
  {
    pattern: /\bfind\s+\S+\s+-name\b/,
    message: "Use 'rg --files | rg pattern' instead of 'find -name'",
    severity: 'warning',
    suggestion: 'Use ripgrep for file searching',
  },
  {
    pattern: /\brm\s+-rf?\s+[\/~]/,
    message: 'Dangerous recursive delete command detected',
    severity: 'error',
    suggestion: 'Be very careful with rm -rf commands',
  },
  {
    pattern: /\bsudo\s+rm\b/,
    message: 'Potentially dangerous sudo rm command',
    severity: 'error',
    suggestion: 'Double-check file paths before running sudo rm',
  },
  {
    pattern: /\bchmod\s+777\b/,
    message: 'chmod 777 creates security vulnerabilities',
    severity: 'warning',
    suggestion: 'Use more restrictive permissions like 755 or 644',
  },
  {
    pattern: /\bmv\s+[^|]+\s+\/dev\/null/,
    message: 'Moving files to /dev/null effectively deletes them',
    severity: 'warning',
    suggestion: 'Use rm instead of mv to /dev/null',
  },
  {
    pattern: /\|\s*sh\s*$/,
    message: 'Piping to sh can be dangerous with untrusted input',
    severity: 'warning',
    suggestion: 'Verify the source before piping to shell',
  },
];

/**
 * Validate a bash command against a set of rules
 */
export function validateBashCommand(
  command: string,
  rules: BashValidationRule[] = DEFAULT_BASH_RULES
): { isValid: boolean; issues: Array<BashValidationRule & { match: string }> } {
  const issues: Array<BashValidationRule & { match: string }> = [];

  for (const rule of rules) {
    const match = command.match(rule.pattern);
    if (match) {
      issues.push({
        ...rule,
        match: match[0],
      });
    }
  }

  const hasErrors = issues.some(issue => issue.severity === 'error');

  return {
    isValid: !hasErrors,
    issues,
  };
}

// =============================================================================
// File Content Validators
// =============================================================================

/**
 * Check if file content contains potential secrets
 */
export function containsSecrets(content: string, filePath: string): boolean {
  const skipExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.svg',
    '.ico',
    '.pdf',
  ];
  if (skipExtensions.some(ext => filePath.toLowerCase().endsWith(ext))) {
    return false;
  }

  const secretPatterns = [
    /(password|pwd)\s*[=:]\s*['"]\w+['"]/i,
    /(api[_-]?key|apikey)\s*[=:]\s*['"]\w+['"]/i,
    /(secret|token)\s*[=:]\s*['"]\w+['"]/i,
    /(private[_-]?key|privatekey)\s*[=:]/i,
    /sk-[a-zA-Z0-9]{32,}/, // OpenAI API keys
    /ghp_[a-zA-Z0-9]{36}/, // GitHub personal access tokens
    /xoxb-[a-zA-Z0-9-]+/, // Slack bot tokens
  ];

  return secretPatterns.some(pattern => pattern.test(content));
}

/**
 * Check if file content has basic syntax issues
 */
export function validateFileSyntax(
  content: string,
  filePath: string
): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (filePath.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch (error) {
      errors.push(
        `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  if (filePath.match(/\.(ts|tsx|js|jsx)$/)) {
    const openBrackets = (content.match(/[{[]/g) ?? []).length;
    const closeBrackets = (content.match(/[}\]]/g) ?? []).length;

    if (openBrackets !== closeBrackets) {
      errors.push('Unmatched brackets detected');
    }

    const singleQuotes = (content.match(/(?<!\\)'/g) ?? []).length;
    const doubleQuotes = (content.match(/(?<!\\)"/g) ?? []).length;

    if (singleQuotes % 2 !== 0) {
      errors.push('Unmatched single quotes detected');
    }

    if (doubleQuotes % 2 !== 0) {
      errors.push('Unmatched double quotes detected');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Path Validators
// =============================================================================

/**
 * Normalize file paths for consistent processing
 * Handles redundant slashes, trailing slashes, and relative path components
 */
export function normalizeFilePath(filePath: string): string {
  let normalized = filePath.replace(/\/+/g, '/');

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  const parts = normalized.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') {
      continue;
    } else if (part === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else {
        resolved.push('..');
      }
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/') ?? '/';
}

/**
 * Check if a file path is safe for operations
 */
export function validateSafeFilePath(filePath: string): {
  isSafe: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (filePath.includes('..')) {
    issues.push('Path traversal detected (..)');
  }

  const dangerousPaths = [
    '/etc/',
    '/bin/',
    '/sbin/',
    '/usr/bin/',
    '/usr/sbin/',
  ];
  if (dangerousPaths.some(path => filePath.startsWith(path))) {
    issues.push('Path targets system directory');
  }

  const sensitivePatterns = [
    /\/\.env/,
    /\/\.git\//,
    /\/\.ssh\//,
    /\/\.aws\//,
    /\/\.docker\//,
    /\/id_rsa/,
    /\/id_ed25519/,
  ];

  if (sensitivePatterns.some(pattern => pattern.test(filePath))) {
    issues.push('Path targets sensitive file or directory');
  }

  return {
    isSafe: issues.length === 0,
    issues,
  };
}
