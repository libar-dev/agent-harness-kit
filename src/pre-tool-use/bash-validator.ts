#!/usr/bin/env tsx

/**
 * Bash Command Validator Hook
 *
 * This PreToolUse hook validates bash commands before execution, providing:
 * - Security warnings for dangerous commands
 * - Performance suggestions (e.g., use ripgrep instead of grep)
 * - Best practice recommendations
 * - Automatic approval for safe commands
 */

import { executeHook, logInfo, outputJson } from '../utils/index.js';
import { HookOutputBuilder, type PreToolUseInput } from '../types/index.js';
import {
  validatePreToolUseInput,
  validateBashToolInput,
  validateBashCommand,
} from '../validation/index.js';

/**
 * Main bash validation logic handler
 */
async function handleBashValidation(input: PreToolUseInput): Promise<void> {
  // Ensure this is a PreToolUse hook for Bash
  validatePreToolUseInput(input);

  // Skip if not a Bash tool
  if (input.tool_name !== 'Bash') {
    // Allow all non-Bash tools to proceed
    return;
  }

  // Extract and validate bash command
  const bashInput = validateBashToolInput(input);
  const command = bashInput.command.trim();

  logInfo(
    `Validating bash command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`
  );

  // Run validation against rules
  const validation = validateBashCommand(command);

  // Handle validation results
  if (validation.issues.length === 0) {
    // Command is clean - auto-approve safe commands
    if (isSafeCommand(command)) {
      outputJson(
        HookOutputBuilder.permission(
          'allow',
          'Command approved: No security or performance issues detected'
        )
      );
    }
    // For other commands, let normal permission flow handle it
    return;
  }

  // Process validation issues
  const errors = validation.issues.filter(issue => issue.severity === 'error');
  const warnings = validation.issues.filter(
    issue => issue.severity === 'warning'
  );
  const info = validation.issues.filter(issue => issue.severity === 'info');

  // Block commands with errors
  if (errors.length > 0) {
    const errorMessages = errors
      .map(
        error =>
          `❌ ${error.message}${error.suggestion ? ` (Suggestion: ${error.suggestion})` : ''}`
      )
      .join('\n');

    outputJson(
      HookOutputBuilder.permission(
        'deny',
        `Dangerous command detected:\n\n${errorMessages}\n\nCommand: ${command}`
      )
    );
    return;
  }

  // For warnings, ask user to confirm
  if (warnings.length > 0) {
    const warningMessages = warnings
      .map(
        warning =>
          `⚠️  ${warning.message}${warning.suggestion ? ` (Suggestion: ${warning.suggestion})` : ''}`
      )
      .join('\n');

    outputJson(
      HookOutputBuilder.permission(
        'ask',
        `Command has warnings:\n\n${warningMessages}\n\nCommand: ${command}\n\nDo you want to proceed?`
      )
    );
    return;
  }

  // For info-only issues, auto-approve with information
  if (info.length > 0) {
    const infoMessages = info
      .map(
        infoItem =>
          `ℹ️  ${infoItem.message}${infoItem.suggestion ? ` (Suggestion: ${infoItem.suggestion})` : ''}`
      )
      .join('\n');

    outputJson(
      HookOutputBuilder.permission(
        'allow',
        `Command approved with suggestions:\n\n${infoMessages}`
      )
    );
    return;
  }
}

/**
 * Check if a command is considered safe for auto-approval
 */
function isSafeCommand(command: string): boolean {
  // List of commands that are generally safe to run automatically
  const safeCommands = [
    // File viewing
    'ls',
    'cat',
    'head',
    'tail',
    'less',
    'more',
    // File information
    'file',
    'stat',
    'wc',
    'du',
    'find',
    // Process information
    'ps',
    'top',
    'jobs',
    'pgrep',
    // System information
    'uname',
    'whoami',
    'pwd',
    'date',
    'uptime',
    // Version checks
    'node --version',
    'npm --version',
    'git --version',
    // Git read operations
    'git status',
    'git log',
    'git diff',
    'git branch',
    'git show',
    // Network information (read-only)
    'ping',
    'nslookup',
    'dig',
    // Safe npm operations
    'npm list',
    'npm outdated',
    'npm audit',
  ];

  // Check if command starts with any safe command
  if (safeCommands.some(safe => command.startsWith(safe))) {
    return true;
  }

  // Check for safe command patterns
  const safePatterns = [
    /^echo\s+/, // Echo commands
    /^which\s+/, // Which commands
    /^type\s+/, // Type commands
    /^grep\s+.*\s+<\s+/, // Grep with input redirection
    /^[a-zA-Z0-9_-]+\s+--help$/, // Help commands
    /^[a-zA-Z0-9_-]+\s+--version$/, // Version commands
  ];

  return safePatterns.some(pattern => pattern.test(command));
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(handleBashValidation).catch(error => {
    console.error('Failed to execute bash validator hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export { handleBashValidation };
