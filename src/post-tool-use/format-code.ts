#!/usr/bin/env tsx

/**
 * Code Formatting Hook
 *
 * This PostToolUse hook automatically formats code files after they are modified:
 * - Runs prettier on supported file types
 * - Applies ESLint fixes for JavaScript/TypeScript files
 * - Validates formatting and provides feedback to Claude
 * - Supports project-specific formatting configuration
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import {
  executeHook,
  logInfo,
  logDebug,
  logError,
  outputJson,
  getProjectDir,
  shouldAutoFormat,
  getConfig,
  isRecord,
  toError,
} from '../utils/index.js';
import { HookOutputBuilder, type PostToolUseInput } from '../types/index.js';
import {
  validatePostToolUseInput,
  validateWriteToolInput,
  validateEditToolInput,
} from '../validation/index.js';

const execFileAsync = promisify(execFile);

/**
 * Configuration for code formatting
 */
interface FormatConfig {
  /** Whether to run prettier */
  prettier: boolean;
  /** Whether to run ESLint fixes */
  eslint: boolean;
  /** File extensions to format */
  extensions: string[];
  /** Maximum time to wait for formatting (seconds) */
  timeout: number;
  /** Whether to fail if formatting fails */
  failOnError: boolean;
}

/**
 * Get formatting configuration
 */
function getFormatConfig(): FormatConfig {
  const config = getConfig();

  return {
    prettier: process.env['CLAUDE_HOOK_DISABLE_PRETTIER'] !== 'true',
    eslint: process.env['CLAUDE_HOOK_DISABLE_ESLINT'] !== 'true',
    extensions: config.rules?.autoFormatExtensions ?? [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.json',
      '.css',
      '.md',
      '.yaml',
      '.yml',
    ],
    timeout: parseInt(process.env['CLAUDE_HOOK_FORMAT_TIMEOUT'] ?? '30', 10),
    failOnError: process.env['CLAUDE_HOOK_FAIL_ON_FORMAT_ERROR'] === 'true',
  };
}

/**
 * Main code formatting logic
 */
async function formatCode(input: PostToolUseInput): Promise<void> {
  validatePostToolUseInput(input);

  // Only process file modification tools
  const fileModificationTools = ['Write', 'Edit', 'MultiEdit'];
  if (!fileModificationTools.includes(input.tool_name)) {
    return;
  }

  let filePath: string;

  // Extract file path from tool input
  try {
    switch (input.tool_name) {
      case 'Write': {
        const writeInput = validateWriteToolInput(input);
        filePath = writeInput.file_path;
        break;
      }
      case 'Edit':
      case 'MultiEdit': {
        const editInput = validateEditToolInput(input);
        filePath = editInput.file_path;
        break;
      }
      default:
        return;
    }
  } catch (error) {
    logDebug(`Could not extract file path from ${input.tool_name}: ${error}`);
    return;
  }

  // Check if file should be formatted
  if (!shouldAutoFormat(filePath)) {
    logDebug(
      `Skipping formatting for ${filePath} - not in auto-format extensions`
    );
    return;
  }

  logInfo(`Auto-formatting file: ${filePath}`);

  const config = getFormatConfig();
  const projectDir = getProjectDir();
  const results: string[] = [];
  const errors: string[] = [];

  // Check if file exists and is accessible
  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    logError(`File not accessible: ${filePath}`, toError(error));
    return;
  }

  // Run Prettier formatting
  if (config.prettier) {
    try {
      const prettierResult = await runPrettier(
        filePath,
        projectDir,
        config.timeout
      );
      if (prettierResult.success) {
        results.push('✅ Prettier formatting applied');
        logInfo(`Prettier formatting successful for ${filePath}`);
      } else {
        errors.push(`❌ Prettier formatting failed: ${prettierResult.error}`);
        logError(
          `Prettier formatting failed for ${filePath}: ${prettierResult.error}`
        );
      }
    } catch (error) {
      const errorMsg = `Prettier execution error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(`❌ ${errorMsg}`);
      logError(`Prettier execution error for ${filePath}`, toError(error));
    }
  }

  // Run ESLint fixes for JavaScript/TypeScript files
  if (config.eslint && isLintableFile(filePath)) {
    try {
      const eslintResult = await runESLintFix(
        filePath,
        projectDir,
        config.timeout
      );
      if (eslintResult.success) {
        if (eslintResult.fixesApplied) {
          results.push('✅ ESLint fixes applied');
          logInfo(`ESLint fixes applied to ${filePath}`);
        } else {
          results.push('✅ ESLint validation passed (no fixes needed)');
          logDebug(`ESLint validation passed for ${filePath}`);
        }
      } else {
        errors.push(`❌ ESLint fixes failed: ${eslintResult.error}`);
        logError(`ESLint fixes failed for ${filePath}: ${eslintResult.error}`);
      }
    } catch (error) {
      const errorMsg = `ESLint execution error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(`❌ ${errorMsg}`);
      logError(`ESLint execution error for ${filePath}`, toError(error));
    }
  }

  // Provide feedback to Claude if there are results or errors
  if (results.length > 0 || errors.length > 0) {
    const allMessages = [...results, ...errors];
    const hasErrors = errors.length > 0;

    if (hasErrors && config.failOnError) {
      // Block and provide feedback to Claude about formatting failures
      outputJson(
        HookOutputBuilder.feedback(
          `Automatic formatting encountered issues for ${filePath}:\n\n${allMessages.join('\n')}\n\nPlease review and fix the formatting issues.`,
          `The file ${filePath} had formatting issues that need to be addressed.`
        )
      );
    } else {
      // Provide informational feedback
      const message = `Code formatting completed for ${filePath}:\n\n${allMessages.join('\n')}`;
      logInfo(message);

      if (hasErrors) {
        // Non-blocking feedback about formatting issues
        outputJson({
          systemMessage: message,
          suppressOutput: false,
        });
      }
    }
  }
}

/**
 * Run Prettier formatting on a file
 */
async function runPrettier(
  filePath: string,
  projectDir: string,
  timeout: number
): Promise<{ success: boolean; error?: string; fixesApplied?: boolean }> {
  try {
    // Try to run prettier from project first, then global
    const prettierCmd = await findCommand(
      ['npx prettier', 'prettier'],
      projectDir
    );

    const { stdout: _stdout, stderr: _stderr } = await execFileAsync(
      'sh',
      ['-c', `cd "${projectDir}" && ${prettierCmd} --write "${filePath}"`],
      {
        timeout: timeout * 1000,
        cwd: projectDir,
      }
    );

    // Prettier doesn't always indicate if changes were made via stdout
    // We consider it successful if it doesn't error
    return {
      success: true,
      fixesApplied: true, // Assume fixes were applied since prettier ran
    };
  } catch (error: unknown) {
    const errorObj = getExecError(error);

    // Handle timeout
    if (errorObj.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: `Prettier timed out after ${timeout} seconds`,
      };
    }

    // Handle prettier not found
    if (errorObj.code === 'ENOENT' || errorObj.message?.includes('not found')) {
      return {
        success: false,
        error: 'Prettier not found - install with: npm install -g prettier',
      };
    }

    // Handle syntax errors or other prettier issues
    const errorMessage =
      errorObj.stderr ?? errorObj.message ?? 'Unknown prettier error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Run ESLint fixes on a file
 */
async function runESLintFix(
  filePath: string,
  projectDir: string,
  timeout: number
): Promise<{ success: boolean; error?: string; fixesApplied?: boolean }> {
  try {
    // Try to run eslint from project first, then global
    const eslintCmd = await findCommand(['npx eslint', 'eslint'], projectDir);

    const { stdout: _stdout, stderr: _stderr } = await execFileAsync(
      'sh',
      ['-c', `cd "${projectDir}" && ${eslintCmd} --fix "${filePath}"`],
      {
        timeout: timeout * 1000,
        cwd: projectDir,
      }
    );

    // ESLint exit code 0 = no issues, 1 = issues found (but potentially fixed)
    // We'll consider both successful for auto-fixing
    return {
      success: true,
      fixesApplied: _stderr.includes('fixed') || _stdout.includes('fixed'),
    };
  } catch (error: unknown) {
    const errorObj = getExecError(error);

    // Handle timeout
    if (errorObj.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: `ESLint timed out after ${timeout} seconds`,
      };
    }

    // Handle eslint not found
    if (errorObj.code === 'ENOENT' || errorObj.message?.includes('not found')) {
      return {
        success: false,
        error: 'ESLint not found - install with: npm install -g eslint',
      };
    }

    // ESLint exit code 2 = configuration error, otherwise it's likely linting errors
    if (errorObj.code === 2) {
      const errorMessage =
        errorObj.stderr ?? errorObj.message ?? 'ESLint configuration error';
      return { success: false, error: errorMessage };
    }

    // For exit code 1, it means linting errors but fixes may have been applied
    return {
      success: true,
      fixesApplied: true, // Assume some fixes were applied
      error: `ESLint found issues: ${errorObj.stderr ?? errorObj.stdout ?? 'Check file for remaining issues'}`,
    };
  }
}

function getExecError(error: unknown): {
  code?: string | number;
  message?: string;
  stderr?: string;
  stdout?: string;
} {
  if (!isRecord(error)) {
    return { message: String(error) };
  }

  const code = error['code'];
  const message = error['message'];
  const stderr = error['stderr'];
  const stdout = error['stdout'];

  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof stderr === 'string' ? { stderr } : {}),
    ...(typeof stdout === 'string' ? { stdout } : {}),
  };
}

/**
 * Find available command from a list of alternatives
 */
async function findCommand(commands: string[], cwd: string): Promise<string> {
  for (const cmd of commands) {
    try {
      await execFileAsync(
        'sh',
        ['-c', `cd "${cwd}" && which ${cmd.split(' ')[0]}`],
        { timeout: 5000 }
      );
      return cmd;
    } catch {
      continue;
    }
  }

  // If none found, return the first one (will error appropriately)
  return commands[0] ?? 'echo "No command available"';
}

/**
 * Check if a file should be processed by ESLint
 */
function isLintableFile(filePath: string): boolean {
  const lintableExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  return lintableExtensions.some(ext => filePath.endsWith(ext));
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(formatCode).catch(error => {
    console.error('Failed to execute code formatting hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export { formatCode, getFormatConfig, runPrettier, runESLintFix };
