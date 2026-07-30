#!/usr/bin/env tsx

/**
 * UserPromptSubmit Hook Handler — Validates prompts and adds context before processing.
 */

import {
  executeHook,
  logInfo,
  logDebug,
  logWarning,
  outputJson,
  getProjectDir,
  isRecord,
  toError,
} from '../utils/index.js';
import {
  HookOutputBuilder,
  type UserPromptSubmitInput,
} from '../types/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Configuration for prompt validation
 */
interface PromptValidationConfig {
  /** Whether to check for secrets in prompts */
  checkSecrets: boolean;
  /** Whether to add contextual information */
  addContext: boolean;
  /** Whether to validate prompt structure */
  validateStructure: boolean;
  /** Whether to check for injection attempts */
  checkInjection: boolean;
  /** Maximum prompt length */
  maxLength: number;
  /** Context enhancement patterns */
  contextPatterns: Array<{
    pattern: RegExp;
    context: string | (() => Promise<string>);
  }>;
}

/**
 * Get prompt validation configuration
 */
function getPromptValidationConfig(): PromptValidationConfig {
  return {
    checkSecrets: process.env['CLAUDE_HOOK_CHECK_SECRETS'] !== 'false',
    addContext: process.env['CLAUDE_HOOK_ADD_CONTEXT'] !== 'false',
    validateStructure: process.env['CLAUDE_HOOK_VALIDATE_STRUCTURE'] === 'true',
    checkInjection: process.env['CLAUDE_HOOK_CHECK_INJECTION'] !== 'false',
    maxLength: parseInt(
      process.env['CLAUDE_HOOK_MAX_PROMPT_LENGTH'] ?? '10000',
      10
    ),
    contextPatterns: [
      {
        pattern: /convex.*schema/i,
        context: async () => await loadConvexSchemaContext(),
      },
      {
        pattern: /package\.json|npm.*script/i,
        context: async () => await loadPackageJsonContext(),
      },
      {
        pattern: /typescript|\.ts|tsconfig/i,
        context:
          'TypeScript project detected. Remember to run `npm run typecheck` after changes.',
      },
      {
        pattern: /test|testing|spec/i,
        context: 'Testing context: Use `npm run test:once` to run tests.',
      },
      {
        pattern: /git|commit|branch/i,
        context: async () => await loadGitContext(),
      },
      {
        pattern: /error|bug|fix|debug/i,
        context: async () => await loadDebuggingContext(),
      },
    ],
  };
}

/**
 * Main prompt validation logic
 */
async function validateUserPrompt(input: UserPromptSubmitInput): Promise<void> {
  const { prompt, session_id: _session_id } = input;
  const config = getPromptValidationConfig();

  logInfo(`Validating user prompt (${prompt.length} characters)`);

  const validationResults = {
    blocked: false,
    warnings: [] as string[],
    addedContext: [] as string[],
    blockReason: '',
  };

  // Check prompt length
  if (prompt.length > config.maxLength) {
    validationResults.blocked = true;
    validationResults.blockReason = `Prompt too long (${prompt.length} characters, max: ${config.maxLength}). Please shorten your request.`;
  }

  // Check for secrets if not already blocked
  if (!validationResults.blocked && config.checkSecrets) {
    const secretsCheck = await checkForSecrets(prompt);
    if (secretsCheck.hasSecrets) {
      validationResults.blocked = true;
      validationResults.blockReason = `Security violation: Prompt contains potential secrets or sensitive information. Please remove: ${secretsCheck.issues.join(', ')}`;
    }
  }

  // Check for injection attempts if not already blocked
  if (!validationResults.blocked && config.checkInjection) {
    const injectionCheck = checkForInjection(prompt);
    if (injectionCheck.suspicious) {
      validationResults.warnings.push(
        `⚠️  Prompt contains patterns similar to injection attempts: ${injectionCheck.issues.join(', ')}`
      );

      // Injection matches warn by default; CLAUDE_HOOK_BLOCK_INJECTION upgrades them to blocks.
      if (process.env['CLAUDE_HOOK_BLOCK_INJECTION'] === 'true') {
        validationResults.blocked = true;
        validationResults.blockReason = `Security: Potential prompt injection detected. Please rephrase your request.`;
      }
    }
  }

  // Validate prompt structure if requested
  if (config.validateStructure) {
    const structureCheck = validatePromptStructure(prompt);
    if (structureCheck.issues.length > 0) {
      validationResults.warnings.push(...structureCheck.issues);
    }
  }

  // Add contextual information if not blocked
  if (!validationResults.blocked && config.addContext) {
    const contextualInfo = await addContextualInformation(prompt, config);
    if (contextualInfo.length > 0) {
      validationResults.addedContext.push(...contextualInfo);
    }
  }

  // Process results
  if (validationResults.blocked) {
    // Block the prompt
    outputJson(HookOutputBuilder.blockPrompt(validationResults.blockReason));
    logWarning(`Prompt blocked: ${validationResults.blockReason}`);
    return;
  }

  // Provide context and warnings if any
  if (
    validationResults.addedContext.length > 0 ||
    validationResults.warnings.length > 0
  ) {
    const contextMessage = [
      ...validationResults.warnings,
      ...validationResults.addedContext,
    ].join('\n\n');

    outputJson(HookOutputBuilder.addContext(contextMessage));
    logInfo(
      `Added context to prompt: ${validationResults.addedContext.length} items, ${validationResults.warnings.length} warnings`
    );
  }

  logDebug('Prompt validation completed - allowing prompt to proceed');
}

/**
 * Check for potential secrets in the prompt
 */
async function checkForSecrets(
  prompt: string
): Promise<{ hasSecrets: boolean; issues: string[] }> {
  const issues: string[] = [];

  const secretPatterns = [
    {
      pattern: /(?:password|pwd)\s*[=:]\s*["']?\w{3,}["']?/i,
      message: 'Password detected',
    },
    {
      pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?\w{10,}["']?/i,
      message: 'API key detected',
    },
    {
      pattern: /(?:secret|token)\s*[=:]\s*["']?\w{10,}["']?/i,
      message: 'Secret/token detected',
    },
    {
      pattern: /sk-[a-zA-Z0-9]{32,}/,
      message: 'OpenAI API key detected',
    },
    {
      pattern: /ghp_[a-zA-Z0-9]{36}/,
      message: 'GitHub token detected',
    },
    {
      pattern: /xoxb-[a-zA-Z0-9-]+/,
      message: 'Slack token detected',
    },
    {
      pattern: /AKIA[0-9A-Z]{16}/,
      message: 'AWS access key detected',
    },
    {
      pattern: /(?:mysql|postgres|mongodb):\/\/[^\s]+:[^\s]+@/i,
      message: 'Database connection string detected',
    },
  ];

  for (const { pattern, message } of secretPatterns) {
    if (pattern.test(prompt)) {
      issues.push(message);
    }
  }

  return {
    hasSecrets: issues.length > 0,
    issues,
  };
}

/**
 * Check for potential prompt injection attempts
 */
function checkForInjection(prompt: string): {
  suspicious: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  const injectionPatterns = [
    {
      pattern:
        /ignore\s+(?:previous|all|above)\s+(?:instructions?|prompts?|context)/i,
      message: 'Instruction override attempt',
    },
    {
      pattern: /you\s+are\s+now\s+(?:a|an)\s+\w+/i,
      message: 'Role override attempt',
    },
    {
      pattern: /(?:system|admin|root)\s*:\s*(?:ignore|override|disable)/i,
      message: 'System override attempt',
    },
    {
      pattern: /(?:execute|run|eval)\s*\(/i,
      message: 'Code execution attempt',
    },
    {
      pattern: /\$\{[^}]+\}/,
      message: 'Template injection pattern',
    },
    {
      pattern: /<script[^>]*>/i,
      message: 'Script injection attempt',
    },
  ];

  for (const { pattern, message } of injectionPatterns) {
    if (pattern.test(prompt)) {
      issues.push(message);
    }
  }

  return {
    suspicious: issues.length > 0,
    issues,
  };
}

/**
 * Validate prompt structure and provide suggestions
 */
function validatePromptStructure(prompt: string): { issues: string[] } {
  const issues: string[] = [];

  // Check for very short prompts that might need more context
  if (prompt.trim().length < 10) {
    issues.push(
      '💡 Very short prompt - consider adding more context for better results'
    );
  }

  // Check for very long single sentences
  const sentences = prompt.split(/[.!?]+/);
  const longSentences = sentences.filter(s => s.length > 200);
  if (longSentences.length > 0) {
    issues.push(
      '💡 Consider breaking long sentences into shorter, clearer statements'
    );
  }

  // Check for excessive repetition
  const words = prompt.toLowerCase().split(/\s+/);
  const wordCounts = words.reduce((acc: Record<string, number>, word) => {
    acc[word] = (acc[word] ?? 0) + 1;
    return acc;
  }, {});

  const repeatedWords = Object.entries(wordCounts)
    .filter(([word, count]) => count > 5 && word.length > 3)
    .map(([word]) => word);

  if (repeatedWords.length > 0) {
    issues.push(
      `💡 Repeated words detected (${repeatedWords.join(', ')}) - consider varying your language`
    );
  }

  return { issues };
}

/**
 * Add contextual information based on prompt content
 */
async function addContextualInformation(
  prompt: string,
  config: PromptValidationConfig
): Promise<string[]> {
  const contextItems: string[] = [];

  // Check prompt against context patterns
  for (const { pattern, context } of config.contextPatterns) {
    if (pattern.test(prompt)) {
      try {
        const contextText =
          typeof context === 'string' ? context : await context();
        if (contextText) {
          contextItems.push(contextText);
        }
      } catch (error) {
        logDebug(
          `Failed to load context for pattern ${pattern}:`,
          toError(error)
        );
      }
    }
  }

  // Add timestamp context
  if (
    prompt.toLowerCase().includes('today') ||
    prompt.toLowerCase().includes('now')
  ) {
    contextItems.push(`📅 Current timestamp: ${new Date().toISOString()}`);
  }

  // Add project-specific context hints
  if (
    prompt.toLowerCase().includes('claude.md') ||
    prompt.toLowerCase().includes('instructions')
  ) {
    contextItems.push(
      `📋 Project instructions are available in CLAUDE.md file`
    );
  }

  return contextItems;
}

/**
 * Load Convex schema context
 */
async function loadConvexSchemaContext(): Promise<string> {
  try {
    const projectDir = getProjectDir();
    const schemaPath = join(projectDir, 'convex', 'schema.ts');
    const schemaContent = await readFile(schemaPath, 'utf-8');

    // Extract table names from schema
    const tableMatches = schemaContent.match(/(\w+):\s*defineTable/g);
    const tables =
      tableMatches?.map(match =>
        match.replace(':', '').replace('defineTable', '').trim()
      ) ?? [];

    return `🗄️  Convex Schema Context: Available tables: ${tables.join(', ')}. Remember to run \`npm run sync\` after schema changes.`;
  } catch {
    return '🗄️  Convex schema file not found or inaccessible.';
  }
}

function parsePackageJsonScripts(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !isRecord(parsed['scripts'])) return {};
  return parsed['scripts'];
}

/**
 * Load package.json context
 */
async function loadPackageJsonContext(): Promise<string> {
  try {
    const projectDir = getProjectDir();
    const packagePath = join(projectDir, 'package.json');
    const scripts = Object.keys(
      parsePackageJsonScripts(await readFile(packagePath, 'utf-8'))
    );
    const importantScripts = scripts.filter(
      script =>
        ['dev', 'build', 'test', 'lint', 'typecheck', 'check', 'fix'].includes(
          script
        ) ||
        script.startsWith('dev:') ||
        script.startsWith('test:')
    );

    return `📦 Package.json Context: Available scripts: ${importantScripts.join(', ')}`;
  } catch {
    return '📦 Package.json not found or inaccessible.';
  }
}

/**
 * Load git context
 */
async function loadGitContext(): Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const projectDir = getProjectDir();
    const { stdout: branch } = await execFileAsync(
      'git',
      ['branch', '--show-current'],
      {
        cwd: projectDir,
        timeout: 3000,
      }
    );

    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      {
        cwd: projectDir,
        timeout: 3000,
      }
    );

    const statusCount = status.trim() ? status.trim().split('\n').length : 0;

    return `🌿 Git Context: Current branch: ${branch.trim()}, ${statusCount} uncommitted changes`;
  } catch {
    return '🌿 Git context not available (may not be a git repository)';
  }
}

/**
 * Load debugging context
 */
async function loadDebuggingContext(): Promise<string> {
  const debuggingTips = [
    '🐛 Debugging Context: Available commands for troubleshooting:',
    '• `npm run check` - Fast validation',
    '• `npm run test:once` - Run tests',
    '• `npm run lint` - Check code quality',
    '• Check browser console for client-side errors',
    '• Use `console.log()` for debugging output',
  ];

  return debuggingTips.join('\n');
}

/**
 * Main execution entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  executeHook<UserPromptSubmitInput>(validateUserPrompt).catch(error => {
    console.error('Failed to execute user prompt validation hook:', error);
    process.exit(1);
  });
}

// Export for use in other hooks
export {
  validateUserPrompt,
  getPromptValidationConfig,
  checkForSecrets,
  checkForInjection,
  addContextualInformation,
};
