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
  const {
    session_id,
    stop_hook_active,
    last_assistant_message,
    agent_transcript_path,
  } = input;

  logInfo(
    `SubagentStop hook triggered (session: ${session_id.substring(0, 8)}...)`
  );
  logDebug('Subagent transcript path', { agent_transcript_path });
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
    const blockMessage = [
      'Subagent task needs attention before completion:',
      '',
      ...issues.map(issue => `• ${issue}`),
      '',
      'Please review and address these issues.',
    ].join('\n');

    outputJson(HookOutputBuilder.subagentStopBlock(blockMessage));
    return;
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
 * Analyze subagent task from transcript and final assistant message.
 *
 * Blank transcript content is treated as unavailable so parent fallback and
 * `last_assistant_message` still participate. Transcript files may lag the
 * in-memory conversation; the final message is the authoritative completion text.
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
    // Prefer the subagent's own transcript; fall back to the parent transcript path.
    // Existing-but-empty files return "" from readTranscript and must not short-circuit fallback.
    const agentTranscript = await readTranscript(input.agent_transcript_path);
    const parentTranscript =
      agentTranscript !== null && agentTranscript.trim().length > 0
        ? null
        : await readTranscript(input.transcript_path);
    const transcript = firstNonBlankTranscript(
      agentTranscript,
      parentTranscript
    );
    const finalMessage = input.last_assistant_message?.trim() ?? '';

    if (transcript) {
      result.taskType = inferTaskType(transcript);
      result.toolsUsed = extractToolsUsed(transcript);
      result.outputSize = transcript.length;
      result.errors = extractStructuredErrors(transcript);
      result.warnings = extractWarnings(transcript);
      const duration = extractDuration(transcript);
      if (duration !== undefined) {
        result.duration = duration;
      }
    }

    // Final assistant prose is authoritative when the transcript lags or is blank.
    // Score prose error markers into the failure state (CHANGELOG parity claim).
    if (finalMessage.length > 0) {
      result.outputSize = Math.max(result.outputSize, finalMessage.length);
      result.errors = mergeUnique(
        result.errors,
        extractProseErrors(finalMessage)
      );
      result.warnings = mergeUnique(
        result.warnings,
        extractWarnings(finalMessage)
      );
    }

    result.success = result.errors.length === 0;
  } catch (error) {
    logDebug('Could not analyze subagent task:', error);
    result.errors.push('Failed to analyze task transcript');
    result.success = false;
  }

  return result;
}

/**
 * Return the first transcript string with non-whitespace content, else null.
 */
function firstNonBlankTranscript(
  ...candidates: Array<string | null>
): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Append unique string values while preserving first-seen order.
 */
function mergeUnique(primary: string[], secondary: string[]): string[] {
  const seen = new Set(primary);
  const merged = [...primary];
  for (const value of secondary) {
    if (!seen.has(value)) {
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
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

/** Extract structured error records from transcript JSONL. */
function extractStructuredErrors(transcript: string): string[] {
  const errors: string[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      collectStructuredErrors(parsed, errors);
    } catch {
      // Transcript readers may receive partial trailing lines; ignore them.
    }
  }
  return errors;
}

/**
 * Extract prose error markers from free-form assistant text.
 * Used for `last_assistant_message` and non-JSONL completion text.
 */
function extractProseErrors(text: string): string[] {
  const errors: string[] = [];
  const patterns = [
    /Error:.+/gi,
    /Failed to.+/gi,
    /Cannot .+/gi,
    /Permission denied.+/gi,
    /File not found.+/gi,
    /Command not found.+/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const match of matches) {
      const trimmed = match.trim();
      if (trimmed.length > 0) {
        errors.push(trimmed);
      }
    }
  }

  return errors;
}

function collectStructuredErrors(value: unknown, errors: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredErrors(item, errors);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (record['is_error'] === true) {
    errors.push(extractStructuredErrorMessage(record));
  }
  if (record['type'] === 'error' || record['type'] === 'tool_error') {
    errors.push(extractStructuredErrorMessage(record));
  }
  for (const nested of Object.values(record)) {
    collectStructuredErrors(nested, errors);
  }
}

function extractStructuredErrorMessage(
  record: Record<string, unknown>
): string {
  for (const key of ['message', 'error', 'content']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'Structured subagent error';
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
