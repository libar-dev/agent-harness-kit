#!/usr/bin/env tsx

/**
 * PostToolBatch Hook
 *
 * Runs after a batch of parallel tool calls resolves. This reference handler
 * logs the batch without blocking the next model call.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { PostToolBatchInput } from '../types/index.js';

async function handlePostToolBatch(input: PostToolBatchInput): Promise<void> {
  const toolNames = input.tool_calls.map(call => call.tool_name);
  logInfo(
    `PostToolBatch hook triggered for ${input.tool_calls.length} tool call(s)`
  );
  logDebug('PostToolBatch tools', { tool_names: toolNames });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<PostToolBatchInput>(handlePostToolBatch);
}

export { handlePostToolBatch };
