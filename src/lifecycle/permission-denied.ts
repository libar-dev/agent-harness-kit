#!/usr/bin/env tsx

/**
 * PermissionDenied Hook Handler
 *
 * Runs after auto mode denies a tool call. This reference handler records the
 * denial and explicitly leaves retry disabled.
 */

import { executeHook, logInfo, logDebug, outputJson } from '../utils/index.js';
import { HookOutputBuilder } from '../utils/output-builder.js';
import type { PermissionDeniedInput } from '../types/index.js';

async function handlePermissionDenied(
  input: PermissionDeniedInput
): Promise<void> {
  logInfo(`PermissionDenied hook triggered for ${input.tool_name}`);
  logDebug('Permission denial details', {
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    reason: input.reason,
  });

  outputJson(HookOutputBuilder.permissionDeniedRetry(false));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void executeHook<PermissionDeniedInput>(handlePermissionDenied);
}

export { handlePermissionDenied };
