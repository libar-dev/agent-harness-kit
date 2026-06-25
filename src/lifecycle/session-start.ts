#!/usr/bin/env tsx

/**
 * Session Start Hook
 *
 * This hook runs when Claude Code sessions start and provides:
 * - Project context and recent changes information
 * - Development environment status checks
 * - Git repository information and recent commits
 * - Package.json and dependency information
 * - Custom project-specific context loading
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import {
  executeHook,
  logInfo,
  logDebug,
  logError,
  outputJson,
  getProjectDir,
  isDevelopment,
  isRecord,
  toError,
} from '../utils/index.js';
import type { SessionStartInput } from '../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * Package.json structure
 */
interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function parsePackageJson(content: string): PackageJson {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) return {};

  return {
    ...(typeof parsed['name'] === 'string' ? { name: parsed['name'] } : {}),
    ...(typeof parsed['version'] === 'string'
      ? { version: parsed['version'] }
      : {}),
    ...(typeof parsed['description'] === 'string'
      ? { description: parsed['description'] }
      : {}),
    ...(isRecord(parsed['scripts']) ? { scripts: parsed['scripts'] } : {}),
    ...(isRecord(parsed['dependencies'])
      ? { dependencies: parsed['dependencies'] }
      : {}),
    ...(isRecord(parsed['devDependencies'])
      ? { devDependencies: parsed['devDependencies'] }
      : {}),
  };
}

/**
 * Configuration for session start behavior
 */
interface SessionStartConfig {
  /** Whether to load git information */
  gitInfo: boolean;
  /** Whether to load project dependencies info */
  dependencyInfo: boolean;
  /** Whether to load recent file changes */
  recentChanges: boolean;
  /** Whether to check development server status */
  devServerStatus: boolean;
  /** Maximum number of recent commits to include */
  maxCommits: number;
  /** Maximum number of recent changes to include */
  maxChanges: number;
  /** Custom context files to load */
  contextFiles: string[];
}

/**
 * Get session start configuration
 */
function getSessionStartConfig(): SessionStartConfig {
  return {
    gitInfo: process.env['CLAUDE_HOOK_SESSION_GIT'] !== 'false',
    dependencyInfo: process.env['CLAUDE_HOOK_SESSION_DEPS'] !== 'false',
    recentChanges: process.env['CLAUDE_HOOK_SESSION_CHANGES'] !== 'false',
    devServerStatus: process.env['CLAUDE_HOOK_SESSION_DEV_STATUS'] !== 'false',
    maxCommits: parseInt(
      process.env['CLAUDE_HOOK_SESSION_MAX_COMMITS'] ?? '5',
      10
    ),
    maxChanges: parseInt(
      process.env['CLAUDE_HOOK_SESSION_MAX_CHANGES'] ?? '10',
      10
    ),
    contextFiles: process.env['CLAUDE_HOOK_CONTEXT_FILES']?.split(',') ?? [
      'README.md',
      'CLAUDE.md',
      'DEVELOPMENT.md',
      'package.json',
    ],
  };
}

/**
 * Main session start logic
 */
async function handleSessionStart(input: SessionStartInput): Promise<void> {
  const { source, session_id, model, agent_type } = input;
  const config = getSessionStartConfig();
  const projectDir = getProjectDir();
  const modelName = model ?? 'unknown';

  logInfo(`Session starting (${source}) - loading project context`);

  const contextSections: string[] = [];

  // Add basic session information
  contextSections.push(
    getSessionInfo(source, session_id, modelName, agent_type)
  );

  // Load project information
  try {
    const projectInfo = await loadProjectInfo(projectDir, config);
    if (projectInfo) {
      contextSections.push(projectInfo);
    }
  } catch (error) {
    logError('Failed to load project info', toError(error));
  }

  // Load git information
  if (config.gitInfo) {
    try {
      const gitInfo = await loadGitInfo(projectDir, config);
      if (gitInfo) {
        contextSections.push(gitInfo);
      }
    } catch (error) {
      logDebug(
        'Failed to load git info (may not be a git repository)',
        toError(error)
      );
    }
  }

  // Load dependency information
  if (config.dependencyInfo) {
    try {
      const depsInfo = await loadDependencyInfo(projectDir, config);
      if (depsInfo) {
        contextSections.push(depsInfo);
      }
    } catch (error) {
      logDebug('Failed to load dependency info', toError(error));
    }
  }

  // Check development server status
  if (config.devServerStatus && isDevelopment()) {
    try {
      const devStatus = await checkDevelopmentStatus(projectDir, config);
      if (devStatus) {
        contextSections.push(devStatus);
      }
    } catch (error) {
      logDebug('Failed to check development status', toError(error));
    }
  }

  // Load recent changes
  if (config.recentChanges) {
    try {
      const recentChanges = await loadRecentChanges(projectDir, config);
      if (recentChanges) {
        contextSections.push(recentChanges);
      }
    } catch (error) {
      logDebug('Failed to load recent changes', toError(error));
    }
  }

  // Load custom context files
  try {
    const contextFiles = await loadContextFiles(
      projectDir,
      config.contextFiles
    );
    if (contextFiles) {
      contextSections.push(contextFiles);
    }
  } catch (error) {
    logDebug('Failed to load context files', toError(error));
  }

  // Combine all context sections
  if (contextSections.length > 0) {
    const fullContext = contextSections.join('\n\n---\n\n');

    outputJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: fullContext,
      },
    });

    logInfo(`Session context loaded (${contextSections.length} sections)`);
  } else {
    logInfo('No additional context loaded');
  }
}

/**
 * Get basic session information
 */
function getSessionInfo(
  source: string,
  sessionId: string,
  model: string,
  agentType?: string
): string {
  const timestamp = new Date().toISOString();
  const shortSessionId = sessionId.substring(0, 8);

  return `# Claude Code Session Started

**Session ID:** ${shortSessionId}...
**Source:** ${source}
**Model:** ${model}
${agentType ? `**Agent Type:** ${agentType}\n` : ''}**Timestamp:** ${timestamp}
**Project:** ${getProjectDir()}
`;
}

/**
 * Load basic project information
 */
async function loadProjectInfo(
  projectDir: string,
  _config: SessionStartConfig
): Promise<string | null> {
  try {
    const packageJsonPath = join(projectDir, 'package.json');
    const packageJson = parsePackageJson(
      await readFile(packageJsonPath, 'utf-8')
    );

    const info = [
      `# Project Information`,
      `**Name:** ${packageJson.name ?? 'Unknown'}`,
      `**Version:** ${packageJson.version ?? 'Unknown'}`,
      `**Description:** ${packageJson.description ?? 'No description'}`,
    ];

    if (packageJson.scripts) {
      const importantScripts = ['dev', 'build', 'test', 'lint', 'typecheck'];
      const availableScripts = Object.keys(packageJson.scripts)
        .filter(
          script =>
            importantScripts.includes(script) ||
            script.startsWith('dev:') ||
            script.startsWith('build:')
        )
        .slice(0, 8); // Limit to most important scripts

      if (availableScripts.length > 0) {
        info.push(`**Available Scripts:** ${availableScripts.join(', ')}`);
      }
    }

    return info.join('\n');
  } catch {
    return null;
  }
}

/**
 * Load git repository information
 */
async function loadGitInfo(
  projectDir: string,
  _config: SessionStartConfig
): Promise<string | null> {
  try {
    // Get current branch
    const { stdout: branch } = await execFileAsync(
      'git',
      ['branch', '--show-current'],
      {
        cwd: projectDir,
        timeout: 5000,
      }
    );

    // Get recent commits
    const { stdout: commits } = await execFileAsync(
      'git',
      ['log', `--oneline`, `-${_config.maxCommits}`, '--no-merges'],
      {
        cwd: projectDir,
        timeout: 5000,
      }
    );

    // Get repository status
    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      {
        cwd: projectDir,
        timeout: 5000,
      }
    );

    const info = [
      `# Git Repository Information`,
      `**Current Branch:** ${branch.trim()}`,
    ];

    if (status.trim()) {
      const statusLines = status.trim().split('\n');
      info.push(
        `**Uncommitted Changes:** ${statusLines.length} files modified`
      );

      // Show first few changed files
      const changedFiles = statusLines
        .slice(0, 5)
        .map(line => `  - ${line.substring(3)}`)
        .join('\n');
      info.push(`**Changed Files:**\n${changedFiles}`);

      if (statusLines.length > 5) {
        info.push(`  ... and ${statusLines.length - 5} more files`);
      }
    } else {
      info.push(`**Status:** Working tree clean`);
    }

    if (commits.trim()) {
      info.push(
        `**Recent Commits:**\n${commits
          .trim()
          .split('\n')
          .map(line => `  - ${line}`)
          .join('\n')}`
      );
    }

    return info.join('\n');
  } catch {
    return null;
  }
}

/**
 * Load dependency information
 */
async function loadDependencyInfo(
  projectDir: string,
  _config: SessionStartConfig
): Promise<string | null> {
  try {
    const packageJsonPath = join(projectDir, 'package.json');
    const packageJson = parsePackageJson(
      await readFile(packageJsonPath, 'utf-8')
    );

    const info = [`# Dependencies Information`];

    if (packageJson.dependencies) {
      const depCount = Object.keys(packageJson.dependencies).length;
      info.push(`**Production Dependencies:** ${depCount}`);

      // Highlight key dependencies
      const keyDeps = Object.keys(packageJson.dependencies).filter(
        dep =>
          dep.includes('react') ||
          dep.includes('next') ||
          dep.includes('convex') ||
          dep.includes('typescript') ||
          dep.includes('zod')
      );

      if (keyDeps.length > 0) {
        info.push(`**Key Dependencies:** ${keyDeps.slice(0, 5).join(', ')}`);
      }
    }

    if (packageJson.devDependencies) {
      const devDepCount = Object.keys(packageJson.devDependencies).length;
      info.push(`**Development Dependencies:** ${devDepCount}`);
    }

    // Check if node_modules exists and when it was last modified
    try {
      const nodeModulesPath = join(projectDir, 'node_modules');
      await access(nodeModulesPath, constants.F_OK);
      info.push(`**Node Modules:** Present`);
    } catch {
      info.push(`**Node Modules:** Missing (run npm install)`);
    }

    return info.join('\n');
  } catch {
    return null;
  }
}

/**
 * Check development environment status
 */
async function checkDevelopmentStatus(
  projectDir: string,
  _config: SessionStartConfig
): Promise<string | null> {
  try {
    const info = [`# Development Environment`];

    // Check if TypeScript is configured
    try {
      await access(join(projectDir, 'tsconfig.json'), constants.F_OK);
      info.push(`**TypeScript:** Configured`);
    } catch {
      info.push(`**TypeScript:** Not configured`);
    }

    // Check if ESLint is configured
    try {
      await access(join(projectDir, '.eslintrc.js'), constants.F_OK);
      info.push(`**ESLint:** Configured`);
    } catch {
      try {
        await access(join(projectDir, 'eslint.config.js'), constants.F_OK);
        info.push(`**ESLint:** Configured (flat config)`);
      } catch {
        info.push(`**ESLint:** Not configured`);
      }
    }

    // Check if Prettier is configured
    try {
      await access(join(projectDir, '.prettierrc'), constants.F_OK);
      info.push(`**Prettier:** Configured`);
    } catch {
      info.push(`**Prettier:** Not configured`);
    }

    return info.join('\n');
  } catch {
    return null;
  }
}

/**
 * Load custom context files
 */
async function loadRecentChanges(
  projectDir: string,
  _config: SessionStartConfig
): Promise<string | null> {
  try {
    // Get recently modified files from git
    const { stdout: recentFiles } = await execFileAsync(
      'git',
      ['diff', '--name-only', 'HEAD~1'],
      {
        cwd: projectDir,
        timeout: 5000,
      }
    );

    if (recentFiles.trim()) {
      const files = recentFiles.trim().split('\n').slice(0, _config.maxChanges);
      const info = [
        `# Recent Changes`,
        `**Files Changed Since Last Commit:**`,
        ...files.map(file => `  - ${file}`),
      ];

      return info.join('\n');
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Load custom context files
 */
async function loadContextFiles(
  projectDir: string,
  contextFiles: string[]
): Promise<string | null> {
  const loadedFiles: string[] = [];

  for (const fileName of contextFiles) {
    try {
      const filePath = join(projectDir, fileName);
      await access(filePath, constants.F_OK);

      const content = await readFile(filePath, 'utf-8');

      // Limit content length to avoid overwhelming the context
      const truncatedContent =
        content.length > 1000
          ? content.substring(0, 1000) + '\n\n... (truncated)'
          : content;

      loadedFiles.push(`## ${fileName}\n\n${truncatedContent}`);
    } catch {
      // File doesn't exist or can't be read, skip it
      continue;
    }
  }

  if (loadedFiles.length > 0) {
    return `# Context Files\n\n${loadedFiles.join('\n\n---\n\n')}`;
  }

  return null;
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<SessionStartInput>(handleSessionStart).catch(error => {
    console.error('Failed to execute session start hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export {
  handleSessionStart,
  getSessionStartConfig,
  loadProjectInfo,
  loadGitInfo,
  loadDependencyInfo,
};
