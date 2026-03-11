/**
 * Vitest configuration for @tianji/contracts package.
 * Extends root vitest.config.ts for consistent test setup.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Extend root config
		extends: '../../vitest.config.ts',

		// Package-specific settings
		name: '@tianji/contracts',

		// Test file patterns for this package
		include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],

		// Exclude patterns
		exclude: ['node_modules', 'dist'],
	},
})
