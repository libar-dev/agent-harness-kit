#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { executeHook, outputJson } from '../src/utils/index.js';
import { HookOutputBuilder } from '../src/utils/output-builder.js';
import { validateWorktreeCreateInput } from '../src/validation/index.js';
import type { WorktreeCreateInput } from '../src/types/index.js';

const execFileAsync = promisify(execFile);

async function handleWorktreeCreate(input: WorktreeCreateInput): Promise<void> {
  const request = validateWorktreeCreateInput(input);
  const root =
    process.env['CLAUDE_CUSTOM_WORKTREE_ROOT'] ??
    join(homedir(), '.claude', 'worktrees');
  const worktreePath = join(root, request.name);

  await mkdir(root, { recursive: true });
  await execFileAsync('sl', [
    'checkout',
    '--rev',
    '.',
    '--cwd',
    request.cwd,
    worktreePath,
  ]);

  outputJson(HookOutputBuilder.worktreePath(worktreePath));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<WorktreeCreateInput>(handleWorktreeCreate).catch(error => {
    console.error('Failed to create custom VCS worktree:', error);
    process.exit(1);
  });
}

export { handleWorktreeCreate };
