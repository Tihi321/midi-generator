import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type LaunchedApp, launchApp } from './launch'

const root = path.resolve(__dirname, '../..')

let launched: LaunchedApp | undefined
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!existsSync(path.join(root, 'out/main/index.js')), 'run `yarn build` first')
  launched = await launchApp()
  page = launched.page
  await waitForTruthy('!!window.__chiptuneStudio')
})

test.afterAll(async () => {
  await launched?.close()
})

/** Poll an expression with page.evaluate (waitForFunction with a string needs eval, which the app's CSP blocks). */
async function waitForTruthy(expr: string, timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await page.evaluate<boolean>(expr).catch(() => false)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${expr}`)
}

const evalPage = <T>(expr: string): Promise<T> => page.evaluate<T>(expr)
const undoDepth = (): Promise<number> => evalPage<number>('window.__chiptuneStudio.session.history.undoDepth')
const chipOf = (): Promise<string> => evalPage<string>('window.__chiptuneStudio.session.song.chip')
const noteRows = (channelId: string, n: number): Promise<Array<number | string | null>> =>
  evalPage(`(() => { const p = window.__chiptuneStudio.session.song.patterns.get('${channelId}:0'); return Array.from({ length: ${n} }, (_, i) => (p && p.rows[i] ? p.rows[i].note ?? null : null)) })()`)

test('Export dialog MIDI tab writes a Standard MIDI File with an MThd header', async () => {
  // a NES starter song with a few notes
  await page.getByTestId('btn-new').click()
  await page.getByTestId('new-chip').selectOption('nes')
  await page.getByTestId('new-create').click()
  await expect(page.getByTestId('dialog-new')).toHaveCount(0)
  expect(await chipOf()).toBe('nes')
  await page.keyboard.press('z')
  await page.keyboard.press('x')
  await page.keyboard.press('c')
  await page.keyboard.press('1')
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, 'off'])

  await page.getByTestId('btn-export').click()
  await expect(page.getByTestId('dialog-export')).toBeVisible()
  await page.getByTestId('export-tab-midi').click()
  await expect(page.getByTestId('export-estimate')).toContainText('Standard MIDI File')
  await page.getByTestId('export-name').fill('e2e-midi')
  await page.getByTestId('export-arp').selectOption('chord')
  await page.getByTestId('export-run').click()
  await expect(page.getByTestId('export-result')).toContainText('Exported MIDI', { timeout: 30000 })

  const file = path.join(launched!.home, 'exports', 'e2e-midi.mid')
  const bytes = await readFile(file)
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd')
  expect(bytes.readUInt32BE(4)).toBe(6)
  expect(bytes.readUInt16BE(8)).toBe(1) // type 1
  expect(bytes.readUInt16BE(12)).toBe(480) // PPQ
  const tracks = bytes.readUInt16BE(10)
  expect(tracks).toBeGreaterThanOrEqual(2)
  expect(bytes.toString('latin1').match(/MTrk/g)).toHaveLength(tracks)
  // the notes are in there: note-on 60, 62, 64 on a pulse track
  expect([...bytes].some((b, i) => b === 0x90 && bytes[i + 1] === 60)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dialog-export')).toHaveCount(0)
})

test('Convert chip dialog switches NES to Genesis in one undo step; one undo restores', async () => {
  const depth = await undoDepth()
  const song0 = await evalPage<string>('window.__chiptuneStudio.session.song.channels.map((c) => c.id).join()')
  expect(song0).toBe('P1,P2,TR,NO')
  await page.getByTestId('btn-convert').click()
  await expect(page.getByTestId('dialog-convert')).toBeVisible()
  await page.getByTestId('convert-chip').selectOption('genesis')
  await expect(page.getByTestId('convert-report')).toContainText('from NES')
  await expect(page.getByTestId('convert-report')).toContainText('to GENESIS')
  await page.getByTestId('convert-run').click()
  await expect(page.getByTestId('dialog-convert')).toHaveCount(0)
  expect(await chipOf()).toBe('genesis')
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.channels.length')).toBe(10)
  expect(await undoDepth()).toBe(depth + 1)
  // the typed melody landed on an FM channel
  expect(await evalPage<boolean>("[...window.__chiptuneStudio.session.song.patterns.entries()].some(([k, p]) => k.startsWith('F') && p.rows.some((c) => c && c.note === 60))")).toBe(true)
  await page.getByTestId('btn-undo').click()
  expect(await chipOf()).toBe('nes')
  expect(await undoDepth()).toBe(depth)
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, 'off'])
  // redo brings the conversion back, undo again restores
  await page.getByTestId('btn-redo').click()
  expect(await chipOf()).toBe('genesis')
  await page.getByTestId('btn-undo').click()
  expect(await chipOf()).toBe('nes')
})

test('Import MIDI dialog reads the exported file with the browser picker and is one undo step', async () => {
  const depth = await undoDepth()
  await page.getByTestId('btn-import-midi').click()
  await expect(page.getByTestId('dialog-import-midi')).toBeVisible()
  await page.getByTestId('import-midi-file').setInputFiles(path.join(launched!.home, 'exports', 'e2e-midi.mid'))
  await page.getByTestId('import-midi-chip').selectOption('gb')
  await expect(page.getByTestId('import-midi-report')).toContainText('Grid:')
  await expect(page.getByTestId('import-midi-report')).toContainText('-> P1')
  await page.getByTestId('import-midi-run').click()
  await expect(page.getByTestId('dialog-import-midi')).toHaveCount(0)
  expect(await chipOf()).toBe('gb')
  expect(await undoDepth()).toBe(depth + 1)
  expect(await evalPage<string>('window.__chiptuneStudio.session.song.name')).toBe('e2e midi')
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, 'off'])
  await page.getByTestId('btn-undo').click()
  expect(await chipOf()).toBe('nes')
  expect(await undoDepth()).toBe(depth)
})
