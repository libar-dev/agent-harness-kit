#!/usr/bin/env tsx

/**
 * TaskCreated Hook Handler — Logs agent-team task creation without blocking it.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { TaskCreatedInput } from '../types/index.js';

async function handleTaskCreated(input: TaskCreatedInput): Promise<void> {
  logInfo(`TaskCreated hook triggered for ${input.task_id}`);
  logDebug('Task created details', {
    task_id: input.task_id,
    task_subject: input.task_subject,
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<TaskCreatedInput>(handleTaskCreated);
}

export { handleTaskCreated };
