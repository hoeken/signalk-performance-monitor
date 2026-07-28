import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

// Built into ../public, which the Signal K server serves at
// /signalk-performance-monitor (via the signalk-webapp keyword).
export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(root, '..', 'public'),
    emptyOutDir: true,
  },
})
