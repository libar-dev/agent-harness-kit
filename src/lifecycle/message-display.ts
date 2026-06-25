#!/usr/bin/env tsx

import { executeHook, outputJson } from '../utils/index.js';
import type { MessageDisplayInput, MessageDisplayOutput } from '../types/index.js';
import { validateMessageDisplayInput } from '../validation/index.js';

async function handleMessageDisplay(input: MessageDisplayInput): Promise<void> {
  const validatedInput = validateMessageDisplayInput(input);
  const output: MessageDisplayOutput = {
    hookSpecificOutput: {
      hookEventName: 'MessageDisplay',
      displayContent: validatedInput.delta,
    },
  };

  outputJson(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<MessageDisplayInput>(handleMessageDisplay);
}

export { handleMessageDisplay };
