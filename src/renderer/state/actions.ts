// UI actions: thin wrappers that build core commands and run them through the session. Errors thrown by the
// command factories (bad instrument, out-of-range value, ...) become status-bar messages.

import {
  type CellDiff,
  type ChipId,
  type Instrument,
  type SampleSlot,
  type SongInfoPatch,
  countChangedCells,
  createCellsCommand,
  createInstrumentCommand,
  createSampleCommand,
  createSetOrdersCommand,
  createSongInfoCommand,
  instrumentSlug,
  missingPresetSample,
  nextFreePattern,
  parseProject,
  patternAt,
  patternNumberAt,
  resolvePreset,
  serializeProject
} from '../../core'
import { buildAuditionSong } from '../lib/audition'
import { deleteNoteDiffs, deriveNotes } from '../lib/pianoRoll'
import { decodeText, readFile, resolveProjectPath, writeFile } from '../lib/files'
import { type NewSongOptions, createStarterSong } from '../lib/newSong'
import {
  type GridCursor,
  type GridPoint,
  type Selection,
  advance,
  clampCursor,
  clearField,
  clearSelectionDiffs,
  copySelection,
  fxAt,
  moveCursor,
  noteEntry,
  pasteDiffs,
  readCell,
  selectionBetween,
  setFxCode,
  setFxParam,
  setInst,
  setVol,
  specialNoteEntry,
  transposeDiffs,
  layoutForSong,
  wholePattern
} from '../lib/trackerGrid'
import type { TrackerAction } from '../lib/trackerKeys'
import { applyMutes, engine } from './audio'
import { session } from './session'
import { useUi } from './ui'

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Run fn; show any error in the status bar. Returns true on success. */
export function attempt(fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (e) {
    useUi.getState().setStatus(message(e))
    return false
  }
}

async function attemptAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    useUi.getState().setStatus(message(e))
    return undefined
  }
}

// ---------------------------------------------------------------- history

export function undo(): void {
  session.undo()
}
export function redo(): void {
  session.redo()
}

// ---------------------------------------------------------------- cells

/**
 * Run cell diffs as ONE undo step. A write that would change nothing records no step. Returns false only when
 * the command was rejected (the reason goes to the status bar).
 */
export function writeCells(diffs: CellDiff[], label: string): boolean {
  if (diffs.length === 0) return true
  return attempt(() => {
    if (countChangedCells(session.song, diffs) === 0) return
    session.execute(createCellsCommand(session.song, diffs, label))
  })
}

// ---------------------------------------------------------------- playback

export async function play(from?: 'start' | 'cursor'): Promise<void> {
  const ui = useUi.getState()
  await attemptAsync(async () => {
    applyMutes()
    await engine.play(from === 'start' ? { order: 0, row: 0 } : undefined, { loop: ui.loop })
  })
}

export function stop(): void {
  engine.stop()
}

export function togglePlay(): void {
  if (engine.playing) stop()
  else void play('cursor')
}

export function setLoop(loop: boolean): void {
  useUi.getState().set({ loop })
  engine.setLoop(loop)
}

export function setVolume(volume: number): void {
  useUi.getState().set({ volume })
  engine.setVolume(volume)
}

export function toggleMute(channel: number): void {
  const ui = useUi.getState()
  ui.set({ mutes: { ...ui.mutes, [channel]: !ui.mutes[channel] } })
  applyMutes()
}

export function toggleSolo(channel: number): void {
  const ui = useUi.getState()
  ui.set({ solo: ui.solo === channel ? null : channel })
  applyMutes()
}

/** Play one note of an instrument (fire and forget; silently does nothing when audio is unavailable). */
export function previewNote(instrument: number, channel: number, midi: number): void {
  const song = buildAuditionSong(session.song, instrument, channel, midi)
  if (!song) return
  void engine.audition(song).catch(() => undefined)
}

// ---------------------------------------------------------------- tracker cursor

export function gridCursor(): GridCursor {
  return clampCursor(session.song, { ...session.cursor, field: useUi.getState().field })
}

export function setGridCursor(c: GridCursor, opts: { extend?: boolean } = {}): void {
  const ui = useUi.getState()
  const next = clampCursor(session.song, c)
  const patch: Partial<Pick<typeof ui, 'field' | 'pendingNibble' | 'anchor'>> = { field: next.field, pendingNibble: null }
  if (opts.extend) {
    if (!ui.anchor) patch.anchor = { order: session.cursor.order, row: session.cursor.row, channel: session.cursor.channel }
  } else if (ui.anchor) patch.anchor = null
  ui.set(patch)
  session.setCursor({ order: next.order, row: next.row, channel: next.channel })
}

export function currentSelection(): Selection | null {
  const { anchor } = useUi.getState()
  if (!anchor) return null
  const c = session.cursor
  return selectionBetween(anchor, { order: c.order, row: c.row, channel: c.channel } satisfies GridPoint)
}

/** The selection, or the single cell under the cursor. */
function selectionOrCell(): Selection {
  const sel = currentSelection()
  if (sel) return sel
  const c = session.cursor
  return { order: c.order, row1: c.row, row2: c.row, ch1: c.channel, ch2: c.channel }
}

function writeAtCursor(cur: GridCursor, cell: ReturnType<typeof setInst>, label: string): boolean {
  const pattern = patternNumberAt(session.song, cur.order, cur.channel)
  if (pattern === undefined) return false
  return writeCells([{ channel: cur.channel, pattern, row: cur.row, cell }], label)
}

function stepDown(cur: GridCursor): void {
  setGridCursor(advance(session.song, cur, useUi.getState().editStep))
}

/** Apply one key action to the tracker. */
export function handleTrackerAction(a: TrackerAction): void {
  const song = session.song
  const ui = useUi.getState()
  const cur = gridCursor()
  const layout = layoutForSong(song)
  const field = layout.channels[cur.channel]?.fields[cur.field]
  const cell = readCell(song, cur.order, cur.channel, cur.row)

  switch (a.type) {
    case 'note': {
      const inst = session.currentInstrument >= 0 && session.currentInstrument < song.instruments.length ? session.currentInstrument : undefined
      if (writeAtCursor(cur, noteEntry(cell, a.midi, inst), 'Enter note')) {
        const used = inst ?? cell?.inst
        if (used !== undefined) previewNote(used, cur.channel, a.midi)
        stepDown(cur)
      }
      return
    }
    case 'noteOff':
      if (writeAtCursor(cur, specialNoteEntry(cell, 'off'), 'Note off')) stepDown(cur)
      return
    case 'release':
      if (writeAtCursor(cur, specialNoteEntry(cell, 'rel'), 'Note release')) stepDown(cur)
      return
    case 'hex': {
      if (!field) return
      const d = a.digit
      switch (field.kind) {
        case 'inst0':
          setGridCursor({ ...cur, field: cur.field + 1 })
          useUi.getState().set({ pendingNibble: d })
          return
        case 'inst1': {
          const hi = ui.pendingNibble ?? ((cell?.inst ?? 0) >> 4)
          if (writeAtCursor(cur, setInst(cell, hi * 16 + d), 'Set instrument')) {
            setGridCursor(advance(song, { ...cur, field: cur.field - 1 }, ui.editStep))
          } else setGridCursor({ ...cur, field: cur.field - 1 })
          return
        }
        case 'vol':
          if (writeAtCursor(cur, setVol(cell, d), 'Set volume')) stepDown(cur)
          return
        case 'fxhi':
          setGridCursor({ ...cur, field: cur.field + 1 })
          useUi.getState().set({ pendingNibble: d })
          return
        case 'fxlo': {
          const k = field.fx ?? 0
          const e = fxAt(cell, k)
          if (!e) {
            ui.set({ status: 'Enter an effect code first (0 1 2 3 4 7 A B C D F G S P Q R W X E).' })
            return
          }
          const hi = ui.pendingNibble ?? (e.param >> 4)
          if (writeAtCursor(cur, setFxParam(cell, k, hi * 16 + d), 'Set effect parameter')) {
            setGridCursor(advance(song, { ...cur, field: cur.field - 1 }, ui.editStep))
          }
          return
        }
        default:
          return
      }
    }
    case 'fxCode': {
      if (!field || field.kind !== 'fxcode') return
      if (writeAtCursor(cur, setFxCode(cell, field.fx ?? 0, a.code), 'Set effect')) {
        setGridCursor({ ...cur, field: cur.field + 1 })
      }
      return
    }
    case 'clear': {
      const sel = currentSelection()
      if (sel) {
        writeCells(clearSelectionDiffs(song, sel), 'Clear selection')
        return
      }
      writeAtCursor(cur, clearField(cell, field), 'Clear field')
      stepDown(cur)
      return
    }
    case 'move': {
      setGridCursor({ ...moveCursor(song, cur, a.key) }, { extend: a.extend })
      return
    }
    case 'octave':
      session.setOctave(session.octave + a.delta)
      return
    case 'undo':
      undo()
      return
    case 'redo':
      redo()
      return
    case 'copy':
      ui.set({ clip: copySelection(song, selectionOrCell()) })
      return
    case 'cut': {
      const sel = selectionOrCell()
      ui.set({ clip: copySelection(song, sel) })
      writeCells(clearSelectionDiffs(song, sel), 'Cut')
      return
    }
    case 'paste': {
      if (!ui.clip) return
      writeCells(pasteDiffs(song, cur.order, cur.row, cur.channel, ui.clip), 'Paste')
      return
    }
    case 'selectAll': {
      const sel = wholePattern(song, cur.order)
      ui.set({ anchor: { order: sel.order, row: sel.row1, channel: sel.ch1 } })
      session.setCursor({ order: sel.order, row: sel.row2, channel: sel.ch2 })
      return
    }
    case 'transpose':
      writeCells(transposeDiffs(song, selectionOrCell(), a.semitones), a.semitones > 0 ? 'Transpose up' : 'Transpose down')
      return
    case 'playToggle':
      togglePlay()
      return
    case 'escape':
      if (ui.anchor) ui.set({ anchor: null })
      return
  }
}

// ---------------------------------------------------------------- order list

function ordersCopy(): number[][] {
  return session.song.orders.map((r) => [...r])
}

function execOrders(orders: number[][], loop: { order: number } | null | undefined, label: string): boolean {
  return attempt(() => session.execute(createSetOrdersCommand(session.song, orders, loop === undefined ? {} : { loop }, label)))
}

export function insertOrder(at: number): void {
  const song = session.song
  const orders = ordersCopy()
  const row = song.channels.map((c) => nextFreePattern(song, c.id))
  const index = Math.max(0, Math.min(orders.length, at))
  orders.splice(index, 0, row)
  const loop = song.loop && song.loop.order >= index ? { order: song.loop.order + 1 } : song.loop
  if (execOrders(orders, loop, 'Insert order')) session.setCursor({ order: index, row: 0 })
}

/** Copy of an order row with NEW patterns holding copies of the cells. */
export function duplicateOrder(index: number): void {
  const song = session.song
  if (index < 0 || index >= song.orders.length) return
  attempt(() => {
    session.transaction('Duplicate order', () => {
      const row = song.channels.map((c) => nextFreePattern(song, c.id))
      const orders = ordersCopy()
      orders.splice(index + 1, 0, row)
      const loop = song.loop && song.loop.order > index ? { order: song.loop.order + 1 } : song.loop
      session.execute(createSetOrdersCommand(song, orders, loop === undefined ? {} : { loop }, 'Duplicate order'))
      const diffs: CellDiff[] = []
      song.channels.forEach((_, ch) => {
        const pat = patternAt(song, index, ch)
        pat?.rows.forEach((cell, r) => {
          if (cell) diffs.push({ channel: ch, pattern: row[ch]!, row: r, cell })
        })
      })
      if (diffs.length > 0) session.execute(createCellsCommand(song, diffs, 'Duplicate order'))
    })
    session.setCursor({ order: index + 1 })
  })
}

export function deleteOrder(index: number): void {
  const song = session.song
  if (song.orders.length <= 1) {
    useUi.getState().setStatus('A song needs at least one order row.')
    return
  }
  const orders = ordersCopy()
  orders.splice(index, 1)
  let loop = song.loop
  if (loop) {
    if (loop.order > index) loop = { order: loop.order - 1 }
    else if (loop.order === index) loop = { order: Math.min(index, orders.length - 1) }
  }
  execOrders(orders, loop, 'Delete order')
}

export function moveOrder(index: number, dir: -1 | 1): void {
  const song = session.song
  const to = index + dir
  if (to < 0 || to >= song.orders.length) return
  const orders = ordersCopy()
  const [row] = orders.splice(index, 1)
  orders.splice(to, 0, row!)
  let loop = song.loop
  if (loop) {
    if (loop.order === index) loop = { order: to }
    else if (loop.order === to) loop = { order: index }
  }
  if (execOrders(orders, loop, 'Move order')) session.setCursor({ order: to })
}

export function setOrderPattern(order: number, channel: number, pattern: number): void {
  const orders = ordersCopy()
  if (!orders[order] || !Number.isInteger(pattern)) return
  orders[order]![channel] = pattern
  execOrders(orders, undefined, 'Set pattern number')
}

export function setLoopOrder(order: number | null): void {
  attempt(() => session.execute(createSongInfoCommand(session.song, { loop: order === null ? null : { order } }, 'Set loop point')))
}

// ---------------------------------------------------------------- song info

export function setSongInfo(patch: SongInfoPatch, label = 'Set song info'): boolean {
  return attempt(() => session.execute(createSongInfoCommand(session.song, patch, label)))
}

// ---------------------------------------------------------------- new / open / save

export function resetViewState(): void {
  useUi.getState().set({ anchor: null, field: 0, pendingNibble: null, mutes: {}, solo: null, rollSelected: null })
}

export function newSong(opts: NewSongOptions): boolean {
  return attempt(() => {
    engine.stop()
    session.replaceSong(createStarterSong(opts), { history: 'clear' })
    session.setCurrentInstrument(0)
    resetViewState()
    useUi.getState().set({ projectPath: null })
    useUi.getState().setStatus(`New ${opts.chip.toUpperCase()} song`)
  })
}

export function openProjectText(text: string, path: string | null): boolean {
  return attempt(() => {
    const song = parseProject(text)
    engine.stop()
    session.replaceSong(song, { history: 'clear' })
    session.setCurrentInstrument(song.instruments.length > 0 ? 0 : -1)
    resetViewState()
    useUi.getState().set({ projectPath: path })
    useUi.getState().setStatus(`Opened ${song.name}`)
  })
}

function withExtension(name: string): string {
  return name.toLowerCase().endsWith('.ctune') ? name : `${name}.ctune`
}

export async function openProjectFromPath(name: string): Promise<boolean> {
  const r = await attemptAsync(async () => {
    const path = await resolveProjectPath(withExtension(name))
    const text = decodeText(await readFile(path))
    return { path, text }
  })
  return r ? openProjectText(r.text, r.path) : false
}

export async function saveProject(name?: string): Promise<boolean> {
  const ui = useUi.getState()
  const target = name ? withExtension(name) : ui.projectPath
  if (!target) return false
  const path = await attemptAsync(async () => {
    const p = name ? await resolveProjectPath(target) : target
    await writeFile(p, serializeProject(session.song))
    return p
  })
  if (!path) return false
  ui.set({ projectPath: path })
  ui.setStatus(`Saved ${path}`)
  return true
}

// ---------------------------------------------------------------- instruments

function uniqueName(base: string): string {
  const taken = new Set(session.song.instruments.map((i) => instrumentSlug(i.name)))
  let name = base
  for (let n = 2; taken.has(instrumentSlug(name)); n++) name = `${base}-${n}`
  return name
}

/** Add an instrument from a preset id or role (the chip is the song's). Selects it as the current instrument. */
export function addInstrumentFromPreset(ref: string): boolean {
  return attempt(() => {
    const song = session.song
    const inst = resolvePreset(song.chip as ChipId, ref)
    inst.name = uniqueName(inst.name)
    // sample presets (SNES, Genesis DAC, NES DPCM) bring their recipe sample slot along (one undo step)
    session.transaction('Add instrument', () => {
      const slot = missingPresetSample(song, inst)
      if (slot) session.execute(createSampleCommand(song, { op: 'add', sample: slot }))
      const cmd = createInstrumentCommand(song, { op: 'add', instrument: inst })
      session.execute(cmd)
      session.setCurrentInstrument(cmd.createdIndex)
    })
  })
}

/** Add a sample slot (recipe or user PCM); returns its id or null on error. Id is made unique. */
export function addSampleSlot(slot: Omit<SampleSlot, 'id'> & { id?: string }): string | null {
  let id: string | null = null
  const ok = attempt(() => {
    const song = session.song
    const base = slot.id ?? slot.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    let unique = base || 'sample'
    for (let n = 2; song.samples.some((s) => s.id === unique); n++) unique = `${base || 'sample'}-${n}`
    const cmd = createSampleCommand(song, { op: 'add', sample: { ...slot, id: unique } })
    session.execute(cmd)
    id = cmd.sampleId
  })
  return ok ? id : null
}

/** Replace an instrument with an edited copy (one undo step). */
export function updateInstrument(index: number, next: Instrument, label?: string): boolean {
  return attempt(() => {
    const cmd = createInstrumentCommand(session.song, { op: 'update', ref: index, patch: { instrument: next } })
    cmd.label = label ?? cmd.label
    session.execute(cmd)
  })
}

export function renameInstrument(index: number, name: string): boolean {
  return attempt(() => session.execute(createInstrumentCommand(session.song, { op: 'update', ref: index, patch: { name } })))
}

export function deleteInstrument(index: number, force: boolean): boolean {
  return attempt(() => {
    session.execute(createInstrumentCommand(session.song, { op: 'delete', ref: index, force }))
    if (session.currentInstrument > index) session.setCurrentInstrument(session.currentInstrument - 1)
  })
}

// ---------------------------------------------------------------- piano roll

/** Delete the selected piano-roll note (one undo step). */
export function deleteSelectedRollNote(): boolean {
  const ui = useUi.getState()
  const sel = ui.rollSelected
  if (!sel) return false
  const note = deriveNotes(session.song, [sel.channel]).find((n) => n.start === sel.start)
  ui.set({ rollSelected: null })
  return note ? writeCells(deleteNoteDiffs(session.song, note), 'Delete note') : false
}
