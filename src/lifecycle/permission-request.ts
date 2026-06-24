#!/usr/bin/env tsx

/**
 * PermissionRequest Hook Handler
 *
 * Runs when Claude Code is about to show a permission dialog. This reference
 * handler logs the request without changing the decision.
 */

import { executeHook, logInfo, logDebug } from '../utils/index.js';
import type { PermissionRequestInput } from '../types/index.js';

async function handlePermissionRequest(
  input: PermissionRequestInput
): Promise<void> {
  logInfo(`PermissionRequest hook triggered for ${input.tool_name}`);
  logDebug('Permission request details', {
    tool_name: input.tool_name,
    suggestion_count: input.permission_suggestions?.length ?? 0,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<PermissionRequestInput>(handlePermissionRequest);
}

export { handlePermissionRequest };
