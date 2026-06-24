#!/usr/bin/env tsx

/**
 * Combined PreToolUse Hook Handler
 *
 * This hook combines multiple PreToolUse validators and protections:
 * - Bash command validation and security checking
 * - File protection for sensitive files and directories
 * - Path traversal and security validation
 * - Automatic approval for safe operations
 */

import { executeHook, logInfo, logDebug, getConfig } from '../utils/index.js';
import { validatePreToolUseInput } from '../validation/index.js';
import type { PreToolUseInput } from '../types/index.js';
import { handleBashValidation } from './bash-validator.js';
import { protectFiles } from './file-protector.js';
import { handleUserPromptExpansion } from './user-prompt-expansion.js';

/**
 * Main PreToolUse hook handler that coordinates all validations
 */
async function handlePreToolUse(input: PreToolUseInput): Promise<void> {
  validatePreToolUseInput(input);

  const config = getConfig();
  const { tool_name, session_id } = input;

  logInfo(
    `PreToolUse hook triggered for ${tool_name} (session: ${session_id.substring(0, 8)}...)`
  );

  if (config.debug) {
    logDebug('Tool input received', {
      tool_name,
      has_tool_input: Object.keys(input.tool_input).length > 0,
      tool_input_keys: Object.keys(input.tool_input ?? {}),
    });
  }

  // Run different validators based on tool type
  switch (tool_name) {
    case 'Bash':
      logDebug('Running bash command validation');
      await handleBashValidation(input);
      break;

    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
      logDebug('Running file protection checks');
      await protectFiles(input);
      break;

    case 'Task':
      // For subagent tasks, we might want special handling
      logDebug('Task tool detected - applying subagent policies');
      await handleSubagentTask(input);
      break;

    case 'WebFetch':
    case 'WebSearch':
      // Web operations might need URL validation
      logDebug('Web operation detected - applying web policies');
      await handleWebOperation(input);
      break;

    default:
      // For unknown tools, apply general safety checks
      logDebug(`Unknown tool ${tool_name} - applying general safety checks`);
      await handleGenericTool(input);
      break;
  }

  // If we reach here without outputting a decision, let the normal flow continue
  logDebug('PreToolUse hook completed - allowing normal permission flow');
}

/**
 * Handle Task tool (subagent) operations
 */
async function handleSubagentTask(input: PreToolUseInput): Promise<void> {
  const taskInput = input.tool_input;

  // Check if the task description contains concerning patterns
  let description = '';
  let prompt = '';

  // Safely extract description and prompt if they exist
  if (typeof taskInput === 'object' && taskInput !== null) {
    const obj = taskInput as Record<string, unknown>;
    if (typeof obj['description'] === 'string') {
      description = obj['description'];
    }
    if (typeof obj['prompt'] === 'string') {
      prompt = obj['prompt'];
    }
  }

  const concerningPatterns = [
    /delete.*all/i,
    /remove.*everything/i,
    /format.*drive/i,
    /system.*admin/i,
  ];

  const hasConcerningContent = concerningPatterns.some(
    pattern => pattern.test(description) || pattern.test(prompt)
  );

  if (hasConcerningContent) {
    logInfo(
      'Task contains potentially concerning patterns - may require review'
    );
    // Could output an 'ask' permission here if needed
  }
}

/**
 * Handle web operations (WebFetch, WebSearch)
 */
async function handleWebOperation(input: PreToolUseInput): Promise<void> {
  const webInput = input.tool_input;
  const url = webInput['url'];

  if (url !== null && url !== undefined && typeof url === 'string') {
    // Basic URL validation
    try {
      const parsedUrl = new URL(url);

      // Check for potentially dangerous URLs
      const dangerousDomains = [
        'localhost',
        '127.0.0.1',
        '0.0.0.0',
        '10.', // Private IP ranges
        '192.168.',
        '172.',
      ];

      const isDangerous = dangerousDomains.some(domain =>
        parsedUrl.hostname.includes(domain)
      );

      if (isDangerous) {
        logInfo(`Web operation to potentially internal URL: ${url}`);
        // Could implement blocking or asking for confirmation here
      }
    } catch {
      logInfo(`Invalid URL detected in web operation: ${url}`);
    }
  }
}

/**
 * Handle generic tools with basic safety checks
 */
async function handleGenericTool(input: PreToolUseInput): Promise<void> {
  // For tools we don't specifically handle, apply general safety patterns
  const toolInput = input.tool_input;

  // Check for file paths in any tool input
  const possiblePaths = Object.values(toolInput)
    .filter((value): value is string => typeof value === 'string')
    .filter(value => value.includes('/') || value.includes('\\'));

  for (const path of possiblePaths) {
    if (path.includes('..') || path.includes('~')) {
      logInfo(
        `Potentially unsafe path detected in ${input.tool_name}: ${path}`
      );
      // Could implement additional validation here
    }
  }

  // Check for potentially dangerous content in any string fields
  const dangerousPatterns = [
    /rm\s+-rf/,
    /sudo.*rm/,
    /chmod.*777/,
    /passwd.*root/,
  ];

  const allValues = Object.values(toolInput)
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  if (dangerousPatterns.some(pattern => pattern.test(allValues))) {
    logInfo(
      `Potentially dangerous content detected in ${input.tool_name} parameters`
    );
  }
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(handlePreToolUse).catch(error => {
    console.error('Failed to execute PreToolUse hook:', error);
    process.exit(1);
  });
}

// Export for testing and composition
export {
  handlePreToolUse,
  handleSubagentTask,
  handleWebOperation,
  handleGenericTool,
  handleUserPromptExpansion,
};
