#!/usr/bin/env tsx

/**
 * UserPromptExpansion Hook
 *
 * Runs before a slash command or MCP prompt expands. This reference handler
 * logs the expansion source without changing behavior.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { UserPromptExpansionInput } from '../types/index.js';

async function handleUserPromptExpansion(
  input: UserPromptExpansionInput
): Promise<void> {
  logInfo(
    `UserPromptExpansion hook triggered for ${input.command_name} (${input.expansion_type})`
  );
  logDebug('Prompt expansion details', {
    command_name: input.command_name,
    command_source: input.command_source,
    has_args: input.command_args.length > 0,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<UserPromptExpansionInput>(handleUserPromptExpansion);
}

export { handleUserPromptExpansion };
