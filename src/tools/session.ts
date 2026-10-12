// SongSession: the framework-free state container around a core Song + History.
//
// The renderer owns ONE session (the live song). UI components, the tool registry (chat agent and MCP
// calls arriving over the tool bridge) and tests all drive the same object, so manual edits and LLM edits
// share one undo history. No DOM, no Electron, no React: subscribe() + getVersion() are shaped for React's
// useSyncExternalStore:
//
//   const version = useSyncExternalStore(session.subscribe, session.getVersion)
//
// `session.song` is a stable object for the lifetime of the session (new/open replace its contents in place,
// see replaceSong), so always re-read from it when `version` changes.

import {
  type Command,
  type HistoryEvent,
  type Song,
  History,
  createCompositeCommand,
  createReplaceSongCommand,
  createSong,
  replaceSongContents
} from '../core'
import type { ToolSession } from './registry'

/** Editor cursor: where the user (and tools without an explicit target) are working. */
export interface SongCursor {
  /** Order row index. */
  order: number
  /** Row inside the pattern. */
  row: number
  /** Channel index. */
  channel: number
}

export interface SongSessionOptions {
  /** Maximum undo steps kept (default 200). */
  maxUndoDepth?: number
}

export interface ReplaceSongOptions {
  /**
   * 'record' (default): the replacement is ONE undoable step, so undo brings the previous song back
   * (the right choice for LLM `new_song` / `open_project`). 'clear': drop all history (File > New).
   */
  history?: 'record' | 'clear'
  label?: string
}

export type SessionListener = () => void

interface TurnState {
  label: string
  /** Undo depth when the turn started: undo never goes below it while the turn runs. */
  startDepth: number
  /** Undo steps pushed during the turn (mirror of the tail of the undo stack). */
  steps: Command[]
  /** Nested beginTurn calls. */
  nesting: number
  /** False if the mirror could not be kept exact (then the turn is not merged). */
  mirrorValid: boolean
}

export class SongSession implements ToolSession {
  readonly history: History
  /** Stable song object (contents are replaced in place by replaceSong). */
  readonly song: Song

  cursor: SongCursor = { order: 0, row: 0, channel: 0 }
  /** Octave used for keyboard note entry in the tracker / piano roll (0..8). */
  octave = 4
  /** Instrument index used for manual note entry (-1 = none). */
  currentInstrument = 0

  private _version = 0
  private listeners = new Set<SessionListener>()
  private lastSongId: string
  private turn: TurnState | null = null

  constructor(song: Song = createSong({ chip: 'nes', name: 'Untitled' }), opts: SongSessionOptions = {}) {
    this.song = song
    this.history = new History(song, { maxDepth: opts.maxUndoDepth })
    this.lastSongId = song.id
    this.normalize()
    this.history.subscribe((e) => this.onHistoryEvent(e))
  }

  // ------------------------------------------------------------ subscription

  /** Monotonically increasing; changes on every song, history or session-state change. */
  getVersion = (): number => this._version

  /** Subscribe to changes (arrow function so it can be passed straight to useSyncExternalStore). */
  subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    this._version++
    for (const l of [...this.listeners]) l()
  }

  // ------------------------------------------------------------ editing

  /** Apply a command and record it (joins the open transaction, if any). */
  execute(cmd: Command): void {
    this.history.execute(cmd)
  }

  /** Run `fn` as one undo step; rolls everything back and rethrows if it throws. */
  transaction<T>(label: string, fn: () => T): T {
    return this.history.transaction(label, fn)
  }

  /** Like `transaction`, but `fn` may be async (used by tool calls that do file IO). */
  async transactionAsync<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    this.history.beginTransaction(label)
    let result: T
    try {
      result = await fn()
    } catch (e) {
      this.history.abortTransaction()
      throw e
    }
    this.history.commitTransaction()
    return result
  }

  beginTransaction(label: string): void {
    this.history.beginTransaction(label)
  }
  commitTransaction(): void {
    this.history.commitTransaction()
  }
  abortTransaction(): void {
    this.history.abortTransaction()
  }

  canUndo(): boolean {
    if (!this.history.canUndo()) return false
    return !this.turn || this.history.undoDepth > this.turn.startDepth
  }
  canRedo(): boolean {
    return this.history.canRedo()
  }
  undoLabel(): string | undefined {
    return this.canUndo() ? this.history.undoLabel() : undefined
  }
  redoLabel(): string | undefined {
    return this.history.redoLabel()
  }

  /** Undo one step. While an agent turn runs this never goes below the turn's start. */
  undo(): boolean {
    if (!this.canUndo()) return false
    return this.history.undo()
  }
  redo(): boolean {
    return this.history.redo()
  }

  /**
   * Replace the whole song (new / open / import / convert). The Song object stays the same, its contents
   * are swapped. `next` is consumed. The cursor is reset.
   */
  replaceSong(next: Song, opts: ReplaceSongOptions = {}): void {
    const mode = opts.history ?? 'record'
    if (mode === 'clear') {
      if (this.history.inTransaction()) throw new Error('Cannot clear history while a transaction is open.')
      replaceSongContents(this.song, next)
      this.history.clear()
    } else {
      this.history.execute(createReplaceSongCommand(this.song, next, opts.label ?? 'Replace song'))
    }
    this.cursor = { order: 0, row: 0, channel: 0 }
    this.lastSongId = this.song.id
    this.normalize()
    this.notify()
  }

  // ------------------------------------------------------------ agent turns

  get turnActive(): boolean {
    return this.turn !== null
  }

  /**
   * Group everything executed until endTurn() into ONE undo step ("Undo agent turn"). Each tool call is
   * still its own transaction while the turn runs, so the undo tool works step by step inside the turn;
   * endTurn() merges them. Calls nest (the outermost endTurn merges).
   */
  beginTurn(label = 'Agent turn'): void {
    if (this.turn) {
      this.turn.nesting++
      return
    }
    if (this.history.inTransaction()) throw new Error('Cannot start an agent turn inside an open transaction.')
    this.turn = { label, startDepth: this.history.undoDepth, steps: [], nesting: 1, mirrorValid: true }
    this.notify()
  }

  endTurn(opts: { rollback?: boolean } = {}): void {
    const turn = this.turn
    if (!turn) return
    if (opts.rollback) turn.nesting = 1
    if (--turn.nesting > 0) return
    if (this.history.inTransaction()) throw new Error('Cannot end an agent turn while a transaction is open.')
    this.turn = null
    if (opts.rollback) {
      while (this.history.undoDepth > turn.startDepth && this.history.undo()) {
        /* keep undoing */
      }
    } else if (turn.mirrorValid && turn.steps.length > 1 && this.history.undoDepth - turn.startDepth === turn.steps.length) {
      const steps = [...turn.steps]
      for (let i = 0; i < steps.length; i++) this.history.undo()
      this.history.execute(createCompositeCommand(turn.label, steps))
    }
    this.notify()
  }

  private trackTurn(e: HistoryEvent): void {
    const turn = this.turn
    if (!turn) return
    switch (e.type) {
      case 'execute':
        if (!e.inTransaction && e.command) turn.steps.push(e.command)
        break
      case 'transaction-commit':
        if (e.command) turn.steps.push(e.command)
        break
      case 'undo':
        if (turn.steps[turn.steps.length - 1] === e.command) turn.steps.pop()
        else turn.mirrorValid = false
        break
      case 'redo':
        if (e.command) turn.steps.push(e.command)
        break
      case 'clear':
        turn.steps = []
        turn.startDepth = 0
        turn.mirrorValid = false
        break
      default:
        break
    }
  }

  // ------------------------------------------------------------ cursor / entry state

  /** Move the cursor (clamped to the song). */
  setCursor(patch: Partial<SongCursor>): void {
    const next = { ...this.cursor, ...patch }
    const cur = this.cursor
    this.cursor = next
    this.normalize()
    if (cur.order === this.cursor.order && cur.row === this.cursor.row && cur.channel === this.cursor.channel) return
    this.notify()
  }

  setOctave(octave: number): void {
    const o = Math.max(0, Math.min(8, Math.floor(octave)))
    if (o === this.octave) return
    this.octave = o
    this.notify()
  }

  setCurrentInstrument(index: number): void {
    const i = Math.max(-1, Math.floor(index))
    if (i === this.currentInstrument) return
    this.currentInstrument = i
    this.notify()
  }

  // ------------------------------------------------------------ internals

  private onHistoryEvent(e: HistoryEvent): void {
    this.trackTurn(e)
    this.normalize()
    this.notify()
  }

  /** Keep the cursor and current instrument valid after any change to the song. */
  private normalize(): void {
    const s = this.song
    if (s.id !== this.lastSongId) {
      // The song was swapped (e.g. undo/redo of a replace): start from the top.
      this.lastSongId = s.id
      this.cursor = { order: 0, row: 0, channel: 0 }
    }
    const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.max(0, max), Math.floor(v)))
    this.cursor = {
      order: clamp(this.cursor.order, s.orders.length - 1),
      row: clamp(this.cursor.row, s.patternLength - 1),
      channel: clamp(this.cursor.channel, s.channels.length - 1)
    }
    if (this.currentInstrument >= s.instruments.length) this.currentInstrument = s.instruments.length - 1
  }
}
