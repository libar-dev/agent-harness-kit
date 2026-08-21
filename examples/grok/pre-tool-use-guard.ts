#!/usr/bin/env tsx

import { executeGrokHook, outputGrokJson } from '../../src/grok/execute.js';
import type { GrokPreToolUseInput } from '../../src/grok/types.js';
import { isRecord } from '../../src/utils/index.js';

const DENIED_COMMAND_PATTERN = /\b(rm\s+-rf|sudo|git\s+push\s+--force)\b/;

function readTerminalCommand(toolInput: unknown): string | undefined {
  if (!isRecord(toolInput)) {
    return undefined;
  }

  const command = toolInput['command'];
  return typeof command === 'string' ? command : undefined;
}

/**
 * Denies terminal commands matching a dangerous pattern and allows everything
 * else. The deny decision is printed and the handler returns normally;
 * upstream honors a deny regardless of the process exit code.
 */
async function handlePreToolUseGuard(
  input: GrokPreToolUseInput
): Promise<void> {
  const command = readTerminalCommand(input.toolInput);

  if (command !== undefined && DENIED_COMMAND_PATTERN.test(command)) {
    outputGrokJson({
      decision: 'deny',
      reason: `Blocked by pre-tool-use guard: ${command}`,
    });
    return;
  }

  outputGrokJson({ decision: 'allow' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeGrokHook<GrokPreToolUseInput>(handlePreToolUseGuard).catch(error => {
    console.error('Failed to execute Grok pre-tool-use guard:', error);
    process.exit(1);
  });
}

export { handlePreToolUseGuard };
