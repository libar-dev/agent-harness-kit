#!/usr/bin/env tsx

/**
 * Stop Hook Handler — Blocks session completion when configured checks find issues.
 */

import {
  executeHook,
  logInfo,
  logDebug,
  outputJson,
  getConfig,
  getProjectDir,
} from '../utils/index.js';
import { type StopInput, type StopOutput } from '../types/index.js';

/**
 * Configuration for stop hook behavior
 */
interface StopHookConfig {
  /** Check for incomplete tasks */
  checkIncompleteTasks: boolean;
  /** Check for uncommitted changes */
  checkUncommittedChanges: boolean;
  /** Check for failed tests */
  checkFailedTests: boolean;
}

/**
 * Get stop hook configuration from environment
 */
function getStopConfig(): StopHookConfig {
  return {
    checkIncompleteTasks: process.env['CLAUDE_HOOK_CHECK_TASKS'] !== 'false',
    checkUncommittedChanges: process.env['CLAUDE_HOOK_CHECK_GIT'] !== 'false',
    checkFailedTests: process.env['CLAUDE_HOOK_CHECK_TESTS'] !== 'false',
  };
}

/**
 * Main stop hook handler
 */
async function handleStop(input: StopInput): Promise<void> {
  const config = getStopConfig();
  const { session_id, stop_hook_active, last_assistant_message } = input;

  logInfo(`Stop hook triggered (session: ${session_id.substring(0, 8)}...)`);
  if (last_assistant_message) {
    logDebug('Stop hook final assistant message', {
      length: last_assistant_message.length,
      preview: last_assistant_message.substring(0, 200),
    });
  }

  // Prevent infinite loops - if stop hook is already active, allow stopping
  if (stop_hook_active) {
    logDebug('Stop hook already active - allowing Claude to stop');
    return;
  }

  const issues: string[] = [];

  // Check for incomplete tasks
  if (config.checkIncompleteTasks) {
    const incompleteTasks = await checkIncompleteTasks();
    if (incompleteTasks.length > 0) {
      issues.push(`Incomplete tasks detected: ${incompleteTasks.join(', ')}`);
    }
  }

  // Check for uncommitted changes
  if (config.checkUncommittedChanges) {
    const uncommittedFiles = await checkUncommittedChanges();
    if (uncommittedFiles.length > 0) {
      issues.push(`Uncommitted changes in: ${uncommittedFiles.join(', ')}`);
    }
  }

  if (config.checkFailedTests) {
    const failedTests = await checkFailedTests();
    if (failedTests.length > 0) {
      issues.push(`Failed tests detected: ${failedTests.join(', ')}`);
    }
  }

  // If issues found, block stopping and provide feedback
  if (issues.length > 0) {
    const blockMessage = [
      'Cannot stop yet - issues detected:',
      '',
      ...issues.map(issue => `• ${issue}`),
      '',
      'Please address these issues before completing the session.',
    ].join('\n');

    outputJson({
      decision: 'block',
      reason: blockMessage,
    } as StopOutput);

    return;
  }

  // No issues found - allow stopping
  logInfo('No issues detected - allowing Claude to stop');

  // Optionally provide a completion summary
  if (getConfig().debug) {
    outputJson({
      systemMessage:
        'Session completed successfully with no outstanding issues.',
    });
  }
}

/**
 * Check for incomplete tasks by scanning for TODO markers, failing processes, etc.
 */
async function checkIncompleteTasks(): Promise<string[]> {
  const issues: string[] = [];

  try {
    // Check for TypeScript compilation errors
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
        cwd: getProjectDir(),
        timeout: 10000,
      });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code !== 0
      ) {
        issues.push('TypeScript compilation errors');
      }
    }
  } catch (error) {
    logDebug('Could not check TypeScript compilation:', error);
  }

  return issues;
}

/**
 * Check for uncommitted changes in git
 */
async function checkUncommittedChanges(): Promise<string[]> {
  const uncommittedFiles: string[] = [];

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Check git status
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: getProjectDir(),
      timeout: 5000,
    });

    if (stdout.trim()) {
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const match = line.match(/^(.{2})\s+(.+)$/);
        if (match) {
          const [, status, filename] = match;
          // Only report modified/added files, not untracked files starting with '??'
          if (status && !status.startsWith('??')) {
            uncommittedFiles.push(filename ?? '');
          }
        }
      }
    }
  } catch (error) {
    logDebug('Could not check git status:', error);
  }

  return uncommittedFiles;
}

/**
 * Check for failed test indicators
 */
async function checkFailedTests(): Promise<string[]> {
  const failedTests: string[] = [];

  try {
    // The .test-failures sentinel is the built-in failed-test source.
    const { access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');

    try {
      await access(`${getProjectDir()}/.test-failures`, constants.F_OK);
      failedTests.push('Recent test failures detected');
    } catch {
      // No test failures file - this is good
    }
  } catch (error) {
    logDebug('Could not check test failures:', error);
  }

  return failedTests;
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<StopInput>(handleStop).catch(error => {
    console.error('Failed to execute stop hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks and testing
export {
  handleStop,
  checkIncompleteTasks,
  checkUncommittedChanges,
  checkFailedTests,
};
