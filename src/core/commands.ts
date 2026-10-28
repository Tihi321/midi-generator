// Commands, undo/redo history and command factories for the song. Pure TypeScript.
//
// Contract: a command factory inspects the song at creation time (it validates input and captures
// "before" state), so create a command and execute it right away, before building the next one.
// Factories throw an Error with a message suitable for showing to an LLM.

import {
  type Cell,
  type ChannelState,
  type Instrument,
  type Pattern,
  type PatternKey,
  type SampleSlot,
  type Song,
  type Timing,
  EFFECT_CODES,
  MAX_ORDERS,
  MAX_PATTERN_NUMBER,
  assertPatternLength,
  assertPatternNumber,
  assertTiming,
  cloneCell,
  clonePattern,
  cloneSong,
  createEmptyPattern,
  createId,
  describeInstruments,
  getPattern,
  normalizeCell,
  parsePatternKey,
  patternKey,
  replaceSongContents,
  requireChannel,
  requireChannelIndex,
  requireInstrumentIndex,
  requireKey
} from './model'
import { MAX_INSTRUMENTS, chipSupportsKind, cloneInstrument, instSampleId, instrumentSlug } from './instruments/types'
import { validateInstrument } from './instruments/validate'
import { songChannelDefs } from './chips'
import { requireScale } from './theory/scales'

export interface Command {
  type: string
  label: string
  apply(song: Song): void
  invert(song: Song): void
}


// ================================================================= History

export type HistoryEventType = 'execute' | 'undo' | 'redo' | 'clear' | 'transaction-begin' | 'transaction-commit' | 'transaction-abort'

export interface HistoryEvent {
  type: HistoryEventType
  command?: Command
  /** True when the event happened while a transaction was open. */
  inTransaction: boolean
}

export interface HistoryOptions {
  /** Maximum undo steps kept (default 200). Oldest steps are dropped. */
  maxDepth?: number
}

interface TxFrame {
  label: string
  startIndex: number
}

export class History {
  readonly song: Song
  private maxDepth: number
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private listeners = new Set<(e: HistoryEvent) => void>()
  private txCommands: Command[] = []
  private txStack: TxFrame[] = []
  /** Increments on every change to the song or the stacks. */
  version = 0

  constructor(song: Song, opts: HistoryOptions = {}) {
    this.song = song
    this.maxDepth = Math.max(1, opts.maxDepth ?? 200)
  }

  subscribe(listener: (e: HistoryEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(type: HistoryEventType, command?: Command): void {
    this.version++
    const e: HistoryEvent = { type, command, inTransaction: this.txStack.length > 0 }
    for (const l of [...this.listeners]) l(e)
  }

  inTransaction(): boolean {
    return this.txStack.length > 0
  }
  canUndo(): boolean {
    return this.txStack.length === 0 && this.undoStack.length > 0
  }
  canRedo(): boolean {
    return this.txStack.length === 0 && this.redoStack.length > 0
  }
  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }
  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }
  get undoDepth(): number {
    return this.undoStack.length
  }
  get redoDepth(): number {
    return this.redoStack.length
  }

  /** Apply a command and record it (inside a transaction it joins the transaction). */
  execute(cmd: Command): void {
    cmd.apply(this.song)
    this.redoStack = []
    if (this.txStack.length > 0) this.txCommands.push(cmd)
    else this.push(cmd)
    this.emit('execute', cmd)
  }

  private push(cmd: Command): void {
    this.undoStack.push(cmd)
    if (this.undoStack.length > this.maxDepth) this.undoStack.splice(0, this.undoStack.length - this.maxDepth)
  }

  undo(): boolean {
    if (!this.canUndo()) return false
    const cmd = this.undoStack.pop()!
    cmd.invert(this.song)
    this.redoStack.push(cmd)
    this.emit('undo', cmd)
    return true
  }

  redo(): boolean {
    if (!this.canRedo()) return false
    const cmd = this.redoStack.pop()!
    cmd.apply(this.song)
    this.undoStack.push(cmd)
    this.emit('redo', cmd)
    return true
  }

  /** Start grouping executed commands into one undo step. Nested calls are safe. */
  beginTransaction(label: string): void {
    this.txStack.push({ label, startIndex: this.txCommands.length })
    this.emit('transaction-begin')
  }

  /**
   * Finish the innermost transaction. The outermost commit pushes a single composite undo step
   * (nothing is pushed if no commands ran). Returns the composite when one was created.
   */
  commitTransaction(): Command | null {
    const frame = this.txStack.pop()
    if (!frame) throw new Error('commitTransaction() called without beginTransaction().')
    let composite: Command | null = null
    if (this.txStack.length === 0) {
      const cmds = this.txCommands
      this.txCommands = []
      if (cmds.length > 0) {
        composite = createCompositeCommand(frame.label, cmds)
        this.push(composite)
      }
    }
    this.emit('transaction-commit', composite ?? undefined)
    return composite
  }

  /** Roll back every command executed since the innermost beginTransaction() and close it. */
  abortTransaction(): void {
    const frame = this.txStack.pop()
    if (!frame) throw new Error('abortTransaction() called without beginTransaction().')
    const undone = this.txCommands.splice(frame.startIndex)
    for (let i = undone.length - 1; i >= 0; i--) undone[i]!.invert(this.song)
    this.emit('transaction-abort')
  }

  /** Run fn inside a transaction: commits on success, aborts (and rethrows) on error. */
  transaction<T>(label: string, fn: () => T): T {
    this.beginTransaction(label)
    let result: T
    try {
      result = fn()
    } catch (e) {
      this.abortTransaction()
      throw e
    }
    this.commitTransaction()
    return result
  }

  /** Forget all undo/redo steps (e.g. after opening a project). Aborts nothing. */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.emit('clear')
  }
}

export function createCompositeCommand(label: string, commands: Command[]): Command {
  const list = [...commands]
  return {
    type: 'composite',
    label,
    apply(song) {
      for (const c of list) c.apply(song)
    },
    invert(song) {
      for (let i = list.length - 1; i >= 0; i--) list[i]!.invert(song)
    }
  }
}

// ================================================================= cells (the single write primitive)

export interface CellDiff {
  /** Channel id, name or index. */
  channel: string | number
  /** Pattern number of that channel (see patternNumberAt for "the pattern an order plays"). */
  pattern: number
  row: number
  /** New content of the row; null/undefined/empty clears it. The whole cell is replaced. */
  cell: Cell | null | undefined
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

/** Validate and copy a cell for storage; throws an LLM-readable error. */
export function checkCell(song: Song, cell: Cell, where: string): Cell | null {
  if (cell.note !== undefined && cell.note !== 'off' && cell.note !== 'rel') {
    if (!Number.isInteger(cell.note) || cell.note < 0 || cell.note > 127) {
      throw new Error(`${where}: note ${String(cell.note)} must be a MIDI number 0..127, "off" or "rel".`)
    }
  }
  if (cell.inst !== undefined) {
    if (!Number.isInteger(cell.inst) || cell.inst < 0 || cell.inst >= song.instruments.length) {
      throw new Error(
        `${where}: instrument @${String(cell.inst)} does not exist. Instruments: ${describeInstruments(song)}.`
      )
    }
  }
  if (cell.vol !== undefined && (!Number.isInteger(cell.vol) || cell.vol < 0 || cell.vol > 15)) {
    throw new Error(`${where}: volume ${String(cell.vol)} must be an integer 0..15.`)
  }
  if (cell.fx) {
    if (cell.fx.length > 4) throw new Error(`${where}: at most 4 effects per cell (got ${cell.fx.length}).`)
    for (const e of cell.fx) {
      if (!EFFECT_CODES.includes(e.code)) {
        throw new Error(`${where}: unknown effect code "${String(e.code)}". Valid codes: ${EFFECT_CODES.join(' ')}.`)
      }
      if (!Number.isInteger(e.param) || e.param < 0 || e.param > 255) {
        throw new Error(`${where}: effect ${e.code} parameter ${String(e.param)} must be an integer 0..255 (hex 00..${hex2(255)}).`)
      }
    }
  }
  return normalizeCell(cell)
}

interface CellChange {
  key: PatternKey
  row: number
  before: Cell | null
  after: Cell | null
}

/**
 * Write cells: the single primitive behind write_pattern, write_melody, write_drums, set_cells, clear,
 * copy and transpose. Later diffs for the same row win. Patterns are created on demand; undo removes the
 * patterns the command created.
 */
export function createCellsCommand(song: Song, diffs: CellDiff[], label = 'Edit cells'): Command {
  const byRow = new Map<string, CellChange>()
  const patternExisted = new Map<PatternKey, boolean>()
  for (const d of diffs) {
    const ch = requireChannel(song, d.channel)
    assertPatternNumber(d.pattern)
    if (!Number.isInteger(d.row) || d.row < 0 || d.row >= song.patternLength) {
      throw new Error(`Row ${d.row} is outside the pattern: use 0..${song.patternLength - 1} (patternLength ${song.patternLength}).`)
    }
    const key = patternKey(ch.id, d.pattern)
    if (!patternExisted.has(key)) patternExisted.set(key, song.patterns.has(key))
    const after = d.cell ? checkCell(song, d.cell, `${ch.id} pattern ${d.pattern} row ${d.row}`) : null
    const id = `${key}#${d.row}`
    const prev = byRow.get(id)
    if (prev) {
      prev.after = after
    } else {
      const before = song.patterns.get(key)?.rows[d.row] ?? null
      byRow.set(id, { key, row: d.row, before: before ? cloneCell(before) : null, after })
    }
  }
  const changes = [...byRow.values()].filter((c) => !sameCell(c.before, c.after))
  const created = [...new Set(changes.map((c) => c.key))].filter((k) => !patternExisted.get(k))

  return {
    type: 'cells',
    label,
    apply(s) {
      for (const c of changes) {
        const { channelId, pattern } = parsePatternKey(c.key)
        const pat = getPattern(s, channelId, pattern)
        pat.rows[c.row] = c.after ? cloneCell(c.after) : null
      }
    },
    invert(s) {
      for (let i = changes.length - 1; i >= 0; i--) {
        const c = changes[i]!
        const pat = s.patterns.get(c.key)
        if (pat) pat.rows[c.row] = c.before ? cloneCell(c.before) : null
      }
      for (const k of created) s.patterns.delete(k)
    }
  }
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  if (!a || !b) return !a && !b
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Number of rows a diff list actually changes (before vs after), for result summaries. */
export function countChangedCells(song: Song, diffs: CellDiff[]): number {
  let n = 0
  for (const d of diffs) {
    const ch = requireChannel(song, d.channel)
    const before = song.patterns.get(patternKey(ch.id, d.pattern))?.rows[d.row] ?? null
    if (!sameCell(before ? normalizeCell(before) : null, d.cell ? normalizeCell(d.cell) : null)) n++
  }
  return n
}

// ================================================================= orders

export interface SetOrdersOptions {
  /** New loop target; undefined keeps the current one (clamped), null removes the loop. */
  loop?: { order: number } | null
}

export function createSetOrdersCommand(song: Song, orders: number[][], opts: SetOrdersOptions = {}, label = 'Set orders'): Command {
  if (!Array.isArray(orders) || orders.length === 0) throw new Error('orders must be a non-empty array of rows, one pattern number per channel.')
  if (orders.length > MAX_ORDERS) throw new Error(`Too many order rows (${orders.length}); the maximum is ${MAX_ORDERS}.`)
  const n = song.channels.length
  const next = orders.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) {
      throw new Error(
        `Order row ${i} has ${Array.isArray(row) ? row.length : 'no'} entries but the song has ${n} channels (${song.channels.map((c) => c.id).join(', ')}): give one pattern number per channel.`
      )
    }
    row.forEach((p, ci) => {
      if (!Number.isInteger(p) || p < 0 || p > MAX_PATTERN_NUMBER) {
        throw new Error(`Order row ${i}, channel ${song.channels[ci]!.id}: pattern number ${String(p)} must be an integer 0..${MAX_PATTERN_NUMBER}.`)
      }
    })
    return [...row]
  })
  const beforeOrders = song.orders.map((r) => [...r])
  const beforeLoop = song.loop ? { ...song.loop } : null
  let afterLoop: { order: number } | null
  if (opts.loop === undefined) afterLoop = beforeLoop ? { order: Math.min(beforeLoop.order, next.length - 1) } : null
  else if (opts.loop === null) afterLoop = null
  else {
    if (!Number.isInteger(opts.loop.order) || opts.loop.order < 0 || opts.loop.order >= next.length) {
      throw new Error(`Loop order ${opts.loop.order} is outside 0..${next.length - 1}.`)
    }
    afterLoop = { order: opts.loop.order }
  }
  return {
    type: 'orders',
    label,
    apply(s) {
      s.orders = next.map((r) => [...r])
      s.loop = afterLoop ? { ...afterLoop } : null
    },
    invert(s) {
      s.orders = beforeOrders.map((r) => [...r])
      s.loop = beforeLoop ? { ...beforeLoop } : null
    }
  }
}

// ================================================================= instruments

function assertUniqueName(song: Song, name: string, ignoreIndex: number): void {
  const slug = instrumentSlug(name)
  if (slug === '') throw new Error('Instrument name must contain letters or digits.')
  if (/^\d+$/.test(slug)) {
    throw new Error(`Instrument name "${name}" is all digits and would clash with @index references; add a letter, e.g. "i${slug}".`)
  }
  const clash = song.instruments.findIndex((x, i) => i !== ignoreIndex && instrumentSlug(x.name) === slug)
  if (clash >= 0) {
    throw new Error(`Instrument name "${name}" is already used by @${clash}; names must be unique (case-insensitive) so that @name resolves. Pick another name.`)
  }
}

function checkInstrumentData(song: Song, inst: Instrument): void {
  if (!chipSupportsKind(song.chip, inst.kind)) {
    throw new Error(`Instrument kind "${inst.kind}" cannot be used on ${song.chip}.`)
  }
  const problems = validateInstrument(inst)
  if (problems.length > 0) throw new Error(`Invalid instrument "${inst.name}":\n- ${problems.join('\n- ')}`)
}

export type InstrumentOp =
  | { op: 'add'; instrument: Instrument }
  | { op: 'update'; ref: string | number; patch: Partial<Instrument> | { instrument: Instrument } }
  | { op: 'delete'; ref: string | number; force?: boolean }

interface InstCellChange {
  key: PatternKey
  row: number
  before: Cell
  after: Cell | null
}

/**
 * Add, update or delete an instrument. Delete refuses while cells use the instrument unless `force`,
 * which clears those cells' inst field in the same command; cells that use higher indices are renumbered.
 * For 'add' the returned command has `createdIndex`.
 */
export function createInstrumentCommand(song: Song, spec: InstrumentOp): Command & { createdIndex: number } {
  if (spec.op === 'add') {
    if (song.instruments.length >= MAX_INSTRUMENTS) {
      throw new Error(`A song can hold at most ${MAX_INSTRUMENTS} instruments; delete one first.`)
    }
    const inst = cloneInstrument(spec.instrument)
    assertUniqueName(song, inst.name, -1)
    checkInstrumentData(song, inst)
    const index = song.instruments.length
    return {
      type: 'instrument-add',
      label: `Add instrument "${inst.name}"`,
      createdIndex: index,
      apply(s) {
        s.instruments.splice(index, 0, cloneInstrument(inst))
      },
      invert(s) {
        s.instruments.splice(index, 1)
      }
    }
  }

  const index = requireInstrumentIndex(song, spec.ref)
  const old = cloneInstrument(song.instruments[index]!)

  if (spec.op === 'update') {
    const patch = spec.patch as Record<string, unknown>
    const replacement = 'instrument' in patch && patch.instrument ? (patch.instrument as Instrument) : undefined
    const merged = (replacement ? cloneInstrument(replacement) : { ...cloneInstrument(old), ...structuredClone(patch) }) as Instrument
    assertUniqueName(song, merged.name, index)
    checkInstrumentData(song, merged)
    return {
      type: 'instrument-update',
      label: `Update instrument "${old.name}"`,
      createdIndex: index,
      apply(s) {
        s.instruments[index] = cloneInstrument(merged)
      },
      invert(s) {
        s.instruments[index] = cloneInstrument(old)
      }
    }
  }

  // delete
  const changes: InstCellChange[] = []
  let usedCount = 0
  const where: string[] = []
  for (const [key, pat] of song.patterns) {
    pat.rows.forEach((c, row) => {
      if (!c || c.inst === undefined || c.inst < index) return
      const before = cloneCell(c)
      let after: Cell | null
      if (c.inst === index) {
        usedCount++
        if (where.length < 4) where.push(`${parsePatternKey(key).channelId} pattern ${parsePatternKey(key).pattern} row ${row}`)
        const a = cloneCell(c)
        delete a.inst
        after = normalizeCell(a)
      } else {
        after = cloneCell(c)
        after.inst = c.inst - 1
      }
      changes.push({ key, row, before, after })
    })
  }
  if (usedCount > 0 && !spec.force) {
    throw new Error(
      `Instrument @${index} "${old.name}" is used by ${usedCount} cell(s) (e.g. ${where.join('; ')}). ` +
        'Deleting it would clear the instrument from those cells; pass force: true to do that, or switch the cells to another instrument first.'
    )
  }
  return {
    type: 'instrument-delete',
    label: `Delete instrument "${old.name}"`,
    createdIndex: index,
    apply(s) {
      s.instruments.splice(index, 1)
      for (const c of changes) {
        const pat = s.patterns.get(c.key)
        if (pat) pat.rows[c.row] = c.after ? cloneCell(c.after) : null
      }
    },
    invert(s) {
      s.instruments.splice(index, 0, cloneInstrument(old))
      for (const c of changes) {
        const pat = s.patterns.get(c.key)
        if (pat) pat.rows[c.row] = cloneCell(c.before)
      }
    }
  }
}

// ================================================================= song info

export interface SongInfoPatch {
  name?: string
  bpm?: number
  speed?: number
  rowsPerBeat?: number
  beatsPerBar?: number
  /** null removes the groove. */
  groove?: number[] | null
  key?: string
  scale?: string
  moods?: string[]
  tags?: string[]
  notes?: string | null
  authenticity?: 'strict' | 'relaxed'
  /** Non-structural chip settings only (region, mixModel, lfo, echo...). */
  chipConfig?: Record<string, unknown>
  loop?: { order: number } | null
}

const STRUCTURAL_CONFIG_KEYS = ['chip', 'dpcm', 'fm6Dac', 'voices']

export function createSongInfoCommand(song: Song, patch: SongInfoPatch, label = 'Set song info'): Command {
  const before = cloneSong(song)
  const after = cloneSong(song)
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') throw new Error('Song name must be a non-empty string.')
    after.name = patch.name
  }
  const timing: Partial<Timing> = {}
  for (const k of ['bpm', 'speed', 'rowsPerBeat', 'beatsPerBar'] as const) if (patch[k] !== undefined) timing[k] = patch[k]
  if (patch.groove) timing.groove = patch.groove
  assertTiming(timing)
  Object.assign(after.timing, timing)
  if (patch.groove === null) delete after.timing.groove
  if (patch.key !== undefined) after.meta.key = requireKey(patch.key)
  if (patch.scale !== undefined) after.meta.scale = requireScale(patch.scale).id
  if (patch.moods !== undefined) after.meta.moods = [...patch.moods]
  if (patch.tags !== undefined) after.meta.tags = [...patch.tags]
  if (patch.notes !== undefined) {
    if (patch.notes === null || patch.notes === '') delete after.meta.notes
    else after.meta.notes = patch.notes
  }
  if (patch.authenticity !== undefined) {
    if (patch.authenticity !== 'strict' && patch.authenticity !== 'relaxed') throw new Error('authenticity must be "strict" or "relaxed".')
    after.authenticity = patch.authenticity
  }
  if (patch.chipConfig !== undefined) {
    for (const k of Object.keys(patch.chipConfig)) {
      if (STRUCTURAL_CONFIG_KEYS.includes(k)) {
        throw new Error(`chipConfig.${k} changes the channel layout and cannot be edited in place; create a new song (new_song) with that setting.`)
      }
      if (!(k in song.chipConfig)) {
        throw new Error(`Unknown chipConfig field "${k}" for ${song.chip}. Fields: ${Object.keys(song.chipConfig).filter((x) => x !== 'chip').join(', ') || '(none)'}.`)
      }
    }
    const merged = structuredClone(song.chipConfig) as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(patch.chipConfig)) {
      const cur = merged[k]
      merged[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' ? { ...cur, ...v } : v
    }
    after.chipConfig = merged as unknown as Song['chipConfig']
  }
  if (patch.loop !== undefined) {
    if (patch.loop !== null && (!Number.isInteger(patch.loop.order) || patch.loop.order < 0 || patch.loop.order >= song.orders.length)) {
      throw new Error(`Loop order ${patch.loop.order} is outside 0..${song.orders.length - 1}.`)
    }
    after.loop = patch.loop ? { order: patch.loop.order } : null
  }
  const assign = (s: Song, src: Song): void => {
    s.name = src.name
    s.timing = { ...src.timing, ...(src.timing.groove ? { groove: [...src.timing.groove] } : {}) }
    s.meta = { ...src.meta, moods: [...src.meta.moods], tags: [...src.meta.tags] }
    s.authenticity = src.authenticity
    s.chipConfig = structuredClone(src.chipConfig)
    s.loop = src.loop ? { ...src.loop } : null
  }
  return {
    type: 'song-info',
    label,
    apply: (s) => assign(s, after),
    invert: (s) => assign(s, before)
  }
}

// ================================================================= channels

export interface ChannelPatch {
  name?: string
  muted?: boolean
  /** -1..1 */
  pan?: number
  /** dB */
  trim?: number
  fxColumns?: 1 | 2 | 3 | 4
}

export function createChannelCommand(song: Song, ref: string | number, patch: ChannelPatch, label?: string): Command {
  const index = requireChannelIndex(song, ref)
  const old: ChannelState = { ...song.channels[index]! }
  const next: ChannelState = { ...old }
  if (patch.name !== undefined) {
    if (patch.name.trim() === '') throw new Error('Channel name must not be empty.')
    next.name = patch.name
  }
  if (patch.muted !== undefined) next.muted = patch.muted
  if (patch.pan !== undefined) {
    if (typeof patch.pan !== 'number' || patch.pan < -1 || patch.pan > 1) throw new Error('pan must be a number -1 (left) .. 1 (right).')
    const def = songChannelDefs(song)[index]
    if (def && def.pan === 'none' && patch.pan !== 0 && song.authenticity === 'strict') {
      throw new Error(`${old.id} has no panning on ${song.chip} (mono); keep pan at 0 or set authenticity to "relaxed".`)
    }
    next.pan = patch.pan
  }
  if (patch.trim !== undefined) {
    if (typeof patch.trim !== 'number' || patch.trim < -48 || patch.trim > 12) throw new Error('trim must be -48..12 dB.')
    next.trim = patch.trim
  }
  if (patch.fxColumns !== undefined) {
    if (![1, 2, 3, 4].includes(patch.fxColumns)) throw new Error('fxColumns must be 1, 2, 3 or 4.')
    next.fxColumns = patch.fxColumns
  }
  return {
    type: 'channel',
    label: label ?? `Update channel ${old.id}`,
    apply(s) {
      s.channels[index] = { ...next }
    },
    invert(s) {
      s.channels[index] = { ...old }
    }
  }
}

// ================================================================= samples

export type SampleOp =
  | { op: 'add'; sample: Omit<SampleSlot, 'id'> & { id?: string } }
  | { op: 'update'; id: string; patch: Partial<Omit<SampleSlot, 'id'>> }
  | { op: 'delete'; id: string }

export function createSampleCommand(song: Song, spec: SampleOp): Command & { sampleId: string } {
  if (spec.op === 'add') {
    const id = spec.sample.id ?? createId('smp')
    if (song.samples.some((s) => s.id === id)) throw new Error(`Sample id "${id}" already exists.`)
    const slot: SampleSlot = { ...structuredClone(spec.sample), id }
    return {
      type: 'sample-add',
      label: `Add sample "${slot.name}"`,
      sampleId: id,
      apply(s) {
        s.samples.push(structuredClone(slot))
      },
      invert(s) {
        const i = s.samples.findIndex((x) => x.id === id)
        if (i >= 0) s.samples.splice(i, 1)
      }
    }
  }
  const index = song.samples.findIndex((s) => s.id === spec.id)
  if (index < 0) {
    throw new Error(`Sample "${spec.id}" not found. Samples: ${song.samples.map((s) => s.id).join(', ') || '(none)'}.`)
  }
  const old = structuredClone(song.samples[index]!)
  if (spec.op === 'update') {
    const merged: SampleSlot = { ...structuredClone(old), ...structuredClone(spec.patch), id: old.id }
    return {
      type: 'sample-update',
      label: `Update sample "${old.name}"`,
      sampleId: old.id,
      apply(s) {
        s.samples[index] = structuredClone(merged)
      },
      invert(s) {
        s.samples[index] = structuredClone(old)
      }
    }
  }
  const users = song.instruments.map((x, i) => ({ x, i })).filter(({ x }) => instSampleId(x) === old.id)
  if (users.length > 0) {
    throw new Error(
      `Sample "${old.id}" is used by instrument(s) ${users.map(({ x, i }) => `@${i} "${x.name}"`).join(', ')}; delete or change those instruments first.`
    )
  }
  return {
    type: 'sample-delete',
    label: `Delete sample "${old.name}"`,
    sampleId: old.id,
    apply(s) {
      const i = s.samples.findIndex((x) => x.id === old.id)
      if (i >= 0) s.samples.splice(i, 1)
    },
    invert(s) {
      s.samples.splice(Math.min(index, s.samples.length), 0, structuredClone(old))
    }
  }
}

// ================================================================= pattern length

export function createPatternLengthCommand(song: Song, length: number, label = 'Set pattern length'): Command {
  assertPatternLength(length)
  const oldLength = song.patternLength
  const before = new Map<PatternKey, Pattern>()
  for (const [k, p] of song.patterns) if (p.rows.length !== length) before.set(k, clonePattern(p))
  const resize = (p: Pattern): Pattern => {
    if (p.rows.length > length) return { rows: p.rows.slice(0, length) }
    return { rows: [...p.rows, ...createEmptyPattern(length - p.rows.length).rows] }
  }
  return {
    type: 'pattern-length',
    label,
    apply(s) {
      s.patternLength = length
      for (const [k, p] of s.patterns) s.patterns.set(k, resize(p))
    },
    invert(s) {
      s.patternLength = oldLength
      for (const [k, p] of before) s.patterns.set(k, clonePattern(p))
    }
  }
}

// ================================================================= replace whole song

export function createReplaceSongCommand(song: Song, replacement: Song, label = 'Replace song'): Command {
  const before = cloneSong(song)
  const next = cloneSong(replacement)
  return {
    type: 'replace-song',
    label,
    apply: (s) => replaceSongContents(s, next),
    invert: (s) => replaceSongContents(s, before)
  }
}

