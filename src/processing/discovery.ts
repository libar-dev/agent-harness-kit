/**
 * Session discovery — find and filter sessions in a Claude project directory.
 *
 * Scans the project dir for session JSONL files, extracts timestamps
 * from their first few lines, and supports filtering by date range
 * or "since last export" via a marker file.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import { compareStrings } from './ordering.js';

/** Metadata about a discovered session (without reading the full file) */
export interface SessionInfo {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly filePath: string;
  readonly startTime: string;
  readonly fileSize: number;
  readonly hasSubagents: boolean;
}

/** Options for discovering sessions */
export interface DiscoverOptions {
  /** Only include sessions starting after this date (ISO string or Date) */
  readonly after?: string | Date | undefined;
  /** Only include sessions starting before this date (ISO string or Date) */
  readonly before?: string | Date | undefined;
  /** Only include sessions since the last export (reads marker file) */
  readonly sinceLastExport?: boolean | undefined;
  /** Max number of sessions to return (default: all) */
  readonly limit?: number | undefined;
}

const EXPORT_MARKER_FILE = '.session-export-marker';

/**
 * Convert a working directory path to a Claude project directory path.
 *
 * Claude Code stores sessions at:
 *   ~/.claude/projects/-Users-foo-dev-bar/<session>.jsonl
 *
 * where the folder name is the working directory with path separators
 * replaced by hyphens.
 */
export function projectDirFromCwd(cwd: string): string {
  // Replace path separators with hyphens, matching Claude Code's convention
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

/**
 * List all available Claude project directories.
 */
export async function listProjects(): Promise<string[]> {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  try {
    const entries = await readdir(projectsRoot);
    return entries
      .filter(e => e.startsWith('-'))
      .map(e => join(projectsRoot, e))
      .sort(compareStrings);
  } catch {
    return [];
  }
}

/**
 * Get a display-friendly path from a project directory name.
 *
 * Reconstructs a tilde-form path from the encoded directory name.
 * Uses the home directory to replace the leading prefix with `~/`,
 * then keeps the remaining segment as-is (since hyphen-to-slash
 * conversion is lossy for directory names containing hyphens).
 *
 * Examples:
 *   "-Users-darkomijic-dev-projects-foo" → "~/dev-projects-foo"
 *   Full path form with resolveProjectPath() for filesystem operations.
 */
export function cwdFromProjectDir(projectDir: string): string {
  const name = basename(projectDir);
  // Strip leading hyphen
  const stripped = name.replace(/^-/, '');

  // Try to replace the home directory prefix with ~/
  const home = homedir();
  const homeEncoded = home.replace(/\//g, '-').replace(/^-/, '');
  if (stripped.startsWith(homeEncoded + '-')) {
    const rest = stripped.substring(homeEncoded.length + 1);
    return '~/' + rest;
  }
  if (stripped === homeEncoded) {
    return '~';
  }

  // Fallback: return with leading slash restored
  return '/' + stripped;
}

/**
 * Attempt to resolve the actual filesystem path from a project directory name.
 *
 * Tries progressively splitting the remaining path segment at each hyphen
 * position to find a directory that exists on disk. Falls back to the
 * raw hyphenated form if no match is found.
 *
 * This is used for computing output directories — where we need the real path,
 * not just a display label.
 */
export async function resolveProjectPath(
  projectDir: string
): Promise<string | null> {
  const name = basename(projectDir);
  const stripped = name.replace(/^-/, '');

  const home = homedir();
  const homeEncoded = home.replace(/\//g, '-').replace(/^-/, '');
  if (!stripped.startsWith(homeEncoded + '-')) {
    return null;
  }

  const rest = stripped.substring(homeEncoded.length + 1);
  // Try to resolve by checking which path exists on disk
  const resolved = await resolveHyphenatedPath(home, rest);
  return resolved;
}

/**
 * Recursively resolve a hyphenated path segment by checking the filesystem.
 * For "dev-projects-claude-code-hooks", tries:
 *   home/dev-projects-claude-code-hooks (check if exists)
 *   home/dev/ + resolve("projects-claude-code-hooks")
 *   home/dev-projects/ + resolve("claude-code-hooks")
 *   etc.
 */
async function resolveHyphenatedPath(
  base: string,
  remaining: string
): Promise<string | null> {
  // Try the whole remaining segment as a single directory name
  const fullPath = join(base, remaining);
  if (await dirExists(fullPath)) {
    return fullPath;
  }

  // Try splitting at each hyphen position
  const parts = remaining.split('-');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('-');
    const suffix = parts.slice(i).join('-');
    const prefixPath = join(base, prefix);
    if (await dirExists(prefixPath)) {
      const resolved = await resolveHyphenatedPath(prefixPath, suffix);
      if (resolved !== null) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * Discover sessions in a project directory.
 *
 * Reads the first few lines of each JSONL file to extract the start
 * timestamp, checks for subagent folders, and applies optional filters.
 */
export async function discoverSessions(
  projectDir: string,
  options: DiscoverOptions = {}
): Promise<SessionInfo[]> {
  const entries = await readdir(projectDir);
  const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));

  const sessions: SessionInfo[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(projectDir, file);
    const sessionId = basename(file, '.jsonl');

    // Get file stats
    const fileStat = await stat(filePath);

    // Read first ~4KB to find the first timestamp
    const startTime = await extractStartTime(filePath);
    if (!startTime) continue;

    // Check for subagents folder
    const hasSubagents = await dirExists(
      join(projectDir, sessionId, 'subagents')
    );

    sessions.push({
      sessionId,
      projectDir,
      filePath,
      startTime,
      fileSize: fileStat.size,
      hasSubagents,
    });
  }

  // Sort by start time (newest first)
  sessions.sort((a, b) => compareStrings(b.startTime, a.startTime));

  // Apply filters
  let filtered = sessions;

  // Since last export
  if (options.sinceLastExport) {
    const lastExport = await readExportMarker(projectDir);
    if (lastExport) {
      const cutoff = new Date(lastExport).getTime();
      filtered = filtered.filter(s => new Date(s.startTime).getTime() > cutoff);
    }
  }

  // Date range filters
  if (options.after !== undefined) {
    const cutoff = new Date(options.after).getTime();
    filtered = filtered.filter(s => new Date(s.startTime).getTime() > cutoff);
  }
  if (options.before !== undefined) {
    const cutoff = new Date(options.before).getTime();
    filtered = filtered.filter(s => new Date(s.startTime).getTime() < cutoff);
  }

  // Limit
  if (options.limit !== undefined && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * Read the first timestamp from a session JSONL file.
 * Skips non-timestamped lines (like file-history-snapshot).
 */
async function extractStartTime(filePath: string): Promise<string | null> {
  try {
    const fd = await readFile(filePath, 'utf-8');
    // Only read first ~4KB worth of lines
    const firstChunk = fd.substring(0, 4096);
    const lines = firstChunk.split('\n');

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'timestamp' in parsed &&
          typeof parsed['timestamp'] === 'string'
        ) {
          return parsed['timestamp'];
        }
      } catch {
        // Skip malformed
      }
    }
  } catch {
    // File read error
  }
  return null;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Export marker persistence.

/**
 * Read the last export timestamp from the marker file.
 */
export async function readExportMarker(
  projectDir: string
): Promise<string | null> {
  try {
    const content = await readFile(
      join(projectDir, EXPORT_MARKER_FILE),
      'utf-8'
    );
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write the current time as the export marker.
 */
export async function writeExportMarker(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, EXPORT_MARKER_FILE),
    new Date().toISOString() + '\n'
  );
}
