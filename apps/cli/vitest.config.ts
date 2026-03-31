import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@tianji/agent': fileURLToPath(new URL('../../packages/agent/src/index.ts', import.meta.url)),
      '@tianji/observer': fileURLToPath(
        new URL('../../packages/observer/src/index.ts', import.meta.url)
      ),
      '@tianji/runtime': fileURLToPath(
        new URL('../../packages/runtime/src/index.ts', import.meta.url)
      ),
      '@tianji/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
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
