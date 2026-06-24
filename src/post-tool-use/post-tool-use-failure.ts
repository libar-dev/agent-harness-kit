#!/usr/bin/env tsx

/**
 * PostToolUseFailure Hook Handler
 *
 * Runs after a tool call fails. This reference handler records the failure
 * context without routing it through successful PostToolUse processors.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { PostToolUseFailureInput } from '../types/index.js';

async function handlePostToolUseFailure(
  input: PostToolUseFailureInput
): Promise<void> {
  logInfo(`PostToolUseFailure hook triggered for ${input.tool_name}`);
  logDebug('Tool failure details', {
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    error: input.error,
    is_interrupt: input.is_interrupt ?? false,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<PostToolUseFailureInput>(handlePostToolUseFailure);
}

export { handlePostToolUseFailure };
