import { describe, it, expect } from 'vitest';

function assertHookValidationError(
  error: unknown
): asserts error is HookValidationError {
  if (!(error instanceof HookValidationError)) {
    throw new Error(`Expected HookValidationError, got ${String(error)}`);
  }
}
import {
  validateHookInput,
  validateToolInput,
  validateBashToolInput,
  validateWriteToolInput,
  validateEditToolInput,
  validateReadToolInput,
  validateWebFetchToolInput,
  validateWebSearchToolInput,
  validateAgentToolInput,
  validateAskUserQuestionToolInput,
  validateExitPlanModeToolInput,
  validateTodoWriteToolInput,
  validateMCPToolInput,
  validateTaskToolInput,
  safeValidateHookInput,
  isPreToolUseInput,
  isPostToolUseInput,
  isPermissionRequestInput,
  isPermissionDeniedInput,
  isPostToolUseFailureInput,
  isPostToolBatchInput,
  isUserPromptSubmitInput,
  isUserPromptExpansionInput,
  isSetupInput,
  isSessionStartInput,
  isSessionEndInput,
  isNotificationInput,
  isMessageDisplayInput,
  isStopInput,
  isStopFailureInput,
  isSubagentStartInput,
  isSubagentStopInput,
  isTeammateIdleInput,
  isTaskCreatedInput,
  isTaskCompletedInput,
  isInstructionsLoadedInput,
  isConfigChangeInput,
  isCwdChangedInput,
  isFileChangedInput,
  isWorktreeCreateInput,
  isWorktreeRemoveInput,
  isPreCompactInput,
  isPostCompactInput,
  isElicitationInput,
  isElicitationResultInput,
  HookValidationError,
  validatePreToolUseInput,
  validatePostToolUseInput,
  validateUserPromptExpansionInput,
  validatePermissionDeniedInput,
  validatePostToolBatchInput,
  validateTaskCreatedInput,
  validateStopFailureInput,
  validateInstructionsLoadedInput,
  validateConfigChangeInput,
  validateCwdChangedInput,
  validateFileChangedInput,
  validateWorktreeCreateInput,
  validateWorktreeRemoveInput,
  validatePostCompactInput,
  validateSetupInput,
  validateMessageDisplayInput,
  validateElicitationInput,
  validateElicitationResultInput,
  permissionRequestOutputSchema,
  permissionDeniedOutputSchema,
  preToolUseOutputSchema,
  postToolUseOutputSchema,
  postToolUseFailureOutputSchema,
  postToolBatchOutputSchema,
  userPromptSubmitOutputSchema,
  userPromptExpansionOutputSchema,
  stopOutputSchema,
  baseHookOutputSchema,
  notificationOutputSchema,
  sessionStartOutputSchema,
  subagentStartOutputSchema,
  preCompactOutputSchema,
  configChangeOutputSchema,
  watchPathsOutputSchema,
  worktreeCreateOutputSchema,
  elicitationOutputSchema,
  elicitationResultOutputSchema,
  validateGlobToolInput,
  validateGrepToolInput,
  validateMultiEditToolInput,
  globToolInputSchema,
  grepToolInputSchema,
  multiEditToolInputSchema,
  agentToolInputSchema,
  askUserQuestionToolInputSchema,
  exitPlanModeToolInputSchema,
  todoWriteToolInputSchema,
  mcpToolInputSchema,
  commandHookHandlerSchema,
  httpHookHandlerSchema,
  mcpToolHookHandlerSchema,
  promptHookHandlerSchema,
  agentHookHandlerSchema,
  hookHandlerSchema,
  matcherGroupSchema,
  hookEventNameSchema,
  hooksConfigSchema,
  validateHooksConfig,
  validateHookHandler,
  validateMatcherGroup,
  hookInputSchemas,
  hookOutputSchemas,
  toolInputSchemas,
  imageContentBlockSchema,
  rawHistoryLineSchema,
  rawTranscriptPayloadMetadataSchema,
  safeValidateRawHistoryLine,
  safeValidateRawTranscriptPayloadMetadata,
  validateRawHistoryLine,
  validateRawTranscriptPayloadMetadata,
} from '../src/validation/index.js';
import { HookOutputBuilder } from '../src/utils/output-builder.js';
import {
  createPreToolUseInput,
  createPostToolUseInput,
  createBashToolInput,
  createBashPreToolUseInput,
  createWritePreToolUseInput,
  createTestHookBase,
  createSetupInput,
  createMessageDisplayInput,
  createPermissionRequestInput,
  createPermissionDeniedInput,
  createPostToolUseFailureInput,
  createPostToolBatchInput,
  createUserPromptSubmitInput,
  createUserPromptExpansionInput,
  createSessionStartInput,
  createSessionEndInput,
  createNotificationInput,
  createStopInput,
  createStopFailureInput,
  createSubagentStartInput,
  createSubagentStopInput,
  createTeammateIdleInput,
  createTaskCreatedInput,
  createTaskCompletedInput,
  createInstructionsLoadedInput,
  createConfigChangeInput,
  createCwdChangedInput,
  createFileChangedInput,
  createWorktreeCreateInput,
  createWorktreeRemoveInput,
  createPreCompactInput,
  createPostCompactInput,
  createElicitationInput,
  createElicitationResultInput,
  expectValidationError,
  createValidationTestCases,
} from './test-utils.js';

describe('Zod-based Hook Validation', () => {
  it('should validate basic hook input structure', () => {
    const validInput = createPreToolUseInput('Bash', { command: 'echo test' });
    const result = validateHookInput(validInput);

    expect(result).toBeDefined();
    expect(result.hook_event_name).toBe('PreToolUse');
    if ('tool_name' in result) {
      expect(result.tool_name).toBe('Bash');
    }
  });

  it('should reject invalid hook input with detailed errors', () => {
    const invalidInput = { invalid: 'structure' };

    expectValidationError(
      () => validateHookInput(invalidInput),
      'MISSING_HOOK_EVENT_NAME'
    );
  });

  it('should validate Bash tool input correctly', () => {
    const hookInput = createBashPreToolUseInput('ls -la');
    const toolInput = validateBashToolInput(hookInput);

    expect(toolInput.command).toBe('ls -la');
  });

  it('should handle various Bash validation scenarios', () => {
    const validBashInput = createBashToolInput('echo hello');

    const testCases = createValidationTestCases(validBashInput, [
      {
        description: 'empty command',
        input: { command: '' },
        expectedError: 'BASH_VALIDATION_FAILED',
      },
      {
        description: 'missing command',
        input: { command: undefined },
        expectedError: 'BASH_VALIDATION_FAILED',
      },
    ]);

    for (const testCase of testCases) {
      if (testCase.shouldPass) {
        const hookInput = createPreToolUseInput('Bash', testCase.input);
        const result = validateBashToolInput(hookInput);
        expect(result).toBeDefined();
      } else {
        const hookInput = createPreToolUseInput('Bash', testCase.input);
        expect(() => validateBashToolInput(hookInput)).toThrow();
      }
    }
  });

  it('should provide detailed error context for debugging', () => {
    const invalidInput = {
      session_id: 'test',
    };

    try {
      validateHookInput(invalidInput);
      expect.fail('Should have thrown validation error');
    } catch (error) {
      assertHookValidationError(error);

      expect(error.code).toBeDefined();
      expect(error.context).toBeDefined();
      expect(error.getDetailedMessage()).toContain('Context:');
    }
  });
});

describe('Validation Error Handling', () => {
  it('should create structured validation errors', () => {
    const error = new HookValidationError(
      'Test validation failed',
      'TEST_ERROR',
      { testField: 'testValue' }
    );

    expect(error.message).toBe('Test validation failed');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.context).toEqual({ testField: 'testValue' });
    expect(error.name).toBe('HookValidationError');
  });

  it('should generate detailed error messages', () => {
    const error = new HookValidationError(
      'Validation failed',
      'DETAILED_ERROR',
      { field1: 'value1', field2: 'value2' }
    );

    const detailedMessage = error.getDetailedMessage();

    expect(detailedMessage).toContain('Validation failed');
    expect(detailedMessage).toContain('DETAILED_ERROR');
    expect(detailedMessage).toContain('Context:');
    expect(detailedMessage).toContain('field1');
    expect(detailedMessage).toContain('value1');
  });
});

describe('Updated Schema Validation (Phase 1)', () => {
  it('should allow permission_mode to be omitted', () => {
    const inputWithoutPermissionMode = {
      session_id: 'test',
      transcript_path: '/tmp/t.json',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_use_id: 'tuid-1',
    };
    const result = validateHookInput(inputWithoutPermissionMode);
    expect(result.hook_event_name).toBe('PreToolUse');
  });

  it('should validate auto permission_mode', () => {
    const input = createPreToolUseInput(
      'Bash',
      { command: 'echo hi' },
      { permission_mode: 'auto' }
    );
    const result = validateHookInput(input);
    expect(result.permission_mode).toBe('auto');
  });

  it('should require tool_use_id in PreToolUse', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'PreToolUse' }),
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate SessionStart with model field', () => {
    const input = createSessionStartInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('SessionStart');
    if ('model' in result) {
      expect(result.model).toBe('claude-sonnet-4-5-20250929');
    }
  });

  it('should validate Setup with init and maintenance triggers', () => {
    const setupInputs = ['init', 'maintenance'].map(trigger => ({
      ...createTestHookBase({ hook_event_name: 'Setup' }),
      hook_event_name: 'Setup' as const,
      trigger,
    }));

    for (const input of setupInputs) {
      const result = validateSetupInput(input);
      expect(result.hook_event_name).toBe('Setup');
      expect(result.trigger).toBe(input.trigger);
    }
  });

  it('should reject Setup with an invalid trigger', () => {
    expectValidationError(
      () =>
        validateSetupInput({
          ...createTestHookBase({ hook_event_name: 'Setup' }),
          hook_event_name: 'Setup',
          trigger: 'boot',
        }),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate MessageDisplay with UUID turn and message ids', () => {
    const result = validateMessageDisplayInput({
      ...createTestHookBase({ hook_event_name: 'MessageDisplay' }),
      hook_event_name: 'MessageDisplay',
      turn_id: '11111111-1111-4111-8111-111111111111',
      message_id: '22222222-2222-4222-8222-222222222222',
      index: 0,
      final: false,
      delta: 'Hello',
    });

    expect(result.hook_event_name).toBe('MessageDisplay');
    expect(result.turn_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.message_id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('should reject MessageDisplay with an invalid UUID', () => {
    expectValidationError(
      () =>
        validateMessageDisplayInput({
          ...createTestHookBase({ hook_event_name: 'MessageDisplay' }),
          hook_event_name: 'MessageDisplay',
          turn_id: 'not-a-uuid',
          message_id: '22222222-2222-4222-8222-222222222222',
          index: 0,
          final: true,
          delta: 'Done',
        }),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should route Setup through the common hook validator', () => {
    const result = validateHookInput(
      createSetupInput({ trigger: 'maintenance' })
    );

    expect(result.hook_event_name).toBe('Setup');
    if (isSetupInput(result)) {
      expect(result.trigger).toBe('maintenance');
    }
  });

  it('should route MessageDisplay through the common hook validator with empty deltas', () => {
    const result = validateHookInput(
      createMessageDisplayInput({ index: 2, final: true, delta: '' })
    );

    expect(result.hook_event_name).toBe('MessageDisplay');
    if (isMessageDisplayInput(result)) {
      expect(result.index).toBe(2);
      expect(result.final).toBe(true);
      expect(result.delta).toBe('');
    }
  });

  it('should validate SessionStart when model is omitted and session_title is provided', () => {
    const result = validateHookInput(
      createSessionStartInput({
        model: undefined,
        session_title: 'Recovered session',
      })
    );

    expect(result.hook_event_name).toBe('SessionStart');
    if ('model' in result) {
      expect(result.model).toBeUndefined();
    }
    if ('session_title' in result) {
      expect(result.session_title).toBe('Recovered session');
    }
  });

  it('should validate the common effort field for valid levels', () => {
    const result = validateHookInput(
      createSessionStartInput({ effort: { level: 'xhigh' } })
    );

    expect(result.effort).toEqual({ level: 'xhigh' });
  });

  it('should reject invalid common effort levels', () => {
    expectValidationError(
      () =>
        validateHookInput({
          ...createSessionStartInput(),
          effort: { level: 'turbo' },
        }),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate duration_ms on PostToolUse inputs', () => {
    const result = validatePostToolUseInput({
      ...createPostToolUseInput(
        'Bash',
        { command: 'pnpm run test:run' },
        { stdout: 'ok' }
      ),
      duration_ms: 125,
    });

    expect(result.duration_ms).toBe(125);
  });

  it('should validate duration_ms on PostToolUseFailure inputs', () => {
    const result = validateHookInput({
      ...createPostToolUseFailureInput(
        'Bash',
        { command: 'pnpm run test:run' },
        'Command failed'
      ),
      duration_ms: 250,
    });

    expect(result.hook_event_name).toBe('PostToolUseFailure');
    if ('duration_ms' in result) {
      expect(result.duration_ms).toBe(250);
    }
  });

  it('should validate SessionEnd with bypass_permissions_disabled reason', () => {
    const input = createSessionEndInput('bypass_permissions_disabled');
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('SessionEnd');
  });

  it('should validate SessionEnd with resume reason', () => {
    const input = createSessionEndInput('resume');
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('SessionEnd');
  });

  it('should validate Notification with notification_type', () => {
    const input = createNotificationInput('test msg', 'permission_prompt');
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('Notification');
    if ('notification_type' in result) {
      expect(result.notification_type).toBe('permission_prompt');
    }
  });

  it('should validate Stop input', () => {
    const input = createStopInput({
      last_assistant_message: 'Done with the task.',
    });
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('Stop');
    if ('last_assistant_message' in result) {
      expect(result.last_assistant_message).toBe('Done with the task.');
    }
  });

  it('should validate SubagentStop with agent fields', () => {
    const input = createSubagentStopInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('SubagentStop');
    if ('agent_type' in result) {
      expect(result.agent_type).toBe('Explore');
    }
    if ('last_assistant_message' in result) {
      expect(result.last_assistant_message).toBe('Analysis complete.');
    }
  });

  it('should validate PreCompact input', () => {
    const input = createPreCompactInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PreCompact');
  });

  it('should tolerate extra fields via passthrough', () => {
    const input = {
      ...createPreToolUseInput('Bash', { command: 'ls' }),
      some_future_field: 'unknown_value',
    };
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PreToolUse');
  });
});

describe('Transcript Validation Primitives', () => {
  const baseHistoryFields = {
    sessionId: 'test-session-001',
    timestamp: '2026-02-16T20:00:00.000Z',
    uuid: 'hist-001',
  };

  it('validates a user history line with string content', () => {
    const result = validateRawHistoryLine({
      type: 'user',
      ...baseHistoryFields,
      message: {
        role: 'user',
        content: 'What files handle routing in this project?',
      },
    });

    expect(result.type).toBe('user');
    if (result.type === 'user') {
      expect(result.message.content).toBe(
        'What files handle routing in this project?'
      );
    }
  });

  it('validates an assistant history line with known content blocks and preserves future fields', () => {
    const result = validateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-002',
      future_outer_field: 'outer',
      message: {
        role: 'assistant',
        future_message_field: 'message',
        content: [
          {
            type: 'text',
            text: 'Here is my recommendation.',
            future_block_field: true,
          },
          {
            type: 'tool_use',
            id: 'tu-001',
            name: 'Read',
            input: { file_path: '/project/src/routes/index.ts' },
          },
        ],
      },
    });

    expect(result).toHaveProperty('future_outer_field', 'outer');
    if (result.type === 'assistant') {
      expect(result.message).toHaveProperty('future_message_field', 'message');
      expect(Array.isArray(result.message.content)).toBe(true);
      if (Array.isArray(result.message.content)) {
        expect(result.message.content[0]).toHaveProperty(
          'future_block_field',
          true
        );
      }
    }
  });

  it('validates a system history line without a message payload', () => {
    const result = validateRawHistoryLine({
      type: 'system',
      ...baseHistoryFields,
      uuid: 'hist-003',
      cwd: '/project',
    });

    expect(result.type).toBe('system');
    expect(result.cwd).toBe('/project');
  });

  it('validates a result history line with summary fields', () => {
    const result = validateRawHistoryLine({
      type: 'result',
      ...baseHistoryFields,
      uuid: 'hist-004',
      costUSD: 0.0234,
      duration: 10000,
      result: 'Session completed',
    });

    expect(result.type).toBe('result');
    expect(result.costUSD).toBe(0.0234);
    expect(result.duration).toBe(10000);
  });

  it('returns structured diagnostics for malformed nested content blocks', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-005',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-002',
            content: [{ type: 123 }],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics.summary).toBe(
        'Raw history line validation failed'
      );
      expect(result.diagnostics.issueCount).toBeGreaterThan(0);
      expect(result.diagnostics.issues).toContainEqual({
        code: 'invalid_type',
        path: ['message', 'content', 0, 'content', 0, 'type'],
        message: 'Invalid input: expected string, received number',
      });
    }
  });

  it('accepts image content blocks with source metadata', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-009',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc123',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('keeps concrete diagnostics for unsupported content block discriminators', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-009-unsupported',
      message: {
        role: 'assistant',
        content: [{ type: 'document', source: 'future-block' }],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics.issues).toContainEqual({
        code: 'invalid_union',
        path: ['message', 'content', 0, 'type'],
        message:
          'Invalid input (discriminator: type; No matching discriminator)',
      });
    }
  });

  it('validates user image content blocks', () => {
    const result = safeValidateRawHistoryLine({
      type: 'user',
      ...baseHistoryFields,
      uuid: 'hist-image-user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { media_type: 'image/jpeg', data: 'abc' } },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('validates assistant image content blocks', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-image-assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'image', source: { media_type: 'image/webp', data: 'abc' } },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('validates mixed text and image content blocks', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      ...baseHistoryFields,
      uuid: 'hist-image-mixed',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'See this screenshot.' },
          { type: 'image', source: { media_type: 'image/png', data: 'abc' } },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('validates image-only content blocks', () => {
    const result = imageContentBlockSchema.safeParse({
      type: 'image',
      source: { media_type: 'image/png', data: 'abc' },
    });

    expect(result.success).toBe(true);
  });

  it('validates image content blocks with missing source', () => {
    const result = imageContentBlockSchema.safeParse({ type: 'image' });

    expect(result.success).toBe(true);
  });

  it('returns structured diagnostics for malformed history line shapes', () => {
    const result = safeValidateRawHistoryLine({
      type: 'assistant',
      timestamp: '2026-02-16T20:00:00.000Z',
      uuid: 'hist-006',
      message: {
        role: 'assistant',
        content: 'Missing session id',
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics.issues).toContainEqual({
        code: 'invalid_type',
        path: ['sessionId'],
        message: 'Invalid input: expected string, received undefined',
      });
    }
  });

  it('validates transcript payload metadata and preserves future fields', () => {
    const result = validateRawTranscriptPayloadMetadata({
      type: 'assistant',
      sessionId: 'test-session-001',
      timestamp: '2026-02-16T20:00:00.000Z',
      uuid: 'hist-007',
      future_meta_field: 'kept',
    });

    expect(result).toHaveProperty('future_meta_field', 'kept');
    expect(rawTranscriptPayloadMetadataSchema.safeParse(result).success).toBe(
      true
    );
    expect(
      rawHistoryLineSchema.safeParse({
        type: 'assistant',
        ...baseHistoryFields,
        uuid: 'hist-008',
        message: {
          role: 'assistant',
          content: 'Schema round-trip check',
        },
      }).success
    ).toBe(true);
  });

  it('returns diagnostics when transcript payload metadata is malformed', () => {
    const result = safeValidateRawTranscriptPayloadMetadata({
      timestamp: 123,
      sessionId: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics.summary).toBe(
        'Raw transcript payload metadata validation failed'
      );
      expect(result.diagnostics.issueCount).toBe(2);
    }
  });
});

describe('HookOutputBuilder', () => {
  it('success() without message returns suppressOutput: true', () => {
    const output = HookOutputBuilder.success();
    expect(output.suppressOutput).toBe(true);
    expect(output).not.toHaveProperty('systemMessage');
  });

  it('success(msg) returns suppressOutput: false with systemMessage', () => {
    const output = HookOutputBuilder.success('All good');
    expect(output.suppressOutput).toBe(false);
    expect(output.systemMessage).toBe('All good');
  });

  it('error(reason) returns continue: true with systemMessage', () => {
    const output = HookOutputBuilder.error('Something failed');
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toBe('Something failed');
    expect(output).not.toHaveProperty('stopReason');
  });

  it('error(reason, true) returns continue: false with stopReason', () => {
    const output = HookOutputBuilder.error('Fatal error', true);
    expect(output.continue).toBe(false);
    expect(output.stopReason).toBe('Fatal error');
    expect(output.systemMessage).toBe('Fatal error');
  });

  it('permission(allow) returns correct hookSpecificOutput', () => {
    const output = HookOutputBuilder.permission('allow', 'Approved');
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved',
    });
  });

  it('permission(deny) returns correct hookSpecificOutput', () => {
    const output = HookOutputBuilder.permission('deny', 'Blocked');
    expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput?.permissionDecisionReason).toBe('Blocked');
  });

  it('permission(ask) returns correct hookSpecificOutput', () => {
    const output = HookOutputBuilder.permission('ask', 'Confirm?');
    expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
  });

  it('feedback(reason, context) returns correct PostToolUse output', () => {
    const output = HookOutputBuilder.feedback('Issue found', 'Extra context');
    expect(output.decision).toBe('block');
    expect(output.reason).toBe('Issue found');
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: 'Extra context',
    });
  });

  it('feedback(reason) without context omits additionalContext', () => {
    const output = HookOutputBuilder.feedback('Issue found');
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
    });
  });

  it('addContext(text) returns UserPromptSubmit output', () => {
    const output = HookOutputBuilder.addContext('Additional info');
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Additional info',
    });
  });

  it('blockPrompt(reason) returns block decision', () => {
    const output = HookOutputBuilder.blockPrompt('Not allowed');
    expect(output.decision).toBe('block');
    expect(output.reason).toBe('Not allowed');
  });
});

describe('Type Guards', () => {
  it('isPreToolUseInput returns true for PreToolUse', () => {
    const input = createPreToolUseInput('Bash', { command: 'ls' });
    const validated = validateHookInput(input);
    expect(isPreToolUseInput(validated)).toBe(true);
  });

  it('isPreToolUseInput returns false for other events', () => {
    const input = createStopInput();
    const validated = validateHookInput(input);
    expect(isPreToolUseInput(validated)).toBe(false);
  });

  it('isPostToolUseInput returns true for PostToolUse', () => {
    const input = createPostToolUseInput(
      'Bash',
      { command: 'ls' },
      { output: 'file.txt' }
    );
    const validated = validateHookInput(input);
    expect(isPostToolUseInput(validated)).toBe(true);
  });

  it('isPostToolUseInput returns false for other events', () => {
    const input = createPreToolUseInput('Bash', { command: 'ls' });
    const validated = validateHookInput(input);
    expect(isPostToolUseInput(validated)).toBe(false);
  });

  it('isUserPromptSubmitInput identifies correctly', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'UserPromptSubmit' }),
      hook_event_name: 'UserPromptSubmit' as const,
      prompt: 'test prompt',
    };
    const validated = validateHookInput(input);
    expect(isUserPromptSubmitInput(validated)).toBe(true);
    expect(isPreToolUseInput(validated)).toBe(false);
  });

  it('isSessionStartInput identifies correctly', () => {
    const input = createSessionStartInput();
    const validated = validateHookInput(input);
    expect(isSessionStartInput(validated)).toBe(true);
    expect(isSessionEndInput(validated)).toBe(false);
  });

  it('isSessionEndInput identifies correctly', () => {
    const input = createSessionEndInput();
    const validated = validateHookInput(input);
    expect(isSessionEndInput(validated)).toBe(true);
    expect(isSessionStartInput(validated)).toBe(false);
  });

  it('isNotificationInput identifies correctly', () => {
    const input = createNotificationInput('test', 'idle_prompt');
    const validated = validateHookInput(input);
    expect(isNotificationInput(validated)).toBe(true);
  });

  it('isSetupInput identifies correctly', () => {
    const input = createSetupInput();
    const validated = validateHookInput(input);
    expect(isSetupInput(validated)).toBe(true);
    expect(isMessageDisplayInput(validated)).toBe(false);
  });

  it('isMessageDisplayInput identifies correctly', () => {
    const input = createMessageDisplayInput();
    const validated = validateHookInput(input);
    expect(isMessageDisplayInput(validated)).toBe(true);
    expect(isSetupInput(validated)).toBe(false);
  });

  it('isStopInput identifies correctly', () => {
    const input = createStopInput();
    const validated = validateHookInput(input);
    expect(isStopInput(validated)).toBe(true);
    expect(isSubagentStopInput(validated)).toBe(false);
  });

  it('isSubagentStopInput identifies correctly', () => {
    const input = createSubagentStopInput();
    const validated = validateHookInput(input);
    expect(isSubagentStopInput(validated)).toBe(true);
    expect(isStopInput(validated)).toBe(false);
  });

  it('isPreCompactInput identifies correctly', () => {
    const input = createPreCompactInput();
    const validated = validateHookInput(input);
    expect(isPreCompactInput(validated)).toBe(true);
  });
});

describe('safeValidateHookInput', () => {
  it('returns success: true for valid input', () => {
    const input = createPreToolUseInput('Bash', { command: 'ls' });
    const result = safeValidateHookInput(input);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.hook_event_name).toBe('PreToolUse');
  });

  it('returns success: false with HookValidationError for invalid input', () => {
    const result = safeValidateHookInput({ invalid: 'data' });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(HookValidationError);
    expect(result.error?.code).toBe('MISSING_HOOK_EVENT_NAME');
  });

  it('returns structured errors for invalid input types', () => {
    const result = safeValidateHookInput(null);
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(HookValidationError);
  });
});

describe('Tool Input Validators', () => {
  it('validateWriteToolInput validates valid Write input', () => {
    const hookInput = createWritePreToolUseInput('/tmp/test.ts', 'content');
    const result = validateWriteToolInput(hookInput);
    expect(result.file_path).toBe('/tmp/test.ts');
    expect(result.content).toBe('content');
  });

  it('validateWriteToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateWriteToolInput(hookInput)).toThrow(
      HookValidationError
    );
    try {
      validateWriteToolInput(hookInput);
    } catch (error) {
      assertHookValidationError(error);
      expect(error.code).toBe('WRONG_TOOL_TYPE');
    }
  });

  it('validateWriteToolInput throws for invalid Write input', () => {
    const hookInput = createPreToolUseInput('Write', {});
    expect(() => validateWriteToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validateEditToolInput validates valid Edit input', () => {
    const hookInput = createPreToolUseInput('Edit', {
      file_path: '/tmp/test.ts',
      old_string: 'old',
      new_string: 'new',
    });
    const result = validateEditToolInput(hookInput);
    expect(result.file_path).toBe('/tmp/test.ts');
    expect(result.old_string).toBe('old');
    expect(result.new_string).toBe('new');
  });

  it('validateEditToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateEditToolInput(hookInput)).toThrow(HookValidationError);
  });

  it('validateReadToolInput validates valid Read input', () => {
    const hookInput = createPreToolUseInput('Read', {
      file_path: '/tmp/test.ts',
    });
    const result = validateReadToolInput(hookInput);
    expect(result.file_path).toBe('/tmp/test.ts');
  });

  it('validateReadToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateReadToolInput(hookInput)).toThrow(HookValidationError);
  });

  it('validateToolInput routes correctly to Bash validator', () => {
    const hookInput = createBashPreToolUseInput('echo test');
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('command', 'echo test');
  });

  it('validateToolInput routes correctly to Write validator', () => {
    const hookInput = createWritePreToolUseInput('/tmp/f.ts', 'code');
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('file_path', '/tmp/f.ts');
  });

  it('validateToolInput throws for unknown tool', () => {
    const hookInput = createPreToolUseInput('UnknownTool', { foo: 'bar' });
    expect(() => validateToolInput(hookInput)).toThrow(HookValidationError);
    try {
      validateToolInput(hookInput);
    } catch (error) {
      assertHookValidationError(error);
      expect(error.code).toBe('UNSUPPORTED_TOOL');
    }
  });
});

describe('Hook-Type-Specific Validators', () => {
  it('validatePreToolUseInput validates and narrows PreToolUse', () => {
    const input = createPreToolUseInput('Bash', { command: 'ls' });
    const result = validatePreToolUseInput(input);
    expect(result.hook_event_name).toBe('PreToolUse');
    expect(result.tool_name).toBe('Bash');
  });

  it('validatePreToolUseInput throws for non-PreToolUse input', () => {
    const input = createStopInput();
    expect(() => validatePreToolUseInput(input)).toThrow(HookValidationError);
    try {
      validatePreToolUseInput(input);
    } catch (error) {
      assertHookValidationError(error);
      expect(error.code).toBe('WRONG_HOOK_TYPE');
    }
  });

  it('validatePostToolUseInput validates and narrows PostToolUse', () => {
    const input = createPostToolUseInput(
      'Bash',
      { command: 'ls' },
      { output: 'ok' }
    );
    const result = validatePostToolUseInput(input);
    expect(result.hook_event_name).toBe('PostToolUse');
    expect(result.tool_name).toBe('Bash');
  });

  it('validatePostToolUseInput throws for non-PostToolUse input', () => {
    const input = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validatePostToolUseInput(input)).toThrow(HookValidationError);
    try {
      validatePostToolUseInput(input);
    } catch (error) {
      assertHookValidationError(error);
      expect(error.code).toBe('WRONG_HOOK_TYPE');
    }
  });
});

describe('Phase 2: New Event Input Schemas', () => {
  it('should validate PermissionRequest input', () => {
    const input = createPermissionRequestInput('Bash', {
      command: 'rm -rf node_modules',
    });
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PermissionRequest');
    if ('tool_name' in result) {
      expect(result.tool_name).toBe('Bash');
    }
  });

  it('should validate PermissionRequest with permission_suggestions', () => {
    const input = createPermissionRequestInput(
      'Bash',
      { command: 'npm test' },
      {
        permission_suggestions: [{ type: 'toolAlwaysAllow', tool: 'Bash' }],
      }
    );
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PermissionRequest');
  });

  it('should reject PermissionRequest with missing tool_name', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'PermissionRequest' }),
      hook_event_name: 'PermissionRequest' as const,
      tool_input: { command: 'ls' },
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate PostToolUseFailure input', () => {
    const input = createPostToolUseFailureInput(
      'Bash',
      { command: 'npm test' },
      'Command exited with non-zero status code 1'
    );
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PostToolUseFailure');
    if ('error' in result) {
      expect(result.error).toBe('Command exited with non-zero status code 1');
    }
  });

  it('should validate PostToolUseFailure with is_interrupt', () => {
    const input = createPostToolUseFailureInput(
      'Bash',
      { command: 'npm test' },
      'Interrupted',
      { is_interrupt: true }
    );
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('PostToolUseFailure');
    if ('is_interrupt' in result) {
      expect(result.is_interrupt).toBe(true);
    }
  });

  it('should reject PostToolUseFailure with missing error', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'PostToolUseFailure' }),
      hook_event_name: 'PostToolUseFailure' as const,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tuid-1',
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate SubagentStart input', () => {
    const input = createSubagentStartInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('SubagentStart');
    if ('agent_type' in result) {
      expect(result.agent_type).toBe('Explore');
    }
  });

  it('should validate TeammateIdle input', () => {
    const input = createTeammateIdleInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('TeammateIdle');
    if ('teammate_name' in result) {
      expect(result.teammate_name).toBe('researcher');
    }
  });

  it('should reject TeammateIdle with empty teammate_name', () => {
    const input = createTeammateIdleInput({ teammate_name: '' });
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate TaskCompleted input with all fields', () => {
    const input = createTaskCompletedInput({
      task_description: 'Add login and signup endpoints',
      teammate_name: 'implementer',
      team_name: 'my-project',
    });
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('TaskCompleted');
    if ('task_subject' in result) {
      expect(result.task_subject).toBe('Implement feature');
    }
  });

  it('should validate TaskCompleted with only required fields', () => {
    const input = createTaskCompletedInput();
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('TaskCompleted');
  });

  it('should reject TaskCompleted with missing task_id', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'TaskCompleted' }),
      hook_event_name: 'TaskCompleted' as const,
      task_subject: 'Test',
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('should validate all Session A event inputs', () => {
    const inputs = [
      createUserPromptExpansionInput(),
      createPermissionDeniedInput(),
      createPostToolBatchInput(),
      createTaskCreatedInput(),
      createStopFailureInput(),
      createInstructionsLoadedInput(),
      createConfigChangeInput(),
      createCwdChangedInput(),
      createFileChangedInput(),
      createWorktreeCreateInput(),
      createWorktreeRemoveInput(),
      createPostCompactInput(),
      createElicitationInput(),
      createElicitationResultInput(),
    ];

    for (const input of inputs) {
      const result = validateHookInput(input);
      expect(result.hook_event_name).toBe(input.hook_event_name);
    }
  });

  it('should reject invalid Session A event inputs', () => {
    const invalidInputs = [
      { ...createUserPromptExpansionInput(), command_name: '' },
      { ...createPermissionDeniedInput(), reason: '' },
      { ...createPostToolBatchInput(), tool_calls: [] },
      { ...createTaskCreatedInput(), task_id: '' },
      { ...createStopFailureInput(), error: 'network_down' },
      { ...createInstructionsLoadedInput(), memory_type: 'Team' },
      { ...createConfigChangeInput(), source: 'repo_settings' },
      { ...createCwdChangedInput(), new_cwd: '' },
      { ...createFileChangedInput(), event: 'rename' },
      { ...createWorktreeCreateInput(), name: '' },
      { ...createWorktreeRemoveInput(), worktree_path: '' },
      { ...createPostCompactInput(), trigger: 'scheduled' },
      { ...createElicitationInput({ mode: 'url' }), url: undefined },
      { ...createElicitationResultInput(), action: 'retry' },
    ];

    for (const input of invalidInputs) {
      expectValidationError(
        () => validateHookInput(input),
        'HOOK_VALIDATION_FAILED'
      );
    }
  });
});

describe('Phase 2: PermissionRequest Output Schema', () => {
  it('should validate allow decision', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: {
          behavior: 'allow' as const,
          updatedInput: { command: 'npm run lint' },
        },
      },
    };
    const result = permissionRequestOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it('should validate allow decision with updatedPermissions', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: {
          behavior: 'allow' as const,
          updatedPermissions: [
            {
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            },
          ],
        },
      },
    };
    const result = permissionRequestOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it('should validate deny decision with message and interrupt', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: {
          behavior: 'deny' as const,
          message: 'Not allowed in production',
          interrupt: true,
        },
      },
    };
    const result = permissionRequestOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it('should reject decision with invalid behavior', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: {
          behavior: 'invalid',
        },
      },
    };
    const result = permissionRequestOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe('Session A: New Event Output Schemas', () => {
  it('accepts UserPromptExpansion context and block output', () => {
    const result = userPromptExpansionOutputSchema.safeParse({
      decision: 'block',
      reason: 'Unavailable command',
      hookSpecificOutput: {
        hookEventName: 'UserPromptExpansion',
        additionalContext: 'Expansion context',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts PermissionDenied retry output', () => {
    const result = permissionDeniedOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'PermissionDenied',
        retry: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts PostToolBatch context output', () => {
    const result = postToolBatchOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: 'Batch context',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts PreCompact additionalContext output', () => {
    const result = preCompactOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: 'Compact this detail',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts ConfigChange block output', () => {
    const result = configChangeOutputSchema.safeParse({
      decision: 'block',
      reason: 'Requires approval',
    });
    expect(result.success).toBe(true);
  });

  it('accepts watchPaths output', () => {
    const result = watchPathsOutputSchema.safeParse({
      watchPaths: ['/tmp/project/.envrc'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts WorktreeCreate path output', () => {
    const result = worktreeCreateOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'WorktreeCreate',
        worktreePath: '/tmp/project/.claude/worktrees/feature-auth',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts Elicitation output', () => {
    const result = elicitationOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'Elicitation',
        action: 'accept',
        content: { username: 'alice' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts ElicitationResult output', () => {
    const result = elicitationResultOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'ElicitationResult',
        action: 'decline',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts SessionStart output with initialUserMessage, sessionTitle, watchPaths, and reloadSkills', () => {
    const result = sessionStartOutputSchema.safeParse({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        initialUserMessage: 'hi',
        sessionTitle: 't',
        watchPaths: ['/a'],
        reloadSkills: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts terminalSequence as a common output field', () => {
    const result = baseHookOutputSchema.safeParse({
      terminalSequence: '\u001b[2J\u001b[H',
    });

    expect(result.success).toBe(true);
  });
});

describe('Phase 2: New Type Guards', () => {
  it('isPermissionRequestInput identifies correctly', () => {
    const input = createPermissionRequestInput('Bash', { command: 'ls' });
    const validated = validateHookInput(input);
    expect(isPermissionRequestInput(validated)).toBe(true);
    expect(isPreToolUseInput(validated)).toBe(false);
  });

  it('isPostToolUseFailureInput identifies correctly', () => {
    const input = createPostToolUseFailureInput(
      'Bash',
      { command: 'ls' },
      'Failed'
    );
    const validated = validateHookInput(input);
    expect(isPostToolUseFailureInput(validated)).toBe(true);
    expect(isPostToolUseInput(validated)).toBe(false);
  });

  it('isSubagentStartInput identifies correctly', () => {
    const input = createSubagentStartInput();
    const validated = validateHookInput(input);
    expect(isSubagentStartInput(validated)).toBe(true);
    expect(isSubagentStopInput(validated)).toBe(false);
  });

  it('isTeammateIdleInput identifies correctly', () => {
    const input = createTeammateIdleInput();
    const validated = validateHookInput(input);
    expect(isTeammateIdleInput(validated)).toBe(true);
    expect(isTaskCompletedInput(validated)).toBe(false);
  });

  it('isTaskCompletedInput identifies correctly', () => {
    const input = createTaskCompletedInput();
    const validated = validateHookInput(input);
    expect(isTaskCompletedInput(validated)).toBe(true);
    expect(isTeammateIdleInput(validated)).toBe(false);
  });

  it('identifies all Session A event inputs correctly', () => {
    const checks = [
      [createUserPromptExpansionInput(), isUserPromptExpansionInput],
      [createPermissionDeniedInput(), isPermissionDeniedInput],
      [createPostToolBatchInput(), isPostToolBatchInput],
      [createTaskCreatedInput(), isTaskCreatedInput],
      [createStopFailureInput(), isStopFailureInput],
      [createInstructionsLoadedInput(), isInstructionsLoadedInput],
      [createConfigChangeInput(), isConfigChangeInput],
      [createCwdChangedInput(), isCwdChangedInput],
      [createFileChangedInput(), isFileChangedInput],
      [createWorktreeCreateInput(), isWorktreeCreateInput],
      [createWorktreeRemoveInput(), isWorktreeRemoveInput],
      [createPostCompactInput(), isPostCompactInput],
      [createElicitationInput(), isElicitationInput],
      [createElicitationResultInput(), isElicitationResultInput],
    ] as const;

    for (const [input, guard] of checks) {
      const validated = validateHookInput(input);
      expect(guard(validated)).toBe(true);
    }
  });

  it('validates all Session A event-specific validators', () => {
    expect(
      validateUserPromptExpansionInput(createUserPromptExpansionInput())
        .hook_event_name
    ).toBe('UserPromptExpansion');
    expect(
      validatePermissionDeniedInput(createPermissionDeniedInput())
        .hook_event_name
    ).toBe('PermissionDenied');
    expect(
      validatePostToolBatchInput(createPostToolBatchInput()).hook_event_name
    ).toBe('PostToolBatch');
    expect(
      validateTaskCreatedInput(createTaskCreatedInput()).hook_event_name
    ).toBe('TaskCreated');
    expect(
      validateStopFailureInput(createStopFailureInput()).hook_event_name
    ).toBe('StopFailure');
    expect(
      validateInstructionsLoadedInput(createInstructionsLoadedInput())
        .hook_event_name
    ).toBe('InstructionsLoaded');
    expect(
      validateConfigChangeInput(createConfigChangeInput()).hook_event_name
    ).toBe('ConfigChange');
    expect(
      validateCwdChangedInput(createCwdChangedInput()).hook_event_name
    ).toBe('CwdChanged');
    expect(
      validateFileChangedInput(createFileChangedInput()).hook_event_name
    ).toBe('FileChanged');
    expect(
      validateWorktreeCreateInput(createWorktreeCreateInput()).hook_event_name
    ).toBe('WorktreeCreate');
    expect(
      validateWorktreeRemoveInput(createWorktreeRemoveInput()).hook_event_name
    ).toBe('WorktreeRemove');
    expect(
      validatePostCompactInput(createPostCompactInput()).hook_event_name
    ).toBe('PostCompact');
    expect(
      validateElicitationInput(createElicitationInput()).hook_event_name
    ).toBe('Elicitation');
    expect(
      validateElicitationResultInput(createElicitationResultInput())
        .hook_event_name
    ).toBe('ElicitationResult');
  });
});

describe('Phase 2: New Tool Input Validators', () => {
  it('validateWebFetchToolInput validates valid input', () => {
    const hookInput = createPreToolUseInput('WebFetch', {
      url: 'https://example.com',
      prompt: 'Extract the API endpoints',
    });
    const result = validateWebFetchToolInput(hookInput);
    expect(result.url).toBe('https://example.com');
    expect(result.prompt).toBe('Extract the API endpoints');
  });

  it('validateWebFetchToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateWebFetchToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validateWebFetchToolInput throws for missing url', () => {
    const hookInput = createPreToolUseInput('WebFetch', {
      prompt: 'Extract data',
    });
    expect(() => validateWebFetchToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validateWebSearchToolInput validates valid input', () => {
    const hookInput = createPreToolUseInput('WebSearch', {
      query: 'react hooks best practices',
    });
    const result = validateWebSearchToolInput(hookInput);
    expect(result.query).toBe('react hooks best practices');
  });

  it('validateWebSearchToolInput validates input with domains', () => {
    const hookInput = createPreToolUseInput('WebSearch', {
      query: 'test',
      allowed_domains: ['docs.example.com'],
      blocked_domains: ['spam.example.com'],
    });
    const result = validateWebSearchToolInput(hookInput);
    expect(result.allowed_domains).toEqual(['docs.example.com']);
    expect(result.blocked_domains).toEqual(['spam.example.com']);
  });

  it('validateWebSearchToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateWebSearchToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validateTaskToolInput validates valid input', () => {
    const hookInput = createPreToolUseInput('Task', {
      prompt: 'Find all API endpoints',
    });
    const result = validateTaskToolInput(hookInput);
    expect(result.prompt).toBe('Find all API endpoints');
  });

  it('validateTaskToolInput validates input with all optional fields', () => {
    const hookInput = createPreToolUseInput('Task', {
      prompt: 'Find all API endpoints',
      description: 'Find API endpoints',
      subagent_type: 'Explore',
      model: 'sonnet',
    });
    const result = validateTaskToolInput(hookInput);
    expect(result.subagent_type).toBe('Explore');
    expect(result.model).toBe('sonnet');
  });

  it('validateTaskToolInput throws for wrong tool name', () => {
    const hookInput = createPreToolUseInput('Bash', { command: 'ls' });
    expect(() => validateTaskToolInput(hookInput)).toThrow(HookValidationError);
  });

  it('validates Agent tool input', () => {
    const hookInput = createPreToolUseInput('Agent', {
      prompt: 'Find all API endpoints',
      description: 'Find API endpoints',
      subagent_type: 'Explore',
      model: 'sonnet',
    });
    const result = validateAgentToolInput(hookInput);
    expect(result.prompt).toBe('Find all API endpoints');
    expect(result.subagent_type).toBe('Explore');
    expect(agentToolInputSchema.safeParse(hookInput.tool_input).success).toBe(
      true
    );
  });

  it('validates AskUserQuestion tool input with optional answers', () => {
    const hookInput = createPreToolUseInput('AskUserQuestion', {
      questions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
          multiSelect: false,
        },
      ],
      answers: { 'Which framework?': 'React' },
    });
    const result = validateAskUserQuestionToolInput(hookInput);
    expect(result.questions[0]?.question).toBe('Which framework?');
    expect(result.answers?.['Which framework?']).toBe('React');
    expect(
      askUserQuestionToolInputSchema.safeParse(hookInput.tool_input).success
    ).toBe(true);
  });

  it('rejects AskUserQuestion with more than four questions', () => {
    const hookInput = createPreToolUseInput('AskUserQuestion', {
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `Question ${index}`,
        header: 'Question',
        options: [{ label: 'Yes' }],
      })),
    });
    expect(() => validateAskUserQuestionToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validates empty ExitPlanMode input', () => {
    const hookInput = createPreToolUseInput('ExitPlanMode', {});
    const result = validateExitPlanModeToolInput(hookInput);
    expect(result).toEqual({});
    expect(exitPlanModeToolInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects non-empty ExitPlanMode input', () => {
    const hookInput = createPreToolUseInput('ExitPlanMode', {
      plan: 'continue',
    });
    expect(() => validateExitPlanModeToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validates TodoWrite tool input', () => {
    const hookInput = createPreToolUseInput('TodoWrite', {
      todos: [
        {
          content: 'Add schema tests',
          status: 'in_progress',
          activeForm: 'Adding schema tests',
        },
      ],
    });
    const result = validateTodoWriteToolInput(hookInput);
    expect(result.todos[0]?.status).toBe('in_progress');
    expect(
      todoWriteToolInputSchema.safeParse(hookInput.tool_input).success
    ).toBe(true);
  });

  it('rejects TodoWrite with invalid status', () => {
    const hookInput = createPreToolUseInput('TodoWrite', {
      todos: [
        {
          content: 'Add schema tests',
          status: 'started',
          activeForm: 'Adding schema tests',
        },
      ],
    });
    expect(() => validateTodoWriteToolInput(hookInput)).toThrow(
      HookValidationError
    );
  });

  it('validates generic MCP tool input', () => {
    const hookInput = createPreToolUseInput('mcp__memory__create_entities', {
      entities: [{ name: 'Session B', entityType: 'task' }],
    });
    const result = validateMCPToolInput(hookInput);
    expect(result['entities']).toEqual([
      { name: 'Session B', entityType: 'task' },
    ]);
    expect(mcpToolInputSchema.safeParse(hookInput.tool_input).success).toBe(
      true
    );
  });

  it('validateToolInput routes correctly to WebFetch validator', () => {
    const hookInput = createPreToolUseInput('WebFetch', {
      url: 'https://example.com',
      prompt: 'Extract data',
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('url', 'https://example.com');
  });

  it('validateToolInput routes correctly to WebSearch validator', () => {
    const hookInput = createPreToolUseInput('WebSearch', {
      query: 'test query',
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('query', 'test query');
  });

  it('validateToolInput routes correctly to Task validator', () => {
    const hookInput = createPreToolUseInput('Task', {
      prompt: 'Find endpoints',
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('prompt', 'Find endpoints');
  });

  it('validateToolInput routes correctly to Agent validator', () => {
    const hookInput = createPreToolUseInput('Agent', {
      prompt: 'Find endpoints',
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('prompt', 'Find endpoints');
  });

  it('validateToolInput routes correctly to AskUserQuestion validator', () => {
    const hookInput = createPreToolUseInput('AskUserQuestion', {
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('questions');
  });

  it('validateToolInput routes correctly to ExitPlanMode validator', () => {
    const hookInput = createPreToolUseInput('ExitPlanMode', {});
    const result = validateToolInput(hookInput);
    expect(result).toEqual({});
  });

  it('validateToolInput routes correctly to TodoWrite validator', () => {
    const hookInput = createPreToolUseInput('TodoWrite', {
      todos: [
        {
          content: 'Run tests',
          status: 'pending',
          activeForm: 'Running tests',
        },
      ],
    });
    const result = validateToolInput(hookInput);
    expect(result).toHaveProperty('todos');
  });

  it('validateToolInput routes correctly to generic MCP validator', () => {
    const hookInput = createPreToolUseInput(
      'mcp__github__search_repositories',
      {
        query: 'agent-harness-kit',
      }
    );
    const result = validateToolInput(hookInput);
    expect(result).toEqual({ query: 'agent-harness-kit' });
  });
});

describe('Phase 3: Output Schema Updates', () => {
  describe('PreToolUse output schema', () => {
    it('accepts updatedInput in hookSpecificOutput', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Safe command',
          updatedInput: { command: 'npm test --coverage' },
        },
      };
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.updatedInput).toEqual({
          command: 'npm test --coverage',
        });
      }
    });

    it('accepts additionalContext in hookSpecificOutput', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Allowed',
          additionalContext: 'Environment: production',
        },
      };
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.additionalContext).toBe(
          'Environment: production'
        );
      }
    });

    it('accepts both updatedInput and additionalContext together', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Modified and contextualized',
          updatedInput: { command: 'npm run lint' },
          additionalContext: 'Running in CI mode',
        },
      };
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('still works without updatedInput and additionalContext', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked',
        },
      };
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('accepts defer permissionDecision', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'defer',
          permissionDecisionReason: 'Collect answer in host UI',
        },
      };
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('PostToolUse output schema', () => {
    it('accepts updatedToolOutput in hookSpecificOutput', () => {
      const output = {
        decision: 'block' as const,
        reason: 'Tool output replaced',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: { replaced: true },
        },
      };
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.updatedToolOutput).toEqual({
          replaced: true,
        });
      }
    });

    it('accepts updatedMCPToolOutput in hookSpecificOutput', () => {
      const output = {
        decision: 'block' as const,
        reason: 'MCP output replaced',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedMCPToolOutput: { result: 'sanitized data' },
        },
      };
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.updatedMCPToolOutput).toEqual({
          result: 'sanitized data',
        });
      }
    });

    it('accepts non-object updatedMCPToolOutput values', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedMCPToolOutput: 'sanitized string output',
        },
      };
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.updatedMCPToolOutput).toBe(
          'sanitized string output'
        );
      }
    });

    it('accepts both additionalContext and updatedMCPToolOutput', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Output was sanitized',
          updatedMCPToolOutput: { filtered: true },
        },
      };
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('still works without updatedMCPToolOutput', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Some context',
        },
      };
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('Notification output schema', () => {
    it('accepts additionalContext in hookSpecificOutput', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'Notification',
          additionalContext: 'Notification logged',
        },
      };
      const result = notificationOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hookSpecificOutput?.additionalContext).toBe(
          'Notification logged'
        );
      }
    });

    it('works without hookSpecificOutput', () => {
      const output = {};
      const result = notificationOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });
});

describe('Phase 3: HookOutputBuilder Updates', () => {
  describe('permission() with options', () => {
    it('creates output without options (backward compatible)', () => {
      const output = HookOutputBuilder.permission('allow', 'Approved');
      expect(output.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(output.hookSpecificOutput?.permissionDecisionReason).toBe(
        'Approved'
      );
      expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
      expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
    });

    it('creates output with updatedInput', () => {
      const output = HookOutputBuilder.permission('allow', 'Modified', {
        updatedInput: { command: 'npm run lint' },
      });
      expect(output.hookSpecificOutput?.updatedInput).toEqual({
        command: 'npm run lint',
      });
    });

    it('creates output with additionalContext', () => {
      const output = HookOutputBuilder.permission('allow', 'Context added', {
        additionalContext: 'Running in production',
      });
      expect(output.hookSpecificOutput?.additionalContext).toBe(
        'Running in production'
      );
    });

    it('creates output with both options', () => {
      const output = HookOutputBuilder.permission('allow', 'Full control', {
        updatedInput: { command: 'npm test' },
        additionalContext: 'CI mode',
      });
      expect(output.hookSpecificOutput?.updatedInput).toEqual({
        command: 'npm test',
      });
      expect(output.hookSpecificOutput?.additionalContext).toBe('CI mode');
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.permission('allow', 'Valid', {
        updatedInput: { file_path: '/tmp/test.ts' },
        additionalContext: 'Test context',
      });
      const result = preToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('feedback() with updatedMCPToolOutput', () => {
    it('creates output without MCP output (backward compatible)', () => {
      const output = HookOutputBuilder.feedback('Issue found', 'Details');
      expect(output.decision).toBe('block');
      expect(output.reason).toBe('Issue found');
      expect(output.hookSpecificOutput?.additionalContext).toBe('Details');
      expect(output.hookSpecificOutput?.updatedMCPToolOutput).toBeUndefined();
    });

    it('creates output with updatedMCPToolOutput', () => {
      const output = HookOutputBuilder.feedback(
        'MCP output replaced',
        'Sanitized',
        { result: 'clean data' }
      );
      expect(output.hookSpecificOutput?.updatedMCPToolOutput).toEqual({
        result: 'clean data',
      });
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.feedback('Reason', 'Context', {
        data: 'replaced',
      });
      const result = postToolUseOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('allowPermission()', () => {
    it('creates basic allow output', () => {
      const output = HookOutputBuilder.allowPermission();
      expect(output.hookSpecificOutput?.decision.behavior).toBe('allow');
    });

    it('creates allow with updatedInput', () => {
      const output = HookOutputBuilder.allowPermission({
        updatedInput: { command: 'npm run lint' },
      });
      const decision = output.hookSpecificOutput?.decision;
      expect(decision?.behavior).toBe('allow');
      if (decision?.behavior === 'allow') {
        expect(decision.updatedInput).toEqual({ command: 'npm run lint' });
      }
    });

    it('creates allow with updatedPermissions', () => {
      const output = HookOutputBuilder.allowPermission({
        updatedPermissions: [{ type: 'toolAlwaysAllow', tool: 'Bash' }],
      });
      const decision = output.hookSpecificOutput?.decision;
      if (decision?.behavior === 'allow') {
        expect(decision.updatedPermissions).toEqual([
          { type: 'toolAlwaysAllow', tool: 'Bash' },
        ]);
      }
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.allowPermission({
        updatedInput: { command: 'echo hello' },
      });
      const result = permissionRequestOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('denyPermission()', () => {
    it('creates basic deny output', () => {
      const output = HookOutputBuilder.denyPermission();
      expect(output.hookSpecificOutput?.decision.behavior).toBe('deny');
    });

    it('creates deny with message', () => {
      const output = HookOutputBuilder.denyPermission({
        message: 'Not allowed in production',
      });
      const decision = output.hookSpecificOutput?.decision;
      if (decision?.behavior === 'deny') {
        expect(decision.message).toBe('Not allowed in production');
      }
    });

    it('creates deny with interrupt', () => {
      const output = HookOutputBuilder.denyPermission({
        message: 'Critical violation',
        interrupt: true,
      });
      const decision = output.hookSpecificOutput?.decision;
      if (decision?.behavior === 'deny') {
        expect(decision.interrupt).toBe(true);
      }
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.denyPermission({
        message: 'Denied',
      });
      const result = permissionRequestOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('subagentContext()', () => {
    it('creates SubagentStart context output', () => {
      const output = HookOutputBuilder.subagentContext(
        'Follow security guidelines'
      );
      expect(output.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
      expect(output.hookSpecificOutput?.additionalContext).toBe(
        'Follow security guidelines'
      );
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.subagentContext('Context for agent');
      const result = subagentStartOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('sessionStartContext()', () => {
    it('creates SessionStart context output', () => {
      const output = HookOutputBuilder.sessionStartContext(
        'Project context loaded'
      );
      expect(output.hookSpecificOutput?.hookEventName).toBe('SessionStart');
      expect(output.hookSpecificOutput?.additionalContext).toBe(
        'Project context loaded'
      );
    });

    it('validates against Zod schema', () => {
      const output = HookOutputBuilder.sessionStartContext('Session context');
      const result = sessionStartOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('Session B helper methods', () => {
    it('permission() creates defer output', () => {
      const output = HookOutputBuilder.permission(
        'defer',
        'Collect answer in host UI'
      );
      expect(output.hookSpecificOutput?.permissionDecision).toBe('defer');
      expect(preToolUseOutputSchema.safeParse(output).success).toBe(true);
    });

    it('permissionRequestSetMode() creates setMode permission update', () => {
      const output = HookOutputBuilder.permissionRequestSetMode('acceptEdits');
      const decision = output.hookSpecificOutput?.decision;
      expect(decision?.behavior).toBe('allow');
      if (decision?.behavior === 'allow') {
        expect(decision.updatedPermissions).toEqual([
          {
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          },
        ]);
      }
      expect(permissionRequestOutputSchema.safeParse(output).success).toBe(
        true
      );
    });

    it('permissionDeniedRetry() creates retry output', () => {
      const output = HookOutputBuilder.permissionDeniedRetry(true);
      expect(output.hookSpecificOutput?.retry).toBe(true);
      expect(permissionDeniedOutputSchema.safeParse(output).success).toBe(true);
    });

    it('elicitation() creates Elicitation output', () => {
      const output = HookOutputBuilder.elicitation('accept', {
        username: 'alice',
      });
      expect(output.hookSpecificOutput?.action).toBe('accept');
      expect(elicitationOutputSchema.safeParse(output).success).toBe(true);
    });

    it('elicitation() creates ElicitationResult output', () => {
      const output = HookOutputBuilder.elicitation(
        'decline',
        undefined,
        'ElicitationResult'
      );
      expect(output.hookSpecificOutput?.hookEventName).toBe(
        'ElicitationResult'
      );
      expect(elicitationResultOutputSchema.safeParse(output).success).toBe(
        true
      );
    });

    it('watchPaths() creates watch path output', () => {
      const output = HookOutputBuilder.watchPaths(['/tmp/project/.envrc']);
      expect(output.watchPaths).toEqual(['/tmp/project/.envrc']);
      expect(watchPathsOutputSchema.safeParse(output).success).toBe(true);
    });

    it('worktreePath() creates WorktreeCreate output', () => {
      const output = HookOutputBuilder.worktreePath(
        '/tmp/project/.claude/worktrees/feature-auth'
      );
      expect(output.hookSpecificOutput?.worktreePath).toContain('feature-auth');
      expect(worktreeCreateOutputSchema.safeParse(output).success).toBe(true);
    });

    it('taskBlock() creates TaskCompleted stop output', () => {
      const output = HookOutputBuilder.taskBlock('Task failed quality gate');
      expect(output.continue).toBe(false);
      expect(output.stopReason).toBe('Task failed quality gate');
      expect(baseHookOutputSchema.safeParse(output).success).toBe(true);
    });

    it('teammateStop() creates TeammateIdle stop output', () => {
      const output = HookOutputBuilder.teammateStop('Teammate should continue');
      expect(output.continue).toBe(false);
      expect(output.hookSpecificOutput.hookEventName).toBe('TeammateIdle');
      expect(baseHookOutputSchema.safeParse(output).success).toBe(true);
    });

    it('batchBlock() creates PostToolBatch block output', () => {
      const output = HookOutputBuilder.batchBlock('Batch needs follow-up');
      expect(output.decision).toBe('block');
      expect(postToolBatchOutputSchema.safeParse(output).success).toBe(true);
    });

    it('sessionTitle() creates UserPromptSubmit title output', () => {
      const output = HookOutputBuilder.sessionTitle('Session B');
      expect(output.hookSpecificOutput?.sessionTitle).toBe('Session B');
      expect(userPromptSubmitOutputSchema.safeParse(output).success).toBe(true);
    });

    it('subagentStopContext() creates SubagentStop block output', () => {
      const output = HookOutputBuilder.subagentStopContext(
        'Summarize findings first'
      );
      expect(output.decision).toBe('block');
      expect(stopOutputSchema.safeParse(output).success).toBe(true);
    });

    it('stopFailureLog() creates observability output', () => {
      const output = HookOutputBuilder.stopFailureLog('Rate limit observed');
      expect(output.systemMessage).toBe('Rate limit observed');
      expect(baseHookOutputSchema.safeParse(output).success).toBe(true);
    });
  });
});

describe('Glob/Grep/MultiEdit Tool Input Schemas', () => {
  describe('globToolInputSchema', () => {
    it('validates minimal Glob input', () => {
      const result = globToolInputSchema.safeParse({ pattern: '**/*.ts' });
      expect(result.success).toBe(true);
    });

    it('validates Glob input with path', () => {
      const result = globToolInputSchema.safeParse({
        pattern: '*.js',
        path: '/src',
      });
      expect(result.success).toBe(true);
    });

    it('rejects Glob input without pattern', () => {
      const result = globToolInputSchema.safeParse({ path: '/src' });
      expect(result.success).toBe(false);
    });
  });

  describe('grepToolInputSchema', () => {
    it('validates minimal Grep input', () => {
      const result = grepToolInputSchema.safeParse({ pattern: 'TODO.*fix' });
      expect(result.success).toBe(true);
    });

    it('validates Grep input with all optional fields', () => {
      const result = grepToolInputSchema.safeParse({
        pattern: 'function\\s+\\w+',
        path: '/src',
        glob: '*.ts',
        type: 'ts',
        output_mode: 'content',
        multiline: true,
        '-i': true,
        '-n': true,
        '-A': 3,
        '-B': 2,
        '-C': 5,
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid output_mode', () => {
      const result = grepToolInputSchema.safeParse({
        pattern: 'test',
        output_mode: 'invalid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('multiEditToolInputSchema', () => {
    it('validates MultiEdit input', () => {
      const result = multiEditToolInputSchema.safeParse({
        file_path: '/src/test.ts',
        edits: [
          { old_string: 'foo', new_string: 'bar' },
          { old_string: 'baz', new_string: 'qux', replace_all: true },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects MultiEdit without file_path', () => {
      const result = multiEditToolInputSchema.safeParse({
        edits: [{ old_string: 'a', new_string: 'b' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('tool input validators', () => {
    it('validateGlobToolInput succeeds for Glob tool', () => {
      const input = createPreToolUseInput('Glob', { pattern: '**/*.ts' });
      const result = validateGlobToolInput(input);
      expect(result.pattern).toBe('**/*.ts');
    });

    it('validateGlobToolInput rejects wrong tool', () => {
      const input = createPreToolUseInput('Bash', { command: 'ls' });
      expect(() => validateGlobToolInput(input)).toThrow('Expected Glob tool');
    });

    it('validateGrepToolInput succeeds for Grep tool', () => {
      const input = createPreToolUseInput('Grep', { pattern: 'TODO' });
      const result = validateGrepToolInput(input);
      expect(result.pattern).toBe('TODO');
    });

    it('validateGrepToolInput rejects wrong tool', () => {
      const input = createPreToolUseInput('Bash', { command: 'ls' });
      expect(() => validateGrepToolInput(input)).toThrow('Expected Grep tool');
    });

    it('validateMultiEditToolInput succeeds for MultiEdit tool', () => {
      const input = createPreToolUseInput('MultiEdit', {
        file_path: '/test.ts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      });
      const result = validateMultiEditToolInput(input);
      expect(result.file_path).toBe('/test.ts');
    });

    it('validateMultiEditToolInput rejects wrong tool', () => {
      const input = createPreToolUseInput('Bash', { command: 'ls' });
      expect(() => validateMultiEditToolInput(input)).toThrow(
        'Expected MultiEdit tool'
      );
    });
  });
});

describe('Hook Configuration Schemas (settings.json)', () => {
  describe('commandHookHandlerSchema', () => {
    it('validates minimal command handler', () => {
      const result = commandHookHandlerSchema.safeParse({
        type: 'command',
        command: '.claude/hooks/block-rm.sh',
      });
      expect(result.success).toBe(true);
    });

    it('validates command handler with all fields', () => {
      const result = commandHookHandlerSchema.safeParse({
        type: 'command',
        command: '.claude/hooks/run-tests.sh',
        args: ['--project', 'hooks'],
        async: true,
        asyncRewake: true,
        shell: 'powershell',
        if: 'Bash(npm test *)',
        timeout: 120,
        statusMessage: 'Running tests...',
        once: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects command handler with non-string args entries', () => {
      const result = commandHookHandlerSchema.safeParse({
        type: 'command',
        command: '.claude/hooks/run-tests.sh',
        args: ['--project', 1],
      });

      expect(result.success).toBe(false);
    });

    it('rejects command handler without command', () => {
      const result = commandHookHandlerSchema.safeParse({ type: 'command' });
      expect(result.success).toBe(false);
    });
  });

  describe('httpHookHandlerSchema', () => {
    it('validates HTTP handler with headers and allowed env vars', () => {
      const result = httpHookHandlerSchema.safeParse({
        type: 'http',
        url: 'http://localhost:8080/hooks/pre-tool-use',
        timeout: 30,
        headers: {
          Authorization: 'Bearer $MY_TOKEN',
        },
        allowedEnvVars: ['MY_TOKEN'],
        if: 'Bash(git *)',
      });
      expect(result.success).toBe(true);
    });

    it('rejects HTTP handler without url', () => {
      const result = httpHookHandlerSchema.safeParse({ type: 'http' });
      expect(result.success).toBe(false);
    });

    it('rejects HTTP handler with invalid url', () => {
      const result = httpHookHandlerSchema.safeParse({
        type: 'http',
        url: 'not a url',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('mcpToolHookHandlerSchema', () => {
    it('validates MCP tool handler with input', () => {
      const result = mcpToolHookHandlerSchema.safeParse({
        type: 'mcp_tool',
        server: 'my_server',
        tool: 'security_scan',
        input: { file_path: '${tool_input.file_path}' },
        if: 'Edit(*.ts)',
      });
      expect(result.success).toBe(true);
    });

    it('rejects MCP tool handler without server', () => {
      const result = mcpToolHookHandlerSchema.safeParse({
        type: 'mcp_tool',
        tool: 'security_scan',
      });
      expect(result.success).toBe(false);
    });

    it('rejects MCP tool handler without tool', () => {
      const result = mcpToolHookHandlerSchema.safeParse({
        type: 'mcp_tool',
        server: 'my_server',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('promptHookHandlerSchema', () => {
    it('validates minimal prompt handler', () => {
      const result = promptHookHandlerSchema.safeParse({
        type: 'prompt',
        prompt: 'Evaluate if Claude should stop: $ARGUMENTS',
      });
      expect(result.success).toBe(true);
    });

    it('validates prompt handler with model', () => {
      const result = promptHookHandlerSchema.safeParse({
        type: 'prompt',
        prompt: 'Check conditions: $ARGUMENTS',
        model: 'claude-haiku-4-5-20251001',
        timeout: 30,
        if: 'Write(*.ts)',
      });
      expect(result.success).toBe(true);
    });

    it('rejects prompt handler without prompt', () => {
      const result = promptHookHandlerSchema.safeParse({ type: 'prompt' });
      expect(result.success).toBe(false);
    });
  });

  describe('agentHookHandlerSchema', () => {
    it('validates minimal agent handler', () => {
      const result = agentHookHandlerSchema.safeParse({
        type: 'agent',
        prompt: 'Verify all tests pass: $ARGUMENTS',
      });
      expect(result.success).toBe(true);
    });

    it('validates agent handler with model and timeout', () => {
      const result = agentHookHandlerSchema.safeParse({
        type: 'agent',
        prompt: 'Verify conditions',
        model: 'claude-sonnet-4-5-20250929',
        timeout: 120,
        statusMessage: 'Verifying...',
        if: 'Bash(npm test *)',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('hookHandlerSchema (discriminated union)', () => {
    it('dispatches to command handler', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'command',
        command: 'echo test',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('command');
      }
    });

    it('dispatches to prompt handler', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'prompt',
        prompt: 'Check: $ARGUMENTS',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('prompt');
      }
    });

    it('dispatches to agent handler', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'agent',
        prompt: 'Verify: $ARGUMENTS',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('agent');
      }
    });

    it('dispatches to HTTP handler', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'http',
        url: 'https://hooks.example.com/pre-tool-use',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('http');
      }
    });

    it('dispatches to MCP tool handler', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'mcp_tool',
        server: 'my_server',
        tool: 'security_scan',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('mcp_tool');
      }
    });

    it('rejects unknown type', () => {
      const result = hookHandlerSchema.safeParse({
        type: 'unknown',
        command: 'echo test',
      });
      expect(result.success).toBe(false);
    });

    it('async field is only valid on command handlers', () => {
      const commandResult = hookHandlerSchema.safeParse({
        type: 'command',
        command: 'echo test',
        async: true,
      });
      expect(commandResult.success).toBe(true);

      // prompt handler should strip the async field (not fail, just ignore)
      const promptResult = promptHookHandlerSchema.safeParse({
        type: 'prompt',
        prompt: 'test',
        async: true,
      });
      // Zod strips unknown fields by default, so this should still succeed
      expect(promptResult.success).toBe(true);
      if (promptResult.success) {
        expect('async' in promptResult.data).toBe(false);
      }
    });

    it('rejects empty if condition on all handler types', () => {
      const handlers = [
        { type: 'command', command: 'echo test', if: '' },
        { type: 'http', url: 'https://hooks.example.com/test', if: '' },
        { type: 'mcp_tool', server: 'server', tool: 'tool', if: '' },
        { type: 'prompt', prompt: 'Check: $ARGUMENTS', if: '' },
        { type: 'agent', prompt: 'Verify: $ARGUMENTS', if: '' },
      ];

      for (const handler of handlers) {
        expect(hookHandlerSchema.safeParse(handler).success).toBe(false);
      }
    });
  });

  describe('matcherGroupSchema', () => {
    it('validates matcher group with matcher', () => {
      const result = matcherGroupSchema.safeParse({
        matcher: 'Bash|Edit',
        hooks: [{ type: 'command', command: 'echo test' }],
      });
      expect(result.success).toBe(true);
    });

    it('validates matcher group without matcher', () => {
      const result = matcherGroupSchema.safeParse({
        hooks: [{ type: 'command', command: 'echo test' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty hooks array', () => {
      const result = matcherGroupSchema.safeParse({
        matcher: 'Bash',
        hooks: [],
      });
      expect(result.success).toBe(false);
    });

    it('validates multiple hooks in a group', () => {
      const result = matcherGroupSchema.safeParse({
        matcher: 'Write|Edit',
        hooks: [
          { type: 'command', command: '.claude/hooks/format.sh' },
          { type: 'http', url: 'https://hooks.example.com/validate' },
          { type: 'mcp_tool', server: 'my_server', tool: 'security_scan' },
          { type: 'prompt', prompt: 'Verify format: $ARGUMENTS' },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('hookEventNameSchema', () => {
    const validEvents = [
      'SessionStart',
      'Setup',
      'UserPromptSubmit',
      'UserPromptExpansion',
      'PreToolUse',
      'PermissionRequest',
      'PermissionDenied',
      'PostToolUse',
      'PostToolUseFailure',
      'PostToolBatch',
      'Notification',
      'MessageDisplay',
      'SubagentStart',
      'SubagentStop',
      'TaskCreated',
      'TaskCompleted',
      'Stop',
      'StopFailure',
      'TeammateIdle',
      'InstructionsLoaded',
      'ConfigChange',
      'CwdChanged',
      'FileChanged',
      'WorktreeCreate',
      'WorktreeRemove',
      'PreCompact',
      'PostCompact',
      'Elicitation',
      'ElicitationResult',
      'SessionEnd',
    ];

    it('accepts all 30 valid event names', () => {
      expect(validEvents).toHaveLength(30);
      for (const event of validEvents) {
        const result = hookEventNameSchema.safeParse(event);
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid event name', () => {
      const result = hookEventNameSchema.safeParse('InvalidEvent');
      expect(result.success).toBe(false);
    });
  });

  describe('hooksConfigSchema', () => {
    it('validates full multi-event config', () => {
      const result = hooksConfigSchema.safeParse({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '.claude/hooks/block-rm.sh' },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: 'prompt', prompt: 'Check tasks: $ARGUMENTS' }],
            },
          ],
          Setup: [
            {
              hooks: [{ type: 'command', command: '.claude/hooks/setup.ts' }],
            },
          ],
          MessageDisplay: [
            {
              hooks: [{ type: 'command', command: '.claude/hooks/display.ts' }],
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('validates empty config', () => {
      const result = hooksConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('validates config with empty hooks object', () => {
      const result = hooksConfigSchema.safeParse({ hooks: {} });
      expect(result.success).toBe(true);
    });

    it('validates root hook restriction fields', () => {
      const result = hooksConfigSchema.safeParse({
        allowManagedHooksOnly: true,
        allowedHttpHookUrls: [
          'https://hooks.example.com/*',
          'http://localhost:*',
        ],
        httpHookAllowedEnvVars: ['MY_TOKEN', 'HOOK_SECRET'],
      });
      expect(result.success).toBe(true);
    });

    it('validates official HTTP hook example shape', () => {
      const result = hooksConfigSchema.safeParse({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'http',
                  url: 'http://localhost:8080/hooks/pre-tool-use',
                  timeout: 30,
                  headers: {
                    Authorization: 'Bearer $MY_TOKEN',
                  },
                  allowedEnvVars: ['MY_TOKEN'],
                },
              ],
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('validates official MCP tool hook example shape', () => {
      const result = hooksConfigSchema.safeParse({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                {
                  type: 'mcp_tool',
                  server: 'my_server',
                  tool: 'security_scan',
                  input: { file_path: '${tool_input.file_path}' },
                },
              ],
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('config validators', () => {
    it('validateHooksConfig succeeds for valid config', () => {
      const config = validateHooksConfig({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo test' }],
            },
          ],
        },
      });
      expect(config.hooks).toBeDefined();
    });

    it('validateHooksConfig rejects null', () => {
      expect(() => validateHooksConfig(null)).toThrow();
    });

    it('validateHookHandler validates command handler', () => {
      const handler = validateHookHandler({
        type: 'command',
        command: 'echo test',
      });
      expect(handler.type).toBe('command');
    });

    it('validateHookHandler rejects invalid handler', () => {
      expect(() => validateHookHandler({ type: 'invalid' })).toThrow();
    });

    it('validateMatcherGroup validates valid group', () => {
      const group = validateMatcherGroup({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo test' }],
      });
      expect(group.matcher).toBe('Bash');
    });

    it('validateMatcherGroup rejects empty hooks', () => {
      expect(() =>
        validateMatcherGroup({ matcher: 'Bash', hooks: [] })
      ).toThrow();
    });
  });
});

describe('Schema Collection Completeness', () => {
  it('hookInputSchemas has all 30 event types', () => {
    const keys = Object.keys(hookInputSchemas);
    expect(keys).toHaveLength(30);
    expect(keys.sort()).toEqual([...hookEventNameSchema.options].sort());
  });

  it('hookOutputSchemas has all 30 event types', () => {
    const keys = Object.keys(hookOutputSchemas);
    expect(keys).toHaveLength(30);
    expect(keys.sort()).toEqual([...hookEventNameSchema.options].sort());
  });

  it('toolInputSchemas has 14 known tool types', () => {
    const keys = Object.keys(toolInputSchemas);
    expect(keys).toHaveLength(14);
    expect(keys.sort()).toEqual([
      'Agent',
      'AskUserQuestion',
      'Bash',
      'Edit',
      'ExitPlanMode',
      'Glob',
      'Grep',
      'MultiEdit',
      'Read',
      'Task',
      'TodoWrite',
      'WebFetch',
      'WebSearch',
      'Write',
    ]);
  });

  it('MCP tool inputs validate through dynamic routing', () => {
    const input = createPreToolUseInput('mcp__memory__read_graph', {
      query: 'Session B',
    });
    const result = validateToolInput(input);
    expect(result).toEqual({ query: 'Session B' });
  });
});

describe('Output Schema Validation', () => {
  describe('baseHookOutputSchema', () => {
    it('accepts empty object', () => {
      const result = baseHookOutputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts all universal fields', () => {
      const result = baseHookOutputSchema.safeParse({
        continue: false,
        stopReason: 'Done',
        suppressOutput: true,
        systemMessage: 'Warning',
      });
      expect(result.success).toBe(true);
    });

    it('continue and suppressOutput are optional (not defaulted)', () => {
      const result = baseHookOutputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.continue).toBeUndefined();
        expect(result.data.suppressOutput).toBeUndefined();
      }
    });
  });

  describe('stopOutputSchema', () => {
    it('accepts block decision with reason', () => {
      const result = stopOutputSchema.safeParse({
        decision: 'block',
        reason: 'Still have tasks to complete',
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty object (no blocking)', () => {
      const result = stopOutputSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('userPromptSubmitOutputSchema', () => {
    it('accepts block decision with reason', () => {
      const result = userPromptSubmitOutputSchema.safeParse({
        decision: 'block',
        reason: 'Prompt not allowed',
      });
      expect(result.success).toBe(true);
    });

    it('accepts additionalContext in hookSpecificOutput', () => {
      const result = userPromptSubmitOutputSchema.safeParse({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'Extra info',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts sessionTitle in hookSpecificOutput', () => {
      const result = userPromptSubmitOutputSchema.safeParse({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          sessionTitle: 'Factorial helper',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('postToolUseFailureOutputSchema', () => {
    it('accepts block decision with reason and context', () => {
      const result = postToolUseFailureOutputSchema.safeParse({
        decision: 'block',
        reason: 'Failure handled',
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: 'Retry with different params',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty object', () => {
      const result = postToolUseFailureOutputSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});

describe('Edge Cases', () => {
  it('rejects empty session_id', () => {
    const input = {
      ...createPreToolUseInput('Bash', { command: 'ls' }),
      session_id: '',
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('rejects empty tool_name in PreToolUse', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'PreToolUse' }),
      hook_event_name: 'PreToolUse' as const,
      tool_name: '',
      tool_input: { command: 'ls' },
      tool_use_id: 'tuid-1',
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('rejects empty tool_use_id in PreToolUse', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'PreToolUse' }),
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: '',
    };
    expectValidationError(
      () => validateHookInput(input),
      'HOOK_VALIDATION_FAILED'
    );
  });

  it('rejects unsupported hook event name', () => {
    const input = {
      ...createTestHookBase({ hook_event_name: 'NonExistentEvent' }),
      hook_event_name: 'NonExistentEvent',
    };
    expectValidationError(
      () => validateHookInput(input),
      'UNSUPPORTED_HOOK_EVENT'
    );
  });

  it('rejects wrong hookEventName literal in PreToolUse output', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved',
      },
    };
    const result = preToolUseOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });

  it('rejects wrong hookEventName literal in PostToolUse output', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'Context',
      },
    };
    const result = postToolUseOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });

  it('denyPermission with interrupt: false includes the field', () => {
    const output = HookOutputBuilder.denyPermission({
      message: 'Denied',
      interrupt: false,
    });
    const decision = output.hookSpecificOutput?.decision;
    expect(decision?.behavior).toBe('deny');
    if (decision?.behavior === 'deny') {
      expect(decision.interrupt).toBe(false);
    }
  });

  it('hooksConfigSchema strips unknown event keys', () => {
    const result = hooksConfigSchema.safeParse({
      hooks: {
        FakeEvent: [{ hooks: [{ type: 'command', command: 'echo test' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo test' }] }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hooks?.['PreToolUse']).toBeDefined();
      expect('FakeEvent' in (result.data.hooks ?? {})).toBe(false);
    }
  });

  it('validates UserPromptSubmit via factory', () => {
    const input = createUserPromptSubmitInput('hello world');
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('UserPromptSubmit');
    if ('prompt' in result) {
      expect(result.prompt).toBe('hello world');
    }
  });

  it('UserPromptSubmit allows empty prompt string', () => {
    const input = createUserPromptSubmitInput('');
    const result = validateHookInput(input);
    expect(result.hook_event_name).toBe('UserPromptSubmit');
  });
});
