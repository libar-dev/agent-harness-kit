#!/usr/bin/env tsx

/**
 * WorktreeCreate Hook Handler
 *
 * Runs when Claude Code requests a worktree. This reference handler logs the
 * request without creating a custom worktree path.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { WorktreeCreateInput } from '../types/index.js';

async function handleWorktreeCreate(input: WorktreeCreateInput): Promise<void> {
  logInfo(`WorktreeCreate hook triggered for ${input.name}`);
  logDebug('Worktree create details', {
    name: input.name,
    cwd: input.cwd,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<WorktreeCreateInput>(handleWorktreeCreate);
}

export { handleWorktreeCreate };
