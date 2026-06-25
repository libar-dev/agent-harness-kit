#!/usr/bin/env tsx

/**
 * WorktreeRemove Hook Handler — Logs worktree removal requests.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { WorktreeRemoveInput } from '../types/index.js';

async function handleWorktreeRemove(input: WorktreeRemoveInput): Promise<void> {
  logInfo(`WorktreeRemove hook triggered for ${input.worktree_path}`);
  logDebug('Worktree remove details', {
    worktree_path: input.worktree_path,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<WorktreeRemoveInput>(handleWorktreeRemove);
}

export { handleWorktreeRemove };
