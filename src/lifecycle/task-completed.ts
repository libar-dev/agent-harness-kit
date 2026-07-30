#!/usr/bin/env tsx

/**
 * TaskCompleted Hook Handler — Logs agent-team task completion without blocking it.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { TaskCompletedInput } from '../types/index.js';

async function handleTaskCompleted(input: TaskCompletedInput): Promise<void> {
  logInfo(`TaskCompleted hook triggered for ${input.task_id}`);
  logDebug('Task completed details', {
    task_id: input.task_id,
    task_subject: input.task_subject,
    teammate_name: input.teammate_name,
    team_name: input.team_name,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<TaskCompletedInput>(handleTaskCompleted);
}

export { handleTaskCompleted };
