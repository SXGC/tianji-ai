import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname, 'src/web'),
  resolve: {
    mainFields: ['module', 'browser', 'main'],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: false,
    commonjsOptions: {
      defaultIsModuleExports: true,
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    include: ['fast-json-patch', '@ag-ui/client', '@copilotkit/react-core', '@copilotkit/react-ui'],
    esbuildOptions: {
      mainFields: ['module', 'main'],
    },
  },
})
