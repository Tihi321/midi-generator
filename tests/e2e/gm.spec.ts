// The gm chip in the real app window: a composed gm song plays through the AudioWorklet with the SoundFont posted ONCE, the
// worklet reports positions (no worklet error), and a missing SoundFont is a readable error. Uses a tiny generated SoundFont
// in the isolated data folder, so it needs no download.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildMiniSoundFont } from '../core/miniSf2'
import { type LaunchedApp, launchApp, projectRoot } from './launch'

let launched: LaunchedApp
let page: Page
let client: Client
const consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!existsSync(path.join(projectRoot, 'out/main/index.js')), 'run `yarn build` first')
  launched = await launchApp()
  page = launched.page
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(e.message))
  await expect.poll(() => page.evaluate<boolean>('!!window.__chiptuneStudio'), { timeout: 20000 }).toBe(true)
  const deadline = Date.now() + 20000
  for (;;) {
    const c = new Client({ name: 'e2e-gm', version: '1.0.0' })
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(launched.mcpUrl)))
      client = c
      break
    } catch (e) {
      await c.close().catch(() => undefined)
      if (Date.now() > deadline) throw e
      await new Promise((r) => setTimeout(r, 300))
    }
  }
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
})

const evalPage = <T>(expr: string): Promise<T> => page.evaluate<T>(expr)
const text = (r: unknown): string =>
  ((r as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

test('without the SoundFont file the gm song says where to put it, with the download address', async () => {
  const status = await client.callTool({ name: 'soundfont_status', arguments: {} })
  expect(text(status)).toContain('"state":"missing"')
  await client.callTool({ name: 'compose_track', arguments: { mood: 'storybook', chip: 'gm', seed: 1, bars: 4 } })
  const r = await client.callTool({ name: 'render_audio', arguments: { path: path.join(launched.home, 'exports', 'x.wav'), format: 'wav' } })
  expect(r.isError).toBe(true)
  expect(text(r)).toContain('soundfonts')
  expect(text(r)).toContain('https://github.com/mrbumpy409/GeneralUser-GS')
})

test('a gm song plays in the window: the worklet runs, the SoundFont is posted once, no console error', async () => {
  await mkdir(path.join(launched.home, 'soundfonts'), { recursive: true })
  // CHIPTUNE_E2E_SOUNDFONT=<path to GeneralUser-GS.sf2> runs this test with the real file
  const real = process.env['CHIPTUNE_E2E_SOUNDFONT']
  await writeFile(path.join(launched.home, 'soundfonts', 'GeneralUser-GS.sf2'), real ? await readFile(real) : buildMiniSoundFont())
  expect(text(await client.callTool({ name: 'soundfont_status', arguments: {} }))).toContain('"state":"present"')
  await client.callTool({ name: 'compose_track', arguments: { mood: 'storybook', chip: 'gm', seed: 1, bars: 8 } })
  await expect.poll(() => evalPage<string>('window.__chiptuneStudio.session.song.chip')).toBe('gm')

  await page.getByTestId('btn-play-start').click()
  await expect.poll(() => evalPage<boolean>('window.__chiptuneStudio.ui.getState().playhead.playing'), { timeout: 20000 }).toBe(true)
  await expect.poll(() => evalPage<number>('window.__chiptuneStudio.audio.info().reports'), { timeout: 20000 }).toBeGreaterThan(3)
  expect(await evalPage<number>('window.__chiptuneStudio.audio.info().soundfontPosts')).toBe(1)
  await page.keyboard.press('Space')
  await expect.poll(() => evalPage<boolean>('window.__chiptuneStudio.ui.getState().playhead.playing')).toBe(false)

  // playing again does not send the file again
  await page.getByTestId('btn-play-start').click()
  await expect.poll(() => evalPage<boolean>('window.__chiptuneStudio.ui.getState().playhead.playing'), { timeout: 20000 }).toBe(true)
  expect(await evalPage<number>('window.__chiptuneStudio.audio.info().soundfontPosts')).toBe(1)
  await page.keyboard.press('Space')

  // the offline render in the window's worker works too
  const r = await client.callTool({ name: 'render_audio', arguments: { path: path.join(launched.home, 'exports', 'gm.wav'), format: 'wav' } })
  expect(r.isError, text(r)).toBeFalsy()
  expect(consoleErrors.filter((e) => /worklet|soundfont|spessa/i.test(e))).toEqual([])
})
