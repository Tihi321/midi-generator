import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { type LaunchedApp, launchApp } from './launch'

const root = path.resolve(__dirname, '../..')

let launched: LaunchedApp | undefined
let page: Page

test.beforeAll(async () => {
  test.skip(!existsSync(path.join(root, 'out/main/index.js')), 'run `yarn build` first')
  launched = await launchApp()
  page = launched.page
})

test.afterAll(async () => {
  await launched?.close()
})

const evalPage = <T>(expr: string): Promise<T> => page.evaluate<T>(expr)

test('the built app opens a window titled Chiptune Studio with the layout regions', async () => {
  await expect(page).toHaveTitle('Chiptune Studio')
  for (const id of ['transport', 'orders', 'center', 'panels']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  await expect(page.getByTestId('tab-tracker')).toBeVisible()
  await expect(page.getByTestId('tab-piano')).toBeVisible()
  for (const id of ['tab-instruments', 'tab-library', 'tab-chat']) await expect(page.getByTestId(id)).toBeVisible()
  expect(await evalPage<string>('typeof window.chiptuneStudio?.invoke')).toBe('function')
  expect(await evalPage<string>('typeof window.chiptuneStudio?.on')).toBe('function')
})

test('the centre tabs switch between Tracker and Piano Roll', async () => {
  await expect(page.getByTestId('tracker')).toBeVisible()
  await page.getByTestId('tab-piano').click()
  await expect(page.getByTestId('piano-roll')).toBeVisible()
  await expect(page.getByTestId('tracker')).toBeHidden()
  await page.getByTestId('tab-tracker').click()
  await expect(page.getByTestId('tracker')).toBeVisible()
})

test('the Chat tab renders and typing in it works', async () => {
  await page.getByTestId('tab-chat').click()
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page.getByTestId('chat-model')).toBeVisible()
  await expect(page.getByTestId('chat-send')).toBeDisabled()
  await page.getByTestId('chat-input').click()
  await page.keyboard.type('hello')
  await expect(page.getByTestId('chat-input')).toHaveValue('hello')
  await expect(page.getByTestId('chat-send')).toBeEnabled()
  await page.getByTestId('tab-instruments').click()
  await expect(page.getByTestId('instruments-panel')).toBeVisible()
})

test('Settings opens from the menu and with Ctrl+, and shows the Providers, Models and MCP tabs', async () => {
  await page.getByTestId('btn-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(page.getByTestId('settings-providers')).toBeVisible()
  await expect(page.getByTestId('provider-anthropic')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('key-input-anthropic')).toHaveAttribute('type', 'password')
  await expect(page.getByTestId('settings-data-dir')).toContainText('ChiptuneStudio')
  await page.getByTestId('settings-tab-models').click()
  await expect(page.getByTestId('settings-models')).toBeVisible()
  await page.getByTestId('settings-tab-mcp').click()
  await expect(page.getByTestId('settings-mcp')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  await page.keyboard.press('Control+,')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
})
