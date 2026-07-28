import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

// Built into ../public, which the Signal K server serves at
// /signalk-performance-monitor (via the signalk-webapp keyword).
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(root, '..', 'public'),
    emptyOutDir: true,
  },
})
