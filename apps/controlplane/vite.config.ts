import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname, 'src/web'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: false,
  },
})
