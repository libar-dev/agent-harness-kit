#!/usr/bin/env tsx

/**
 * Setup Hook Handler — Provides optional setup context before Claude Code starts work.
 */

import { executeHook, logDebug, logInfo, outputJson } from '../utils/index.js';
import type { SetupInput, SetupOutput } from '../types/index.js';
import { validateSetupInput } from '../validation/index.js';

function getAdditionalContext(_input: SetupInput): string | undefined {
  return undefined;
}

async function handleSetup(input: SetupInput): Promise<void> {
  const validatedInput = validateSetupInput(input);
  const additionalContext = getAdditionalContext(validatedInput);

  logInfo(`Setup hook triggered (${validatedInput.trigger})`);
  logDebug('Setup details', {
    trigger: validatedInput.trigger,
  });

  if (additionalContext === undefined) {
    return;
  }

  const output: SetupOutput = {
    hookSpecificOutput: {
      hookEventName: 'Setup',
      additionalContext,
    },
  };

  outputJson(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<SetupInput>(handleSetup);
}

export { handleSetup, getAdditionalContext };
