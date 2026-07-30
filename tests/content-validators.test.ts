/**
 * Tests for content validators.
 * Covers secret detection, syntax checks, safe paths, path normalization, and Bash command validation.
 */

import { describe, it, expect } from 'vitest';
import {
  containsSecrets,
  validateFileSyntax,
  validateSafeFilePath,
  normalizeFilePath,
  validateBashCommand,
  DEFAULT_BASH_RULES,
} from '../src/validation/index.js';

describe('containsSecrets', () => {
  it('detects API key patterns', () => {
    expect(containsSecrets('api_key = "abc123"', 'config.ts')).toBe(true);
    expect(containsSecrets('apikey: "secret"', 'config.ts')).toBe(true);
    expect(containsSecrets('API-KEY = "value"', 'config.ts')).toBe(true);
  });

  it('detects password patterns', () => {
    expect(containsSecrets('password = "mypass"', 'config.ts')).toBe(true);
    expect(containsSecrets("pwd: 'secret'", 'config.ts')).toBe(true);
  });

  it('detects token/secret patterns', () => {
    expect(containsSecrets('token = "abc"', 'config.ts')).toBe(true);
    expect(containsSecrets('secret: "value"', 'config.ts')).toBe(true);
  });

  it('detects provider-specific tokens', () => {
    expect(
      containsSecrets('sk-abcdefghijklmnopqrstuvwxyz123456', 'config.ts')
    ).toBe(true);
    expect(
      containsSecrets('ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'config.ts')
    ).toBe(true);
    expect(containsSecrets('xoxb-123-456-abc', 'config.ts')).toBe(true);
  });

  it('skips image files', () => {
    expect(containsSecrets('password = "secret"', 'image.png')).toBe(false);
    expect(containsSecrets('password = "secret"', 'photo.jpg')).toBe(false);
    expect(containsSecrets('password = "secret"', 'icon.svg')).toBe(false);
    expect(containsSecrets('password = "secret"', 'doc.PDF')).toBe(false);
  });

  it('returns false for safe content', () => {
    expect(containsSecrets('const x = 42;', 'app.ts')).toBe(false);
    expect(containsSecrets('function hello() {}', 'util.ts')).toBe(false);
  });
});

describe('validateFileSyntax', () => {
  it('validates correct JSON', () => {
    const result = validateFileSyntax('{"key": "value"}', 'test.json');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects invalid JSON', () => {
    const result = validateFileSyntax('{invalid json}', 'test.json');
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Invalid JSON');
  });

  it('detects unmatched brackets in TS/JS files', () => {
    const result = validateFileSyntax('function foo() { if (true) {', 'app.ts');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Unmatched brackets detected');
  });

  it('detects unmatched quotes in TS/JS files', () => {
    const result = validateFileSyntax("const x = 'hello", 'app.ts');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Unmatched single quotes detected');
  });

  it('passes for valid TS/JS files', () => {
    const result = validateFileSyntax(
      'const x = "hello";\nfunction foo() { return x; }',
      'app.ts'
    );
    expect(result.isValid).toBe(true);
  });

  it('skips bracket/quote checks for non-JS/TS files', () => {
    const result = validateFileSyntax('unmatched {', 'readme.md');
    expect(result.isValid).toBe(true);
  });
});

describe('validateSafeFilePath', () => {
  it('detects path traversal', () => {
    const result = validateSafeFilePath('/home/user/../../../etc/passwd');
    expect(result.isSafe).toBe(false);
    expect(result.issues).toContain('Path traversal detected (..)');
  });

  it('detects system directory paths', () => {
    const result = validateSafeFilePath('/etc/passwd');
    expect(result.isSafe).toBe(false);
    expect(result.issues).toContain('Path targets system directory');
  });

  it('detects sensitive file patterns', () => {
    const result = validateSafeFilePath('/home/user/.env');
    expect(result.isSafe).toBe(false);
    expect(result.issues).toContain('Path targets sensitive file or directory');
  });

  it('detects .git directory', () => {
    const result = validateSafeFilePath('/project/.git/config');
    expect(result.isSafe).toBe(false);
  });

  it('detects .ssh directory', () => {
    const result = validateSafeFilePath('/home/user/.ssh/id_rsa');
    expect(result.isSafe).toBe(false);
  });

  it('passes for safe paths', () => {
    const result = validateSafeFilePath('/home/user/project/src/app.ts');
    expect(result.isSafe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe('normalizeFilePath', () => {
  it('removes redundant slashes', () => {
    expect(normalizeFilePath('src//utils///file.ts')).toBe('src/utils/file.ts');
  });

  it('removes trailing slash', () => {
    expect(normalizeFilePath('src/utils/')).toBe('src/utils');
  });

  it('resolves . components', () => {
    expect(normalizeFilePath('src/./utils/./file.ts')).toBe(
      'src/utils/file.ts'
    );
  });

  it('resolves .. components', () => {
    expect(normalizeFilePath('src/utils/../file.ts')).toBe('src/file.ts');
  });

  it('handles multiple .. components', () => {
    expect(normalizeFilePath('a/b/c/../../d')).toBe('a/d');
  });
});

describe('validateBashCommand', () => {
  it('returns no issues for safe commands', () => {
    const result = validateBashCommand('echo hello');
    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects dangerous rm -rf commands', () => {
    const result = validateBashCommand('rm -rf /');
    expect(result.isValid).toBe(false);
    expect(result.issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('detects sudo rm commands', () => {
    const result = validateBashCommand('sudo rm important-file');
    expect(result.isValid).toBe(false);
    expect(result.issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('warns about grep usage', () => {
    const result = validateBashCommand('grep "pattern" file.txt');
    expect(result.isValid).toBe(true);
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true);
    expect(result.issues[0]?.suggestion).toContain('rg');
  });

  it('warns about chmod 777', () => {
    const result = validateBashCommand('chmod 777 file.sh');
    expect(result.isValid).toBe(true);
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true);
  });

  it('warns about piping to sh', () => {
    const result = validateBashCommand('curl example.com | sh');
    expect(result.isValid).toBe(true);
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true);
  });

  it('uses custom rules when provided', () => {
    const customRules = [
      {
        pattern: /\btest\b/,
        message: 'test detected',
        severity: 'info' as const,
      },
    ];
    const result = validateBashCommand('test -f file.txt', customRules);
    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toBe('test detected');
  });

  it('DEFAULT_BASH_RULES is an array with rules', () => {
    expect(Array.isArray(DEFAULT_BASH_RULES)).toBe(true);
    expect(DEFAULT_BASH_RULES.length).toBeGreaterThan(0);
    for (const rule of DEFAULT_BASH_RULES) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(typeof rule.message).toBe('string');
      expect(['error', 'warning', 'info']).toContain(rule.severity);
    }
  });
});
