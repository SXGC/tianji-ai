import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/observer': fileURLToPath(new URL('../observer/src/index.ts', import.meta.url)),
      '@tianji/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
      '@tianji/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@langchain/core': fileURLToPath(
        new URL('../runtime/node_modules/@langchain/core', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    name: '@tianji/agent',
    include: ['src/**/__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
})
