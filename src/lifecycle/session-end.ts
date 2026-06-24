#!/usr/bin/env tsx

/**
 * SessionEnd Hook Handler
 *
 * This hook runs when a Claude Code session ends and performs cleanup tasks,
 * saves session state, and generates session statistics.
 *
 * Use cases:
 * - Clean up temporary files and processes
 * - Save session statistics and metrics
 * - Generate session summaries
 * - Archive important session data
 * - Send notifications about session completion
 * - Prepare environment for next session
 */

import {
  executeHook,
  logInfo,
  logDebug,
  logWarning,
  outputJson,
  getConfig,
  getProjectDir,
} from '../utils/index.js';
import { type SessionEndInput } from '../types/index.js';
import { readTranscript, extractToolsUsed } from './utils.js';

/**
 * Configuration for session end hook behavior
 */
interface SessionEndConfig {
  /** Clean up temporary files */
  cleanupTempFiles: boolean;
  /** Save session statistics */
  saveSessionStats: boolean;
  /** Generate session summary */
  generateSessionSummary: boolean;
  /** Archive session transcript */
  archiveTranscript: boolean;
  /** Send completion notifications */
  sendNotifications: boolean;
  /** Maximum age of temp files to clean (hours) */
  maxTempFileAge: number;
}

/**
 * Get session end configuration from environment
 */
function getSessionEndConfig(): SessionEndConfig {
  return {
    cleanupTempFiles: process.env['CLAUDE_HOOK_CLEANUP_TEMP'] !== 'false',
    saveSessionStats: process.env['CLAUDE_HOOK_SAVE_STATS'] !== 'false',
    generateSessionSummary:
      process.env['CLAUDE_HOOK_GENERATE_SUMMARY'] !== 'false',
    archiveTranscript: process.env['CLAUDE_HOOK_ARCHIVE_TRANSCRIPT'] === 'true',
    sendNotifications: process.env['CLAUDE_HOOK_SEND_NOTIFICATIONS'] === 'true',
    maxTempFileAge: parseInt(
      process.env['CLAUDE_HOOK_MAX_TEMP_AGE'] ?? '24',
      10
    ),
  };
}

/**
 * Session statistics interface
 */
interface SessionStats {
  sessionId: string;
  startTime?: Date;
  endTime: Date;
  duration?: number;
  reason: string;
  toolsUsed: string[];
  filesModified: string[];
  commandsExecuted: number;
  errorsEncountered: number;
  transcriptSize: number;
  projectPath: string;
}

/**
 * Main session end hook handler
 */
async function handleSessionEnd(input: SessionEndInput): Promise<void> {
  const config = getSessionEndConfig();
  const { session_id, reason } = input;

  logInfo(
    `SessionEnd hook triggered: ${reason} (session: ${session_id.substring(0, 8)}...)`
  );

  const completionTasks: string[] = [];

  try {
    // Generate session statistics
    let sessionStats: SessionStats | null = null;
    if (config.saveSessionStats || config.generateSessionSummary) {
      sessionStats = await generateSessionStats(input);

      if (config.saveSessionStats) {
        await saveSessionStats(sessionStats);
        completionTasks.push('Session statistics saved');
      }
    }

    // Generate and save session summary
    if (config.generateSessionSummary && sessionStats) {
      const summary = await generateSessionSummary(sessionStats);
      if (summary) {
        await saveSessionSummary(summary, session_id);
        completionTasks.push('Session summary generated');
      }
    }

    // Archive transcript if configured
    if (config.archiveTranscript) {
      const archivePath = await archiveSessionTranscript(input);
      if (archivePath) {
        completionTasks.push(`Transcript archived to ${archivePath}`);
      }
    }

    // Clean up temporary files
    if (config.cleanupTempFiles) {
      const cleanupCount = await cleanupTemporaryFiles(
        session_id,
        config.maxTempFileAge
      );
      if (cleanupCount > 0) {
        completionTasks.push(`Cleaned up ${cleanupCount} temporary files`);
      }
    }

    // Send notifications if configured
    if (config.sendNotifications && sessionStats) {
      await sendSessionCompletionNotification(sessionStats, reason);
      completionTasks.push('Completion notification sent');
    }

    // Log completion summary
    if (completionTasks.length > 0) {
      logInfo(`Session cleanup completed: ${completionTasks.join(', ')}`);

      if (getConfig().debug) {
        outputJson({
          systemMessage: [
            '🎯 **Session End Summary**',
            '',
            ...completionTasks.map(task => `✅ ${task}`),
            '',
            `Session ended due to: ${reason}`,
          ].join('\n'),
          suppressOutput: false,
        });
      }
    }
  } catch (error) {
    logWarning(
      `Session end hook encountered error: ${error instanceof Error ? error.message : String(error)}`
    );

    // Don't prevent session end, but log the error
    if (getConfig().debug) {
      outputJson({
        systemMessage: `⚠️ Session end cleanup encountered issues: ${error instanceof Error ? error.message : String(error)}`,
        suppressOutput: false,
      });
    }
  }
}

/**
 * Generate comprehensive session statistics
 */
async function generateSessionStats(
  input: SessionEndInput
): Promise<SessionStats> {
  const stats: SessionStats = {
    sessionId: input.session_id,
    endTime: new Date(),
    reason: input.reason,
    toolsUsed: [],
    filesModified: [],
    commandsExecuted: 0,
    errorsEncountered: 0,
    transcriptSize: 0,
    projectPath: getProjectDir(),
  };

  try {
    // Analyze transcript for detailed statistics
    const transcript = await readTranscript(input.transcript_path);

    if (transcript) {
      stats.transcriptSize = transcript.length;

      // Extract tools used
      stats.toolsUsed = extractToolsUsed(transcript);

      // Extract modified files
      stats.filesModified = extractModifiedFiles(transcript);

      // Count commands executed
      stats.commandsExecuted = countCommandsExecuted(transcript);

      // Count errors encountered
      stats.errorsEncountered = countErrors(transcript);

      // Try to determine session start time from transcript
      const startTime = extractSessionStartTime(transcript);
      if (startTime) {
        stats.startTime = startTime;
      }

      // Calculate duration if start time is available
      if (stats.startTime) {
        stats.duration = stats.endTime.getTime() - stats.startTime.getTime();
      }
    }
  } catch (error) {
    logDebug('Could not analyze transcript for statistics:', error);
  }

  return stats;
}

/**
 * Extract modified files from transcript
 */
function extractModifiedFiles(transcript: string): string[] {
  const files = new Set<string>();

  // Look for file modification tools
  const fileModificationPatterns = [
    /"tool_name":"Write".*?"file_path":"([^"]+)"/g,
    /"tool_name":"Edit".*?"file_path":"([^"]+)"/g,
    /"tool_name":"MultiEdit".*?"file_path":"([^"]+)"/g,
  ];

  for (const pattern of fileModificationPatterns) {
    let match: RegExpExecArray | null = pattern.exec(transcript);
    while (match !== null) {
      const filePath = match[1];
      if (filePath && !filePath.includes('node_modules')) {
        files.add(filePath);
      }
      match = pattern.exec(transcript);
    }
  }

  return Array.from(files);
}

/**
 * Count commands executed in session
 */
function countCommandsExecuted(transcript: string): number {
  const bashMatches = transcript.match(/"tool_name":"Bash"/g) ?? [];
  return bashMatches.length;
}

/**
 * Count errors encountered in session
 */
function countErrors(transcript: string): number {
  const errorPatterns = [/Error:/g, /Failed to/g, /Cannot/g, /"error":/g];

  let errorCount = 0;
  for (const pattern of errorPatterns) {
    const matches = transcript.match(pattern) ?? [];
    errorCount += matches.length;
  }

  return errorCount;
}

/**
 * Extract session start time from transcript
 */
function extractSessionStartTime(transcript: string): Date | undefined {
  // Look for the first timestamp in the transcript
  const timestampMatch = transcript.match(/"timestamp":"([^"]+)"/);

  if (timestampMatch?.[1]) {
    try {
      return new Date(timestampMatch[1]);
    } catch (error) {
      logDebug('Could not parse session start timestamp:', error);
    }
  }

  return undefined;
}

/**
 * Save session statistics to file
 */
async function saveSessionStats(stats: SessionStats): Promise<void> {
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');

    // Ensure stats directory exists
    const statsDir = `${getProjectDir()}/.claude/stats`;
    try {
      await mkdir(statsDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    // Save to JSONL format for easy analysis
    const statsFile = `${statsDir}/session-stats.jsonl`;
    const statsLine = JSON.stringify(stats) + '\n';

    await appendFile(statsFile, statsLine, 'utf-8');
    logDebug(`Session statistics saved to ${statsFile}`);
  } catch (error) {
    logDebug('Could not save session statistics:', error);
  }
}

/**
 * Generate human-readable session summary
 */
async function generateSessionSummary(
  stats: SessionStats
): Promise<string | null> {
  try {
    const summary = [
      `# Claude Code Session Summary`,
      ``,
      `**Session ID:** ${stats.sessionId}`,
      `**Project:** ${stats.projectPath}`,
      `**End Time:** ${stats.endTime.toLocaleString()}`,
      `**End Reason:** ${stats.reason}`,
      ``,
      `## Session Metrics`,
      ``,
    ];

    if (stats.duration !== undefined) {
      const minutes = Math.round(stats.duration / 60000);
      summary.push(`**Duration:** ${minutes} minutes`);
    }

    summary.push(
      `**Tools Used:** ${stats.toolsUsed.join(', ') || 'None'}`,
      `**Files Modified:** ${stats.filesModified.length}`,
      `**Commands Executed:** ${stats.commandsExecuted}`,
      `**Errors Encountered:** ${stats.errorsEncountered}`,
      `**Transcript Size:** ${Math.round(stats.transcriptSize / 1024)}KB`,
      ``
    );

    if (stats.filesModified.length > 0) {
      summary.push(
        `## Modified Files`,
        ``,
        ...stats.filesModified.map(file => `- ${file}`),
        ``
      );
    }

    if (stats.errorsEncountered > 0) {
      summary.push(
        `⚠️ Session ended with ${stats.errorsEncountered} errors - review transcript for details.`
      );
    } else {
      summary.push(`✅ Session completed successfully with no errors.`);
    }

    return summary.join('\n');
  } catch (error) {
    logDebug('Could not generate session summary:', error);
    return null;
  }
}

/**
 * Save session summary to file
 */
async function saveSessionSummary(
  summary: string,
  sessionId: string
): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');

    // Ensure summaries directory exists
    const summariesDir = `${getProjectDir()}/.claude/summaries`;
    try {
      await mkdir(summariesDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const summaryFile = `${summariesDir}/${sessionId}.md`;
    await writeFile(summaryFile, summary, 'utf-8');
    logDebug(`Session summary saved to ${summaryFile}`);
  } catch (error) {
    logDebug('Could not save session summary:', error);
  }
}

/**
 * Archive session transcript
 */
async function archiveSessionTranscript(
  input: SessionEndInput
): Promise<string | null> {
  try {
    const { copyFile, mkdir } = await import('node:fs/promises');

    // Ensure archive directory exists
    const archiveDir = `${getProjectDir()}/.claude/archive`;
    try {
      await mkdir(archiveDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = `${archiveDir}/${input.session_id}-${timestamp}.jsonl`;

    await copyFile(input.transcript_path, archivePath);
    return archivePath;
  } catch (error) {
    logDebug('Could not archive transcript:', error);
    return null;
  }
}

/**
 * Clean up temporary files created during session
 */
async function cleanupTemporaryFiles(
  sessionId: string,
  maxAgeHours: number
): Promise<number> {
  let cleanupCount = 0;

  try {
    const { readdir, stat, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const tempDir = '/tmp';
    const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds
    const now = Date.now();

    // Look for Claude-related temporary files
    const files = await readdir(tempDir);
    const claudeFiles = files.filter(
      file =>
        file.includes('claude-') ||
        file.includes(sessionId) ||
        file.startsWith('tmp-hook-')
    );

    for (const file of claudeFiles) {
      try {
        const filePath = join(tempDir, file);
        const fileStats = await stat(filePath);

        if (now - fileStats.mtime.getTime() > maxAge) {
          await unlink(filePath);
          cleanupCount++;
          logDebug(`Cleaned up temporary file: ${file}`);
        }
      } catch (error) {
        // File might have been deleted or inaccessible - continue
        logDebug(`Could not clean up ${file}:`, error);
      }
    }
  } catch (error) {
    logDebug('Could not perform temporary file cleanup:', error);
  }

  return cleanupCount;
}

/**
 * Send session completion notification
 */
async function sendSessionCompletionNotification(
  stats: SessionStats,
  reason: string
): Promise<void> {
  try {
    const duration =
      stats.duration !== undefined ? Math.round(stats.duration / 60000) : 0;
    const message = [
      `Claude Code session completed (${reason})`,
      `Duration: ${duration} minutes`,
      `Files modified: ${stats.filesModified.length}`,
      `Commands: ${stats.commandsExecuted}`,
      stats.errorsEncountered > 0
        ? `Errors: ${stats.errorsEncountered}`
        : 'No errors',
    ].join(' • ');

    // Send desktop notification if available
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      // Try macOS notification
      await execFileAsync(
        'osascript',
        [
          '-e',
          `display notification "${message}" with title "Claude Code Session Complete"`,
        ],
        { timeout: 3000 }
      );
    } catch {
      // Try Linux notification
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        await execFileAsync(
          'notify-send',
          ['Claude Code Session Complete', message],
          { timeout: 3000 }
        );
      } catch {
        // Notification failed - just log it
        logDebug('Could not send desktop notification');
      }
    }
  } catch (error) {
    logDebug('Could not send session completion notification:', error);
  }
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<SessionEndInput>(handleSessionEnd).catch(error => {
    console.error('Failed to execute session end hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks and testing
export {
  handleSessionEnd,
  generateSessionStats,
  generateSessionSummary,
  cleanupTemporaryFiles,
  sendSessionCompletionNotification,
};
