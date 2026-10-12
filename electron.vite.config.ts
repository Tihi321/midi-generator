import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { minify: 'esbuild', rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    // The AudioWorklet (audio/worklet.ts, loaded with ?worker&url) and the render Worker are bundled as ES
    // modules: addModule() and `new Worker(url, { type: 'module' })` both accept them.
    worker: { format: 'es' },
    plugins: [react()]
  }
})
