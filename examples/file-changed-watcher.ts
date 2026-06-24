#!/usr/bin/env tsx

import { join } from 'node:path';

import { executeHook, outputJson } from '../src/utils/index.js';
import { HookOutputBuilder } from '../src/utils/output-builder.js';
import { validateCwdChangedInput } from '../src/validation/index.js';
import type { CwdChangedInput } from '../src/types/index.js';

async function handleCwdChanged(input: CwdChangedInput): Promise<void> {
  const cwdChange = validateCwdChangedInput(input);

  outputJson(
    HookOutputBuilder.watchPaths([
      join(cwdChange.new_cwd, '.env'),
      join(cwdChange.new_cwd, '.envrc'),
    ])
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<CwdChangedInput>(handleCwdChanged).catch(error => {
    console.error('Failed to execute file watcher hook:', error);
    process.exit(1);
  });
}

export { handleCwdChanged };
