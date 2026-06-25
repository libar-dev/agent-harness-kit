#!/usr/bin/env tsx

import {
  executeHook,
  logInfo,
  logDebug,
  getConfig,
  toError,
} from '../utils/index.js';
import { isHookType, type HookInput } from '../types/index.js';
import { handleNotification } from './notification-handler.js';
import { handleSessionStart } from './session-start.js';
import { validateUserPrompt } from './user-prompt-validator.js';
import { handleStop } from './stop-handler.js';
import { handleSubagentStop } from './subagent-stop.js';
import { handlePreCompact } from './pre-compact.js';
import { handleSessionEnd as handleSessionEndImpl } from './session-end.js';
import { handlePermissionRequest } from './permission-request.js';
import { handlePermissionDenied } from './permission-denied.js';
import { handleSubagentStart } from './subagent-start.js';
import { handleTeammateIdle } from './teammate-idle.js';
import { handleTaskCreated } from './task-created.js';
import { handleTaskCompleted } from './task-completed.js';
import { handleStopFailure } from './stop-failure.js';
import { handleInstructionsLoaded } from './instructions-loaded.js';
import { handleConfigChange } from './config-change.js';
import { handleCwdChanged } from './cwd-changed.js';
import { handleFileChanged } from './file-changed.js';
import { handleWorktreeCreate } from './worktree-create.js';
import { handleWorktreeRemove } from './worktree-remove.js';
import { handlePostCompact } from './post-compact.js';
import { handleElicitation } from './elicitation.js';
import { handleElicitationResult } from './elicitation-result.js';
import { handleSetup } from './setup.js';
import { handleMessageDisplay } from './message-display.js';

async function handleLifecycleEvent(input: HookInput): Promise<void> {
  const { hook_event_name, session_id } = input;

  logInfo(
    `Lifecycle hook triggered: ${hook_event_name} (session: ${session_id.substring(0, 8)}...)`
  );

  const config = getConfig();
  if (config.debug) {
    logDebug('Lifecycle event details', {
      event: hook_event_name,
      session_id: session_id.substring(0, 8) + '...',
      timestamp: new Date().toISOString(),
    });
  }

  switch (hook_event_name) {
    case 'Setup':
      if (isHookType(input, 'Setup')) {
        await handleSetup(input);
      }
      break;

    case 'UserPromptSubmit':
      if (isHookType(input, 'UserPromptSubmit')) {
        await validateUserPrompt(input);
      }
      break;

    case 'Notification':
      if (isHookType(input, 'Notification')) {
        await handleNotification(input);
      }
      break;

    case 'MessageDisplay':
      if (isHookType(input, 'MessageDisplay')) {
        await handleMessageDisplay(input);
      }
      break;

    case 'SessionStart':
      if (isHookType(input, 'SessionStart')) {
        await handleSessionStart(input);
      }
      break;

    case 'SessionEnd':
      if (isHookType(input, 'SessionEnd')) {
        await handleSessionEndImpl(input);
      }
      break;

    case 'Stop':
      if (isHookType(input, 'Stop')) {
        await handleStop(input);
      }
      break;

    case 'StopFailure':
      if (isHookType(input, 'StopFailure')) {
        await handleStopFailure(input);
      }
      break;

    case 'SubagentStart':
      if (isHookType(input, 'SubagentStart')) {
        await handleSubagentStart(input);
      }
      break;

    case 'SubagentStop':
      if (isHookType(input, 'SubagentStop')) {
        await handleSubagentStop(input);
      }
      break;

    case 'PermissionRequest':
      if (isHookType(input, 'PermissionRequest')) {
        await handlePermissionRequest(input);
      }
      break;

    case 'PermissionDenied':
      if (isHookType(input, 'PermissionDenied')) {
        await handlePermissionDenied(input);
      }
      break;

    case 'TeammateIdle':
      if (isHookType(input, 'TeammateIdle')) {
        await handleTeammateIdle(input);
      }
      break;

    case 'TaskCreated':
      if (isHookType(input, 'TaskCreated')) {
        await handleTaskCreated(input);
      }
      break;

    case 'TaskCompleted':
      if (isHookType(input, 'TaskCompleted')) {
        await handleTaskCompleted(input);
      }
      break;

    case 'InstructionsLoaded':
      if (isHookType(input, 'InstructionsLoaded')) {
        await handleInstructionsLoaded(input);
      }
      break;

    case 'ConfigChange':
      if (isHookType(input, 'ConfigChange')) {
        await handleConfigChange(input);
      }
      break;

    case 'CwdChanged':
      if (isHookType(input, 'CwdChanged')) {
        await handleCwdChanged(input);
      }
      break;

    case 'FileChanged':
      if (isHookType(input, 'FileChanged')) {
        await handleFileChanged(input);
      }
      break;

    case 'WorktreeCreate':
      if (isHookType(input, 'WorktreeCreate')) {
        await handleWorktreeCreate(input);
      }
      break;

    case 'WorktreeRemove':
      if (isHookType(input, 'WorktreeRemove')) {
        await handleWorktreeRemove(input);
      }
      break;

    case 'PreCompact':
      if (isHookType(input, 'PreCompact')) {
        await handlePreCompact(input);
      }
      break;

    case 'PostCompact':
      if (isHookType(input, 'PostCompact')) {
        await handlePostCompact(input);
      }
      break;

    case 'Elicitation':
      if (isHookType(input, 'Elicitation')) {
        await handleElicitation(input);
      }
      break;

    case 'ElicitationResult':
      if (isHookType(input, 'ElicitationResult')) {
        await handleElicitationResult(input);
      }
      break;

    default:
      logInfo(`Unknown lifecycle event: ${hook_event_name}`);
      break;
  }

  logDebug(`Lifecycle hook completed: ${hook_event_name}`);
}

async function logSessionStatistics(
  sessionId: string,
  endReason: string
): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    const sessionInfo = {
      session_id: sessionId,
      end_reason: endReason,
      end_timestamp: timestamp,
      duration: 'unknown',
    };

    logInfo(`Session statistics: ${JSON.stringify(sessionInfo)}`);
  } catch (error) {
    logDebug('Failed to log session statistics:', toError(error));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<HookInput>(handleLifecycleEvent).catch(error => {
    console.error('Failed to execute lifecycle hook:', error);
    process.exit(1);
  });
}

export { handleLifecycleEvent, logSessionStatistics };

export { handleNotification } from './notification-handler.js';
export { handleSessionStart } from './session-start.js';
export { validateUserPrompt } from './user-prompt-validator.js';
export { handleStop } from './stop-handler.js';
export { handleSubagentStop } from './subagent-stop.js';
export { handlePreCompact } from './pre-compact.js';
export { handleSessionEnd } from './session-end.js';
export { handlePermissionRequest } from './permission-request.js';
export { handlePermissionDenied } from './permission-denied.js';
export { handleSubagentStart } from './subagent-start.js';
export { handleTeammateIdle } from './teammate-idle.js';
export { handleTaskCreated } from './task-created.js';
export { handleTaskCompleted } from './task-completed.js';
export { handleStopFailure } from './stop-failure.js';
export { handleInstructionsLoaded } from './instructions-loaded.js';
export { handleConfigChange } from './config-change.js';
export { handleCwdChanged } from './cwd-changed.js';
export { handleFileChanged } from './file-changed.js';
export { handleWorktreeCreate } from './worktree-create.js';
export { handleWorktreeRemove } from './worktree-remove.js';
export { handlePostCompact } from './post-compact.js';
export { handleElicitation } from './elicitation.js';
export { handleElicitationResult } from './elicitation-result.js';
export { handleSetup } from './setup.js';
export { handleMessageDisplay } from './message-display.js';
