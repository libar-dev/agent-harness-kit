#!/usr/bin/env tsx

/**
 * PostCompact Hook Handler
 *
 * Runs after context compaction completes. This reference handler logs the
 * generated summary size for audit/observability use cases.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { PostCompactInput } from '../types/index.js';

async function handlePostCompact(input: PostCompactInput): Promise<void> {
  logInfo(`PostCompact hook triggered (${input.trigger})`);
  logDebug('Post compact details', {
    trigger: input.trigger,
    compact_summary_length: input.compact_summary.length,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<PostCompactInput>(handlePostCompact);
}

export { handlePostCompact };
