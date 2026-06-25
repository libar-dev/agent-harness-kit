#!/usr/bin/env tsx

/**
 * SubagentStop Hook Handler — Validates subagent completion before allowing stop.
 */

import {
  executeHook,
  logInfo,
  logDebug,
  logWarning,
  outputJson,
  getConfig,
} from '../utils/index.js';
import { HookOutputBuilder, type SubagentStopInput } from '../types/index.js';
import { readTranscript, extractToolsUsed } from './utils.js';

/**
 * Configuration for subagent stop hook behavior
 */
interface SubagentStopConfig {
  /** Validate subagent task completion */
  validateTaskCompletion: boolean;
  /** Check for subagent errors that need escalation */
  checkForErrors: boolean;
  /** Log subagent performance metrics */
  logPerformanceMetrics: boolean;
  /** Maximum retry attempts for failed subagent tasks */
  maxRetryAttempts: number;
}

/**
 * Get subagent stop configuration from environment
 */
function getSubagentStopConfig(): SubagentStopConfig {
  return {
    validateTaskCompletion:
      process.env['CLAUDE_HOOK_VALIDATE_SUBAGENT'] !== 'false',
    checkForErrors:
      process.env['CLAUDE_HOOK_CHECK_SUBAGENT_ERRORS'] !== 'false',
    logPerformanceMetrics:
      process.env['CLAUDE_HOOK_LOG_SUBAGENT_METRICS'] === 'true',
    maxRetryAttempts: parseInt(
      process.env['CLAUDE_HOOK_SUBAGENT_MAX_RETRIES'] ?? '2',
      10
    ),
  };
}

/**
 * Subagent task result interface (inferred from transcript analysis)
 */
interface SubagentTaskResult {
  taskType: string;
  success: boolean;
  duration?: number;
  errors: string[];
  warnings: string[];
  outputSize: number;
  toolsUsed: string[];
}

/**
 * Main subagent stop hook handler
 */
async function handleSubagentStop(input: SubagentStopInput): Promise<void> {
  const config = getSubagentStopConfig();
  const { session_id, stop_hook_active, last_assistant_message } = input;

  logInfo(
    `SubagentStop hook triggered (session: ${session_id.substring(0, 8)}...)`
  );
  if (last_assistant_message) {
    logDebug('Subagent final assistant message', {
      length: last_assistant_message.length,
      preview: last_assistant_message.substring(0, 200),
    });
  }

  // Prevent infinite loops - if stop hook is already active, allow stopping
  if (stop_hook_active) {
    logDebug('Subagent stop hook already active - allowing subagent to stop');
    return;
  }

  const issues: string[] = [];
  let taskResult: SubagentTaskResult | null = null;

  // Analyze subagent task completion
  if (config.validateTaskCompletion) {
    taskResult = await analyzeSubagentTask(input);

    if (!taskResult.success) {
      issues.push(`Subagent task failed: ${taskResult.errors.join(', ')}`);
    }

    if (taskResult.warnings.length > 0) {
      logWarning(
        `Subagent task completed with warnings: ${taskResult.warnings.join(', ')}`
      );
    }
  }

  // Check for escalation-worthy errors
  if (config.checkForErrors && taskResult) {
    const criticalErrors = await checkForCriticalErrors(taskResult);
    if (criticalErrors.length > 0) {
      issues.push(
        `Critical errors require main thread attention: ${criticalErrors.join(', ')}`
      );
    }
  }

  // Log performance metrics if enabled
  if (config.logPerformanceMetrics && taskResult) {
    await logSubagentMetrics(taskResult, session_id);
  }

  // If issues found, block stopping and provide feedback
  if (issues.length > 0) {
    const retryCount = await getSubagentRetryCount(session_id);

    if (retryCount < config.maxRetryAttempts) {
      await incrementSubagentRetryCount(session_id);

      const blockMessage = [
        'Subagent task needs attention before completion:',
        '',
        ...issues.map(issue => `• ${issue}`),
        '',
        'Please review and address these issues.',
        `(Retry ${retryCount + 1}/${config.maxRetryAttempts})`,
      ].join('\n');

      outputJson(HookOutputBuilder.subagentStopContext(blockMessage));

      return;
    } else {
      logWarning(
        `Maximum subagent retries (${config.maxRetryAttempts}) reached - allowing stop with errors`
      );
    }
  }

  // No critical issues - allow subagent to stop
  logInfo('Subagent task completed successfully - allowing stop');

  // Provide success summary if configured
  if (getConfig().debug && taskResult) {
    const summary = [
      'Subagent task completed:',
      `• Type: ${taskResult.taskType}`,
      `• Duration: ${taskResult.duration !== undefined ? `${taskResult.duration}ms` : 'unknown'}`,
      `• Tools used: ${taskResult.toolsUsed.join(', ') || 'none'}`,
      `• Output size: ${taskResult.outputSize} characters`,
    ].join('\n');

    outputJson(HookOutputBuilder.success(summary));
  }
}

/**
 * Analyze subagent task from transcript
 */
async function analyzeSubagentTask(
  input: SubagentStopInput
): Promise<SubagentTaskResult> {
  const result: SubagentTaskResult = {
    taskType: 'unknown',
    success: true,
    errors: [],
    warnings: [],
    outputSize: 0,
    toolsUsed: [],
  };

  try {
    // Read and parse transcript to understand what the subagent did
    const transcript = await readTranscript(input.transcript_path);

    if (transcript) {
      result.taskType = inferTaskType(transcript);
      result.toolsUsed = extractToolsUsed(transcript);
      result.outputSize = transcript.length;
      result.errors = extractErrors(transcript);
      result.warnings = extractWarnings(transcript);
      result.success = result.errors.length === 0;
      const duration = extractDuration(transcript);
      if (duration !== undefined) {
        result.duration = duration;
      }
    }
  } catch (error) {
    logDebug('Could not analyze subagent task:', error);
    result.errors.push('Failed to analyze task transcript');
    result.success = false;
  }

  return result;
}

/**
 * Infer task type from transcript content
 */
function inferTaskType(transcript: string): string {
  // Simple heuristics to identify task types
  if (
    transcript.includes('"tool_name":"Write"') ||
    transcript.includes('"tool_name":"Edit"')
  ) {
    return 'file-modification';
  }
  if (transcript.includes('"tool_name":"Bash"')) {
    return 'command-execution';
  }
  if (
    transcript.includes('"tool_name":"WebFetch"') ||
    transcript.includes('"tool_name":"WebSearch"')
  ) {
    return 'web-research';
  }
  if (
    transcript.includes('"tool_name":"Read"') ||
    transcript.includes('"tool_name":"Grep"')
  ) {
    return 'code-analysis';
  }

  return 'general-task';
}

/**
 * Extract errors from transcript
 */
function extractErrors(transcript: string): string[] {
  const errors: string[] = [];

  // Look for error indicators in the transcript
  const errorPatterns = [
    /Error:/g,
    /Failed to/g,
    /Cannot/g,
    /Permission denied/g,
    /File not found/g,
    /Command not found/g,
  ];

  for (const pattern of errorPatterns) {
    const matches = transcript.match(pattern);
    if (matches) {
      errors.push(
        `Found ${matches.length} instances of '${pattern.source.replace(/\\\//g, '/')}'`
      );
    }
  }

  return errors;
}

/**
 * Extract warnings from transcript
 */
function extractWarnings(transcript: string): string[] {
  const warnings: string[] = [];

  // Look for warning indicators
  const warningPatterns = [
    /Warning:/g,
    /Deprecated/g,
    /Should use/g,
    /Consider using/g,
  ];

  for (const pattern of warningPatterns) {
    const matches = transcript.match(pattern);
    if (matches) {
      warnings.push(
        `Found ${matches.length} instances of '${pattern.source.replace(/\\\//g, '/')}'`
      );
    }
  }

  return warnings;
}

/**
 * Extract task duration from transcript timestamps
 */
function extractDuration(transcript: string): number | undefined {
  const timestampMatches = transcript.match(/"timestamp":"([^"]+)"/g);

  if (timestampMatches && timestampMatches.length >= 2) {
    try {
      const firstTimestamp = new Date(
        timestampMatches[0].match(/"timestamp":"([^"]+)"/)?.[1] ?? ''
      );
      const lastTimestamp = new Date(
        timestampMatches[timestampMatches.length - 1]?.match(
          /"timestamp":"([^"]+)"/
        )?.[1] ?? ''
      );

      if (!isNaN(firstTimestamp.getTime()) && !isNaN(lastTimestamp.getTime())) {
        return lastTimestamp.getTime() - firstTimestamp.getTime();
      }
    } catch (error) {
      logDebug('Could not parse timestamps:', error);
    }
  }

  return undefined;
}

/**
 * Check for critical errors that require main thread attention
 */
async function checkForCriticalErrors(
  taskResult: SubagentTaskResult
): Promise<string[]> {
  const criticalErrors: string[] = [];

  // Define what constitutes critical errors for different task types
  const criticalPatterns: Record<string, RegExp[]> = {
    'file-modification': [
      /permission denied/i,
      /file not found/i,
      /syntax error/i,
    ],
    'command-execution': [
      /command not found/i,
      /permission denied/i,
      /segmentation fault/i,
    ],
    'web-research': [
      /timeout/i,
      /network error/i,
      /403 forbidden/i,
      /404 not found/i,
    ],
  };

  const patterns = criticalPatterns[taskResult.taskType] ?? [];
  const allErrors = taskResult.errors.join(' ');

  for (const pattern of patterns) {
    if (pattern.test(allErrors)) {
      criticalErrors.push(`Critical error detected: ${pattern.source}`);
    }
  }

  return criticalErrors;
}

/**
 * Log subagent performance metrics
 */
async function logSubagentMetrics(
  taskResult: SubagentTaskResult,
  sessionId: string
): Promise<void> {
  const metrics = {
    session_id: sessionId,
    task_type: taskResult.taskType,
    duration_ms: taskResult.duration,
    tools_used: taskResult.toolsUsed,
    output_size: taskResult.outputSize,
    success: taskResult.success,
    error_count: taskResult.errors.length,
    warning_count: taskResult.warnings.length,
    timestamp: new Date().toISOString(),
  };

  logInfo(`Subagent metrics: ${JSON.stringify(metrics)}`);

  // Optionally write to metrics file
  try {
    const { appendFile } = await import('node:fs/promises');
    const metricsFile = `/tmp/claude-subagent-metrics.jsonl`;
    await appendFile(metricsFile, JSON.stringify(metrics) + '\n', 'utf-8');
  } catch (error) {
    logDebug('Could not write metrics file:', error);
  }
}

/**
 * Get subagent retry count for session
 */
async function getSubagentRetryCount(sessionId: string): Promise<number> {
  try {
    const { readFile } = await import('node:fs/promises');
    const countFile = `/tmp/claude-subagent-retries-${sessionId}`;

    try {
      const content = await readFile(countFile, 'utf-8');
      const parsed = parseInt(content.trim(), 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    } catch {
      return 0; // File doesn't exist, first attempt
    }
  } catch (error) {
    logDebug('Could not read subagent retry count:', error);
    return 0;
  }
}

/**
 * Increment subagent retry count for session
 */
async function incrementSubagentRetryCount(sessionId: string): Promise<void> {
  try {
    const { writeFile } = await import('node:fs/promises');
    const countFile = `/tmp/claude-subagent-retries-${sessionId}`;

    const currentCount = await getSubagentRetryCount(sessionId);
    await writeFile(countFile, (currentCount + 1).toString(), 'utf-8');
  } catch (error) {
    logDebug('Could not increment subagent retry count:', error);
  }
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<SubagentStopInput>(handleSubagentStop).catch(error => {
    console.error('Failed to execute subagent stop hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks and testing
export {
  handleSubagentStop,
  analyzeSubagentTask,
  checkForCriticalErrors,
  logSubagentMetrics,
};
