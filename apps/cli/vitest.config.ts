import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    name: '@tianji/cli',
    include: ['src/__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    setupFiles: ['./src/__tests__/setup-env.ts'],
  },
})
