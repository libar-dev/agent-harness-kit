// eslint.config.mjs for Claude Code Hooks
// Focused on experimental development with basic quality control
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const nodeBuiltinModules = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'test',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

const useNodeProtocolMessage =
  'Use the node: protocol for Node.js built-in imports.';

const nodeBuiltinImportRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: nodeBuiltinModules.map(name => ({
        name,
        message: useNodeProtocolMessage,
      })),
    },
  ],
  'no-restricted-syntax': [
    'error',
    ...nodeBuiltinModules.map(name => ({
      selector: `ImportExpression[source.value='${name}']`,
      message: useNodeProtocolMessage,
    })),
  ],
};

export default [
  {
    // Ignore build and dependency directories
    ignores: [
      'node_modules/',
      'dist/',
      '**/*.d.ts',
      'examples/**/node_modules/',
    ],
  },
  {
    rules: nodeBuiltinImportRules,
  },
  {
    // Main configuration for TypeScript files
    files: ['src/**/*.ts', 'src/**/*.tsx', 'examples/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      // Prettier integration
      'prettier/prettier': 'error',
      ...prettierConfig.rules,

      // Enhanced TypeScript rules following parent project standards
      '@typescript-eslint/no-unused-vars': [
        'warn', // Only warn, don't error for scaffolding code
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_|^[A-Z]', // Allow unused constants and underscore prefixed
          ignoreRestSiblings: true,
        },
      ],
      
      // CRITICAL: NO ANY TYPES EVER (Parent project rule)
      '@typescript-eslint/no-explicit-any': 'error', // NO ANY, EVER! 🚫
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'warn',
      
      // Type safety improvements from parent project
      '@typescript-eslint/explicit-function-return-type': 'off', // Too strict for experimentation
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn', // Parent allows with caution
      '@typescript-eslint/strict-boolean-expressions': [
        'warn',
        {
          allowString: true,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowNullableString: true,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      
      // Schema-first validation enforcement (inspired by parent)
      '@typescript-eslint/no-empty-object-type': [
        'error',
        {
          allowInterfaces: 'never',
          allowObjectTypes: 'never',
        },
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            object: {
              message: 'Use Record<string, unknown> instead',
            },
          },
        },
      ],
      '@typescript-eslint/no-unsafe-function-type': 'error',

      // Basic code quality - keep these for safety
      'no-debugger': 'error',
      'no-console': ['warn', { allow: ['error'] }], // console.error is valid in hook entry points (stderr)
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': 'error',
      'no-duplicate-imports': 'error',
      
      // Async/Promise handling
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      
      // Disable project-specific rules that don't apply to hooks
      // (These would error if they were imported, but they're not in our plugins)
    },
  },
  {
    // CLI entry points talk to the user via stdout/stderr — console is the
    // intended interface for them.
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Even more relaxed rules for examples and tests (but still NO ANY!)
    files: ['examples/**/*.ts', 'tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off', // Completely off for examples
      '@typescript-eslint/no-explicit-any': 'error', // NO ANY, EVER! Even in tests! 🚫
      '@typescript-eslint/no-unsafe-assignment': 'warn', // Warn in tests (more lenient)
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-type-assertion': 'warn',
      'no-console': 'off', // Examples should be able to use console
    },
  },
];
