// Live check of Chiptune Studio on the ACP proxy (MDI-08), through the real Electron app: Settings > Models, the add-provider form and the
// agent chat. Needs the proxy running on 127.0.0.1:7461. Gated: `ACP_LIVE=1 yarn playwright test --config playwright.electron.config.ts acp-live`.
// The app gets an isolated data folder holding a COPY of ~/ChiptuneStudio/config, so the real config is never written.
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type LaunchedApp, launchApp, projectRoot } from './launch'

const PROXY = 'http://127.0.0.1:7461/v1'
const RUNS = [
  { ref: 'acp/codex/gpt-5.6-luna', timeout: 420_000 },
  { ref: 'acp/antigravity/gemini-3.8-flash', timeout: 420_000 }
]
const TASK =
  'Compose an 8-bar chiptune melody in C major at 120 bpm: set the tempo, then write the notes into the first channel of the song with your tools. Use the tools, do not just describe it.'

test.skip(process.env.ACP_LIVE !== '1', 'set ACP_LIVE=1 (needs the ACP proxy on 127.0.0.1:7461)')
test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
let page: Page
const timings: string[] = []
const lap = (name: string, t0: number): void => {
  timings.push(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

test.beforeAll(async () => {
  test.skip(!existsSync(path.join(projectRoot, 'out/main/index.js')), 'run `yarn build` first')
  const r = await fetch(`${PROXY}/models`)
  const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id)
  expect(ids.length).toBeGreaterThan(0)
  expect(ids.filter((i) => !i.includes('/')), 'the proxy still lists unprefixed ids').toEqual([])
  launched = await launchApp({ configFrom: path.join(os.homedir(), 'ChiptuneStudio', 'config') })
  page = launched.page
  page.on('dialog', (d) => void d.accept())
  await expect.poll(() => page.evaluate<boolean>('!!window.__chiptuneStudio'), { timeout: 30000 }).toBe(true)
  await page.getByTestId('tab-chat').click()
})

test.afterAll(async () => {
  console.log(`ACP LIVE TIMINGS\n${timings.join('\n')}`)
  await launched?.close()
})

const openModels = async (): Promise<void> => {
  await page.getByTestId('btn-settings').click()
  await page.getByTestId('settings-tab-models').click()
  await expect(page.getByTestId('settings-models')).toBeVisible()
}
const closeSettings = async (): Promise<void> => {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
}
const chatOptions = (): Promise<string[]> => page.getByTestId('chat-model').locator('option').evaluateAll((o) => o.map((x) => (x as { value: string }).value))
/** The checkbox is controlled by the saved overview, so click it and wait for the saved state. */
const tick = async (ref: string): Promise<void> => {
  const box = page.getByTestId(`models-row-${ref}`).locator('input[type=checkbox]')
  await box.click()
  await expect(box).toBeChecked({ timeout: 15000 })
}
/** Every note of the live song as one string: a run that writes notes changes it (a second run may rewrite the first one's notes). */
const notes = (): Promise<string[]> =>
  page.evaluate<string[]>(
    `(() => { const out = []; for (const [k, p] of window.__chiptuneStudio.session.song.patterns) p.rows.forEach((c, i) => { if (c && c.note != null) out.push(k + '@' + i + '=' + c.note) }); return out })()`
  )

test('a) Settings > Models shows acp and its prefixed models only', async () => {
  const t0 = Date.now()
  await openModels()
  await page.getByTestId('models-provider-acp').click()
  await expect(page.getByTestId('models-provider-name')).toHaveText('ACP proxy')
  if ((await page.getByTestId('models-toggle-provider').textContent())?.trim() === 'Enable') await page.getByTestId('models-toggle-provider').click()
  await expect(page.getByTestId('models-toggle-provider')).toHaveText('Disable')
  await page.getByTestId('models-detect').click()
  await expect(page.getByTestId(`models-row-${RUNS[0]!.ref}`)).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId(`models-row-${RUNS[1]!.ref}`)).toBeVisible()
  const ids = await page.getByTestId('models-list').locator('.model-id').allTextContents()
  expect(ids.length).toBeGreaterThanOrEqual(2)
  expect(ids.filter((i) => !i.includes('/')), 'unprefixed duplicate ids').toEqual([])
  expect(new Set(ids).size).toBe(ids.length)
  for (const r of RUNS) await tick(r.ref)
  await closeSettings()
  const opts = await chatOptions()
  for (const r of RUNS) expect(opts).toContain(r.ref)
  lap('a) settings shows acp', t0)
})

test('b) add a custom provider through the form, test, detect, remove: the chat selector stays valid', async () => {
  const t0 = Date.now()
  await openModels()
  await page.getByTestId('models-add-provider').click()
  await page.getByTestId('provider-name').fill('acp-e2e')
  await page.getByTestId('provider-url').fill(PROXY)
  await page.getByTestId('provider-concurrency').fill('1')
  const schema = page.getByTestId('provider-json-schema')
  if (await schema.isChecked()) await schema.uncheck()
  await page.getByTestId('provider-test').click()
  await expect(page.getByTestId('provider-test-result')).toContainText('Reachable', { timeout: 20000 })
  await page.getByTestId('provider-save').click()
  await expect(page.getByTestId('models-provider-acp-e2e')).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('models-provider-name')).toHaveText('acp-e2e')
  await page.getByTestId('models-detect').click()
  const row = page.getByTestId('models-row-acp-e2e/codex/gpt-5.6-luna')
  await expect(row).toBeVisible({ timeout: 30000 })
  await tick('acp-e2e/codex/gpt-5.6-luna')
  await closeSettings()
  // choose the custom provider's model in the chat, then remove the provider: the selection must fall back to a valid option
  await page.getByTestId('chat-model').selectOption('acp-e2e/codex/gpt-5.6-luna')
  await expect(page.getByTestId('chat-model')).toHaveValue('acp-e2e/codex/gpt-5.6-luna')
  await openModels()
  await page.getByTestId('models-provider-acp-e2e').click()
  await page.getByTestId('models-remove-provider').click()
  await expect(page.getByTestId('models-provider-acp-e2e')).toHaveCount(0, { timeout: 20000 })
  await closeSettings()
  const opts = await chatOptions()
  expect(opts.some((o) => o.startsWith('acp-e2e/'))).toBe(false)
  const value = await page.getByTestId('chat-model').inputValue()
  expect(opts, `chat selector holds a dead value "${value}"`).toContain(value)
  const saved = JSON.parse(await readFile(path.join(launched.home, 'config', 'app.json'), 'utf8')) as { selectedModel: string | null }
  expect(saved.selectedModel?.startsWith('acp-e2e/') ?? false).toBe(false)
  lap('b) custom provider add/test/detect/remove', t0)
})

for (const run of RUNS) {
  test(`c) agent run on ${run.ref}`, async () => {
    test.setTimeout(run.timeout + 60_000)
    const t0 = Date.now()
    await page.getByTestId('tab-chat').click()
    await page.getByTestId('chat-new').click()
    await page.getByTestId('chat-model').selectOption(run.ref)
    const before = await notes()
    await page.getByTestId('chat-input').fill(TASK)
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('chat-stop')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: run.timeout })
    const err = await page.getByTestId('chat-error').allTextContents()
    const tools = await page.getByTestId('tool-card').count()
    const reply = (await page.getByTestId('chat-assistant').allTextContents()).join('\n').slice(0, 400)
    const cards = await page.getByTestId('tool-card').evaluateAll((els) => els.map((e) => `${e.className}: ${(e.textContent ?? '').slice(0, 300)}`))
    console.log(`TOOLS ${cards.join(' || ')}`)
    console.log(`RUN ${run.ref}: tool cards ${tools}, notes before ${before.length}, notes after ${(await notes()).length}, reply: ${reply}`)
    expect(err, `agent errors: ${err.join(' | ')}`).toEqual([])
    expect(tools).toBeGreaterThan(0)
    const after = await notes()
    expect(after.length).toBeGreaterThan(0)
    expect(after).not.toEqual(before)
    lap(`c) agent ${run.ref} (${tools} tool calls)`, t0)
  })
}
