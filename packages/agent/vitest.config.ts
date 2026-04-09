import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 更具体的 subpath 必须放在前面,否则 vite 的前缀匹配会先命中 '@langchain/core'。
      // @langchain/core 的 ./testing exports 在 dist 子目录下,不能依靠根目录前缀替换 resolve。
      '@langchain/core/testing': fileURLToPath(
        new URL('../runtime/node_modules/@langchain/core/dist/testing/index.js', import.meta.url)
      ),
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
