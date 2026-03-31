import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/observer': fileURLToPath(new URL('../observer/src/index.ts', import.meta.url)),
      '@tianji/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
      '@tianji/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    name: '@tianji/agent',
    include: ['src/__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
  },
})
