import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    name: '@tianji/observer',
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*-types.test.ts'],
    globals: true,
  },
})
