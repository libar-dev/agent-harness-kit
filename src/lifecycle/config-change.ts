#!/usr/bin/env tsx

/**
 * ConfigChange Hook Handler
 *
 * Runs when Claude Code configuration changes. This reference handler logs the
 * change without blocking it.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { ConfigChangeInput } from '../types/index.js';

async function handleConfigChange(input: ConfigChangeInput): Promise<void> {
  logInfo(`ConfigChange hook triggered from ${input.source}`);
  logDebug('Config change details', {
    source: input.source,
    file_path: input.file_path,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<ConfigChangeInput>(handleConfigChange);
}

export { handleConfigChange };
