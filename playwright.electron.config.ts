import { defineConfig } from '@playwright/test'

/**
 * Smoke test of the real app: Electron main, preload and the renderer.
 * Run `yarn build` first. `yarn test:electron` does both.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '.claude/temp/pw-results-electron'
})
