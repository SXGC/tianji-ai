/**
 * Vitest configuration for @tianji/shared package.
 * Extends root vitest.config.ts for consistent test setup.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Extend root configuration
    environment: 'node',
    include: ['**/__tests__/**/*.{test,spec}.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
  },
})
