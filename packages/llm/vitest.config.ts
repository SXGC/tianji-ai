/**
 * Vitest configuration for @tianji/llm package.
 * Extends root vitest.config.ts for consistent test setup.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Package-specific settings
		environment: 'node',
		name: '@tianji/llm',

		// Test file patterns for this package
		include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],

		// Exclude patterns
		exclude: ['node_modules', 'dist'],

		// Enable globals for describe, it, expect
		globals: true,
	},
})
