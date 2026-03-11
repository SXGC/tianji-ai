import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    name: '@tianji/runtime',
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
  },
})
