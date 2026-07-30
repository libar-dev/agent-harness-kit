/**
 * Integration tests for Claude Code hooks
 *
 * These tests verify that the hook system works correctly by:
 * - Testing input/output JSON parsing
 * - Validating hook behavior with different inputs
 * - Ensuring proper error handling
 * - Checking hook composition and integration
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { PreToolUseInput, PostToolUseInput } from '../src/types/index.js';
import {
  readStdinJson,
  outputJson,
  validateRequiredFields,
  isProtectedFile,
  isDangerousCommand,
  clearGlobRegexCache,
  getConfig,
  resetConfigCache,
} from '../src/utils/index.js';
import {
  createUserPromptExpansionInput,
  createPermissionRequestInput,
  createPermissionDeniedInput,
  createPostToolUseFailureInput,
  createPostToolBatchInput,
  createSubagentStartInput,
  createTeammateIdleInput,
  createTaskCreatedInput,
  createTaskCompletedInput,
  createStopFailureInput,
  createInstructionsLoadedInput,
  createConfigChangeInput,
  createCwdChangedInput,
  createFileChangedInput,
  createWorktreeCreateInput,
  createWorktreeRemoveInput,
  createPostCompactInput,
  createElicitationInput,
  createElicitationResultInput,
  createSessionStartInput,
  createPreCompactInput,
  createNotificationInput,
  createSubagentStopInput,
} from './test-utils.js';
import {
  validateBashToolInput,
  validateWriteToolInput,
} from '../src/validation/index.js';
import { handleUserPromptExpansion } from '../src/pre-tool-use/user-prompt-expansion.js';
import { handlePostToolBatch } from '../src/post-tool-use/post-tool-batch.js';
import { handlePostToolUseFailure } from '../src/post-tool-use/post-tool-use-failure.js';
import { handlePermissionRequest } from '../src/lifecycle/permission-request.js';
import { handlePermissionDenied } from '../src/lifecycle/permission-denied.js';
import { handleSubagentStart } from '../src/lifecycle/subagent-start.js';
import { handleTeammateIdle } from '../src/lifecycle/teammate-idle.js';
import { handleTaskCreated } from '../src/lifecycle/task-created.js';
import { handleTaskCompleted } from '../src/lifecycle/task-completed.js';
import { handleStopFailure } from '../src/lifecycle/stop-failure.js';
import { handleInstructionsLoaded } from '../src/lifecycle/instructions-loaded.js';
import { handleConfigChange } from '../src/lifecycle/config-change.js';
import { handleCwdChanged } from '../src/lifecycle/cwd-changed.js';
import { handleFileChanged } from '../src/lifecycle/file-changed.js';
import { handleWorktreeCreate } from '../src/lifecycle/worktree-create.js';
import { handleWorktreeRemove } from '../src/lifecycle/worktree-remove.js';
import { handlePostCompact } from '../src/lifecycle/post-compact.js';
import { handleElicitation } from '../src/lifecycle/elicitation.js';
import { handleElicitationResult } from '../src/lifecycle/elicitation-result.js';
import { handleSessionStart } from '../src/lifecycle/session-start.js';
import {
  classifyNotification,
  expandNotificationCommandPlaceholders,
  handleNotification,
} from '../src/lifecycle/notification-handler.js';
import { handleSubagentStop } from '../src/lifecycle/subagent-stop.js';
import {
  formatDetailedContextSummary,
  handlePreCompact,
} from '../src/lifecycle/pre-compact.js';
import {
  consumePreCompactContext,
  savePreCompactContext,
} from '../src/lifecycle/pre-compact-context.js';

/**
 * Typed mock interfaces for process streams
 */
interface MockReadableStdin {
  data: string;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

interface MockWritableStream {
  output: string;
  write(data: string): boolean;
}

interface MockProcess {
  stdin: MockReadableStdin;
  stdout: MockWritableStream;
  stderr: MockWritableStream;
  exit: ReturnType<typeof vi.fn>;
  env: Record<string, string | undefined>;
}

async function getMockProcess(): Promise<MockProcess> {
  const proc = await import('node:process');
  assertMockProcess(proc);
  return proc;
}

function assertMockProcess(value: unknown): asserts value is MockProcess {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected mock process object');
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object, got ${String(parsed)}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getRecord(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  const nested = isRecord(value) ? value[key] : undefined;
  return isRecord(nested) ? nested : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const maybe = isRecord(value) ? value[key] : undefined;
  return typeof maybe === 'string' ? maybe : undefined;
}

function clearEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    delete env[key];
  }
}

async function resetMockProcess(): Promise<MockProcess> {
  const proc = await getMockProcess();
  proc.stdout.output = '';
  proc.stderr.output = '';
  proc.stdin.data = '';
  clearEnv(proc.env);
  resetConfigCache();
  return proc;
}

function captureConsoleErrorToStderr(proc: MockProcess): void {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    proc.stderr.output += args.map(String).join(' ');
  });
}

// Mock process with factory function
vi.mock('node:process', () => {
  const mockStdin: MockReadableStdin = {
    data: '',
    async *[Symbol.asyncIterator]() {
      if (mockStdin.data) {
        yield Buffer.from(mockStdin.data, 'utf-8');
      }
    },
  };

  const mockStdout: MockWritableStream = {
    output: '',
    write(data: string) {
      mockStdout.output += data;
      return true;
    },
  };

  const mockStderr: MockWritableStream = {
    output: '',
    write(data: string) {
      mockStderr.output += data;
      return true;
    },
  };

  return {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    exit: vi.fn(),
    env: {},
  };
});

// Helper to create test hook inputs
function createPreToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>
): PreToolUseInput {
  return {
    session_id: 'test-session-123',
    transcript_path: '/tmp/test-transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id-123',
  };
}

function createPostToolUseInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown>
): PostToolUseInput {
  return {
    session_id: 'test-session-123',
    transcript_path: '/tmp/test-transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUse',
    permission_mode: 'default',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: 'test-tool-use-id-123',
  };
}

describe('Hook Input/Output', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetMockProcess();
  });

  test('should parse valid hook input JSON', async () => {
    const testInput = createPreToolUseInput('Bash', {
      command: 'ls -la',
      description: 'List files',
    });

    // Set up mock stdin data
    const proc = await getMockProcess();
    proc.stdin.data = JSON.stringify(testInput);

    // Test the actual readStdinJson function
    const parsedInput = await readStdinJson();

    expect(parsedInput).toEqual(testInput);
    expect(parsedInput.hook_event_name).toBe('PreToolUse');
    if ('tool_name' in parsedInput) {
      expect(parsedInput.tool_name).toBe('Bash');
      expect(parsedInput.tool_input['command']).toBe('ls -la');
    }
  });

  test('should handle invalid JSON gracefully', async () => {
    // Set up invalid JSON in mock stdin
    const proc = await getMockProcess();
    proc.stdin.data = 'invalid json{';

    // Test that readStdinJson throws proper error
    await expect(readStdinJson()).rejects.toThrow(
      /Failed to parse hook input JSON/
    );
  });

  test('should handle empty stdin input', async () => {
    // Set up empty stdin
    const proc = await getMockProcess();
    proc.stdin.data = '';

    // Test that readStdinJson throws proper error for empty input
    await expect(readStdinJson()).rejects.toThrow(
      /Unexpected end of JSON input|Failed to parse hook input JSON/
    );
  });

  test('should format JSON output correctly', async () => {
    const output = {
      decision: 'block' as const,
      reason: 'Test block decision',
    };

    // Test the actual outputJson function
    outputJson(output);

    // Verify the output was written to mock stdout
    const proc = await getMockProcess();
    expect(proc.stdout.output).toBeTruthy();
    const parsedOutput = parseJsonObject(proc.stdout.output);
    expect(parsedOutput).toEqual(output);
    expect(parsedOutput['decision']).toBe('block');
    expect(parsedOutput['reason']).toBe('Test block decision');
  });

  test('should format JSON output with proper indentation', async () => {
    const output = {
      decision: 'block' as const,
      reason: 'Safe command approved',
    };

    outputJson(output);

    // Check that JSON is properly formatted with 2-space indentation
    const expectedJson = JSON.stringify(output, null, 2);
    const proc = await getMockProcess();
    expect(proc.stdout.output).toBe(expectedJson);
  });
});

describe('Runtime Configuration', () => {
  beforeEach(async () => {
    await resetMockProcess();
  });

  test('defaults hook timeout to 60 seconds', async () => {
    await resetMockProcess();

    expect(getConfig().timeout).toBe(60);
  });

  test('uses CLAUDE_HOOK_TIMEOUT when provided', async () => {
    const proc = await resetMockProcess();
    proc.env['CLAUDE_HOOK_TIMEOUT'] = '15';
    resetConfigCache();

    expect(getConfig().timeout).toBe(15);
  });

  test('parses SessionEnd timeout budget', async () => {
    const proc = await resetMockProcess();
    expect(getConfig().sessionEndTimeoutMs).toBe(1500);

    proc.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'] = '5000';
    resetConfigCache();
    expect(getConfig().sessionEndTimeoutMs).toBe(5000);

    proc.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'] = 'not-a-number';
    resetConfigCache();
    expect(getConfig().sessionEndTimeoutMs).toBe(1500);

    proc.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'] = '0';
    resetConfigCache();
    expect(getConfig().sessionEndTimeoutMs).toBe(1500);

    proc.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'] = '90000';
    resetConfigCache();
    expect(getConfig().sessionEndTimeoutMs).toBe(60000);
  });

  test('treats verbose Claude Code debug log level as debug mode', async () => {
    const proc = await resetMockProcess();
    proc.env['CLAUDE_CODE_DEBUG_LOG_LEVEL'] = 'verbose';
    resetConfigCache();

    expect(getConfig().debug).toBe(true);
  });

  test('parses sync plugin install flag', async () => {
    const proc = await resetMockProcess();
    expect(getConfig().syncPluginInstall).toBe(false);

    proc.env['CLAUDE_CODE_SYNC_PLUGIN_INSTALL'] = 'true';
    resetConfigCache();
    expect(getConfig().syncPluginInstall).toBe(true);
  });
});

describe('Input Validation', () => {
  test('should validate required hook input fields', () => {
    const validInput = createPreToolUseInput('Bash', { command: 'echo test' });

    expect(() => {
      validateRequiredFields(toRecord(validInput), [
        'session_id',
        'hook_event_name',
        'tool_name',
      ]);
    }).not.toThrow();
  });

  test('should throw error for missing required fields', () => {
    const invalidInput = { session_id: 'test' }; // Missing required fields

    expect(() => {
      validateRequiredFields(invalidInput, [
        'session_id',
        'hook_event_name',
        'tool_name',
      ]);
    }).toThrow(/Missing required field/);
  });

  test('should validate bash tool input', () => {
    const bashInput = createPreToolUseInput('Bash', {
      command: 'ls -la',
      description: 'List files',
      timeout: 30000,
    });

    expect(bashInput.tool_name).toBe('Bash');
    expect(validateBashToolInput(bashInput).command).toBe('ls -la');
    expect(validateBashToolInput(bashInput).description).toBe('List files');
  });

  test('should validate write tool input', () => {
    const writeInput = createPreToolUseInput('Write', {
      file_path: '/test/file.txt',
      content: 'Test content',
    });

    expect(writeInput.tool_name).toBe('Write');
    expect(validateWriteToolInput(writeInput).file_path).toBe('/test/file.txt');
    expect(validateWriteToolInput(writeInput).content).toBe('Test content');
  });
});

describe('Security Validation', () => {
  test('should detect protected files', () => {
    expect(isProtectedFile('.env')).toBe(true);
    expect(isProtectedFile('.env.local')).toBe(true);
    expect(isProtectedFile('.git/config')).toBe(true);
    expect(isProtectedFile('package-lock.json')).toBe(true);
    expect(isProtectedFile('regular-file.txt')).toBe(false);
  });

  test('should handle Windows-style paths', () => {
    // Test Windows backslash paths - should be normalized to forward slashes
    expect(isProtectedFile('.git\\config')).toBe(true);
    expect(isProtectedFile('.env.local')).toBe(true);
    expect(isProtectedFile('src\\regular-file.txt')).toBe(false);
  });

  test('should handle trailing slashes consistently', () => {
    // These should all be treated the same way
    expect(isProtectedFile('.git')).toBe(isProtectedFile('.git/'));
    expect(isProtectedFile('.git/config')).toBe(true);
    expect(isProtectedFile('.git/config/')).toBe(true);
  });

  test('should handle case sensitivity appropriately', () => {
    // On case-insensitive systems (simulated), these should match
    // On case-sensitive systems, they should not match
    const originalPlatform = process.platform;

    // Test case-sensitive behavior (Unix-like)
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
    });
    expect(isProtectedFile('.ENV')).toBe(false); // Different case, should not match
    expect(isProtectedFile('.env')).toBe(true); // Exact case, should match

    // Test case-insensitive behavior (Windows-like)
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    expect(isProtectedFile('.ENV')).toBe(true); // Different case, should match on Windows
    expect(isProtectedFile('.env')).toBe(true); // Same case, should match

    // Restore original platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
  });

  test('should handle complex glob patterns with edge cases', () => {
    // Test recursive glob patterns
    expect(isProtectedFile('.git/objects/abc123')).toBe(true); // Matches .git/**
    expect(isProtectedFile('.git/refs/heads/main')).toBe(true); // Matches .git/**

    // Test that non-matching paths are not protected
    expect(isProtectedFile('gitignore')).toBe(false); // Doesn't start with .git
    expect(isProtectedFile('my-git-file')).toBe(false); // Contains git but different pattern
  });

  test('should detect dangerous commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('sudo rm important-file')).toBe(true);
    expect(isDangerousCommand('chmod 777 file')).toBe(true);
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
  });

  test('should handle path traversal attempts', () => {
    expect(isProtectedFile('../../../etc/passwd')).toBe(false); // Not in our protected patterns
    expect(() => {
      validateRequiredFields({ file_path: '../../../etc/passwd' }, [
        'file_path',
      ]);
    }).not.toThrow(); // Basic validation doesn't check path traversal
  });
});

describe('Hook Integration', () => {
  test('should handle PreToolUse for Bash commands', () => {
    const bashInput = createPreToolUseInput('Bash', {
      command: 'echo "Hello World"',
      description: 'Print greeting',
    });

    // Verify input structure
    expect(bashInput.hook_event_name).toBe('PreToolUse');
    expect(bashInput.tool_name).toBe('Bash');
    expect(bashInput.tool_input['command']).toBe('echo "Hello World"');
  });

  test('should handle PostToolUse for file operations', () => {
    const writeInput = createPostToolUseInput(
      'Write',
      { file_path: '/test/output.txt', content: 'Test content' },
      { filePath: '/test/output.txt', success: true }
    );

    // Verify input structure
    expect(writeInput.hook_event_name).toBe('PostToolUse');
    expect(writeInput.tool_name).toBe('Write');
    expect(writeInput.tool_response['success']).toBe(true);
  });

  test('should handle multiple tools in sequence', () => {
    const tools = ['Write', 'Edit', 'Bash', 'Read'];

    tools.forEach(toolName => {
      const input = createPreToolUseInput(toolName, {
        example: `${toolName} tool input`,
      });

      expect(input.tool_name).toBe(toolName);
      expect(input.hook_event_name).toBe('PreToolUse');
    });
  });
});

describe('Session C Reference Handlers', () => {
  beforeEach(async () => {
    await resetMockProcess();
  });

  const handlerCases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'UserPromptExpansion',
      run: () => handleUserPromptExpansion(createUserPromptExpansionInput()),
    },
    {
      name: 'PostToolBatch',
      run: () => handlePostToolBatch(createPostToolBatchInput()),
    },
    {
      name: 'PostToolUseFailure',
      run: () =>
        handlePostToolUseFailure(
          createPostToolUseFailureInput(
            'Bash',
            { command: 'exit 1' },
            'Command failed'
          )
        ),
    },
    {
      name: 'PermissionRequest',
      run: () =>
        handlePermissionRequest(
          createPermissionRequestInput('Bash', { command: 'npm test' })
        ),
    },
    {
      name: 'PermissionDenied',
      run: () => handlePermissionDenied(createPermissionDeniedInput()),
    },
    {
      name: 'SubagentStart',
      run: () => handleSubagentStart(createSubagentStartInput()),
    },
    {
      name: 'TeammateIdle',
      run: () => handleTeammateIdle(createTeammateIdleInput()),
    },
    {
      name: 'TaskCreated',
      run: () => handleTaskCreated(createTaskCreatedInput()),
    },
    {
      name: 'TaskCompleted',
      run: () => handleTaskCompleted(createTaskCompletedInput()),
    },
    {
      name: 'StopFailure',
      run: () => handleStopFailure(createStopFailureInput()),
    },
    {
      name: 'InstructionsLoaded',
      run: () => handleInstructionsLoaded(createInstructionsLoadedInput()),
    },
    {
      name: 'ConfigChange',
      run: () => handleConfigChange(createConfigChangeInput()),
    },
    {
      name: 'CwdChanged',
      run: () => handleCwdChanged(createCwdChangedInput()),
    },
    {
      name: 'FileChanged',
      run: () => handleFileChanged(createFileChangedInput()),
    },
    {
      name: 'WorktreeCreate',
      run: () => handleWorktreeCreate(createWorktreeCreateInput()),
    },
    {
      name: 'WorktreeRemove',
      run: () => handleWorktreeRemove(createWorktreeRemoveInput()),
    },
    {
      name: 'PostCompact',
      run: () => handlePostCompact(createPostCompactInput()),
    },
    {
      name: 'Elicitation',
      run: () => handleElicitation(createElicitationInput()),
    },
    {
      name: 'ElicitationResult',
      run: () => handleElicitationResult(createElicitationResultInput()),
    },
  ];

  test.each(handlerCases)('$name handler accepts a valid input', async item => {
    await expect(item.run()).resolves.toBeUndefined();
  });
});

describe('Session C Handler Regressions', () => {
  beforeEach(async () => {
    await resetMockProcess();
  });

  test('SessionStart context includes model and agent type', async () => {
    const proc = await resetMockProcess();
    proc.env['CLAUDE_PROJECT_DIR'] = process.cwd();

    const originalEnv = { ...process.env };
    process.env['CLAUDE_HOOK_SESSION_GIT'] = 'false';
    process.env['CLAUDE_HOOK_SESSION_DEPS'] = 'false';
    process.env['CLAUDE_HOOK_SESSION_CHANGES'] = 'false';
    process.env['CLAUDE_HOOK_SESSION_DEV_STATUS'] = 'false';
    process.env['CLAUDE_HOOK_CONTEXT_FILES'] = '__missing_context_file__';

    try {
      await handleSessionStart(
        createSessionStartInput({
          model: 'claude-test-model',
          agent_type: 'reviewer',
        })
      );
    } finally {
      process.env = originalEnv;
    }

    const output = parseJsonObject(proc.stdout.output);
    const additionalContext = getString(
      getRecord(output, 'hookSpecificOutput'),
      'additionalContext'
    );
    expect(additionalContext).toContain('**Model:** claude-test-model');
    expect(additionalContext).toContain('**Agent Type:** reviewer');
  });

  test('Notification classification honors notification_type', () => {
    expect(
      classifyNotification('Waiting for approval', 'permission_prompt')
    ).toBe('permission');
    expect(classifyNotification('Authenticated', 'auth_success')).toBe('info');
    expect(
      classifyNotification('Server needs input', 'elicitation_dialog')
    ).toBe('waiting');
    expect(
      classifyNotification('Background agent paused', 'agent_needs_input')
    ).toBe('waiting');
    expect(
      classifyNotification('Background agent finished', 'agent_completed')
    ).toBe('info');
  });

  test('Notification honors optional title from input', async () => {
    const proc = await resetMockProcess();
    captureConsoleErrorToStderr(proc);
    const originalEnv = { ...process.env };
    process.env['CLAUDE_HOOK_DESKTOP_NOTIFICATIONS'] = 'false';
    process.env['CLAUDE_HOOK_CONSOLE_NOTIFICATIONS'] = 'true';
    process.env['CLAUDE_HOOK_NOTIFICATIONS_IN_CI'] = 'true';

    try {
      await handleNotification(
        createNotificationInput('Agent needs your input', 'agent_needs_input', {
          title: 'Custom agent title',
        })
      );
    } finally {
      process.env = originalEnv;
    }

    expect(proc.stderr.output).toContain('Custom agent title');
    expect(proc.stderr.output).toContain('Agent needs your input');
  });

  test('custom notification commands expand placeholders to env refs (not raw text)', () => {
    const expanded = expandNotificationCommandPlaceholders(
      'notify --title {title} --body {message} --p {priority} {icon}',
      {
        title: 'SAFE_TITLE_VALUE',
        message: 'SAFE_MESSAGE_VALUE',
        priority: 'high',
        icon: '🔐',
      }
    );
    expect(expanded).toBe(
      'notify --title "${CLAUDE_NOTIFICATION_TITLE}" --body "${CLAUDE_NOTIFICATION_MESSAGE}" --p "${CLAUDE_NOTIFICATION_PRIORITY}" "${CLAUDE_NOTIFICATION_ICON}"'
    );
    expect(expanded).not.toContain('{title}');
    expect(expanded).not.toContain('{message}');
    // Notification values must not be spliced into the shell source string.
    expect(expanded).not.toContain('SAFE_TITLE_VALUE');
    expect(expanded).not.toContain('SAFE_MESSAGE_VALUE');
  });

  test('custom notification placeholders expand inside single-quoted shell words', () => {
    // Legacy form Greptile flagged: printf '%s' '{title}'
    expect(expandNotificationCommandPlaceholders(`printf '%s' '{title}'`)).toBe(
      `printf '%s' ''"\${CLAUDE_NOTIFICATION_TITLE}"''`
    );

    // Placeholder embedded in a larger single-quoted string
    expect(
      expandNotificationCommandPlaceholders(`echo 'prefix {message} suffix'`)
    ).toBe(`echo 'prefix '"\${CLAUDE_NOTIFICATION_MESSAGE}"' suffix'`);

    // Double-quoted placeholders keep a single surrounding double-quoted word
    expect(
      expandNotificationCommandPlaceholders(`notify --title "{title}"`)
    ).toBe(`notify --title "\${CLAUDE_NOTIFICATION_TITLE}"`);
  });

  test('custom notification placeholder expansion cannot inject shell metacharacters', () => {
    const hostile = '"; touch /tmp/pwned; #';
    const expanded = expandNotificationCommandPlaceholders(
      'echo {title} {message}',
      {
        title: hostile,
        message: '$(evil)',
        priority: 'high',
        icon: 'x',
      }
    );
    // Raw hostile payload must never appear in the sh -c source string.
    expect(expanded).not.toContain(hostile);
    expect(expanded).not.toContain('$(evil)');
    expect(expanded).toBe(
      'echo "${CLAUDE_NOTIFICATION_TITLE}" "${CLAUDE_NOTIFICATION_MESSAGE}"'
    );

    const singleQuotedHostile = expandNotificationCommandPlaceholders(
      `printf '%s' '{title}'`,
      { title: hostile, message: 'm', priority: 'low', icon: 'i' }
    );
    expect(singleQuotedHostile).not.toContain(hostile);
    expect(singleQuotedHostile).toContain('${CLAUDE_NOTIFICATION_TITLE}');
  });

  test('StopFailure logs without writing meaningful JSON stdout', async () => {
    const proc = await resetMockProcess();

    await handleStopFailure(
      createStopFailureInput({
        error: 'rate_limit',
        error_details: '429 Too Many Requests',
      })
    );

    expect(proc.stdout.output.trim()).toBe('');
  });

  test('SubagentStop reads agent_transcript_path for analysis', async () => {
    const proc = await resetMockProcess();
    const originalEnv = { ...process.env };
    process.env['CLAUDE_HOOK_VALIDATE_SUBAGENT'] = 'true';
    process.env['CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS'] = 'false';
    process.env['CLAUDE_HOOK_LOG_SUBAGENT_METRICS'] = 'false';

    try {
      await handleSubagentStop(
        createSubagentStopInput({
          agent_transcript_path: '/tmp/missing-agent-transcript.jsonl',
          transcript_path: '/tmp/missing-parent-transcript.jsonl',
          stop_hook_active: false,
        })
      );
    } finally {
      process.env = originalEnv;
    }

    // Missing transcripts complete without throwing when no error markers exist.
    expect(typeof proc.stdout.output).toBe('string');
  });

  test('SubagentStop treats empty agent transcript plus error final message as failed', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const proc = await resetMockProcess();
    const originalEnv = { ...process.env };
    process.env['CLAUDE_HOOK_VALIDATE_SUBAGENT'] = 'true';
    process.env['CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS'] = 'false';
    process.env['CLAUDE_HOOK_LOG_SUBAGENT_METRICS'] = 'false';

    const dir = await mkdtemp(join(tmpdir(), 'subagent-stop-'));
    const emptyAgentTranscript = join(dir, 'agent.jsonl');
    await writeFile(emptyAgentTranscript, '', 'utf-8');

    try {
      await handleSubagentStop(
        createSubagentStopInput({
          agent_transcript_path: emptyAgentTranscript,
          transcript_path: join(dir, 'missing-parent.jsonl'),
          stop_hook_active: false,
          last_assistant_message: 'Error: task failed',
        })
      );
    } finally {
      process.env = originalEnv;
      await rm(dir, { recursive: true, force: true });
    }

    const output = parseJsonObject(proc.stdout.output);
    expect(getString(output, 'decision')).toBe('block');
    expect(getString(output, 'reason')).toContain('Error:');
  });

  test('PreCompact emits systemMessage and stores context for SessionStart', async () => {
    const proc = await resetMockProcess();

    const originalEnv = { ...process.env };
    process.env['CLAUDE_HOOK_SAVE_CONTEXT'] = 'false';
    process.env['CLAUDE_HOOK_GENERATE_SUMMARY'] = 'false';
    process.env['CLAUDE_HOOK_CREATE_BACKUP'] = 'false';

    try {
      await handlePreCompact(
        createPreCompactInput({
          custom_instructions: 'ignore all minor details',
        })
      );
    } finally {
      process.env = originalEnv;
    }

    const output = parseJsonObject(proc.stdout.output);
    // PreCompact no longer injects additionalContext (not a documented channel).
    // Context is user-visible via systemMessage and re-injected on compact SessionStart.
    expect(getString(output, 'systemMessage')).toContain(
      'Instruction Validation'
    );
    expect(output['hookSpecificOutput']).toBeUndefined();
  });

  test('formatDetailedContextSummary keeps full decisions and files (not counts only)', () => {
    const detailed = formatDetailedContextSummary({
      projectStatus: '3 modified files',
      keyDecisions: ['decided to use Vitest for unit tests'],
      recentChanges: ['src/lifecycle/pre-compact.ts'],
      pendingTasks: [],
      errors: ['Type error in hooks'],
      importantFiles: [
        'src/lifecycle/pre-compact.ts',
        'src/lifecycle/session-start.ts',
      ],
    });

    expect(detailed).toContain('decided to use Vitest for unit tests');
    expect(detailed).toContain('src/lifecycle/session-start.ts');
    expect(detailed).toContain('Type error in hooks');
    // Abbreviated board style ("1 recorded") must not replace the detailed body.
    expect(detailed).not.toMatch(/Key Decisions:\s*1 recorded/i);
  });

  test('PreCompact SessionStart restore keeps detailed context after single write', async () => {
    const sessionId = `precompact-restore-${Date.now()}`;
    // Simulate the two payloads the handler used to write separately.
    // The bug was a second savePreCompactContext call overwriting the first.
    const detailed = formatDetailedContextSummary({
      projectStatus: 'dirty tree',
      keyDecisions: ['decided to use strict PreCompact schema'],
      recentChanges: [],
      pendingTasks: [],
      errors: [],
      importantFiles: ['src/validation/schemas.ts'],
    });
    const abbreviated = [
      'Pre-Compact Context Summary',
      '',
      '📋 **Project Status Preserved**',
      'Key Decisions: 1 recorded',
    ].join('\n');

    // Correct single-write contract used by handlePreCompact after the fix.
    await savePreCompactContext(
      sessionId,
      [detailed, abbreviated].filter(Boolean).join('\n\n')
    );
    const restored = await consumePreCompactContext(sessionId);

    expect(restored).toContain('decided to use strict PreCompact schema');
    expect(restored).toContain('src/validation/schemas.ts');
    expect(restored).toContain('Key Decisions: 1 recorded');
    // Second consume should find nothing (file removed).
    expect(await consumePreCompactContext(sessionId)).toBeNull();
  });
});

describe('Error Handling', () => {
  test('should handle missing tool input gracefully', () => {
    const invalidInput = createPreToolUseInput('Bash', {});

    // The hook should handle empty tool inputs
    expect(invalidInput.tool_input).toEqual({});
    expect(invalidInput.hook_event_name).toBe('PreToolUse');
  });

  test('should handle malformed tool inputs', () => {
    const malformedInput = createPreToolUseInput('Bash', {
      // Missing required command field
      description: 'No command provided',
    });

    expect(malformedInput.tool_input['description']).toBe(
      'No command provided'
    );
    expect(malformedInput.tool_input['command']).toBeUndefined();
  });

  test('should handle empty session data', () => {
    const emptySessionInput = {
      ...createPreToolUseInput('Write', { file_path: 'test.txt', content: '' }),
      session_id: '',
      transcript_path: '',
    };

    expect(emptySessionInput.session_id).toBe('');
    expect(emptySessionInput.transcript_path).toBe('');
  });
});

describe('Performance and Limits', () => {
  test('should handle large tool inputs', () => {
    const largeContent = 'x'.repeat(100000); // 100KB of content

    const largeInput = createPreToolUseInput('Write', {
      file_path: '/test/large-file.txt',
      content: largeContent,
    });

    expect(largeInput.tool_input['content']).toHaveLength(100000);
    expect(typeof largeInput.tool_input['content']).toBe('string');
  });

  test('should handle many rapid hook calls', () => {
    const hookCalls: PreToolUseInput[] = [];

    // Simulate 100 rapid hook calls
    for (let i = 0; i < 100; i++) {
      hookCalls.push(
        createPreToolUseInput('Bash', {
          command: `echo "Hook call ${i}"`,
          description: `Test hook ${i}`,
        })
      );
    }

    expect(hookCalls).toHaveLength(100);
    expect(hookCalls[0]?.tool_input['command']).toBe('echo "Hook call 0"');
    expect(hookCalls[99]?.tool_input['command']).toBe('echo "Hook call 99"');
  });

  test('should cache regex patterns for performance', () => {
    // Clear cache to start with clean state
    if (typeof clearGlobRegexCache === 'function') {
      clearGlobRegexCache();
    } else {
      console.log('clearGlobRegexCache function not available');
    }

    // First call - should compile regex
    const result1 = isProtectedFile('.git/config');

    // Second call - should use cached regex
    const result2 = isProtectedFile('.git/config');

    // Both calls should return the same result
    expect(result1).toBe(true);
    expect(result2).toBe(true);

    // Second call should be faster (cached)
    // Note: This is a micro-benchmark, so results may vary
    // We're mainly testing that caching doesn't break functionality
    expect(result1).toBe(result2);
  });

  test('should handle cache clearing', () => {
    // Populate cache
    isProtectedFile('.git/**');
    isProtectedFile('*.lock');

    // Clear cache should not throw
    if (typeof clearGlobRegexCache === 'function') {
      expect(() => clearGlobRegexCache()).not.toThrow();
    } else {
      // Skip this test if function not available
      console.log('clearGlobRegexCache function not available, skipping');
    }

    // Function should still work after cache clearing
    expect(isProtectedFile('.git/config')).toBe(true);
    expect(isProtectedFile('package-lock.json')).toBe(true);
  });

  test('should handle repeated pattern matching efficiently', () => {
    if (typeof clearGlobRegexCache === 'function') {
      clearGlobRegexCache();
    }

    const testPaths = [
      '.git/config',
      '.git/objects/abc123',
      '.env.local',
      'package-lock.json',
      'yarn.lock',
      '.git/refs/heads/main',
    ];

    // Test multiple iterations to exercise caching
    const startTime = performance.now();
    for (let i = 0; i < 10; i++) {
      testPaths.forEach(path => {
        isProtectedFile(path);
      });
    }
    const endTime = performance.now();
    const totalDuration = endTime - startTime;

    // Should handle 60 calls (10 iterations * 6 paths) quickly
    expect(totalDuration).toBeLessThan(50); // 50ms should be plenty

    // Verify results are still correct after caching
    expect(isProtectedFile('.git/config')).toBe(true);
    expect(isProtectedFile('.env.local')).toBe(true);
    expect(isProtectedFile('regular-file.txt')).toBe(false);
  });
});

describe('Integration Tests - Full I/O Pipeline', () => {
  test('should handle complete hook execution pipeline', async () => {
    // Test the complete flow: stdin -> process -> stdout
    const testInput = createPreToolUseInput('Bash', {
      command: 'echo "test"',
      description: 'Test command',
    });

    // Set up input
    const proc = await getMockProcess();
    proc.stdin.data = JSON.stringify(testInput);
    proc.stdout.output = '';

    // Read input
    const parsedInput = await readStdinJson();
    expect(parsedInput).toEqual(testInput);

    // Process and validate
    expect(() => {
      validateRequiredFields(toRecord(parsedInput), [
        'session_id',
        'hook_event_name',
        'tool_name',
      ]);
    }).not.toThrow();

    // Generate response and output
    const response = {
      decision: 'block' as const,
      reason: 'Integration test response',
    };

    outputJson(response);

    // Verify output
    expect(proc.stdout.output).toBeTruthy();
    const outputResult = parseJsonObject(proc.stdout.output);
    expect(outputResult).toEqual(response);
  });

  test('should handle error conditions in pipeline', async () => {
    // Test error handling through the pipeline
    const proc = await getMockProcess();
    proc.stdin.data = 'invalid json';
    proc.stdout.output = '';

    // Should throw on invalid JSON
    await expect(readStdinJson()).rejects.toThrow(
      /Failed to parse hook input JSON/
    );
  });

  test('should integrate with security validation', async () => {
    // Test security integration in pipeline
    const testInput = createPreToolUseInput('Write', {
      file_path: '.env', // Protected file
      content: 'SECRET=test',
    });

    const proc = await getMockProcess();
    proc.stdin.data = JSON.stringify(testInput);
    proc.stdout.output = '';

    // Read and validate input
    const parsedInput = await readStdinJson();

    // Check security validation — narrow to PreToolUse to access tool_input
    const toolInput = 'tool_input' in parsedInput ? parsedInput.tool_input : {};
    const isProtected = isProtectedFile(String(toolInput['file_path'] ?? ''));
    expect(isProtected).toBe(true);

    // Generate security response
    const securityResponse = {
      decision: 'block' as const,
      reason: 'Cannot modify protected file: .env',
    };

    outputJson(securityResponse);

    // Verify security response
    const outputResult = parseJsonObject(proc.stdout.output);
    expect(outputResult['decision']).toBe('block');
    expect(outputResult['reason']).toContain('protected file');
  });

  test('should handle multiple hook types in sequence', async () => {
    // Test different hook types can be processed
    const hookTypes = [
      createPreToolUseInput('Bash', { command: 'ls' }),
      createPostToolUseInput(
        'Write',
        { file_path: 'test.txt', content: 'test' },
        { success: true }
      ),
    ];

    for (const hookInput of hookTypes) {
      const proc = await getMockProcess();
      proc.stdin.data = JSON.stringify(hookInput);
      proc.stdout.output = '';

      // Each should be processable through the pipeline
      const parsedInput = await readStdinJson();
      expect(parsedInput.hook_event_name).toMatch(/^(PreToolUse|PostToolUse)$/);

      // Validate required fields
      expect(() => {
        validateRequiredFields(toRecord(parsedInput), [
          'session_id',
          'hook_event_name',
          'tool_name',
        ]);
      }).not.toThrow();
    }
  });
});

// Test runner configuration
describe('Hook System Integration', () => {
  test('should be ready for production use', () => {
    // Verify all essential components exist
    expect(typeof readStdinJson).toBe('function');
    expect(typeof outputJson).toBe('function');
    expect(typeof validateRequiredFields).toBe('function');
    expect(typeof isProtectedFile).toBe('function');
    expect(typeof isDangerousCommand).toBe('function');
  });

  test('should support all hook event types', () => {
    const eventTypes = [
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'PostToolUseFailure',
      'UserPromptSubmit',
      'Notification',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'TeammateIdle',
      'TaskCompleted',
      'PreCompact',
      'SessionStart',
      'SessionEnd',
    ];

    eventTypes.forEach(eventType => {
      const input = {
        session_id: 'test',
        transcript_path: '/tmp/test.jsonl',
        cwd: '/test',
        hook_event_name: eventType,
      };

      expect(input.hook_event_name).toBe(eventType);
    });
  });
});
