#!/usr/bin/env tsx

/**
 * SubagentStart Hook Handler — Logs subagent creation without injecting context.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { SubagentStartInput } from '../types/index.js';

async function handleSubagentStart(input: SubagentStartInput): Promise<void> {
  logInfo(`SubagentStart hook triggered for ${input.agent_type}`);
  logDebug('Subagent start details', {
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<SubagentStartInput>(handleSubagentStart);
}

export { handleSubagentStart };
