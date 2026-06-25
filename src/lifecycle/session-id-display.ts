#!/usr/bin/env tsx

/**
 * SessionStart Hook Handler — Injects the session ID without displaying hook output.
 */

import { outputJson, executeHook } from '../utils/index.js';
import type { SessionStartInput } from '../types/index.js';

/**
 * Main session ID display logic
 */
async function displaySessionId(input: SessionStartInput): Promise<void> {
  const { session_id } = input;

  // Use JSON output to suppress display while injecting into context
  // The suppressOutput flag hides the <session-start-hook> tags
  outputJson({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: session_id,
    },
  });
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<SessionStartInput>(displaySessionId).catch(error => {
    console.error('Failed to display session ID:', error);
    process.exit(1);
  });
}

// Export for testing
export { displaySessionId };
