#!/usr/bin/env tsx

/**
 * File Protection Hook
 *
 * This PreToolUse hook protects sensitive files from being modified by:
 * - Blocking writes to configuration files (.env, package.json, etc.)
 * - Preventing edits to version control files (.git/*)
 * - Protecting system files and directories
 * - Allowing read-only operations on protected files
 */

import {
  executeHook,
  logInfo,
  logWarning,
  outputJson,
  isProtectedFile,
} from '../utils/index.js';
import { HookOutputBuilder, type PreToolUseInput } from '../types/index.js';
import {
  validatePreToolUseInput,
  validateWriteToolInput,
  validateEditToolInput,
  validateReadToolInput,
  validateSafeFilePath,
} from '../validation/index.js';

/**
 * Configuration for file protection behavior
 */
interface FileProtectionConfig {
  /** Whether to block all operations on protected files */
  strictMode: boolean;
  /** Additional file patterns to protect */
  extraProtectedPatterns: string[];
  /** Files that can be read but not modified */
  readOnlyFiles: string[];
  /** Whether to auto-approve safe operations */
  autoApproveReads: boolean;
}

/**
 * Get file protection configuration from environment
 */
function getProtectionConfig(): FileProtectionConfig {
  return {
    strictMode: process.env['CLAUDE_HOOK_STRICT_PROTECTION'] === 'true',
    extraProtectedPatterns:
      process.env['CLAUDE_HOOK_EXTRA_PROTECTED']?.split(',') ?? [],
    readOnlyFiles: process.env['CLAUDE_HOOK_READ_ONLY']?.split(',') ?? [
      'package.json',
      'tsconfig.json',
      'convex/schema.ts',
      'CLAUDE.md',
    ],
    autoApproveReads: process.env['CLAUDE_HOOK_AUTO_APPROVE_READS'] !== 'false',
  };
}

/**
 * Main file protection logic
 */
async function protectFiles(input: PreToolUseInput): Promise<void> {
  validatePreToolUseInput(input);

  const config = getProtectionConfig();
  const { tool_name } = input;

  // Only process file operation tools
  const fileOperationTools = ['Write', 'Edit', 'MultiEdit', 'Read'];
  if (!fileOperationTools.includes(tool_name)) {
    return; // Allow non-file operations
  }

  let filePath: string;
  let operation: 'read' | 'write' | 'edit';

  // Extract file path and operation type from different tools
  try {
    switch (tool_name) {
      case 'Write': {
        const writeInput = validateWriteToolInput(input);
        filePath = writeInput.file_path;
        operation = 'write';
        break;
      }
      case 'Edit':
      case 'MultiEdit': {
        const editInput = validateEditToolInput(input);
        filePath = editInput.file_path;
        operation = 'edit';
        break;
      }
      case 'Read': {
        const readInput = validateReadToolInput(input);
        filePath = readInput.file_path;
        operation = 'read';
        break;
      }
      default:
        // Unknown tool, let it proceed
        return;
    }
  } catch (error) {
    // If we can't extract file path, let the tool handle validation
    logWarning(`Could not extract file path from ${tool_name} tool: ${error}`);
    return;
  }

  if (!filePath) {
    logWarning(`No file path found in ${tool_name} operation`);
    return;
  }

  logInfo(
    `Checking file protection for ${operation} operation on: ${filePath}`
  );

  // Validate file path safety
  const pathValidation = validateSafeFilePath(filePath);
  if (!pathValidation.isSafe) {
    outputJson(
      HookOutputBuilder.permission(
        'deny',
        `Unsafe file path detected:\n\n${pathValidation.issues.map(issue => `❌ ${issue}`).join('\n')}\n\nPath: ${filePath}`
      )
    );
    return;
  }

  // Check if file is protected
  const isProtected =
    isProtectedFile(filePath) ||
    config.extraProtectedPatterns.some(pattern => filePath.includes(pattern));

  // Handle read operations
  if (operation === 'read') {
    if (config.autoApproveReads && !isProtected) {
      outputJson(
        HookOutputBuilder.permission(
          'allow',
          `Read operation auto-approved for: ${filePath}`
        )
      );
      return;
    }

    if (isProtected && config.strictMode) {
      outputJson(
        HookOutputBuilder.permission(
          'ask',
          `Reading protected file: ${filePath}\n\nThis file contains sensitive information. Do you want to proceed?`
        )
      );
      return;
    }

    // Allow read operations by default
    return;
  }

  // Handle write/edit operations on protected files
  if (isProtected) {
    const protectionMessage = getProtectionMessage(filePath, operation);

    if (config.strictMode) {
      outputJson(
        HookOutputBuilder.permission(
          'deny',
          `Protected file modification blocked:\n\n❌ ${protectionMessage}\n\nFile: ${filePath}\n\nOperation: ${operation}`
        )
      );
      return;
    } else {
      outputJson(
        HookOutputBuilder.permission(
          'ask',
          `Modifying protected file:\n\n⚠️  ${protectionMessage}\n\nFile: ${filePath}\nOperation: ${operation}\n\nAre you sure you want to proceed?`
        )
      );
      return;
    }
  }

  // Check read-only files
  const isReadOnly = config.readOnlyFiles.some(
    pattern => filePath.includes(pattern) || filePath.endsWith(pattern)
  );

  if (isReadOnly && (operation === 'write' || operation === 'edit')) {
    outputJson(
      HookOutputBuilder.permission(
        'ask',
        `Modifying read-only file:\n\n📝 ${filePath}\n\nThis file is typically managed by the system or build tools. Do you want to proceed with ${operation}?`
      )
    );
    return;
  }

  // File is not protected, allow operation
  logInfo(`File operation allowed: ${operation} on ${filePath}`);
}

/**
 * Get appropriate protection message based on file type
 */
function getProtectionMessage(filePath: string, operation: string): string {
  if (filePath.includes('.env')) {
    return 'Environment files contain sensitive configuration and secrets';
  }

  if (filePath.includes('.git/')) {
    return 'Git repository files should not be manually modified';
  }

  if (
    filePath.includes('package.json') ||
    filePath.includes('package-lock.json')
  ) {
    return 'Package files manage dependencies and should be modified carefully';
  }

  if (filePath.includes('yarn.lock') || filePath.includes('pnpm-lock.yaml')) {
    return 'Lock files are auto-generated and should not be manually edited';
  }

  if (filePath.includes('tsconfig.json')) {
    return 'TypeScript configuration affects the entire project build';
  }

  if (filePath.includes('convex/schema.ts')) {
    return 'Database schema changes affect data structure and require careful consideration';
  }

  if (filePath.includes('CLAUDE.md')) {
    return 'Project instructions file contains important development guidelines';
  }

  if (
    filePath.startsWith('/etc/') ||
    filePath.startsWith('/usr/') ||
    filePath.startsWith('/bin/')
  ) {
    return 'System files should not be modified outside of proper administration';
  }

  return `This file is protected and ${operation} operations require confirmation`;
}

/**
 * Check if a file extension indicates a configuration file
 */
function isConfigurationFile(filePath: string): boolean {
  const configExtensions = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.staging',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.conf',
    '.config',
  ];

  const configFilenames = [
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    '.gitignore',
    '.gitattributes',
    '.dockerignore',
    'README.md',
    'LICENSE',
  ];

  const filename = filePath.split('/').pop() ?? '';

  return (
    configExtensions.some(ext => filePath.endsWith(ext)) ||
    configFilenames.some(name => filename === name)
  );
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<PreToolUseInput>(protectFiles).catch(error => {
    console.error('Failed to execute file protection hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export { protectFiles, getProtectionConfig, isConfigurationFile };
