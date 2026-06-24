#!/usr/bin/env tsx

/**
 * ESLint Disable Blocker Hook
 *
 * This PreToolUse hook prevents the use of eslint-disable directives by:
 * - Blocking Write/Edit/MultiEdit operations containing eslint-disable patterns
 * - Providing educational feedback about architectural directives
 * - Referencing project documentation for proper alternatives
 *
 * WHY: eslint-disable creates redundant suppression violations and generates
 * more lint errors. Architectural directives are BOTH documentation AND
 * suppression mechanism - they automatically suppress ESLint errors.
 */

import { executeHook, logInfo, outputJson } from '../utils/index.js';
import { HookOutputBuilder, type PreToolUseInput } from '../types/index.js';
import { validatePreToolUseInput } from '../validation/index.js';

/**
 * Extract content to check based on tool type
 */
function extractContentToCheck(input: PreToolUseInput): string | null {
  const toolInput = input.tool_input;

  switch (input.tool_name) {
    case 'Write':
      return typeof toolInput['content'] === 'string'
        ? toolInput['content']
        : null;

    case 'Edit':
      return typeof toolInput['new_string'] === 'string'
        ? toolInput['new_string']
        : null;

    case 'MultiEdit': {
      if (Array.isArray(toolInput['edits'])) {
        // Concatenate all new_string values from edits
        return toolInput['edits']
          .map((edit: unknown) => {
            if (
              typeof edit === 'object' &&
              edit !== null &&
              'new_string' in edit
            ) {
              return typeof edit.new_string === 'string' ? edit.new_string : '';
            }
            return '';
          })
          .join('\n');
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Check if content contains eslint-disable patterns
 */
function containsEslintDisable(content: string): boolean {
  // Create a new regex instance for each test to avoid state issues
  const pattern =
    /\/\/\s*eslint-disable(?:-next-line|-line)?|\/\*\s*eslint-disable(?:-next-line|-line)?/gi;
  return pattern.test(content);
}

/**
 * Generate educational feedback message
 */
function generateFeedbackMessage(): string {
  return `❌ ESLint disable directives are FORBIDDEN

Usage of eslint-disable creates redundant suppression violations and generates more lint errors.

🔧 USE ARCHITECTURAL DIRECTIVES INSTEAD:

Architectural directives automatically suppress ESLint errors without eslint-disable.
They serve as BOTH documentation AND suppression mechanism.

The prevent-unsafe-patterns ESLint rule scans 500 preceding characters and
automatically suppresses errors when it finds @architectural-directive: pattern.

Example:
// @architectural-directive: sequential-for-stability
// Reason: Prevents concurrency cascade during processing
// Impact: Maintains system stability within limits
for (const id of ids) {
  const result = await ctx.db.get(id);
}

📖 Complete directive list: docs/patterns/architecturalDirectives.md

💡 Key concepts:
1. Architectural directives ARE the ESLint suppression (no eslint-disable needed)
2. Directive must be within 500 characters BEFORE the code with the lint error
3. Review documentation - multiple directive types available for different patterns`;
}

/**
 * Main handler for ESLint disable blocker
 */
async function handleEslintDisableBlocker(
  input: PreToolUseInput
): Promise<void> {
  // Validate input
  validatePreToolUseInput(input);

  // Only check Write, Edit, and MultiEdit tools
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) {
    return; // Allow other tools to proceed
  }

  logInfo(`Checking ${input.tool_name} operation for eslint-disable patterns`);

  // Extract content to check
  const content = extractContentToCheck(input);

  if (!content) {
    logInfo('No content to check - allowing operation');
    return;
  }

  // Check for eslint-disable patterns
  if (containsEslintDisable(content)) {
    logInfo('ESLint disable pattern detected - blocking operation');

    // Block the operation with educational feedback
    outputJson(HookOutputBuilder.permission('deny', generateFeedbackMessage()));
    return;
  }

  logInfo('No eslint-disable patterns found - allowing operation');
  // Allow the operation to proceed (no output needed)
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(handleEslintDisableBlocker).catch(error => {
    console.error('Failed to execute eslint-disable-blocker hook:', error);
    process.exit(1);
  });
}

// Export for testing
export {
  handleEslintDisableBlocker,
  containsEslintDisable,
  extractContentToCheck,
};
