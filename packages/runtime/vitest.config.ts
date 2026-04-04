import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@tianji/observer': fileURLToPath(new URL('../observer/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    name: '@tianji/runtime',
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    root: packageRoot,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
})
