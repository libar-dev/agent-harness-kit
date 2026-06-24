#!/usr/bin/env tsx

import { executeHook, outputJson } from '../src/utils/index.js';
import { HookOutputBuilder } from '../src/utils/output-builder.js';
import { validateElicitationInput } from '../src/validation/index.js';
import type { ElicitationInput } from '../src/types/index.js';

async function handleElicitation(input: ElicitationInput): Promise<void> {
  const elicitation = validateElicitationInput(input);

  if (elicitation.mode !== 'form') {
    return;
  }

  outputJson(
    HookOutputBuilder.elicitation('accept', {
      accepted: true,
      source: 'example-elicitation-responder',
    })
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<ElicitationInput>(handleElicitation).catch(error => {
    console.error('Failed to execute elicitation responder:', error);
    process.exit(1);
  });
}

export { handleElicitation };
