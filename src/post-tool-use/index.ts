#!/usr/bin/env tsx

/**
 * Combined PostToolUse Hook
 *
 * Coordinates PostToolUse formatting, validation, and analysis handlers.
 */

import { executeHook, logInfo, logDebug, getConfig } from '../utils/index.js';
import { validatePostToolUseInput } from '../validation/index.js';
import type { PostToolUseInput } from '../types/index.js';
import { formatCode } from './format-code.js';
import { validateTypeScript } from './validate-typescript.js';
import { handlePostToolBatch } from './post-tool-batch.js';
import { handlePostToolUseFailure } from './post-tool-use-failure.js';

/**
 * Coordinate post-processing for completed tool calls.
 */
async function handlePostToolUse(input: PostToolUseInput): Promise<void> {
  validatePostToolUseInput(input);

  const config = getConfig();
  const { tool_name, session_id } = input;

  logInfo(
    `PostToolUse hook triggered for ${tool_name} (session: ${session_id.substring(0, 8)}...)`
  );

  if (config.debug) {
    logDebug('Tool execution completed', {
      tool_name,
      has_tool_input: Object.keys(input.tool_input).length > 0,
      has_tool_response: Object.keys(input.tool_response ?? {}).length > 0,
      response_keys: Object.keys(input.tool_response ?? {}),
    });
  }

  switch (tool_name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      logDebug(
        'File modification detected - running post-modification processors'
      );
      await handleFileModification(input);
      break;

    case 'Bash':
      logDebug('Bash execution detected - running command analysis');
      await handleBashExecution(input);
      break;

    case 'Task':
      logDebug('Subagent task completed - running task analysis');
      await handleSubagentCompletion(input);
      break;

    case 'WebFetch':
    case 'WebSearch':
      logDebug('Web operation completed - running web analysis');
      await handleWebOperation(input);
      break;

    default:
      logDebug(
        `Generic tool ${tool_name} completed - running general analysis`
      );
      await handleGenericTool(input);
      break;
  }

  logDebug('PostToolUse hook completed');
}

/**
 * Run formatting and validation after file modifications.
 */
async function handleFileModification(input: PostToolUseInput): Promise<void> {
  try {
    logDebug('Running code formatting');
    await formatCode(input);

    logDebug('Running TypeScript validation');
    await validateTypeScript(input);

    await runAdditionalFileValidations(input);
  } catch (error) {
    logInfo(
      `Post-processing error (non-blocking): ${error instanceof Error ? error.message : String(error)}`
    );

    if (process.env['CLAUDE_HOOK_STRICT_POST_VALIDATION'] === 'true') {
      throw error;
    }
  }
}

/**
 * Record Bash execution results and analyze failures.
 */
async function handleBashExecution(input: PostToolUseInput): Promise<void> {
  const toolInput = input.tool_input;
  const toolResponse = input.tool_response;

  const command =
    typeof toolInput['command'] === 'string' ? toolInput['command'] : 'unknown';
  const success = toolResponse['success'] !== false; // Default to true if not specified

  logInfo(
    `Bash command ${success ? 'succeeded' : 'failed'}: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`
  );

  if (command.includes('convex codegen')) {
    logInfo('Convex codegen detected - types may have been updated');
  } else if (command.includes('npm install') || command.includes('yarn add')) {
    logInfo('Package installation detected - dependencies may have changed');
  } else if (
    command.includes('git ') &&
    (command.includes('pull') || command.includes('merge'))
  ) {
    logInfo('Git operation detected - codebase may have changed');
  }

  const stderrValue = toolResponse['stderr'];
  if (!success && typeof stderrValue === 'string') {
    const stderr = stderrValue;
    await analyzeCommandFailure(command, stderr);
  }
}

/**
 * Record subagent task completion.
 */
async function handleSubagentCompletion(
  input: PostToolUseInput
): Promise<void> {
  const taskResponse = input.tool_response;

  logInfo('Subagent task completed');

  if (getConfig().debug) {
    logDebug('Subagent response', {
      has_result: taskResponse['result'] !== undefined,
      success: taskResponse['success'] !== false,
    });
  }
}

/**
 * Record completed web operations.
 */
async function handleWebOperation(input: PostToolUseInput): Promise<void> {
  logInfo(`Web operation completed: ${input.tool_name}`);
}

/**
 * Record completed generic tools.
 */
async function handleGenericTool(input: PostToolUseInput): Promise<void> {
  logDebug(`Generic tool ${input.tool_name} completed`);
}

/**
 * Log file-specific follow-up guidance.
 */
async function runAdditionalFileValidations(
  input: PostToolUseInput
): Promise<void> {
  const rawFilePath = input.tool_input['file_path'];
  const filePath = typeof rawFilePath === 'string' ? rawFilePath : undefined;

  if (!filePath) return;

  if (filePath.includes('package.json')) {
    logInfo('package.json modified - consider running npm install');
  } else if (filePath.includes('convex/schema.ts')) {
    logInfo('Convex schema modified - types will be regenerated');
  } else if (filePath.includes('tsconfig.json')) {
    logInfo('TypeScript config modified - may affect compilation');
  } else if (filePath.includes('.env')) {
    logInfo('Environment file modified - restart may be required');
  }
}

/**
 * Analyze bash command failures and log guidance.
 */
async function analyzeCommandFailure(
  _command: string,
  stderr: string
): Promise<void> {
  const errorPatterns = [
    {
      pattern: /command not found/i,
      suggestion:
        'Command not found. Check if the tool is installed and in your PATH.',
    },
    {
      pattern: /permission denied/i,
      suggestion:
        'Permission denied. You may need to use sudo or check file permissions.',
    },
    {
      pattern: /no such file or directory/i,
      suggestion:
        'File or directory not found. Check the path and ensure the file exists.',
    },
    {
      pattern: /npm.*ENOENT/i,
      suggestion:
        'npm error: Try running "npm install" to install dependencies.',
    },
    {
      pattern: /git.*not a git repository/i,
      suggestion:
        'Not a git repository. Run "git init" to initialize a git repository.',
    },
    {
      pattern: /typescript.*error/i,
      suggestion:
        'TypeScript compilation error. Check the TypeScript code for syntax errors.',
    },
  ];

  for (const { pattern, suggestion } of errorPatterns) {
    if (pattern.test(stderr)) {
      logInfo(`Command failure analysis: ${suggestion}`);
      break;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(handlePostToolUse).catch(error => {
    console.error('Failed to execute PostToolUse hook:', error);
    process.exit(1);
  });
}

export {
  handlePostToolUse,
  handleFileModification,
  handleBashExecution,
  handleSubagentCompletion,
  handleWebOperation,
  runAdditionalFileValidations,
  handlePostToolBatch,
  handlePostToolUseFailure,
};
