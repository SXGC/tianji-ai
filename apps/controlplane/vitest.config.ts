import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/observer': fileURLToPath(
        new URL('../../packages/observer/src/index.ts', import.meta.url)
      ),
      '@tianji/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    name: '@tianji/controlplane',
    include: ['src/**/__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    root: packageRoot,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
})
