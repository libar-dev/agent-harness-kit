#!/usr/bin/env tsx

/**
 * Combined PostToolUse Hook Handler
 *
 * This hook combines multiple PostToolUse processors:
 * - Automatic code formatting (Prettier, ESLint)
 * - TypeScript validation and compilation checks
 * - Convex schema validation and codegen
 * - File content validation and feedback
 */

import { executeHook, logInfo, logDebug, getConfig } from '../utils/index.js';
import { validatePostToolUseInput } from '../validation/index.js';
import type { PostToolUseInput } from '../types/index.js';
import { formatCode } from './format-code.js';
import { validateTypeScript } from './validate-typescript.js';
import { handlePostToolBatch } from './post-tool-batch.js';
import { handlePostToolUseFailure } from './post-tool-use-failure.js';

/**
 * Main PostToolUse hook handler that coordinates all post-processing
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

  // Process different tools based on their type
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
 * Handle file modification operations (Write, Edit, MultiEdit)
 */
async function handleFileModification(input: PostToolUseInput): Promise<void> {
  // Run formatting and validation in sequence (formatting first, then validation)
  // This ensures that validation runs on properly formatted code

  try {
    // Step 1: Format code
    logDebug('Running code formatting');
    await formatCode(input);

    // Step 2: Validate TypeScript (if applicable)
    logDebug('Running TypeScript validation');
    await validateTypeScript(input);

    // Step 3: Additional file-specific validations
    await runAdditionalFileValidations(input);
  } catch (error) {
    logInfo(
      `Post-processing error (non-blocking): ${error instanceof Error ? error.message : String(error)}`
    );

    // Don't block execution for post-processing errors unless specifically configured
    if (process.env['CLAUDE_HOOK_STRICT_POST_VALIDATION'] === 'true') {
      throw error;
    }
  }
}

/**
 * Handle bash command execution
 */
async function handleBashExecution(input: PostToolUseInput): Promise<void> {
  const toolInput = input.tool_input;
  const toolResponse = input.tool_response;

  // Log command execution for audit trail — safe property access
  const command =
    typeof toolInput['command'] === 'string' ? toolInput['command'] : 'unknown';
  const success = toolResponse['success'] !== false; // Default to true if not specified

  logInfo(
    `Bash command ${success ? 'succeeded' : 'failed'}: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`
  );

  // Check for specific command patterns that might require follow-up
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

  // If command failed, we might want to provide suggestions
  const stderrValue = toolResponse['stderr'];
  if (!success && typeof stderrValue === 'string') {
    const stderr = stderrValue;
    await analyzeCommandFailure(command, stderr);
  }
}

/**
 * Handle subagent (Task) completion
 */
async function handleSubagentCompletion(
  input: PostToolUseInput
): Promise<void> {
  const taskResponse = input.tool_response;

  // Log subagent completion
  logInfo('Subagent task completed');

  if (getConfig().debug) {
    logDebug('Subagent response', {
      has_result: taskResponse['result'] !== undefined,
      success: taskResponse['success'] !== false,
    });
  }

  // Could add logic here to:
  // - Analyze subagent results
  // - Chain additional subagents based on results
  // - Validate subagent outputs
}

/**
 * Handle web operations
 */
async function handleWebOperation(input: PostToolUseInput): Promise<void> {
  logInfo(`Web operation completed: ${input.tool_name}`);

  // Could add logic here to:
  // - Cache web responses
  // - Validate web content
  // - Extract and process data from web responses
}

/**
 * Handle generic tools
 */
async function handleGenericTool(input: PostToolUseInput): Promise<void> {
  // Basic logging and analysis for unknown tools
  logDebug(`Generic tool ${input.tool_name} completed`);

  // Could add generic patterns like:
  // - Response size analysis
  // - Performance timing
  // - Error pattern detection
}

/**
 * Run additional file-specific validations
 */
async function runAdditionalFileValidations(
  input: PostToolUseInput
): Promise<void> {
  // Extract file path via safe property access
  const rawFilePath = input.tool_input['file_path'];
  const filePath = typeof rawFilePath === 'string' ? rawFilePath : undefined;

  if (!filePath) return;

  // File-specific validations based on file type/path
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
 * Analyze bash command failures and provide suggestions
 */
async function analyzeCommandFailure(
  _command: string,
  stderr: string
): Promise<void> {
  // Common error patterns and suggestions
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

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(handlePostToolUse).catch(error => {
    console.error('Failed to execute PostToolUse hook:', error);
    process.exit(1);
  });
}

// Export for testing and composition
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
