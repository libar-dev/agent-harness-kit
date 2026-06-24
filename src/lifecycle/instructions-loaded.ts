#!/usr/bin/env tsx

/**
 * InstructionsLoaded Hook Handler
 *
 * Runs after Claude Code loads a memory/instructions file. This reference
 * handler logs the load event without changing behavior.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { InstructionsLoadedInput } from '../types/index.js';

async function handleInstructionsLoaded(
  input: InstructionsLoadedInput
): Promise<void> {
  logInfo(`InstructionsLoaded hook triggered for ${input.file_path}`);
  logDebug('Instructions loaded details', {
    memory_type: input.memory_type,
    load_reason: input.load_reason,
    globs: input.globs,
    trigger_file_path: input.trigger_file_path,
    parent_file_path: input.parent_file_path,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<InstructionsLoadedInput>(handleInstructionsLoaded);
}

export { handleInstructionsLoaded };
