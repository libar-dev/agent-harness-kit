#!/usr/bin/env tsx

/**
 * ElicitationResult Hook Handler — Logs user elicitation responses without changing them.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { ElicitationResultInput } from '../types/index.js';

async function handleElicitationResult(
  input: ElicitationResultInput
): Promise<void> {
  logInfo(`ElicitationResult hook triggered for ${input.mcp_server_name}`);
  logDebug('Elicitation result details', {
    mcp_server_name: input.mcp_server_name,
    action: input.action,
    mode: input.mode,
    elicitation_id: input.elicitation_id,
    has_content: input.content !== undefined,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<ElicitationResultInput>(handleElicitationResult);
}

export { handleElicitationResult };
