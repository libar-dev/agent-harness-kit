/**
 * Test suite for ESLint Disable Blocker Hook
 *
 * Tests pattern detection, tool type handling, and feedback messages
 */

import assert from 'node:assert';
import { describe, it, expect } from 'vitest';
import {
  containsEslintDisable,
  extractContentToCheck,
} from '../src/pre-tool-use/eslint-disable-blocker.js';
import {
  createPreToolUseInput,
  createWritePreToolUseInput,
} from './test-utils.js';

describe('ESLint Disable Blocker', () => {
  describe('Pattern Detection', () => {
    it('should detect // eslint-disable pattern', () => {
      const content = 'const x = 1;\n// eslint-disable\nconst y = 2;';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should detect // eslint-disable-next-line pattern', () => {
      const content = '// eslint-disable-next-line\nconst x = 1;';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should detect // eslint-disable-line pattern', () => {
      const content = 'const x = 1; // eslint-disable-line';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should detect /* eslint-disable */ pattern', () => {
      const content = '/* eslint-disable */\nconst x = 1;';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should detect pattern with extra whitespace', () => {
      const content = '//  eslint-disable-next-line  \nconst x = 1;';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should detect pattern case-insensitively', () => {
      const content = '// ESLINT-DISABLE\nconst x = 1;';
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should NOT detect architectural directives', () => {
      const content = `
// @architectural-directive: sequential-for-stability
// Reason: Prevents concurrency cascade
for (const id of ids) {
  const result = await ctx.db.get(id);
}`;
      expect(containsEslintDisable(content)).toBe(false);
    });

    it('should NOT detect normal comments', () => {
      const content = `
// This is a normal comment
const x = 1;
/* Another normal comment */
const y = 2;`;
      expect(containsEslintDisable(content)).toBe(false);
    });
  });

  describe('Content Extraction', () => {
    it('should extract content from Write tool', () => {
      const input = createWritePreToolUseInput(
        '/test/file.ts',
        'const x = 1;\n// eslint-disable\nconst y = 2;'
      );
      const content = extractContentToCheck(input);
      expect(content).toContain('eslint-disable');
    });

    it('should extract new_string from Edit tool', () => {
      const input = createPreToolUseInput('Edit', {
        file_path: '/test/file.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 1;\n// eslint-disable',
      });
      const content = extractContentToCheck(input);
      expect(content).toContain('eslint-disable');
    });

    it('should extract from MultiEdit tool', () => {
      const input = createPreToolUseInput('MultiEdit', {
        file_path: '/test/file.ts',
        edits: [
          {
            old_string: 'const x = 1;',
            new_string: 'const x = 1;\n// eslint-disable',
          },
          {
            old_string: 'const y = 2;',
            new_string: 'const y = 2;\n// Another edit',
          },
        ],
      });
      const content = extractContentToCheck(input);
      expect(content).toContain('eslint-disable');
    });

    it('should return null for non-file-editing tools', () => {
      const input = createPreToolUseInput('Bash', {
        command: 'echo test',
      });
      const content = extractContentToCheck(input);
      expect(content).toBeNull();
    });

    it('should return null for Write tool without content', () => {
      const input = createPreToolUseInput('Write', {
        file_path: '/test/file.ts',
      });
      const content = extractContentToCheck(input);
      expect(content).toBeNull();
    });
  });

  describe('Integration Tests', () => {
    it('should allow clean code without eslint-disable', () => {
      const input = createWritePreToolUseInput(
        '/test/file.ts',
        'const x = 1;\nconst y = 2;\n'
      );
      const content = extractContentToCheck(input);
      assert(content, 'content should be defined');
      expect(containsEslintDisable(content)).toBe(false);
    });

    it('should allow architectural directives', () => {
      const input = createWritePreToolUseInput(
        '/test/file.ts',
        `// @architectural-directive: validation-at-boundary
// Reason: Hybrid validation pattern
export const myMutation = internalAuthenticatedMutation({
  handler: async (ctx, args) => {
    return result;
  },
});`
      );
      const content = extractContentToCheck(input);
      assert(content, 'content should be defined');
      expect(containsEslintDisable(content)).toBe(false);
    });

    it('should block code with eslint-disable in Write', () => {
      const input = createWritePreToolUseInput(
        '/test/file.ts',
        `const x = 1;
// eslint-disable-next-line
const y: any = 2;`
      );
      const content = extractContentToCheck(input);
      assert(content, 'content should be defined');
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should block code with eslint-disable in Edit new_string', () => {
      const input = createPreToolUseInput('Edit', {
        file_path: '/test/file.ts',
        old_string: 'const y = 2;',
        new_string: '// eslint-disable-next-line\nconst y: any = 2;',
      });
      const content = extractContentToCheck(input);
      assert(content, 'content should be defined');
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should block code with eslint-disable in MultiEdit', () => {
      const input = createPreToolUseInput('MultiEdit', {
        file_path: '/test/file.ts',
        edits: [
          {
            old_string: 'const x = 1;',
            new_string: 'const x = 1; // Good edit',
          },
          {
            old_string: 'const y = 2;',
            new_string:
              '// eslint-disable-next-line\nconst y: any = 2; // Bad edit',
          },
        ],
      });
      const content = extractContentToCheck(input);
      assert(content, 'content should be defined');
      expect(containsEslintDisable(content)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const content = '';
      expect(containsEslintDisable(content)).toBe(false);
    });

    it('should handle content with only whitespace', () => {
      const content = '   \n\n\t\t\n   ';
      expect(containsEslintDisable(content)).toBe(false);
    });

    it('should detect pattern in middle of large file', () => {
      const content = `
${'const x = 1;\n'.repeat(100)}
// eslint-disable-next-line
const problem: any = true;
${'const y = 2;\n'.repeat(100)}
`;
      expect(containsEslintDisable(content)).toBe(true);
    });

    it('should handle malformed tool input gracefully', () => {
      const input = createPreToolUseInput('Write', {
        file_path: '/test/file.ts',
        content: null, // Invalid: should be string
      });
      const content = extractContentToCheck(input);
      expect(content).toBeNull();
    });
  });
});
