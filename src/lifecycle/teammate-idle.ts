#!/usr/bin/env tsx

/**
 * TeammateIdle Hook Handler
 *
 * Runs when an agent-team teammate is about to become idle. This reference
 * handler logs the event without stopping the teammate.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { TeammateIdleInput } from '../types/index.js';

async function handleTeammateIdle(input: TeammateIdleInput): Promise<void> {
  logInfo(`TeammateIdle hook triggered for ${input.teammate_name}`);
  logDebug('Teammate idle details', {
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<TeammateIdleInput>(handleTeammateIdle);
}

export { handleTeammateIdle };
