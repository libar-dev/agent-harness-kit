/**
 * Core utility functions for Claude Code hooks
 *
 * This module provides essential utilities that all hooks can use:
 * - Input/output handling
 * - Error management
 * - JSON formatting
 * - Environment detection
 */

import { stdin, stdout, stderr, env, exit } from 'node:process';
import type { HookInput, HookOutput, HookConfig } from '../types/index.js';
import { validateHookInput as zodValidateHookInput } from '../validation/validators.js';
import type { HookInputSchema } from '../validation/schemas.js';

// =============================================================================
// Input/Output Utilities
// =============================================================================

/**
 * Read and parse JSON input from stdin
 * This is the primary way hooks receive data from Claude Code.
 * All input is validated at this boundary using Zod schemas.
 */
export async function readStdinJson(): Promise<HookInputSchema> {
  try {
    const input = await readStdin();
    const parsed: unknown = JSON.parse(input);

    // Validate at boundary using Zod schemas — the primary defense
    const validated = zodValidateHookInput(parsed);

    if (getConfig().debug) {
      logDebug('Received hook input:', validated);
    }

    return validated;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown parsing error';
    throw new Error(`Failed to parse hook input JSON: ${message}`);
  }
}

/**
 * Read raw text from stdin
 * Used internally by readStdinJson, but also available for custom parsing
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  // Set a timeout to prevent hanging
  const timeout = setTimeout(() => {
    logError('Timeout waiting for stdin input');
    exit(1);
  }, 30000); // 30 second timeout

  try {
    for await (const chunk of stdin as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    clearTimeout(timeout);

    const result = Buffer.concat(chunks).toString('utf-8');
    if (getConfig().debug) {
      logDebug(`Read ${result.length} characters from stdin`);
    }

    return result;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Output JSON response to Claude Code
 * This is the primary way hooks send structured responses
 */
export function outputJson(data: HookOutput): void {
  const jsonString = JSON.stringify(data, null, 2);

  if (getConfig().debug) {
    logDebug('Sending hook output:', data);
  }

  stdout.write(jsonString);
}

/**
 * Output plain text (for simple success messages)
 * Used when hooks want to send simple text responses
 */
export function outputText(message: string): void {
  if (getConfig().debug) {
    logDebug('Sending text output:', message);
  }

  stdout.write(message);
}

// =============================================================================
// Logging Utilities
// =============================================================================

/**
 * Log error message to stderr
 * Claude Code shows stderr to the user when hooks fail
 */
export function logError(message: string, error?: Error): void {
  const timestamp = new Date().toISOString();
  const fullMessage = error
    ? `[${timestamp}] ERROR: ${message}\n${error.stack ?? error.message}`
    : `[${timestamp}] ERROR: ${message}`;

  stderr.write(fullMessage + '\n');
}

/**
 * Log warning message to stderr
 * Used for non-fatal issues that users should be aware of
 */
export function logWarning(message: string): void {
  if (getConfig().debug) {
    const timestamp = new Date().toISOString();
    stderr.write(`[${timestamp}] WARNING: ${message}\n`);
  }
}

/**
 * Log debug information to stderr
 * Only shown when debug mode is enabled
 */
export function logDebug(message: string, data?: unknown): void {
  if (getConfig().debug) {
    const timestamp = new Date().toISOString();
    let fullMessage = `[${timestamp}] DEBUG: ${message}`;

    if (data !== undefined) {
      fullMessage += '\n' + JSON.stringify(data, null, 2);
    }

    stderr.write(fullMessage + '\n');
  }
}

/**
 * Log info message to stderr
 * General informational messages for the user
 */
export function logInfo(message: string): void {
  const timestamp = new Date().toISOString();
  stderr.write(`[${timestamp}] INFO: ${message}\n`);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// =============================================================================
// Environment and Configuration
// =============================================================================

/**
 * Get hook configuration from environment variables
 * Allows hooks to be customized without code changes.
 * Env is read once per process; tests can call resetConfigCache() to reload.
 */
let cachedConfig: HookConfig | undefined;

export function getConfig(): HookConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    debug:
      env['CLAUDE_HOOK_DEBUG'] === 'true' ||
      env['DEBUG'] === 'true' ||
      env['CLAUDE_CODE_DEBUG_LOG_LEVEL'] === 'verbose',
    timeout: parseInt(env['CLAUDE_HOOK_TIMEOUT'] ?? '60', 10),
    sessionEndTimeoutMs: parseSessionEndTimeoutMs(
      env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS']
    ),
    syncPluginInstall: env['CLAUDE_CODE_SYNC_PLUGIN_INSTALL'] === 'true',
    rules: {
      protectedFiles: env['CLAUDE_HOOK_PROTECTED_FILES']?.split(',') ?? [
        '.env',
        '.env.local',
        '.env.production',
        '.git/**',
        'package-lock.json',
        'yarn.lock',
      ],
      dangerousCommands: env['CLAUDE_HOOK_DANGEROUS_COMMANDS']?.split(',') ?? [
        'rm -rf',
        'sudo',
        'chmod 777',
        'dd',
        'mkfs',
      ],
      autoFormatExtensions: env['CLAUDE_HOOK_AUTO_FORMAT']?.split(',') ?? [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.json',
        '.css',
        '.md',
      ],
    },
  };

  return cachedConfig;
}

/**
 * Clear the cached HookConfig. Exposed for tests that mutate env vars
 * between cases; not intended for runtime use.
 */
export function resetConfigCache(): void {
  cachedConfig = undefined;
}

function parseSessionEndTimeoutMs(value: string | undefined): number {
  if (!value) return 1500;

  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1500;

  return Math.min(parsed, 60000);
}

/**
 * Get the project root directory
 * Uses CLAUDE_PROJECT_DIR environment variable set by Claude Code
 */
export function getProjectDir(): string {
  const projectDir = env['CLAUDE_PROJECT_DIR'];
  if (!projectDir) {
    throw new Error('CLAUDE_PROJECT_DIR environment variable not set');
  }
  return projectDir;
}

/**
 * Check if we're running in a development environment
 * Useful for enabling different behavior during development vs production
 */
export function isDevelopment(): boolean {
  return env['NODE_ENV'] === 'development' || env['NODE_ENV'] === undefined;
}

/**
 * Check if we're running in CI
 * Useful for disabling interactive features in automated environments
 */
export function isCI(): boolean {
  return (
    env['CI'] === 'true' ||
    env['GITHUB_ACTIONS'] === 'true' ||
    env['TRAVIS'] === 'true'
  );
}

// =============================================================================
// Error Handling Utilities
// =============================================================================

/**
 * Wrap hook execution with proper error handling
 * Ensures consistent error reporting and exit codes
 */
export function executeHook<T extends HookInput = HookInput>(
  handler: (input: T) => Promise<void> | void
): Promise<void>;
export async function executeHook(
  handler: (input: HookInput) => Promise<void> | void
): Promise<void> {
  try {
    const input = await readStdinJson();
    await handler(input);
    exit(0);
  } catch (error) {
    if (error instanceof Error) {
      logError('Hook execution failed', error);

      // Exit code 2 = blocking error (Claude Code will show this to Claude)
      // Exit code 1 = non-blocking error (shown to user only)
      const isBlockingError =
        error.message.includes('BLOCK') || error.message.includes('DENY');
      exit(isBlockingError ? 2 : 1);
    } else {
      logError('Unknown error occurred', new Error(String(error)));
      exit(1);
    }
  }
}

/**
 * Create a standardized error for blocking operations
 * Use this when you want Claude Code to show the error to Claude for processing
 */
export function createBlockingError(message: string): Error {
  const error = new Error(`BLOCK: ${message}`);
  error.name = 'BlockingError';
  return error;
}

/**
 * Create a standardized error for non-blocking warnings
 * Use this for issues that don't prevent operation but should be noted
 */
export function createWarningError(message: string): Error {
  const error = new Error(`WARNING: ${message}`);
  error.name = 'WarningError';
  return error;
}

// =============================================================================
// File and Path Utilities
// =============================================================================

/**
 * Normalize file path for consistent comparison across platforms
 *
 * This function handles cross-platform path differences to ensure
 * consistent behavior across Windows, macOS, and Linux systems.
 *
 * Transformations performed:
 * 1. Convert Windows backslashes (\) to forward slashes (/)
 * 2. Remove trailing slashes except for root directory
 * 3. Apply case-insensitive normalization on Windows platforms
 *
 * Examples:
 * - Windows: "src\\file.txt" -> "src/file.txt"
 * - Trailing: "path/to/dir/" -> "path/to/dir"
 * - Root: "/" remains "/"
 * - Windows case: "FILE.TXT" -> "file.txt" (on win32)
 *
 * @param path The file path to normalize
 * @returns Normalized path string for consistent comparison
 */
function normalizeFilePath(path: string): string {
  // Step 1: Convert Windows backslashes to forward slashes for consistent comparison
  // This ensures paths work the same way regardless of platform
  let normalized = path.replace(/\\/g, '/');

  // Step 2: Remove trailing slashes except for root directory
  // This prevents "/path/" and "/path" from being treated differently
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  // Step 3: Convert to lowercase for case-insensitive comparison on Windows-like systems
  // Windows file systems are case-insensitive, so "FILE.txt" === "file.txt"
  // Unix-like systems are case-sensitive, so we preserve case there
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

// Cache for compiled regex patterns to avoid recompilation
// Using Map to allow for proper cleanup and garbage collection
const globRegexCache = new Map<string, RegExp>();

/**
 * Convert glob pattern to regex with proper cross-platform handling
 *
 * This function transforms glob patterns (like those used in .gitignore)
 * into JavaScript RegExp objects for efficient pattern matching.
 *
 * SUPPORTED GLOB PATTERNS:
 * - `*`  : Matches any characters except path separators (single directory level)
 * - `**` : Matches any characters including path separators (recursive/multi-level)
 * - `.`  : Literal dot (escaped in output regex)
 * - Other special regex chars are automatically escaped
 *
 * EXAMPLES:
 * - `*.txt`        -> Matches: file.txt, test.txt | No match: dir/file.txt
 * - `**​/*.txt`     -> Matches: file.txt, dir/file.txt, deep/nested/file.txt
 * - `.git/**​`      -> Matches: .git/config, .git/objects/abc123
 * - `node_modules` -> Matches: node_modules (exact)
 *
 * PERFORMANCE FEATURES:
 * - Compiled regex patterns are cached to avoid recompilation
 * - Cache keys include platform information for cross-platform consistency
 * - Map-based cache allows for proper garbage collection
 *
 * CROSS-PLATFORM HANDLING:
 * - Normalizes paths before processing (handles Windows backslashes)
 * - Uses case-insensitive matching on Windows platforms
 * - Anchors patterns for exact matching (^ and $ boundaries)
 *
 * IMPLEMENTATION DETAILS:
 * The function uses a placeholder technique to safely handle both `*` and `**`:
 * 1. Replace `**` with unique placeholder to avoid conflicts
 * 2. Replace remaining `*` with `[^/]*` (non-slash characters)
 * 3. Replace placeholders with `.*` (any characters including slashes)
 *
 * This prevents the scenario where `**` -> `.*` -> `[^/]*[^/]*` (incorrect)
 * and ensures `**` properly becomes `.*` (correct recursive match).
 *
 * @param pattern Glob pattern string to convert (e.g., "*.js", "src/**")
 * @returns Compiled RegExp object ready for testing file paths
 */
function globToRegex(pattern: string): RegExp {
  // Step 1: Create a cache key that includes platform-specific flags
  // This ensures Windows (case-insensitive) and Unix (case-sensitive)
  // patterns are cached separately
  const cacheKey = `${pattern}:${process.platform}`;

  // Step 2: Return cached regex if available (performance optimization)
  const cached = globRegexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Step 3: Normalize the pattern for cross-platform consistency
  // This handles Windows backslashes, trailing slashes, and case sensitivity
  const normalizedPattern = normalizeFilePath(pattern);

  // Step 4: Escape special regex characters except for our glob wildcards
  // Characters like ., +, ^, $, (, ), |, [, ], {, }, \ have special meaning in regex
  // We escape them to treat them as literal characters, but preserve * for glob processing
  let regexPattern = normalizedPattern.replace(/[.+^$()|[\]{}\\]/g, '\\$&'); // Escape regex special chars

  // Step 5: Handle glob patterns using placeholder technique to avoid conflicts
  // CRITICAL: This order prevents `**` -> `.*` -> `[^/]*[^/]*` transformation

  // 5a: Replace `**` with a unique placeholder first
  // This ensures recursive wildcards are processed separately from single wildcards
  regexPattern = regexPattern.replace(/\*\*/g, '___RECURSIVE_WILDCARD___');

  // 5b: Replace single `*` with character class (anything except path separator)
  // `[^/]*` matches any characters except forward slash, restricting to single directory level
  regexPattern = regexPattern.replace(/\*/g, '[^/]*');

  // 5c: Replace the placeholder with proper recursive regex
  // `.*` matches any characters including slashes, enabling multi-level directory matching
  regexPattern = regexPattern.replace(/___RECURSIVE_WILDCARD___/g, '.*');

  // Step 6: Anchor the pattern for exact matching
  // Without anchors, pattern "test" would match "testing" (partial match)
  // With anchors, pattern "test" only matches "test" exactly
  const anchoredPattern = '^' + regexPattern + '$';

  // Step 7: Create regex with appropriate flags based on platform
  // Windows file systems are case-insensitive, Unix-like systems are case-sensitive
  const flags = process.platform === 'win32' ? 'i' : ''; // Case-insensitive on Windows
  const regex = new RegExp(anchoredPattern, flags);

  // Step 8: Cache the compiled regex for future use
  // Subsequent calls with the same pattern will return the cached version
  globRegexCache.set(cacheKey, regex);

  return regex;
}

/**
 * Clear the glob regex cache - useful for testing or memory management
 * Exported for testing purposes and potential memory cleanup
 */
export function clearGlobRegexCache(): void {
  globRegexCache.clear();
}

/**
 * Check if a file path matches any of the protected patterns
 *
 * This function is the core of the file protection system, determining whether
 * a file should be protected from modification based on configured patterns.
 * It's used by file protection hooks to prevent accidental edits to sensitive files.
 *
 * PROTECTION STRATEGY:
 * The function implements a multi-layered protection approach:
 * 1. Exact path matching (fastest, most precise)
 * 2. Glob pattern matching (flexible, supports wildcards)
 * 3. Directory prefix matching (protects entire directories)
 *
 * SUPPORTED PATTERN TYPES:
 *
 * 1. EXACT MATCHES:
 *    - Pattern: ".env" matches only ".env" exactly
 *    - Use for: Specific critical files
 *
 * 2. GLOB PATTERNS (contain * or **):
 *    - Pattern: "*.log" matches "app.log", "error.log"
 *    - Pattern: ".git/**​" matches all files in .git directory
 *    - Pattern: "**​/node_modules" matches node_modules at any depth
 *    - Use for: File extensions, recursive directory protection
 *
 * 3. DIRECTORY PREFIX MATCHING:
 *    - Pattern: ".git" matches ".git/config", ".git/objects/abc123"
 *    - Pattern: "node_modules" matches "node_modules/package/file.js"
 *    - Use for: Protecting entire directory trees without glob syntax
 *
 * CROSS-PLATFORM FEATURES:
 * - Handles Windows backslashes: "src\\file.txt" treated same as "src/file.txt"
 * - Case sensitivity: Respects platform conventions (Windows=insensitive, Unix=sensitive)
 * - Path normalization: Removes trailing slashes, handles path variations
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Exact matches checked first (O(1) string comparison)
 * - Regex compilation is cached to avoid recompilation overhead
 * - Short-circuit evaluation stops at first match
 *
 * CONFIGURATION:
 * Protected patterns come from environment variables or default configuration:
 * - Default patterns: .env, .env.local, .git/**​, package-lock.json, yarn.lock
 * - Configurable via: CLAUDE_HOOK_PROTECTED_FILES environment variable
 *
 * EXAMPLES:
 * ```typescript
 * // Exact matches
 * isProtectedFile('.env')                    // true (matches exactly)
 * isProtectedFile('.env.backup')             // false (different file)
 *
 * // Glob patterns
 * isProtectedFile('.git/config')             // true (matches .git/**)
 * isProtectedFile('logs/app.log')            // depends on patterns
 *
 * // Directory prefix
 * isProtectedFile('node_modules/pkg/file')   // true (if node_modules protected)
 * isProtectedFile('my_modules/file')         // false (different prefix)
 *
 * // Cross-platform
 * isProtectedFile('.git\\config')            // true (Windows path normalized)
 * isProtectedFile('.GIT/config')             // true on Windows, false on Unix
 * ```
 *
 * @param filePath The file path to check for protection (can be relative or absolute)
 * @returns true if the file matches any protected pattern, false otherwise
 */
export function isProtectedFile(filePath: string): boolean {
  const config = getConfig();
  const protectedPatterns = config.rules?.protectedFiles ?? [];

  // Step 1: Normalize the input file path for consistent cross-platform comparison
  // This handles Windows backslashes, trailing slashes, and case sensitivity
  const normalizedFilePath = normalizeFilePath(filePath);

  // Step 2: Check each protection pattern using short-circuit evaluation
  // The function returns true immediately when the first match is found
  return protectedPatterns.some(pattern => {
    const normalizedPattern = normalizeFilePath(pattern);

    // Strategy 1: Handle exact matches first (fastest check)
    // This catches specific files like ".env", "package-lock.json" exactly
    if (normalizedPattern === normalizedFilePath) {
      return true;
    }

    // Strategy 2: Handle glob patterns (contains wildcards)
    // This processes patterns like "*.log", ".git/**", "**/node_modules"
    if (pattern.includes('*')) {
      const regex = globToRegex(pattern);
      return regex.test(normalizedFilePath);
    }

    // Strategy 3: Handle directory prefix matching for non-glob patterns
    // This protects entire directories: pattern ".git" protects ".git/config"
    // Uses startsWith with '/' suffix to avoid false matches like ".gitignore"
    return (
      normalizedFilePath === normalizedPattern ||
      normalizedFilePath.startsWith(normalizedPattern + '/')
    );
  });
}

/**
 * Check if a command contains dangerous patterns
 * Used by bash validation hooks to warn about risky commands
 */
export function isDangerousCommand(command: string): boolean {
  const config = getConfig();
  const dangerousPatterns = config.rules?.dangerousCommands ?? [];

  return dangerousPatterns.some(pattern =>
    command.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Check if a file should be auto-formatted
 * Based on file extension and configuration
 */
export function shouldAutoFormat(filePath: string): boolean {
  const config = getConfig();
  const formatExtensions = config.rules?.autoFormatExtensions ?? [];

  return formatExtensions.some(ext => filePath.endsWith(ext));
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate that required fields are present in hook input
 * Throws an error if validation fails
 */
export function validateRequiredFields(
  input: Record<string, unknown>,
  requiredFields: string[]
): void {
  for (const field of requiredFields) {
    if (
      !(field in input) ||
      input[field] === undefined ||
      input[field] === null
    ) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
}

/**
 * Validate that a file path is safe and within project bounds
 * Prevents path traversal attacks and operations outside project
 */
export function validateFilePath(filePath: string): void {
  // Check for path traversal attempts
  if (filePath.includes('..')) {
    throw createBlockingError('Path traversal detected in file path');
  }

  // Check for absolute paths outside project (optional safety check)
  const projectDir = getProjectDir();
  if (filePath.startsWith('/') && !filePath.startsWith(projectDir)) {
    logWarning(
      `File path ${filePath} is outside project directory ${projectDir}`
    );
  }
}

/**
 * Sanitize user input for shell commands
 * Basic protection against command injection
 */
export function sanitizeCommand(command: string): string {
  // Remove or escape potentially dangerous characters
  // This is basic sanitization - for production use, consider more robust solutions
  return command
    .replace(/[`$()]/g, '') // Remove backticks, dollar signs, parentheses
    .replace(/;+/g, ';') // Collapse multiple semicolons
    .trim();
}
