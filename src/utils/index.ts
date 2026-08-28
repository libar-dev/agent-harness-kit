/**
 * Utilities for hook stdin/stdout I/O, logging, config, and path checks.
 */

import { stdin, stdout, stderr, env, exit } from 'node:process';
import { readBoundedTimedStdin } from '../internal/stdin.js';
import type { HookInput, HookOutput, HookConfig } from '../types/index.js';
import { validateHookInput as zodValidateHookInput } from '../validation/validators.js';
import type { HookInputSchema } from '../validation/schemas.js';

const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 30_000;

/**
 * Read JSON from stdin and validate it at the hook boundary.
 */
export async function readStdinJson(): Promise<HookInputSchema> {
  try {
    const input = await readStdin();
    const parsed: unknown = JSON.parse(input);

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
 * Read raw stdin text with a 30-second timeout and a 1 MiB byte cap.
 *
 * Truncation policy matches {@link readBoundedTimedStdin}: stop consuming
 * once 1 MiB has accumulated and abandon unread bytes. On timeout the
 * shared reader logs `Timeout waiting for stdin input` and exits 1.
 *
 * @returns The UTF-8 decoded retained prefix.
 * @throws The timeout error after the log and exit hook have run.
 */
export async function readStdin(): Promise<string> {
  const result = await readBoundedTimedStdin({
    stdin: stdin as AsyncIterable<Buffer>,
    maxBytes: DEFAULT_STDIN_MAX_BYTES,
    timeoutMs: STDIN_TIMEOUT_MS,
    stderr,
    exit,
    timeoutMessage: 'Timeout waiting for stdin input',
    createTimeoutError: () => new Error('Timeout waiting for stdin input'),
  });
  if (getConfig().debug) {
    logDebug(`Read ${result.length} characters from stdin`);
  }
  return result;
}

/**
 * Write structured hook output to stdout.
 */
export function outputJson(data: HookOutput): void {
  const jsonString = JSON.stringify(data, null, 2);

  if (getConfig().debug) {
    logDebug('Sending hook output:', data);
  }

  stdout.write(jsonString);
}

/**
 * Write plain text to stdout.
 */
export function outputText(message: string): void {
  if (getConfig().debug) {
    logDebug('Sending text output:', message);
  }

  stdout.write(message);
}

/**
 * Log an error to stderr.
 */
export function logError(message: string, error?: Error): void {
  const timestamp = new Date().toISOString();
  const fullMessage = error
    ? `[${timestamp}] ERROR: ${message}\n${error.stack ?? error.message}`
    : `[${timestamp}] ERROR: ${message}`;

  stderr.write(fullMessage + '\n');
}

/**
 * Log a warning to stderr when debug mode is enabled.
 */
export function logWarning(message: string): void {
  if (getConfig().debug) {
    const timestamp = new Date().toISOString();
    stderr.write(`[${timestamp}] WARNING: ${message}\n`);
  }
}

/**
 * Log debug data to stderr when debug mode is enabled.
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
 * Log an info message to stderr.
 */
export function logInfo(message: string): void {
  const timestamp = new Date().toISOString();
  stderr.write(`[${timestamp}] INFO: ${message}\n`);
}

/**
 * Normalize an unknown value to an Error instance.
 *
 * @param error - Value to normalize.
 * @returns The error if it is an Error, otherwise a new Error wrapping the value.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Check whether a value is a non-null object record.
 *
 * @param value - Value to check.
 * @returns true when the value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Read hook configuration from environment variables and cache it per process.
 * Tests can call resetConfigCache() after mutating env vars.
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
 * Clear the cached hook config for tests that mutate env vars.
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
 * Return CLAUDE_PROJECT_DIR and throw if it is unset.
 */
export function getProjectDir(): string {
  const projectDir = env['CLAUDE_PROJECT_DIR'];
  if (!projectDir) {
    throw new Error('CLAUDE_PROJECT_DIR environment variable not set');
  }
  return projectDir;
}

/**
 * Return true in development or when NODE_ENV is unset.
 */
export function isDevelopment(): boolean {
  return env['NODE_ENV'] === 'development' || env['NODE_ENV'] === undefined;
}

/**
 * Return true in common CI environments.
 */
export function isCI(): boolean {
  return (
    env['CI'] === 'true' ||
    env['GITHUB_ACTIONS'] === 'true' ||
    env['TRAVIS'] === 'true'
  );
}

/**
 * Run a hook handler with standard stdin parsing, logging, and exit codes.
 * Blocking errors exit 2; non-blocking errors exit 1.
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
 * Create an error tagged for blocking operations.
 */
export function createBlockingError(message: string): Error {
  const error = new Error(`BLOCK: ${message}`);
  error.name = 'BlockingError';
  return error;
}

/**
 * Create an error tagged for non-blocking warnings.
 */
export function createWarningError(message: string): Error {
  const error = new Error(`WARNING: ${message}`);
  error.name = 'WarningError';
  return error;
}

function normalizeFilePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

const globRegexCache = new Map<string, RegExp>();

function globToRegex(pattern: string): RegExp {
  const cacheKey = `${pattern}:${process.platform}`;

  const cached = globRegexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const normalizedPattern = normalizeFilePath(pattern);

  let regexPattern = normalizedPattern.replace(/[.+^$()|[\]{}\\]/g, '\\$&');

  regexPattern = regexPattern.replace(/\*\*/g, '___RECURSIVE_WILDCARD___');

  regexPattern = regexPattern.replace(/\*/g, '[^/]*');

  regexPattern = regexPattern.replace(/___RECURSIVE_WILDCARD___/g, '.*');

  const anchoredPattern = '^' + regexPattern + '$';

  const flags = process.platform === 'win32' ? 'i' : '';
  const regex = new RegExp(anchoredPattern, flags);

  globRegexCache.set(cacheKey, regex);

  return regex;
}

/**
 * Clear the glob regex cache for tests.
 */
export function clearGlobRegexCache(): void {
  globRegexCache.clear();
}

/**
 * Return true when a path matches a protected pattern.
 *
 * Exact matches, glob patterns, and directory prefixes are checked in that
 * order after path normalization.
 * This is a string-pattern check, not filesystem access control, and it does
 * not by itself prevent escapes from project bounds.
 *
 * @param filePath - Path to check against the configured protected patterns.
 * @returns true when the path matches a protected pattern.
 */
export function isProtectedFile(filePath: string): boolean {
  const config = getConfig();
  const protectedPatterns = config.rules?.protectedFiles ?? [];

  const normalizedFilePath = normalizeFilePath(filePath);

  return protectedPatterns.some(pattern => {
    const normalizedPattern = normalizeFilePath(pattern);

    if (normalizedPattern === normalizedFilePath) {
      return true;
    }

    if (pattern.includes('*')) {
      const regex = globToRegex(pattern);
      return regex.test(normalizedFilePath);
    }

    return (
      normalizedFilePath === normalizedPattern ||
      normalizedFilePath.startsWith(normalizedPattern + '/')
    );
  });
}

/**
 * Return true when a command contains a dangerous pattern.
 */
export function isDangerousCommand(command: string): boolean {
  const config = getConfig();
  const dangerousPatterns = config.rules?.dangerousCommands ?? [];

  return dangerousPatterns.some(pattern =>
    command.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Return true when a file extension is configured for auto-formatting.
 */
export function shouldAutoFormat(filePath: string): boolean {
  const config = getConfig();
  const formatExtensions = config.rules?.autoFormatExtensions ?? [];

  return formatExtensions.some(ext => filePath.endsWith(ext));
}

/**
 * Validate that required fields are present in hook input.
 *
 * @param input - Hook input object to validate.
 * @param requiredFields - Field names that must be present and non-null.
 * @throws Error when any required field is missing, undefined, or null.
 * @returns void
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
 * Validate that a file path is safe and within project bounds.
 *
 * @param filePath - File path to validate.
 * @throws BlockingError when path traversal (`..`) is detected.
 * Absolute paths outside `CLAUDE_PROJECT_DIR` are logged as a warning.
 * @returns void
 */
export function validateFilePath(filePath: string): void {
  if (filePath.includes('..')) {
    throw createBlockingError('Path traversal detected in file path');
  }

  const projectDir = getProjectDir();
  if (filePath.startsWith('/') && !filePath.startsWith(projectDir)) {
    logWarning(
      `File path ${filePath} is outside project directory ${projectDir}`
    );
  }
}

/**
 * Strip shell metacharacters used by simple hooks.
 *
 * @param command - Command string to sanitize.
 * @returns command with shell metacharacters stripped.
 * Removes backticks, `$`, and parentheses, collapses repeated semicolons, and
 * trims whitespace. This is not a full shell-injection sanitizer.
 */
export function sanitizeCommand(command: string): string {
  return command
    .replace(/[`$()]/g, '')
    .replace(/;+/g, ';')
    .trim();
}
