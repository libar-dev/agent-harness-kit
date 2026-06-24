import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // Explicitly set root to this directory to avoid parent config conflicts
  root: resolve(__dirname || import.meta.dirname || process.cwd()),

  test: {
    // Use Node.js environment for testing hook utilities
    environment: 'node',

    // Include test files
    include: ['tests/**/*.test.ts'],

    // Test timeout (prevent hanging)
    testTimeout: 10000,

    // Hook timeout
    hookTimeout: 10000,

    // Enable Vitest v4 typecheck integration alongside runtime tests
    typecheck: {
      enabled: true,
      checker: 'tsc',
      include: ['tests/**/*.test.ts'],
      tsconfig: './tsconfig.json',
    },

    // Mock reset behavior
    clearMocks: true,
    restoreMocks: true,

    // Coverage configuration (optional)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'tests/**/*'],
    },

    // Disable globals to avoid conflicts
    globals: false,
  },

  // ESBuild configuration for TypeScript
  esbuild: {
    target: 'es2022',
  },
});
