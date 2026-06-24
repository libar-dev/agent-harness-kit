#!/usr/bin/env tsx

/**
 * Long-Running Commands Hook
 *
 * This PreToolUse hook intercepts critical validation commands that require
 * extended timeouts beyond Claude Code's default 30-second limit.
 *
 * Intercepted Commands:
 * - npm run check:fast (~75s)
 * - npm run check (~90s)
 * - npm run fix:file -- <path> (~30-60s)
 * - npm run typecheck:all (~60s)
 * - npm run lint:focus (~30s)
 *
 * Strategy:
 * - Auto-approve matching commands (no permission blocking)
 * - Execute with extended timeouts (120-180s)
 * - Stream progress feedback to Claude
 * - Handle validation errors gracefully
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executeHook,
  logInfo,
  logDebug,
  logError,
  outputJson,
  getProjectDir,
  isRecord,
  toError,
} from '../utils/index.js';
import { HookOutputBuilder, type PreToolUseInput } from '../types/index.js';
import { validateBashToolInput } from '../validation/index.js';

const execFileAsync = promisify(execFile);

/**
 * Configuration for command timeouts (in seconds)
 */
const COMMAND_TIMEOUTS = {
  'check:fast': 180, // TypeScript-only validation
  check: 180, // TypeScript + ESLint cached
  'fix:file': 120, // File-specific validation + fixes
  'typecheck:all': 120, // Core TypeScript validation
  'lint:focus': 90, // Filtered lint output
  'lint:dev': 90, // Development lint (cached)
  lint: 120, // Full lint (can be slow on cache invalidation)
  'lint:classify': 90, // Lint analysis wrapper
  'lint:session': 90, // Session-specific lint filtering
  sync: 120, // Validators + codegen + check:fast
  codegen: 60, // Convex type generation
} as const;

/**
 * Long-running validation command patterns
 */
const LONG_RUNNING_PATTERNS = [
  /^npm run check:fast$/,
  /^npm run check$/,
  /^npm run check:ci$/,
  /^npm run fix:file\s+--\s+.+$/,
  /^npm run typecheck:all$/,
  /^npm run lint:focus$/,
  /^npm run lint:dev$/,
  /^npm run lint$/,
  /^npm run lint:classify$/,
  /^npm run lint:session:.+$/,
  /^npm run sync$/,
  /^npm run validate:.+$/,
  /^npx convex codegen(\s+--typecheck[=-](?:disable|enable))?$/,
];

/**
 * Check if a command is a long-running validation command
 */
function isLongRunningCommand(command: string): boolean {
  return LONG_RUNNING_PATTERNS.some(pattern => pattern.test(command.trim()));
}

/**
 * Get timeout for a specific command
 */
function getCommandTimeout(command: string): number {
  // Extract command name from npm run scripts
  const match = command.match(/npm run ([\w:]+)/);
  if (!match?.[1]) return 120; // Default 2 minutes

  const scriptName = match[1];

  // Check exact matches first
  for (const [key, timeout] of Object.entries(COMMAND_TIMEOUTS)) {
    if (scriptName === key || scriptName.startsWith(`${key}:`)) {
      return timeout;
    }
  }

  // Default for validation-related commands
  if (scriptName.includes('validate') || scriptName.includes('check')) {
    return 180;
  }

  return 120; // Default 2 minutes
}

/**
 * Get friendly name for progress messages
 */
function getCommandDisplayName(command: string): string {
  // Handle npx commands
  if (command.startsWith('npx convex codegen')) {
    return 'Convex type generation';
  }

  const match = command.match(/npm run ([\w:]+)/);
  if (!match?.[1]) return 'validation command';

  const scriptName = match[1];
  const displayNames: Record<string, string> = {
    'check:fast': 'TypeScript validation (fast)',
    check: 'TypeScript + ESLint validation',
    'fix:file': 'file validation and formatting',
    'typecheck:all': 'TypeScript type checking',
    'lint:focus': 'focused lint checking',
    lint: 'ESLint validation',
    'lint:classify': 'lint error classification',
    sync: 'schema sync and validation',
  };

  // Handle lint:session:* dynamically
  if (scriptName.startsWith('lint:session:')) {
    const group = scriptName.replace('lint:session:', '');
    return `lint session analysis (${group})`;
  }

  return displayNames[scriptName] ?? scriptName.replace(/:/g, ' ');
}

/**
 * Execute a long-running command with extended timeout
 */
async function executeLongRunningCommand(
  command: string,
  projectDir: string,
  timeout: number
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    logInfo(
      `Executing long-running command with ${timeout}s timeout: ${command}`
    );

    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd: projectDir,
      timeout: timeout * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      env: {
        ...process.env,
        FORCE_COLOR: '0', // Disable color codes in output
      },
    });

    logInfo(`Command completed successfully: ${command}`);
    return { success: true, stdout, stderr };
  } catch (error: unknown) {
    const execError = getExecError(error);

    // Handle timeout
    if (execError.code === 'ETIMEDOUT' || execError.killed) {
      logError(
        `Command timed out after ${timeout}s: ${command}`,
        toError(error)
      );
      return {
        success: false,
        stdout: execError.stdout ?? '',
        stderr: `Command timed out after ${timeout} seconds. Consider optimizing or increasing timeout.`,
      };
    }

    // Handle validation failures (exit code != 0)
    logDebug(`Command failed with error: ${execError.message ?? 'Unknown'}`);
    return {
      success: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message ?? 'Unknown error',
    };
  }
}

function getExecError(error: unknown): {
  code?: string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
} {
  if (!isRecord(error)) {
    return { message: String(error) };
  }

  const code = error['code'];
  const killed = error['killed'];
  const signal = error['signal'];
  const stdout = error['stdout'];
  const stderr = error['stderr'];
  const message = error['message'];

  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {}),
    ...(typeof signal === 'string' ? { signal } : {}),
    ...(typeof stdout === 'string' ? { stdout } : {}),
    ...(typeof stderr === 'string' ? { stderr } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/**
 * Main hook logic
 */
async function handleLongRunningCommand(input: PreToolUseInput): Promise<void> {
  // Only process Bash tool calls
  if (input.tool_name !== 'Bash') {
    return;
  }

  // Validate and extract command
  const bashInput = validateBashToolInput(input);
  const command = bashInput.command.trim();

  // Check if this is a long-running validation command
  if (!isLongRunningCommand(command)) {
    logDebug(`Command not matched for long-running handling: ${command}`);
    return;
  }

  const timeout = getCommandTimeout(command);
  const displayName = getCommandDisplayName(command);
  const projectDir = getProjectDir();

  logInfo(
    `Intercepting long-running command: ${command} (timeout: ${timeout}s)`
  );

  // Auto-approve and provide progress feedback
  outputJson(
    HookOutputBuilder.permission(
      'allow',
      `Running ${displayName} with ${timeout}s timeout...`
    )
  );

  // Execute the command with extended timeout
  const result = await executeLongRunningCommand(command, projectDir, timeout);

  if (result.success) {
    // Success - provide feedback if there's meaningful output
    if (result.stdout.trim()) {
      const successMsg = `✅ ${displayName} completed successfully\n\n${result.stdout.substring(0, 500)}${result.stdout.length > 500 ? '\n... (output truncated)' : ''}`;
      logInfo(successMsg);
    } else {
      logInfo(`✅ ${displayName} completed successfully (no output)`);
    }
  } else {
    // Failure - provide error details to Claude
    const errorMsg = `❌ ${displayName} failed:\n\n${result.stderr}`;
    logError(`Command failed: ${command}`, new Error(result.stderr));

    // Don't block execution, but provide feedback
    outputJson({
      systemMessage: errorMsg,
      suppressOutput: false,
    });
  }
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(handleLongRunningCommand).catch(error => {
    console.error('Failed to execute long-running command hook:', error);
    process.exit(1);
  });
}

// Export for testing
export {
  handleLongRunningCommand,
  isLongRunningCommand,
  getCommandTimeout,
  getCommandDisplayName,
  executeLongRunningCommand,
};
