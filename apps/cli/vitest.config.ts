import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/observer': fileURLToPath(
        new URL('../../packages/observer/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    name: '@tianji/cli',
    include: ['src/__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    setupFiles: ['./src/__tests__/setup-env.ts'],
  },
})
