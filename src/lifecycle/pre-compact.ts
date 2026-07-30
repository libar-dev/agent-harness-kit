#!/usr/bin/env tsx

/**
 * PreCompact Hook Handler — Preserves context before Claude Code compacts a conversation.
 */

import {
  executeHook,
  logInfo,
  logDebug,
  logWarning,
  outputJson,
  getProjectDir,
} from '../utils/index.js';
import { type PreCompactInput } from '../types/index.js';
import { savePreCompactContext } from './pre-compact-context.js';
import { readTranscript } from './utils.js';

/**
 * Configuration for pre-compact hook behavior
 */
interface PreCompactConfig {
  /** Save important context before compaction */
  saveImportantContext: boolean;
  /** Generate project status summary */
  generateStatusSummary: boolean;
  /** Extract key decisions from conversation */
  extractKeyDecisions: boolean;
  /** Create compact backup file */
  createBackupFile: boolean;
  /** Maximum context size to extract (characters) */
  maxContextSize: number;
}

/**
 * Get pre-compact configuration from environment
 */
function getPreCompactConfig(): PreCompactConfig {
  return {
    saveImportantContext: process.env['CLAUDE_HOOK_SAVE_CONTEXT'] !== 'false',
    generateStatusSummary:
      process.env['CLAUDE_HOOK_GENERATE_SUMMARY'] !== 'false',
    extractKeyDecisions:
      process.env['CLAUDE_HOOK_EXTRACT_DECISIONS'] !== 'false',
    createBackupFile: process.env['CLAUDE_HOOK_CREATE_BACKUP'] === 'true',
    maxContextSize: parseInt(
      process.env['CLAUDE_HOOK_MAX_CONTEXT_SIZE'] ?? '10000',
      10
    ),
  };
}

/**
 * Important context that should be preserved
 */
interface ImportantContext {
  projectStatus: string;
  keyDecisions: string[];
  recentChanges: string[];
  pendingTasks: string[];
  errors: string[];
  importantFiles: string[];
}

/**
 * Main pre-compact hook handler
 */
async function handlePreCompact(input: PreCompactInput): Promise<void> {
  const config = getPreCompactConfig();
  const { session_id, trigger, custom_instructions } = input;

  logInfo(
    `PreCompact hook triggered (${trigger}) for session: ${session_id.substring(0, 8)}...`
  );

  if (custom_instructions) {
    logDebug(
      `Custom compact instructions: ${custom_instructions.substring(0, 200)}...`
    );
  }

  const contextSummary: string[] = [];

  try {
    // Extract and save important context
    if (config.saveImportantContext) {
      const importantContext = await extractImportantContext(input);
      await saveContextSummary(importantContext, session_id);

      contextSummary.push('📋 **Project Status Preserved**');
      if (importantContext.projectStatus) {
        contextSummary.push(`Status: ${importantContext.projectStatus}`);
      }

      if (importantContext.keyDecisions.length > 0) {
        contextSummary.push(
          `Key Decisions: ${importantContext.keyDecisions.length} recorded`
        );
      }

      if (importantContext.recentChanges.length > 0) {
        contextSummary.push(
          `Recent Changes: ${importantContext.recentChanges.join(', ')}`
        );
      }

      if (importantContext.pendingTasks.length > 0) {
        contextSummary.push(
          `Pending Tasks: ${importantContext.pendingTasks.join(', ')}`
        );
      }

      if (importantContext.errors.length > 0) {
        contextSummary.push(
          `⚠️ Unresolved Errors: ${importantContext.errors.join(', ')}`
        );
      }
    }

    // Generate project status summary
    if (config.generateStatusSummary) {
      const statusSummary = await generateProjectStatus();
      if (statusSummary) {
        contextSummary.push('', '🔍 **Current Project State**', statusSummary);
      }
    }

    // Create backup if requested
    if (config.createBackupFile) {
      const backupPath = await createPreCompactBackup(input);
      if (backupPath) {
        contextSummary.push('', `💾 **Backup Created**: ${backupPath}`);
      }
    }

    // Validate custom instructions if provided
    if (custom_instructions) {
      const validationResult = validateCustomInstructions(custom_instructions);
      if (!validationResult.isValid) {
        logWarning(
          `Custom compact instructions may be problematic: ${validationResult.issues.join(', ')}`
        );
        contextSummary.push(
          '',
          `⚠️ **Instruction Validation**: ${validationResult.issues.join(', ')}`
        );
      }
    }

    // Output context summary if we have important information to preserve
    if (contextSummary.length > 0) {
      logInfo('Pre-compact context extraction completed');

      const preservedContext = [
        'Pre-Compact Context Summary',
        '',
        ...contextSummary,
        '',
        '(This summary was generated before context compaction to preserve important information)',
      ].join('\n');
      await savePreCompactContext(session_id, preservedContext);
      outputJson({
        systemMessage: [
          '📄 **Pre-Compact Context Summary**',
          '',
          ...contextSummary,
          '',
          '*(This summary will be restored after compaction.)*',
        ].join('\n'),
      });
    }
  } catch (error) {
    logWarning(
      `Pre-compact hook encountered error: ${error instanceof Error ? error.message : String(error)}`
    );

    // Still allow compaction to proceed, but notify the user.
    const message = `Pre-compact context extraction failed: ${error instanceof Error ? error.message : String(error)}`;
    outputJson({ systemMessage: `⚠️ ${message}` });
  }
}

/**
 * Extract important context from the conversation transcript
 */
async function extractImportantContext(
  input: PreCompactInput
): Promise<ImportantContext> {
  const context: ImportantContext = {
    projectStatus: '',
    keyDecisions: [],
    recentChanges: [],
    pendingTasks: [],
    errors: [],
    importantFiles: [],
  };

  try {
    // Read transcript to analyze conversation
    const transcript = await readTranscript(input.transcript_path);

    if (transcript) {
      context.keyDecisions = extractKeyDecisions(transcript);
      context.recentChanges = extractRecentChanges(transcript);
      context.pendingTasks = extractPendingTasks(transcript);
      context.errors = extractUnresolvedErrors(transcript);
      context.importantFiles = extractImportantFiles(transcript);
    }

    // Get current project status
    context.projectStatus = await getCurrentProjectStatus();
  } catch (error) {
    logDebug('Could not extract full context:', error);
  }

  return context;
}

/**
 * Extract key decisions from transcript
 */
function extractKeyDecisions(transcript: string): string[] {
  const decisions: string[] = [];

  // Look for decision-indicating patterns
  const decisionPatterns = [
    /decided to use/gi,
    /chose to implement/gi,
    /will use.*instead of/gi,
    /opted for/gi,
    /selected.*approach/gi,
  ];

  for (const pattern of decisionPatterns) {
    const matches = transcript.match(pattern);
    if (matches) {
      // Extract context around each match
      const regex = new RegExp(`(.{0,50}${pattern.source}.{0,100})`, 'gi');
      const contextMatches = transcript.match(regex) ?? [];
      decisions.push(...contextMatches.slice(0, 3)); // Limit to avoid overwhelming
    }
  }

  return decisions.slice(0, 10); // Limit to most recent decisions
}

/**
 * Extract file changes from transcript
 */
function extractRecentChanges(transcript: string): string[] {
  const changes: string[] = [];

  // Look for file modification patterns
  const filePatterns = [
    /"tool_name":"Write".*"file_path":"([^"]+)"/g,
    /"tool_name":"Edit".*"file_path":"([^"]+)"/g,
    /"tool_name":"MultiEdit".*"file_path":"([^"]+)"/g,
  ];

  for (const pattern of filePatterns) {
    let match: RegExpExecArray | null = pattern.exec(transcript);
    while (match !== null) {
      const filePath = match[1];
      if (filePath && !changes.includes(filePath)) {
        changes.push(filePath);
      }
      match = pattern.exec(transcript);
    }
  }

  return changes.slice(0, 20); // Limit to most recent changes
}

/**
 * Extract pending tasks from transcript
 */
function extractPendingTasks(transcript: string): string[] {
  const tasks: string[] = [];

  // Look for task-indicating patterns
  const taskPatterns = [
    /TODO:?\s*(.+)/gi,
    /FIXME:?\s*(.+)/gi,
    /need to\s+(.+)/gi,
    /should\s+(.+)/gi,
    /will\s+(.+)/gi,
  ];

  for (const pattern of taskPatterns) {
    let match: RegExpExecArray | null = pattern.exec(transcript);
    while (match !== null) {
      const task = match[1]?.trim();
      if (task && task.length < 200) {
        // Reasonable task length
        tasks.push(task);
      }
      match = pattern.exec(transcript);
    }
  }

  return tasks.slice(0, 15); // Limit to avoid overwhelming
}

/**
 * Extract unresolved errors from transcript
 */
function extractUnresolvedErrors(transcript: string): string[] {
  const errors: string[] = [];

  // Look for error patterns that weren't resolved
  const errorPatterns = [
    /Error:?\s*(.+)/gi,
    /Failed to\s+(.+)/gi,
    /Cannot\s+(.+)/gi,
    /TypeError:?\s*(.+)/gi,
  ];

  for (const pattern of errorPatterns) {
    let match: RegExpExecArray | null = pattern.exec(transcript);
    while (match !== null) {
      const error = match[1]?.trim();
      if (error && error.length < 300) {
        errors.push(error);
      }
      match = pattern.exec(transcript);
    }
  }

  return errors.slice(0, 10); // Limit to most recent errors
}

/**
 * Extract important files mentioned in transcript
 */
function extractImportantFiles(transcript: string): string[] {
  const files = new Set<string>();

  // Extract file paths from various tool calls
  const filePathPatterns = [/"file_path":"([^"]+)"/g, /"path":"([^"]+)"/g];

  for (const pattern of filePathPatterns) {
    let match: RegExpExecArray | null = pattern.exec(transcript);
    while (match !== null) {
      const filePath = match[1];
      if (
        filePath &&
        !filePath.includes('node_modules') &&
        !filePath.includes('.git')
      ) {
        files.add(filePath);
      }
      match = pattern.exec(transcript);
    }
  }

  return Array.from(files).slice(0, 25);
}

/**
 * Get current project status
 */
async function getCurrentProjectStatus(): Promise<string> {
  const statusParts: string[] = [];

  try {
    // Check git status
    const gitStatus = await getGitStatus();
    if (gitStatus) {
      statusParts.push(`Git: ${gitStatus}`);
    }

    const hasTypeErrors = await checkTypeScriptErrors();
    if (hasTypeErrors) {
      statusParts.push('TypeScript: Has compilation errors');
    } else {
      statusParts.push('TypeScript: Clean');
    }

    const testStatus = await getTestStatus();
    if (testStatus) {
      statusParts.push(`Tests: ${testStatus}`);
    }
  } catch (error) {
    logDebug('Could not get full project status:', error);
    statusParts.push('Status check partially failed');
  }

  return statusParts.join(', ') || 'Unknown';
}

/**
 * Get git status summary
 */
async function getGitStatus(): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: getProjectDir(),
      timeout: 3000,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return 'Clean working directory';
    }

    const modified = lines.filter(line => line.startsWith(' M')).length;
    const added = lines.filter(line => line.startsWith('A ')).length;
    const untracked = lines.filter(line => line.startsWith('??')).length;

    return `${modified} modified, ${added} staged, ${untracked} untracked files`;
  } catch {
    return null;
  }
}

/**
 * Check for TypeScript compilation errors
 */
async function checkTypeScriptErrors(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
      cwd: getProjectDir(),
      timeout: 15000,
    });

    return false; // No errors
  } catch {
    return true; // Has errors
  }
}

/**
 * Get test status summary
 */
async function getTestStatus(): Promise<string | null> {
  // This is a placeholder for project-specific test status sources:
  // - Check test result files
  // - Parse test output
  // - Check test coverage reports
  return null;
}

/**
 * Save context summary to file
 */
async function saveContextSummary(
  context: ImportantContext,
  sessionId: string
): Promise<void> {
  try {
    const summary = [
      context.projectStatus && `Project status: ${context.projectStatus}`,
      context.keyDecisions.length > 0 &&
        `Key decisions:\n${context.keyDecisions.map(value => `- ${value}`).join('\n')}`,
      context.recentChanges.length > 0 &&
        `Recent changes:\n${context.recentChanges.map(value => `- ${value}`).join('\n')}`,
      context.pendingTasks.length > 0 &&
        `Pending tasks:\n${context.pendingTasks.map(value => `- ${value}`).join('\n')}`,
      context.errors.length > 0 &&
        `Unresolved errors:\n${context.errors.map(value => `- ${value}`).join('\n')}`,
      context.importantFiles.length > 0 &&
        `Important files:\n${context.importantFiles.map(value => `- ${value}`).join('\n')}`,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n\n');
    if (summary) {
      await savePreCompactContext(sessionId, summary);
      logDebug('Pre-compact context summary saved');
    }
  } catch (error) {
    logDebug('Could not save context summary:', error);
  }
}

/**
 * Generate project status summary
 */
async function generateProjectStatus(): Promise<string | null> {
  try {
    const status = await getCurrentProjectStatus();
    const timestamp = new Date().toLocaleString();

    return `${status} (as of ${timestamp})`;
  } catch {
    return null;
  }
}

/**
 * Create backup of current transcript before compaction
 */
async function createPreCompactBackup(
  input: PreCompactInput
): Promise<string | null> {
  try {
    const { copyFile } = await import('node:fs/promises');
    const backupPath = `${input.transcript_path}.pre-compact-backup`;

    await copyFile(input.transcript_path, backupPath);
    return backupPath;
  } catch (error) {
    logDebug('Could not create backup:', error);
    return null;
  }
}

/**
 * Validate custom compact instructions
 */
function validateCustomInstructions(instructions: string): {
  isValid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for potentially problematic instructions
  if (instructions.includes('ignore') || instructions.includes('delete all')) {
    issues.push('Instructions may be too aggressive');
  }

  if (instructions.length > 1000) {
    issues.push('Instructions are very long and may not be effective');
  }

  if (instructions.length < 10) {
    issues.push('Instructions may be too brief to be useful');
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreCompactInput>(handlePreCompact).catch(error => {
    console.error('Failed to execute pre-compact hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks and testing
export {
  handlePreCompact,
  extractImportantContext,
  getCurrentProjectStatus,
  validateCustomInstructions,
};
