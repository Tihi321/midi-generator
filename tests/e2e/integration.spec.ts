// End-to-end proof of the real main <-> renderer tool bridge: an MCP client talks to the MCP server inside the
// running app, and the renderer's LIVE session reflects what it did (and one undo reverts one tool call).
// Also covers the asset library through MCP, the filesystem and the Library tab (place, style reference, delete).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { type LaunchedApp, launchApp, projectRoot } from './launch'

let launched: LaunchedApp
let page: Page
let client: Client

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!existsSync(path.join(projectRoot, 'out/main/index.js')), 'run `yarn build` first')
  launched = await launchApp()
  page = launched.page
  await expect.poll(() => page.evaluate<boolean>('!!window.__chiptuneStudio'), { timeout: 20000 }).toBe(true)

  // The MCP server starts a moment after launch: retry until it accepts the connection.
  const deadline = Date.now() + 20000
  for (;;) {
    const c = new Client({ name: 'e2e', version: '1.0.0' })
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
const undoDepth = (): Promise<number> => evalPage<number>('window.__chiptuneStudio.session.history.undoDepth')
/** Notes (or null) of rows 0..n-1 of a channel's pattern 0 in the live song. */
const noteRows = (channelId: string, n: number): Promise<Array<number | string | null>> =>
  evalPage(
    `(() => { const p = window.__chiptuneStudio.session.song.patterns.get('${channelId}:0'); return Array.from({ length: ${n} }, (_, i) => (p && p.rows[i] ? p.rows[i].note ?? null : null)) })()`
  )
const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const r = await client.callTool({ name, arguments: args })
  expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
  return text(r)
}

test('MCP tool calls change the live renderer session, and one undo reverts one call', async () => {
  const tools = (await client.listTools()).tools
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['new_song', 'write_drums', 'write_melody', 'save_as_asset', 'place_asset', 'get_style_context']))

  await call('new_song', { chip: 'nes', name: 'e2e-mcp', bpm: 132, key: 'A', scale: 'minor' })
  expect(await evalPage<string>('window.__chiptuneStudio.session.song.name')).toBe('e2e-mcp')
  await call('add_instrument', { preset: 'lead', channel: 'P1' })
  await call('write_drums', { channel: 'NO', legend: { K: 'kick', S: 'snare', h: 'hihat' }, steps: 'K.h.S.h.K.hhS.h.', repeat: 4 })
  expect((await noteRows('NO', 8)).filter((n) => n !== null).length).toBeGreaterThan(3)

  const depthBefore = await undoDepth()
  expect((await noteRows('P1', 8)).every((n) => n === null)).toBe(true)
  await call('write_melody', { channel: 'P1', melody: '@lead A4:2 C5:2 E5:4 D5:2 C5:2 B4:4' })
  expect(await noteRows('P1', 8)).toEqual([69, null, 72, null, 76, null, null, null])
  expect(await undoDepth()).toBe(depthBefore + 1)
  // the editor (not just the model) shows it: the history indicator follows the session
  await expect(page.getByTestId('history-indicator')).toContainText(`${depthBefore + 1} /`)

  // one undo in the renderer reverts exactly the write_melody; the drums stay
  expect(await evalPage<boolean>('window.__chiptuneStudio.session.undo()')).toBe(true)
  expect((await noteRows('P1', 8)).every((n) => n === null)).toBe(true)
  expect((await noteRows('NO', 8)).filter((n) => n !== null).length).toBeGreaterThan(3)
  expect(await undoDepth()).toBe(depthBefore)
  expect(await evalPage<boolean>('window.__chiptuneStudio.session.redo()')).toBe(true)
  expect(await noteRows('P1', 8)).toEqual([69, null, 72, null, 76, null, null, null])
  expect(await call('get_song', {})).toContain('e2e-mcp')
})

test('library: saved through MCP, stored under CHIPTUNE_STUDIO_HOME, listed live in the Library tab, placed, referenced and deleted from the UI', async () => {
  await page.getByTestId('tab-library').click()
  await expect(page.getByTestId('assets-panel')).toBeVisible()
  await expect(page.getByTestId('asset-empty')).toBeVisible()

  const savedSong = await call('save_as_asset', { name: 'E2E Song', kind: 'song', tags: ['e2e'], moods: ['heroic'], notes: 'driving minor theme' })
  expect(savedSong).toMatch(/id e2e-song/)
  await call('save_as_asset', { name: 'E2E Lick', kind: 'motif', channels: ['P1'], toRow: 16, tags: ['e2e', 'lick'] })

  // the folder layout on disk
  const dir = path.join(launched.home, 'assets', 'e2e-song')
  expect((await readdir(dir)).sort()).toEqual(['asset.ctune', 'meta.md', 'thumb.png'])
  const meta = await readFile(path.join(dir, 'meta.md'), 'utf8')
  expect(meta).toMatch(/^---\n/)
  expect(meta).toContain('kind: song')
  expect(meta).toContain('chip: nes')
  expect(meta).toContain('key: A')
  expect(meta).toContain('driving minor theme')
  expect(JSON.parse(await readFile(path.join(dir, 'asset.ctune'), 'utf8'))).toMatchObject({ format: 'chiptune-studio' })
  expect([...(await readFile(path.join(dir, 'thumb.png'))).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect((await stat(path.join(launched.home, 'assets', 'e2e-lick', 'asset.ctune'))).size).toBeGreaterThan(50)

  // live refresh: the cards appear without reloading (assets:changed)
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 10000 })
  await expect(page.getByTestId('asset-card').first()).toContainText('E2E')
  await expect(page.getByTestId('asset-card').first().locator('img')).toBeVisible()
  // the MCP resource lists them too
  const res = await client.readResource({ uri: 'chiptune-studio://assets' })
  expect(String((res.contents[0] as { text?: string }).text)).toContain('e2e-lick')

  // filters
  await page.getByTestId('asset-kind').selectOption('instrument')
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  await page.getByTestId('asset-kind').selectOption('motif')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await page.getByTestId('asset-kind').selectOption('')
  await page.getByTestId('asset-chip').selectOption('gb')
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  await page.getByTestId('asset-chip').selectOption('')
  await page.getByTestId('asset-search').fill('zzz')
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  await page.getByTestId('asset-search').fill('lick')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await page.getByTestId('asset-search').fill('')
  await expect(page.getByTestId('asset-card')).toHaveCount(2)

  // a new song in C major; place the motif at the cursor from the UI: one undo step, transposed A -> C (+3)
  await call('new_song', { chip: 'nes', name: 'e2e-target', key: 'C', scale: 'major' })
  expect(await noteRows('P1', 8)).toEqual([null, null, null, null, null, null, null, null])
  const lick = page.locator('[data-testid="asset-card"][data-asset-id="e2e-lick"]')
  const depth = await undoDepth()
  await lick.getByTestId('asset-place').click()
  await expect.poll(() => undoDepth()).toBe(depth + 1)
  expect(await noteRows('P1', 8)).toEqual([72, null, 75, null, 79, null, null, null])
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')).toBe(1)
  await evalPage('window.__chiptuneStudio.session.undo()')
  expect(await noteRows('P1', 8)).toEqual([null, null, null, null, null, null, null, null])
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')).toBe(0)

  // toggle a style reference (one undo step each) and see it in get_style_context
  const song = page.locator('[data-testid="asset-card"][data-asset-id="e2e-song"]')
  const d2 = await undoDepth()
  await song.getByTestId('asset-ref').check()
  await expect.poll(() => evalPage<string[]>('window.__chiptuneStudio.session.song.references.map((r) => r.assetId)')).toEqual(['e2e-song'])
  expect(await undoDepth()).toBe(d2 + 1)
  expect(await call('get_style_context', {})).toMatch(/Reference 1: "E2E Song"/)
  expect(await call('get_song', {})).toContain('References: e2e-song')
  await song.getByTestId('asset-ref').uncheck()
  await expect.poll(() => evalPage<number>('window.__chiptuneStudio.session.song.references.length')).toBe(0)
  expect(await call('get_style_context', {})).toMatch(/^No style references/)

  // opening a song asset replaces the song (undoable)
  await song.getByTestId('asset-place').click()
  await expect.poll(() => evalPage<string>('window.__chiptuneStudio.session.song.name')).toBe('E2E Song')
  expect((await noteRows('P1', 8))[0]).toBe(69)
  await evalPage('window.__chiptuneStudio.session.undo()')
  expect(await evalPage<string>('window.__chiptuneStudio.session.song.name')).toBe('e2e-target')

  // delete with inline confirmation: "No" keeps it, "Yes" removes it from the panel and from the disk
  await lick.getByTestId('asset-delete').click()
  await lick.getByTestId('asset-delete-no').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(2)
  await lick.getByTestId('asset-delete').click()
  await lick.getByTestId('asset-delete-yes').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1, { timeout: 10000 })
  expect(existsSync(path.join(launched.home, 'assets', 'e2e-lick'))).toBe(false)
  expect(existsSync(path.join(launched.home, 'assets', 'e2e-song'))).toBe(true)
})

test('the Save to library dialog saves the current instrument', async () => {
  await call('new_song', { chip: 'gb', name: 'e2e-gb' })
  await call('add_instrument', { preset: 'lead', channel: 'P1' })
  await page.getByTestId('tab-instruments').click()
  await page.getByTestId('instrument-save-0').click()
  await expect(page.getByTestId('dialog-save-asset')).toBeVisible()
  await expect(page.getByTestId('asset-kind-select')).toHaveValue('instrument')
  await page.getByTestId('asset-tags').fill('lead, e2e')
  await page.getByTestId('asset-save-confirm').click()
  await expect(page.getByTestId('dialog-save-asset')).toHaveCount(0)
  await page.getByTestId('tab-library').click()
  await expect(page.locator('[data-testid="asset-card"]').filter({ hasText: 'GB' })).toHaveCount(1, { timeout: 10000 })
  const list = await call('list_assets', { kind: 'instrument' })
  expect(list).toMatch(/^1 asset/)
  expect(list).toContain('"chip":"gb"')
})
