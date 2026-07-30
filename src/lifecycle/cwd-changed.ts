#!/usr/bin/env tsx

/**
 * CwdChanged Hook Handler — Logs working-directory transitions for env refresh hooks.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { CwdChangedInput } from '../types/index.js';

async function handleCwdChanged(input: CwdChangedInput): Promise<void> {
  logInfo(`CwdChanged hook triggered: ${input.old_cwd} -> ${input.new_cwd}`);
  logDebug('Cwd change details', {
    old_cwd: input.old_cwd,
    new_cwd: input.new_cwd,
    has_env_file: Boolean(process.env['CLAUDE_ENV_FILE']),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<CwdChangedInput>(handleCwdChanged);
}

export { handleCwdChanged };
