#!/usr/bin/env tsx

/**
 * FileChanged Hook Handler
 *
 * Runs when a watched file changes. This reference handler logs the event;
 * projects can extend it to refresh environment state.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { FileChangedInput } from '../types/index.js';

async function handleFileChanged(input: FileChangedInput): Promise<void> {
  logInfo(`FileChanged hook triggered for ${input.file_path}`);
  logDebug('File change details', {
    file_path: input.file_path,
    event: input.event,
    has_env_file: Boolean(process.env['CLAUDE_ENV_FILE']),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<FileChangedInput>(handleFileChanged);
}

export { handleFileChanged };
