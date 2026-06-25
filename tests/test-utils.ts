import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { vi } from 'vitest';
import {
  HookValidationError,
  type PreToolUseInputSchema,
  type PostToolUseInputSchema,
  type PermissionRequestInputSchema,
  type PermissionDeniedInputSchema,
  type PostToolUseFailureInputSchema,
  type PostToolBatchInputSchema,
  type UserPromptSubmitInputSchema,
  type UserPromptExpansionInputSchema,
  type BashToolInputSchema,
  type WriteToolInputSchema,
  type EditToolInputSchema,
  type ReadToolInputSchema,
  type WebFetchToolInputSchema,
  type WebSearchToolInputSchema,
  type TaskToolInputSchema,
  type SessionStartInputSchema,
  type SessionEndInputSchema,
  type NotificationInputSchema,
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
  type SetupInputSchema,
  type MessageDisplayInputSchema,
  type ElicitationInputSchema,
  type ElicitationResultInputSchema,
} from '../src/validation/index.js';
import { type HookInputSchema } from '../src/validation/schemas.js';

export function must<T>(value: T | undefined | null, msg?: string): T {
  if (value === undefined || value === null) {
    throw new Error(msg ?? 'expected value to be defined');
  }
  return value;
}

type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

export function createTestHookBase(
  overrides: Partial<{
    session_id: string;
    transcript_path: string;
    cwd: string;
    hook_event_name: string;
    permission_mode: PermissionMode | undefined;
  }> = {}
): {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: PermissionMode | undefined;
} {
  return {
    session_id: 'test-session-123',
    transcript_path: '/tmp/test-transcript.json',
    cwd: '/tmp/test-workspace',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    ...overrides,
  };
}

export function createPreToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  baseOverrides: Parameters<typeof createTestHookBase>[0] = {}
): PreToolUseInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PreToolUse', ...baseOverrides }),
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id-123',
  };
}

export function createPostToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown>,
  baseOverrides: Parameters<typeof createTestHookBase>[0] = {}
): PostToolUseInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PostToolUse', ...baseOverrides }),
    hook_event_name: 'PostToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: 'test-tool-use-id-123',
  };
}

export function createUserPromptSubmitInput(
  prompt: string = 'test prompt',
  overrides: Partial<UserPromptSubmitInputSchema> = {}
): UserPromptSubmitInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'UserPromptSubmit' }),
    hook_event_name: 'UserPromptSubmit' as const,
    prompt,
    ...overrides,
  };
}

export function createUserPromptExpansionInput(
  overrides: Partial<UserPromptExpansionInputSchema> = {}
): UserPromptExpansionInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'UserPromptExpansion' }),
    hook_event_name: 'UserPromptExpansion' as const,
    expansion_type: 'slash_command' as const,
    command_name: 'example-skill',
    command_args: 'arg1 arg2',
    command_source: 'plugin',
    prompt: '/example-skill arg1 arg2',
    ...overrides,
  };
}

export function createSessionStartInput(
  overrides: Partial<SessionStartInputSchema> = {}
): SessionStartInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'SessionStart' }),
    hook_event_name: 'SessionStart' as const,
    source: 'startup' as const,
    model: 'claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

export function createSetupInput(
  overrides: Partial<SetupInputSchema> = {}
): SetupInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'Setup' }),
    hook_event_name: 'Setup' as const,
    trigger: 'init' as const,
    ...overrides,
  };
}

export function createMessageDisplayInput(
  overrides: Partial<MessageDisplayInputSchema> = {}
): MessageDisplayInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'MessageDisplay' }),
    hook_event_name: 'MessageDisplay' as const,
    turn_id: '123e4567-e89b-12d3-a456-426614174000',
    message_id: '123e4567-e89b-12d3-a456-426614174001',
    index: 0,
    final: false,
    delta: 'test delta',
    ...overrides,
  };
}

export function createSessionEndInput(
  reason: SessionEndInputSchema['reason'] = 'other',
  overrides: Partial<SessionEndInputSchema> = {}
): SessionEndInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'SessionEnd' }),
    hook_event_name: 'SessionEnd' as const,
    reason,
    ...overrides,
  };
}

export function createNotificationInput(
  message: string,
  notificationType: NotificationInputSchema['notification_type'] = 'idle_prompt',
  overrides: Partial<NotificationInputSchema> = {}
): NotificationInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'Notification' }),
    hook_event_name: 'Notification' as const,
    message,
    notification_type: notificationType,
    ...overrides,
  };
}

export function createStopInput(
  overrides: Partial<StopInputSchema> = {}
): StopInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'Stop' }),
    hook_event_name: 'Stop' as const,
    stop_hook_active: false,
    last_assistant_message: 'Finished the requested work.',
    ...overrides,
  };
}

export function createStopFailureInput(
  overrides: Partial<StopFailureInputSchema> = {}
): StopFailureInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'StopFailure' }),
    hook_event_name: 'StopFailure' as const,
    error: 'rate_limit' as const,
    error_details: '429 Too Many Requests',
    last_assistant_message: 'API Error: Rate limit reached',
    ...overrides,
  };
}

export function createSubagentStopInput(
  overrides: Partial<SubagentStopInputSchema> = {}
): SubagentStopInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'SubagentStop' }),
    hook_event_name: 'SubagentStop' as const,
    stop_hook_active: false,
    agent_id: 'test-agent-id',
    agent_type: 'Explore',
    agent_transcript_path: '/tmp/test-agent-transcript.jsonl',
    last_assistant_message: 'Analysis complete.',
    ...overrides,
  };
}

export function createPreCompactInput(
  overrides: Partial<PreCompactInputSchema> = {}
): PreCompactInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PreCompact' }),
    hook_event_name: 'PreCompact' as const,
    trigger: 'manual' as const,
    custom_instructions: '',
    ...overrides,
  };
}

export function createPostCompactInput(
  overrides: Partial<PostCompactInputSchema> = {}
): PostCompactInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PostCompact' }),
    hook_event_name: 'PostCompact' as const,
    trigger: 'manual' as const,
    compact_summary: 'Summary of compacted conversation',
    ...overrides,
  };
}

export function createPermissionRequestInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<PermissionRequestInputSchema> = {}
): PermissionRequestInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PermissionRequest' }),
    hook_event_name: 'PermissionRequest' as const,
    tool_name: toolName,
    tool_input: toolInput,
    ...overrides,
  };
}

export function createPermissionDeniedInput(
  toolName: string = 'Bash',
  toolInput: Record<string, unknown> = { command: 'rm -rf /tmp/build' },
  overrides: Partial<PermissionDeniedInputSchema> = {}
): PermissionDeniedInputSchema {
  return {
    ...createTestHookBase({
      hook_event_name: 'PermissionDenied',
      permission_mode: 'auto',
    }),
    hook_event_name: 'PermissionDenied' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id-123',
    reason: 'Auto mode denied: command targets a path outside the project',
    ...overrides,
  };
}

export function createPostToolUseFailureInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  error: string,
  overrides: Partial<PostToolUseFailureInputSchema> = {}
): PostToolUseFailureInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PostToolUseFailure' }),
    hook_event_name: 'PostToolUseFailure' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id-123',
    error,
    ...overrides,
  };
}

export function createPostToolBatchInput(
  overrides: Partial<PostToolBatchInputSchema> = {}
): PostToolBatchInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'PostToolBatch' }),
    hook_event_name: 'PostToolBatch' as const,
    tool_calls: [
      {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.ts' },
        tool_use_id: 'toolu_01',
        tool_response: '1\tconst value = true;',
      },
    ],
    ...overrides,
  };
}

export function createSubagentStartInput(
  overrides: Partial<SubagentStartInputSchema> = {}
): SubagentStartInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'SubagentStart' }),
    hook_event_name: 'SubagentStart' as const,
    agent_id: 'test-agent-id',
    agent_type: 'Explore',
    ...overrides,
  };
}

export function createTeammateIdleInput(
  overrides: Partial<TeammateIdleInputSchema> = {}
): TeammateIdleInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'TeammateIdle' }),
    hook_event_name: 'TeammateIdle' as const,
    teammate_name: 'researcher',
    team_name: 'my-project',
    ...overrides,
  };
}

export function createTaskCreatedInput(
  overrides: Partial<TaskCreatedInputSchema> = {}
): TaskCreatedInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'TaskCreated' }),
    hook_event_name: 'TaskCreated' as const,
    task_id: 'task-001',
    task_subject: 'Implement feature',
    ...overrides,
  };
}

export function createTaskCompletedInput(
  overrides: Partial<TaskCompletedInputSchema> = {}
): TaskCompletedInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'TaskCompleted' }),
    hook_event_name: 'TaskCompleted' as const,
    task_id: 'task-001',
    task_subject: 'Implement feature',
    ...overrides,
  };
}

export function createInstructionsLoadedInput(
  overrides: Partial<InstructionsLoadedInputSchema> = {}
): InstructionsLoadedInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'InstructionsLoaded' }),
    hook_event_name: 'InstructionsLoaded' as const,
    file_path: '/tmp/project/CLAUDE.md',
    memory_type: 'Project' as const,
    load_reason: 'session_start' as const,
    ...overrides,
  };
}

export function createConfigChangeInput(
  overrides: Partial<ConfigChangeInputSchema> = {}
): ConfigChangeInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'ConfigChange' }),
    hook_event_name: 'ConfigChange' as const,
    source: 'project_settings' as const,
    file_path: '/tmp/project/.claude/settings.json',
    ...overrides,
  };
}

export function createCwdChangedInput(
  overrides: Partial<CwdChangedInputSchema> = {}
): CwdChangedInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'CwdChanged' }),
    hook_event_name: 'CwdChanged' as const,
    old_cwd: '/tmp/project',
    new_cwd: '/tmp/project/src',
    ...overrides,
  };
}

export function createFileChangedInput(
  overrides: Partial<FileChangedInputSchema> = {}
): FileChangedInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'FileChanged' }),
    hook_event_name: 'FileChanged' as const,
    file_path: '/tmp/project/.envrc',
    event: 'change' as const,
    ...overrides,
  };
}

export function createWorktreeCreateInput(
  overrides: Partial<WorktreeCreateInputSchema> = {}
): WorktreeCreateInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'WorktreeCreate' }),
    hook_event_name: 'WorktreeCreate' as const,
    name: 'feature-auth',
    ...overrides,
  };
}

export function createWorktreeRemoveInput(
  overrides: Partial<WorktreeRemoveInputSchema> = {}
): WorktreeRemoveInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'WorktreeRemove' }),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: '/tmp/project/.claude/worktrees/feature-auth',
    ...overrides,
  };
}

export function createElicitationInput(
  overrides: Partial<ElicitationInputSchema> = {}
): ElicitationInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'Elicitation' }),
    hook_event_name: 'Elicitation' as const,
    mcp_server_name: 'my-mcp-server',
    message: 'Please provide your credentials',
    mode: 'form' as const,
    requested_schema: {
      type: 'object',
      properties: { username: { type: 'string', title: 'Username' } },
    },
    elicitation_id: 'elicit-123',
    url: 'https://example.com',
    ...overrides,
  };
}

export function createElicitationResultInput(
  overrides: Partial<ElicitationResultInputSchema> = {}
): ElicitationResultInputSchema {
  return {
    ...createTestHookBase({ hook_event_name: 'ElicitationResult' }),
    hook_event_name: 'ElicitationResult' as const,
    mcp_server_name: 'my-mcp-server',
    action: 'accept' as const,
    content: { username: 'alice' },
    mode: 'form' as const,
    elicitation_id: 'elicit-123',
    ...overrides,
  };
}

export function createBashToolInput(
  command: string,
  overrides: Partial<BashToolInputSchema> = {}
): BashToolInputSchema {
  return {
    command,
    ...overrides,
  };
}

export function createBashPreToolUseInput(
  command: string,
  bashOverrides: Partial<BashToolInputSchema> = {},
  baseOverrides: Parameters<typeof createTestHookBase>[0] = {}
): PreToolUseInputSchema {
  return createPreToolUseInput(
    'Bash',
    createBashToolInput(command, bashOverrides),
    baseOverrides
  );
}

export function createWriteToolInput(
  filePath: string,
  content: string,
  overrides: Partial<WriteToolInputSchema> = {}
): WriteToolInputSchema {
  return {
    file_path: filePath,
    content,
    ...overrides,
  };
}

export function createWritePreToolUseInput(
  filePath: string,
  content: string,
  writeOverrides: Partial<WriteToolInputSchema> = {},
  baseOverrides: Parameters<typeof createTestHookBase>[0] = {}
): PreToolUseInputSchema {
  return createPreToolUseInput(
    'Write',
    createWriteToolInput(filePath, content, writeOverrides),
    baseOverrides
  );
}

export function createEditToolInput(
  filePath: string,
  oldString: string,
  newString: string,
  overrides: Partial<EditToolInputSchema> = {}
): EditToolInputSchema {
  return {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
    replace_all: false,
    ...overrides,
  };
}

export function createReadToolInput(
  filePath: string,
  overrides: Partial<ReadToolInputSchema> = {}
): ReadToolInputSchema {
  return {
    file_path: filePath,
    ...overrides,
  };
}

export function createWebFetchToolInput(
  url: string,
  prompt: string,
  overrides: Partial<WebFetchToolInputSchema> = {}
): WebFetchToolInputSchema {
  return { url, prompt, ...overrides };
}

export function createWebSearchToolInput(
  query: string,
  overrides: Partial<WebSearchToolInputSchema> = {}
): WebSearchToolInputSchema {
  return { query, ...overrides };
}

export function createTaskToolInput(
  prompt: string,
  overrides: Partial<TaskToolInputSchema> = {}
): TaskToolInputSchema {
  return { prompt, ...overrides };
}

export function createStdinMock(input: HookInputSchema): {
  mockStdin: () => void;
  restoreStdin: () => void;
} {
  const originalStdin = process.stdin;

  const mockStdin = (): void => {
    const mockReadableStream = {
      on: vi.fn((event: string, callback: unknown) => {
        if (event === 'data') {
          invokeCallback(callback, Buffer.from(JSON.stringify(input)));
        }
        if (event === 'end') {
          invokeCallback(callback);
        }
      }),
      resume: vi.fn(),
      setEncoding: vi.fn(),
    };

    Object.assign(process, { stdin: mockReadableStream });
  };

  const restoreStdin = (): void => {
    process.stdin = originalStdin;
  };

  return { mockStdin, restoreStdin };
}

function invokeCallback(callback: unknown, ...args: unknown[]): void {
  if (typeof callback === 'function') {
    Reflect.apply(callback, undefined, args);
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createStdoutMock(): {
  mockStdout: () => void;
  restoreStdout: () => void;
  getOutput: () => string;
  getOutputAsJson: () => Record<string, unknown>;
} {
  const originalStdout = process.stdout;
  let capturedOutput = '';

  const mockStdout = (): void => {
    const mockWritableStream = {
      write: vi.fn((chunk: string) => {
        capturedOutput += chunk;
        return true;
      }),
    };

    Object.assign(process, { stdout: mockWritableStream });
  };

  const restoreStdout = (): void => {
    process.stdout = originalStdout;
  };

  const getOutput = (): string => capturedOutput;

  const getOutputAsJson = (): Record<string, unknown> => {
    try {
      return parseJsonObject(capturedOutput) ?? {};
    } catch {
      return {};
    }
  };

  return { mockStdout, restoreStdout, getOutput, getOutputAsJson };
}

export function expectValidationError(
  testFn: () => void,
  expectedCode: string,
  expectedMessage?: string
): void {
  try {
    testFn();
    throw new Error('Expected function to throw an error, but it did not');
  } catch (error) {
    if (error instanceof HookValidationError) {
      if (error.code !== expectedCode) {
        throw new Error(
          `Expected error code '${expectedCode}', but got '${error.code}'`
        );
      }
      if (expectedMessage && !error.message.includes(expectedMessage)) {
        throw new Error(
          `Expected error message to contain '${expectedMessage}', but got '${error.message}'`
        );
      }
    } else {
      throw new Error(
        `Expected validation error with code '${expectedCode}', but got: ${error}`
      );
    }
  }
}

export function createValidationTestCases<T>(
  validInput: T,
  invalidCases: Array<{
    description: string;
    input: Partial<{ [K in keyof T]: T[K] | undefined }>;
    expectedError: string;
  }>
): Array<{
  description: string;
  input: T;
  shouldPass: boolean;
  expectedError?: string;
}> {
  const testCases: Array<{
    description: string;
    input: T;
    shouldPass: boolean;
    expectedError?: string;
  }> = [
    {
      description: 'valid input',
      input: validInput,
      shouldPass: true,
    },
  ];

  for (const invalidCase of invalidCases) {
    testCases.push({
      description: invalidCase.description,
      input: { ...validInput, ...invalidCase.input },
      shouldPass: false,
      expectedError: invalidCase.expectedError,
    });
  }

  return testCases;
}

export function createTempTestFile(content: string = 'test content'): {
  filePath: string;
  cleanup: () => void;
} {
  const tempDir = os.tmpdir();
  const fileName = `test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}.txt`;
  const filePath = path.join(tempDir, fileName);

  fs.writeFileSync(filePath, content);

  const cleanup = (): void => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors
    }
  };

  return { filePath, cleanup };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

export function withEnvVars<T>(
  envVars: Record<string, string>,
  testFn: () => T | Promise<T>
): Promise<T> {
  const originalEnv = { ...process.env };

  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }

  const cleanup = (): void => {
    process.env = originalEnv;
  };

  try {
    const result = testFn();

    if (result instanceof Promise) {
      return result.finally(cleanup);
    } else {
      cleanup();
      return Promise.resolve(result);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function withDebugMode<T>(testFn: () => T | Promise<T>): Promise<T> {
  return withEnvVars({ CLAUDE_HOOK_DEBUG: 'true' }, testFn);
}
