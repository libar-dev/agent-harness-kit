#!/usr/bin/env tsx

/**
 * Elicitation Hook Handler — Logs MCP elicitation requests without answering them.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { ElicitationInput } from '../types/index.js';

async function handleElicitation(input: ElicitationInput): Promise<void> {
  logInfo(`Elicitation hook triggered for ${input.mcp_server_name}`);
  logDebug('Elicitation details', {
    mcp_server_name: input.mcp_server_name,
    mode: input.mode,
    elicitation_id: input.elicitation_id,
    has_requested_schema: input.requested_schema !== undefined,
    has_url: input.url !== undefined,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<ElicitationInput>(handleElicitation);
}

export { handleElicitation };
