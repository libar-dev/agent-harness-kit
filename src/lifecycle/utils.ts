/**
 * Shared utilities for lifecycle hooks
 *
 * Contains functions that were previously duplicated across
 * pre-compact.ts, session-end.ts, and subagent-stop.ts.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logDebug } from '../utils/index.js';

export const execFileAsync = promisify(execFile);

/**
 * Read transcript file contents
 */
export async function readTranscript(
  transcriptPath: string
): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(transcriptPath, 'utf-8');
    return content;
  } catch (error) {
    logDebug('Could not read transcript:', error);
    return null;
  }
}

/**
 * Extract unique tool names used from a transcript string
 */
export function extractToolsUsed(transcript: string): string[] {
  const tools = new Set<string>();
  const toolMatches = transcript.match(/"tool_name":"([^"]+)"/g) ?? [];

  for (const match of toolMatches) {
    const tool = match.match(/"tool_name":"([^"]+)"/);
    if (tool?.[1]) {
      tools.add(tool[1]);
    }
  }

  return Array.from(tools);
}
