/**
 * Root Vitest configuration - base config for package inheritance.
 * Packages should extend this config using `defineConfig` with `extends: './vitest.config.ts'`.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node test environment for backend packages
    environment: 'node',

    // Test file patterns - matches __tests__ directories and .test./.spec. files
    include: ['**/__tests__/**/*.{test,spec}.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],

    // Exclude patterns - node_modules, dist, and common non-test directories
    exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/coverage/**'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['**/src/**/*.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/types/**',
      ],
    },

    // Global test APIs (describe, it, expect, etc.)
    globals: true,
  },
})
