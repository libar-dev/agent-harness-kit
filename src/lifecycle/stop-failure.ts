#!/usr/bin/env tsx

/**
 * StopFailure Hook Handler — Logs API-error turn endings for observability.
 * Claude Code ignores output and exit code for this event.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { StopFailureInput } from '../types/index.js';

async function handleStopFailure(input: StopFailureInput): Promise<void> {
  // StopFailure is side-effect-only: Claude Code ignores stdout JSON and exit code.
  logInfo(`StopFailure hook triggered for ${input.error}`);
  logDebug('Stop failure details', {
    error: input.error,
    error_details: input.error_details,
    last_assistant_message: input.last_assistant_message,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<StopFailureInput>(handleStopFailure);
}

export { handleStopFailure };
