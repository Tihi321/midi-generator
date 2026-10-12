import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the stdio->HTTP MCP shim to out/mcp-stdio/index.js (CommonJS, runs with plain Node).
// Dependencies stay external (ssr build), so node_modules must be present next to the repo.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/mcp-stdio/index.ts'),
    outDir: 'out/mcp-stdio',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'index.js' }
    }
  },
  ssr: { target: 'node', noExternal: [] }
})
