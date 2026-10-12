import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
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
/** Notes (or null) of rows 0..n-1 of a channel's pattern 0. */
const noteRows = (channelId: string, n: number): Promise<Array<number | string | null>> =>
  evalPage(`(() => { const p = window.__chiptuneStudio.session.song.patterns.get('${channelId}:0'); return Array.from({ length: ${n} }, (_, i) => (p && p.rows[i] ? p.rows[i].note ?? null : null)) })()`)

test('the studio layout renders: orders, tracker, transport, instruments and status', async () => {
  await expect(page.getByTestId('order-list')).toBeVisible()
  await expect(page.getByTestId('tracker-view')).toBeVisible()
  await expect(page.getByTestId('transport-bar')).toBeVisible()
  await expect(page.getByTestId('btn-play')).toBeVisible()
  await expect(page.getByTestId('field-bpm')).toHaveValue('120')
  await expect(page.getByTestId('instrument-list')).toBeVisible()
  await expect(page.getByTestId('statusbar')).toBeVisible()
  await expect(page.getByTestId('issues')).toContainText('0 errors')
  // NES channel headers with chip names and mute/solo buttons
  for (const id of ['P1', 'P2', 'TR', 'NO']) await expect(page.getByTestId(`chead-${id}`)).toBeVisible()
  await expect(page.getByTestId('mute-P1')).toBeVisible()
  await expect(page.getByTestId('tracker-cursor')).toBeVisible()
})

test('typing notes in the tracker writes cells; each note is one undo step; undo and redo work', async () => {
  expect(await undoDepth()).toBe(0)
  await page.keyboard.press('z') // C-4
  await page.keyboard.press('x') // D-4
  await page.keyboard.press('c') // E-4
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, null])
  expect(await undoDepth()).toBe(3)
  expect(await evalPage<number>('window.__chiptuneStudio.session.cursor.row')).toBe(3)
  // the current instrument is stored with the note
  expect(await evalPage<number | null>("window.__chiptuneStudio.session.song.patterns.get('P1:0').rows[0].inst ?? null")).toBe(0)
  await page.keyboard.press('Control+z')
  expect(await noteRows('P1', 4)).toEqual([60, 62, null, null])
  await page.keyboard.press('Control+y')
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, null])
  // the upper piano row is one octave higher, numpad plus raises the entry octave
  await page.keyboard.press('q') // C-5
  expect(await noteRows('P1', 4)).toEqual([60, 62, 64, 72])
  await page.keyboard.press('NumpadAdd')
  expect(await evalPage<number>('window.__chiptuneStudio.session.octave')).toBe(5)
  await page.keyboard.press('NumpadSubtract')
  // note off and release keys
  await page.keyboard.press('1')
  expect(await noteRows('P1', 6)).toEqual([60, 62, 64, 72, 'off', null])
  await expect(page.getByTestId('history-indicator')).toContainText('5 / 0')
})

test('hex entry sets the instrument column', async () => {
  await page.keyboard.press('Home') // row 0
  await page.keyboard.press('ArrowRight') // instrument high digit
  await page.keyboard.press('0')
  await page.keyboard.press('1')
  expect(await evalPage<number>("window.__chiptuneStudio.session.song.patterns.get('P1:0').rows[0].inst")).toBe(1)
  expect(await evalPage<number>('window.__chiptuneStudio.session.cursor.row')).toBe(1)
  // invalid instrument numbers are reported, not written
  const depth = await undoDepth()
  await page.keyboard.press('3')
  await page.keyboard.press('f')
  expect(await undoDepth()).toBe(depth)
  await expect(page.getByTestId('status')).toContainText('does not exist')
  await page.keyboard.press('Escape')
})

test('typing in the chat does not edit the song', async () => {
  const depth = await undoDepth()
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-input').click()
  await page.keyboard.type('zxc q1 ')
  await expect(page.getByTestId('chat-input')).toHaveValue('zxc q1 ')
  expect(await undoDepth()).toBe(depth)
  await page.getByTestId('tab-instruments').click()
})

test('select, copy, paste and transpose are single undo steps', async () => {
  // click the first note cell of P1 row 0, then extend the selection with Shift+Down
  await page.getByTestId('tracker-body').click({ position: { x: 90, y: 4 } })
  expect(await evalPage<number>('window.__chiptuneStudio.session.cursor.row')).toBe(0)
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  expect(await evalPage<boolean>('!!window.__chiptuneStudio.ui.getState().anchor')).toBe(true)
  await page.keyboard.press('Control+c')
  expect(await undoDepth()).toBeGreaterThan(0)
  const depth = await undoDepth()
  // paste into the second channel at row 0
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Home')
  await page.keyboard.press('Control+v')
  expect(await undoDepth()).toBe(depth + 1)
  expect(await noteRows('P2', 3)).toEqual([60, 62, 64])
  // transpose the pasted cells up an octave with one step
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Control+Shift+ArrowUp')
  expect(await undoDepth()).toBe(depth + 2)
  expect(await noteRows('P2', 3)).toEqual([72, 74, 76])
  await page.keyboard.press('Control+z')
  expect(await noteRows('P2', 3)).toEqual([60, 62, 64])
  await page.keyboard.press('Control+z')
  expect(await noteRows('P2', 3)).toEqual([null, null, null])
  expect(await undoDepth()).toBe(depth)
})

test('piano roll: drawing a note is one undo step; Delete removes the selected note', async () => {
  await page.getByTestId('tab-piano').click()
  await expect(page.getByTestId('roll-canvas')).toBeVisible()
  await waitForTruthy('!!window.__chiptuneStudio.pianoRoll')
  await page.getByTestId('roll-channel').selectOption('2') // TR
  const pitch = await evalPage<number>('window.__chiptuneStudio.pianoRoll.centerPitch()')
  const before = await undoDepth()
  const from = await evalPage<{ x: number; y: number }>(`window.__chiptuneStudio.pianoRoll.pointFor(8, ${pitch})`)
  const to = await evalPage<{ x: number; y: number }>(`window.__chiptuneStudio.pianoRoll.pointFor(11, ${pitch})`)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, from.y)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
  expect(await undoDepth()).toBe(before + 1)
  const notes = await evalPage<Array<{ channel: number; start: number; end: number; pitch: number }>>('window.__chiptuneStudio.pianoRoll.notes()')
  expect(notes.find((n) => n.channel === 2)).toMatchObject({ start: 8, end: 12, pitch })
  // the cells hold the note and a note-off
  expect(await noteRows('TR', 13)).toEqual([null, null, null, null, null, null, null, null, pitch, null, null, null, 'off'])
  // Delete removes the (selected) note, again as one step
  await page.keyboard.press('Delete')
  expect(await undoDepth()).toBe(before + 2)
  expect(await noteRows('TR', 13)).toEqual(new Array(13).fill(null))
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  expect(await undoDepth()).toBe(before)
  expect(await noteRows('TR', 13)).toEqual(new Array(13).fill(null))
  await page.getByTestId('tab-tracker').click()
})

test('instruments panel: add a preset, edit a macro as text, delete with confirmation', async () => {
  await page.getByTestId('tab-instruments').click()
  const count = await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')
  await page.getByTestId('preset-add').click()
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')).toBe(count + 1)
  await expect(page.getByTestId('instrument-editor')).toBeVisible()
  const text = page.getByTestId('macro-vol-text')
  await text.fill('15 12 9 | 6 3 / 0')
  await text.press('Enter')
  const vol = await evalPage<{ values: number[]; loop?: number; release?: number }>(`window.__chiptuneStudio.session.song.instruments[${count}].macros.vol`)
  expect(vol).toEqual({ values: [15, 12, 9, 6, 3, 0], loop: 3, release: 5 })
  await page.keyboard.press('Control+z') // not typing any more: undoes the macro edit
  await page.getByTestId('instrument-audition').click()
  await page.getByTestId(`instrument-delete-${count}`).click()
  await page.getByTestId(`instrument-delete-confirm-${count}`).click()
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')).toBe(count)
})

test('order list: insert, duplicate and delete order rows', async () => {
  await page.getByTestId('order-insert').click()
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.orders.length')).toBe(2)
  await page.getByTestId('order-dup').click()
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.orders.length')).toBe(3)
  await page.getByTestId('order-delete').click()
  await page.getByTestId('order-row-1').locator('button.oidx').dblclick()
  expect(await evalPage<number | null>('window.__chiptuneStudio.session.song.loop?.order ?? null')).toBe(1)
  await page.keyboard.press('Control+z') // loop point
  await page.getByTestId('order-row-0').locator('button.oidx').click()
  await page.getByTestId('order-delete').click()
  await page.getByTestId('order-delete').click()
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.orders.length')).toBe(1)
})

test('playback starts from the transport, the playhead advances and Stop stops it', async () => {
  await page.getByTestId('btn-play-start').click()
  await expect.poll(() => evalPage<boolean>('window.__chiptuneStudio.ui.getState().playhead.playing'), { timeout: 15000 }).toBe(true)
  // the worklet reports its position: the audio thread is running and time moves forward
  await expect.poll(() => evalPage<number>('window.__chiptuneStudio.audio.info().reports'), { timeout: 15000 }).toBeGreaterThan(3)
  const t0 = await evalPage<number>('window.__chiptuneStudio.ui.getState().playhead.seconds')
  await expect.poll(() => evalPage<number>('window.__chiptuneStudio.ui.getState().playhead.seconds'), { timeout: 15000 }).toBeGreaterThan(t0)
  await expect(page.getByTestId('play-row')).toBeVisible()
  expect(await evalPage<string>('window.__chiptuneStudio.audio.info().state')).toBe('running')
  await page.keyboard.press('Space')
  await expect.poll(() => evalPage<boolean>('window.__chiptuneStudio.ui.getState().playhead.playing')).toBe(false)
})

test('mute and solo are player-level toggles', async () => {
  await page.getByTestId('mute-P1').click()
  expect(await evalPage<boolean>('window.__chiptuneStudio.ui.getState().mutes[0]')).toBe(true)
  await page.getByTestId('mute-P1').click()
  await page.getByTestId('solo-P2').click()
  expect(await evalPage<number | null>('window.__chiptuneStudio.ui.getState().solo')).toBe(1)
  await page.getByTestId('solo-P2').click()
  expect(await evalPage<number | null>('window.__chiptuneStudio.ui.getState().solo')).toBe(null)
})

test('New Song switches the chip to Game Boy and clears the history', async () => {
  await page.getByTestId('btn-new').click()
  await expect(page.getByTestId('dialog-new')).toBeVisible()
  // keys typed in the dialog must not reach the tracker
  const depth = await undoDepth()
  await page.getByTestId('new-name').fill('Pocket Tune')
  await page.getByTestId('new-chip').selectOption('gb')
  await page.getByTestId('new-bpm').fill('96')
  await page.getByTestId('new-length').selectOption('32')
  await page.getByTestId('new-create').click()
  await expect(page.getByTestId('dialog-new')).toHaveCount(0)
  expect(await evalPage<string>('window.__chiptuneStudio.session.song.chip')).toBe('gb')
  expect(await evalPage<string[]>('window.__chiptuneStudio.session.song.channels.map((c) => c.id)')).toEqual(['P1', 'P2', 'WV', 'NO'])
  expect(await evalPage<string>('window.__chiptuneStudio.session.song.name')).toBe('Pocket Tune')
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.patternLength')).toBe(32)
  expect(await undoDepth()).toBe(0)
  expect(depth).toBeGreaterThan(0)
  await expect(page.getByTestId('chead-WV')).toBeVisible()
  await expect(page.getByTestId('field-bpm')).toHaveValue('96')
  expect(await evalPage<number>('window.__chiptuneStudio.session.song.instruments.length')).toBeGreaterThan(0)
})

test('Game Boy instrument editors: wave drawer and pulse duty are single undo steps', async () => {
  await page.getByTestId('tab-instruments').click()
  const waveIndex = await evalPage<number>("window.__chiptuneStudio.session.song.instruments.findIndex((i) => i.kind === 'gb-wave')")
  expect(waveIndex).toBeGreaterThanOrEqual(0)
  await page.getByTestId(`instrument-select-${waveIndex}`).click()
  const drawer = page.getByTestId('gb-wave-drawer')
  await expect(drawer).toBeVisible()
  const box = (await drawer.boundingBox())!
  const before = await undoDepth()
  const wave0 = await evalPage<number[]>(`window.__chiptuneStudio.session.song.instruments[${waveIndex}].wave`)
  // draw columns 4..6 to the top (value 15) in one drag, column 5 to the bottom first
  await page.mouse.move(box.x + 4 * 9 + 4, box.y + 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 5 * 9 + 4, box.y + 16 * 9 - 2)
  await page.mouse.move(box.x + 6 * 9 + 4, box.y + 2)
  await page.mouse.up()
  expect(await undoDepth()).toBe(before + 1)
  const wave1 = await evalPage<number[]>(`window.__chiptuneStudio.session.song.instruments[${waveIndex}].wave`)
  expect(wave1.slice(4, 7)).toEqual([15, 0, 15])
  expect(wave1.filter((v, i) => v !== wave0[i]).length).toBeGreaterThan(0)
  await page.getByTestId('gb-wave-level').selectOption('2')
  expect(await evalPage<number>(`window.__chiptuneStudio.session.song.instruments[${waveIndex}].level`)).toBe(2)
  expect(await undoDepth()).toBe(before + 2)

  const pulseIndex = await evalPage<number>("window.__chiptuneStudio.session.song.instruments.findIndex((i) => i.kind === 'gb-pulse')")
  await page.getByTestId(`instrument-select-${pulseIndex}`).click()
  await page.getByTestId('gb-duty').selectOption('3')
  expect(await evalPage<number>(`window.__chiptuneStudio.session.song.instruments[${pulseIndex}].duty`)).toBe(3)
  expect(await undoDepth()).toBe(before + 3)
  await page.getByTestId('gb-env-init').fill('9')
  await page.getByTestId('gb-env-init').press('Enter')
  expect(await evalPage<number>(`window.__chiptuneStudio.session.song.instruments[${pulseIndex}].env.init`)).toBe(9)
  // undo all four edits
  await page.getByTestId('btn-undo').click()
  await page.getByTestId('btn-undo').click()
  await page.getByTestId('btn-undo').click()
  await page.getByTestId('btn-undo').click()
  expect(await undoDepth()).toBe(before)
  expect(await evalPage<number[]>(`window.__chiptuneStudio.session.song.instruments[${waveIndex}].wave`)).toEqual(wave0)
})

test('Export WAV via the dialog writes a RIFF file with a smpl loop chunk, plus stems', async () => {
  // some music on the Game Boy song
  await page.keyboard.press('z')
  await page.keyboard.press('x')
  await page.keyboard.press('c')
  await page.keyboard.press('1')
  await page.getByTestId('btn-export').click()
  await expect(page.getByTestId('dialog-export')).toBeVisible()
  await page.getByTestId('export-name').fill('e2e-song')
  await page.getByTestId('export-stems').check()
  await expect(page.getByTestId('export-estimate')).toContainText('loop points')
  await page.getByTestId('export-run').click()
  await expect(page.getByTestId('export-result')).toContainText('Exported', { timeout: 60000 })

  const exportsDir = path.join(launched!.home, 'exports')
  const files = (await readdir(exportsDir)).sort()
  expect(files).toEqual(['e2e-song.wav', 'e2e-song_NO.wav', 'e2e-song_P1.wav', 'e2e-song_P2.wav', 'e2e-song_WV.wav'])
  const wav = await readFile(path.join(exportsDir, 'e2e-song.wav'))
  expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
  expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE')
  expect(wav.includes(Buffer.from('smpl', 'latin1'))).toBe(true)
  expect(wav.includes(Buffer.from('data', 'latin1'))).toBe(true)
  // 44.1 kHz stereo PCM16
  expect(wav.readUInt32LE(24)).toBe(44100)
  expect(wav.readUInt16LE(22)).toBe(2)
  expect(wav.readUInt16LE(34)).toBe(16)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dialog-export')).toHaveCount(0)
})

test('Save writes a .ctune project under the projects folder', async () => {
  await page.getByTestId('btn-save').click()
  await expect(page.getByTestId('dialog-save')).toBeVisible()
  await page.getByTestId('save-name').fill('e2e-project')
  await page.getByTestId('save-confirm').click()
  await expect(page.getByTestId('dialog-save')).toHaveCount(0)
  const text = await readFile(path.join(launched!.home, 'projects', 'e2e-project.ctune'), 'utf8')
  const json = JSON.parse(text) as { format: string; song: { chip: string; patterns: Record<string, unknown> } }
  expect(json.format).toBe('chiptune-studio')
  expect(json.song.chip).toBe('gb')
  expect(Object.keys(json.song.patterns)).toContain('P1:0')
})
