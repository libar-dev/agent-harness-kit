#!/usr/bin/env tsx

/**
 * PostCompact Hook Handler — Logs compaction results for observability.
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
