#!/usr/bin/env tsx

/**
 * TypeScript Validation Hook
 *
 * Validates modified TypeScript and Convex files after tool use.
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
 * TypeScript validation behavior.
 */
interface TypeScriptConfig {
  /** Whether to run full project typecheck */
  fullProjectCheck: boolean;
  /** Whether to run Convex schema validation */
  convexValidation: boolean;
  /** Maximum time to wait for validation (seconds) */
  timeout: number;
  /** Whether to block on type errors */
  blockOnErrors: boolean;
  /** File patterns that require stricter validation */
  strictFiles: string[];
}

/**
 * Read TypeScript validation configuration.
 */
function getTypeScriptConfig(): TypeScriptConfig {
  return {
    fullProjectCheck: process.env['CLAUDE_HOOK_TS_FULL_CHECK'] === 'true',
    convexValidation: process.env['CLAUDE_HOOK_CONVEX_VALIDATION'] !== 'false',
    timeout: parseInt(process.env['CLAUDE_HOOK_TS_TIMEOUT'] ?? '60', 10),
    blockOnErrors: process.env['CLAUDE_HOOK_TS_BLOCK_ON_ERROR'] === 'true',
    strictFiles: process.env['CLAUDE_HOOK_TS_STRICT_FILES']?.split(',') ?? [
      'convex/schema.ts',
      'convex/toolkit/',
      'src/types/',
    ],
  };
}

/**
 * Validate modified TypeScript files and report compiler errors.
 */
async function validateTypeScript(input: PostToolUseInput): Promise<void> {
  validatePostToolUseInput(input);

  const fileModificationTools = ['Write', 'Edit', 'MultiEdit'];
  if (!fileModificationTools.includes(input.tool_name)) {
    return;
  }

  let filePath: string;

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

  if (!isTypeScriptFile(filePath)) {
    return;
  }

  logInfo(`Validating TypeScript file: ${filePath}`);

  const config = getTypeScriptConfig();
  const projectDir = getProjectDir();
  const results: string[] = [];
  const errors: string[] = [];

  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    logError(`File not accessible: ${filePath}`, toError(error));
    return;
  }

  try {
    const tsResult = await runTypeScriptCheck(filePath, projectDir, config);

    if (tsResult.success) {
      results.push('✅ TypeScript validation passed');
      logInfo(`TypeScript validation successful for ${filePath}`);
    } else {
      errors.push(
        `❌ TypeScript errors found:\n${tsResult.errors?.join('\n') ?? tsResult.error}`
      );
      logError(
        `TypeScript validation failed for ${filePath}: ${tsResult.error}`
      );
    }
  } catch (error) {
    const errorMsg = `TypeScript validation error: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(`❌ ${errorMsg}`);
    logError(`TypeScript execution error for ${filePath}`, toError(error));
  }

  if (config.convexValidation && isConvexFile(filePath)) {
    try {
      const convexResult = await runConvexValidation(
        filePath,
        projectDir,
        config
      );

      if (convexResult.success) {
        results.push('✅ Convex validation passed');
        logInfo(`Convex validation successful for ${filePath}`);
      } else {
        errors.push(`❌ Convex validation failed:\n${convexResult.error}`);
        logError(
          `Convex validation failed for ${filePath}: ${convexResult.error}`
        );
      }
    } catch (error) {
      const errorMsg = `Convex validation error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(`❌ ${errorMsg}`);
      logError(`Convex validation error for ${filePath}`, toError(error));
    }
  }

  if (errors.length > 0) {
    const errorMessage = `TypeScript validation failed for ${filePath}:\n\n${errors.join('\n\n')}`;

    if (config.blockOnErrors || isStrictFile(filePath, config.strictFiles)) {
      outputJson(
        HookOutputBuilder.feedback(
          errorMessage +
            '\n\nPlease fix the TypeScript errors before proceeding.',
          `The file ${filePath} has TypeScript errors that must be resolved.`
        )
      );
    } else {
      outputJson({
        systemMessage: `TypeScript validation warnings for ${filePath}:\n\n${errors.join('\n\n')}`,
        suppressOutput: false,
      });
      logError('TypeScript validation failed but not blocking execution');
    }
  } else if (results.length > 0) {
    const successMessage = `TypeScript validation completed for ${filePath}:\n\n${results.join('\n')}`;
    logInfo(successMessage);

    if (getConfig().debug) {
      outputJson({
        systemMessage: successMessage,
        suppressOutput: true,
      });
    }
  }
}

/**
 * Run the TypeScript compiler for a file.
 */
async function runTypeScriptCheck(
  filePath: string,
  projectDir: string,
  config: TypeScriptConfig
): Promise<{ success: boolean; error?: string; errors?: string[] }> {
  try {
    const { command, configFile } = getTypeScriptCommand(filePath, projectDir);

    const tsCommand = config.fullProjectCheck
      ? `${command} --noEmit${configFile ? ` -p ${configFile}` : ''}`
      : `${command} --noEmit${configFile ? ` -p ${configFile}` : ''} "${filePath}"`;

    logDebug(`Running TypeScript check: ${tsCommand}`);

    const { stdout: _stdout, stderr: _stderr } = await execFileAsync(
      'sh',
      ['-c', `cd "${projectDir}" && ${tsCommand}`],
      {
        timeout: config.timeout * 1000,
        cwd: projectDir,
      }
    );

    return { success: true };
  } catch (error: unknown) {
    const errorObj = getExecError(error);

    if (errorObj.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: `TypeScript check timed out after ${config.timeout} seconds`,
      };
    }

    if (errorObj.code === 'ENOENT' || errorObj.message?.includes('not found')) {
      return {
        success: false,
        error: 'TypeScript not found - install with: npm install -g typescript',
      };
    }

    const errorOutput = errorObj.stderr ?? errorObj.stdout ?? '';
    const errors = parseTypeScriptErrors(errorOutput);

    return {
      success: false,
      error: `TypeScript compilation errors found`,
      errors: errors.length > 0 ? errors : [errorOutput],
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
 * Run Convex-specific validation.
 */
async function runConvexValidation(
  filePath: string,
  projectDir: string,
  config: TypeScriptConfig
): Promise<{ success: boolean; error?: string }> {
  try {
    if (filePath.includes('convex/schema.ts')) {
      logDebug('Schema file modified - running Convex codegen');

      const { stdout: _stdout, stderr: _stderr } = await execFileAsync(
        'sh',
        ['-c', `cd "${projectDir}" && npx convex codegen --typecheck=disable`],
        {
          timeout: config.timeout * 1000,
          cwd: projectDir,
        }
      );

      logInfo('Convex codegen completed successfully');
    }

    const convexTsCommand = `npx tsc --noEmit -p convex/tsconfig.json`;

    const { stdout: _stdout, stderr: _stderr } = await execFileAsync(
      'sh',
      ['-c', `cd "${projectDir}" && ${convexTsCommand}`],
      {
        timeout: config.timeout * 1000,
        cwd: projectDir,
      }
    );

    return { success: true };
  } catch (error: unknown) {
    const errorObj = getExecError(error);

    if (errorObj.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: `Convex validation timed out after ${config.timeout} seconds`,
      };
    }

    if (errorObj.code === 'ENOENT' || errorObj.message?.includes('not found')) {
      return {
        success: false,
        error: 'Convex not found - run: npm install convex',
      };
    }

    const errorOutput = errorObj.stderr ?? errorObj.stdout ?? '';
    return {
      success: false,
      error: errorOutput ?? 'Unknown Convex validation error',
    };
  }
}

/**
 * Get the TypeScript command and config for a file.
 */
function getTypeScriptCommand(
  filePath: string,
  _projectDir: string
): { command: string; configFile?: string } {
  if (filePath.includes('/convex/')) {
    return {
      command: 'npx tsc',
      configFile: 'convex/tsconfig.json',
    };
  }

  return {
    command: 'npx tsc',
    configFile: 'tsconfig.json',
  };
}

/**
 * Parse TypeScript error output into grouped messages.
 */
function parseTypeScriptErrors(errorOutput: string): string[] {
  if (!errorOutput) return [];

  const lines = errorOutput.split('\n').filter(line => line.trim());

  const errors: string[] = [];
  let currentError: string[] = [];

  for (const line of lines) {
    // A fresh error block typically starts with a file path.
    if (line.match(/^.*\(\d+,\d+\):/)) {
      if (currentError.length > 0) {
        errors.push(currentError.join('\n'));
      }
      currentError = [line];
    } else if (line.trim() && currentError.length > 0) {
      currentError.push(line);
    } else if (line.trim() && currentError.length === 0) {
      errors.push(line);
    }
  }

  if (currentError.length > 0) {
    errors.push(currentError.join('\n'));
  }

  return errors.filter(error => error.trim().length > 0);
}

/**
 * Check whether a file is TypeScript.
 */
function isTypeScriptFile(filePath: string): boolean {
  const tsExtensions = ['.ts', '.tsx', '.d.ts'];
  return tsExtensions.some(ext => filePath.endsWith(ext));
}

/**
 * Check whether a file belongs to Convex.
 */
function isConvexFile(filePath: string): boolean {
  return (
    filePath.includes('/convex/') ||
    filePath.includes('convex/schema.ts') ||
    filePath.includes('convex/_generated/')
  );
}

/**
 * Check whether a file requires strict validation.
 */
function isStrictFile(filePath: string, strictPatterns: string[]): boolean {
  return strictPatterns.some(pattern => filePath.includes(pattern));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PostToolUseInput>(validateTypeScript).catch(error => {
    console.error('Failed to execute TypeScript validation hook:', error);
    process.exit(1);
  });
}

export {
  validateTypeScript,
  getTypeScriptConfig,
  runTypeScriptCheck,
  runConvexValidation,
  parseTypeScriptErrors,
};
