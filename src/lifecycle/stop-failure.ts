#!/usr/bin/env tsx

/**
 * StopFailure Hook Handler — Logs API-error turn endings for observability.
 * Claude Code ignores output and exit code for this event.
 */

import { executeHook, logInfo, logDebug, outputJson } from '../utils/index.js';
import { HookOutputBuilder } from '../utils/output-builder.js';
import type { StopFailureInput } from '../types/index.js';

async function handleStopFailure(input: StopFailureInput): Promise<void> {
  logInfo(`StopFailure hook triggered for ${input.error}`);
  logDebug('Stop failure details', {
    error: input.error,
    error_details: input.error_details,
    last_assistant_message: input.last_assistant_message,
  });

  outputJson(HookOutputBuilder.stopFailureLog());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<StopFailureInput>(handleStopFailure);
}

export { handleStopFailure };
