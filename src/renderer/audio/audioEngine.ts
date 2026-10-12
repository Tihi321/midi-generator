// AudioEngine: owns the AudioContext and the AudioWorklet that plays the live song.
//
//  - The worklet (worklet.ts) is loaded lazily on the first play/audition, which is a user gesture.
//  - Edits made while playing are hot-swapped into the running player, debounced, keeping the playhead.
//  - The playhead is reported by the worklet (~30 Hz) to listeners; it never touches the undo history.
//  - Nothing here touches the DOM at import time, so the module is safe to import in Node tests.

import type { Song } from '../../core/types'
import type { SongSession } from '../../tools/session'
import type { PlaybackPosition } from '../../tools/services'
import { type FromWorklet, type ToWorklet, WORKLET_NAME } from './protocol'

export type PositionListener = (p: PlaybackPosition) => void

export interface EngineInfo {
  /** AudioContext state, or 'none' before the first init. */
  state: AudioContextState | 'none'
  sampleRate: number
  /** Position reports received from the worklet since the last play (proves the audio thread runs). */
  reports: number
}

const SYNC_DELAY_MS = 120

export class AudioEngine {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private initPromise: Promise<void> | null = null
  private session: SongSession | null = null
  private unbind: (() => void) | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncedVersion = -1
  private listeners = new Set<PositionListener>()
  private pos: PlaybackPosition = { playing: false, order: 0, row: 0, seconds: 0 }
  private loop = true
  private volume = 0.8
  private mutes: (boolean | undefined)[] = []
  private reports = 0

  // ------------------------------------------------------------ wiring

  /** Follow a session: edits made while playing are hot-swapped into the player. */
  bind(session: SongSession): void {
    this.unbind?.()
    this.session = session
    this.syncedVersion = session.history.version
    this.unbind = session.subscribe(() => {
      if (!this.pos.playing) {
        this.syncedVersion = session.history.version
        return
      }
      if (session.history.version === this.syncedVersion) return
      if (this.syncTimer) clearTimeout(this.syncTimer)
      this.syncTimer = setTimeout(() => this.syncSong(), SYNC_DELAY_MS)
    })
  }

  private syncSong(): void {
    this.syncTimer = null
    if (!this.session || !this.pos.playing) return
    this.syncedVersion = this.session.history.version
    this.post({ type: 'song', song: this.session.song })
  }

  /** Subscribe to playhead/playing changes. Returns an unsubscribe function. */
  subscribe(l: PositionListener): () => void {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  private emit(): void {
    const p = { ...this.pos }
    for (const l of [...this.listeners]) l(p)
  }

  private post(msg: ToWorklet): void {
    this.node?.port.postMessage(msg)
  }

  // ------------------------------------------------------------ lifecycle

  /** Create the context and load the worklet (idempotent). Call from a user gesture when possible. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((e: unknown) => {
        this.initPromise = null
        throw e
      })
    }
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (typeof AudioContext === 'undefined') throw new Error('Audio is not available in this environment.')
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const { default: url } = await import('./worklet?worker&url')
    await ctx.audioWorklet.addModule(url)
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data)
    node.connect(ctx.destination)
    this.ctx = ctx
    this.node = node
    this.post({ type: 'volume', value: this.volume })
    this.post({ type: 'loop', loop: this.loop })
    this.mutes.forEach((m, i) => this.post({ type: 'mute', index: i, muted: m }))
  }

  private onMessage(m: FromWorklet): void {
    if (m.type === 'pos') {
      this.reports++
      // A stopped report carries no position: keep the last known one (the view stays where playback ended).
      this.pos = m.playing ? { playing: true, order: m.order, row: m.row, seconds: m.seconds } : { ...this.pos, playing: false }
      this.emit()
    } else if (m.type === 'ended') {
      this.pos = { ...this.pos, playing: false }
      this.emit()
    }
  }

  private async ensureRunning(): Promise<void> {
    await this.init()
    const ctx = this.ctx
    if (ctx && ctx.state !== 'running') {
      // resume() can stay pending when the browser has no audio output; do not hang the caller on it.
      await Promise.race([ctx.resume().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))])
    }
  }

  info(): EngineInfo {
    return { state: this.ctx ? this.ctx.state : 'none', sampleRate: this.ctx?.sampleRate ?? 0, reports: this.reports }
  }

  // ------------------------------------------------------------ transport

  get playing(): boolean {
    return this.pos.playing
  }

  position(): PlaybackPosition {
    return { ...this.pos }
  }

  /** Start playing the bound session's song. Default start: the cursor. */
  async play(from?: { order: number; row?: number }, opts: { loop?: boolean } = {}): Promise<void> {
    const session = this.session
    if (!session) throw new Error('The audio engine is not attached to a song.')
    const song = session.song
    const order = from ? from.order : session.cursor.order
    const row = from ? (from.row ?? 0) : session.cursor.row
    if (!Number.isInteger(order) || order < 0 || order >= song.orders.length) {
      throw new Error(`Order ${order} does not exist: the song has ${song.orders.length} order row(s).`)
    }
    if (opts.loop !== undefined) this.loop = opts.loop
    await this.ensureRunning()
    this.reports = 0
    this.syncedVersion = session.history.version
    this.pos = { playing: true, order, row: Math.max(0, Math.min(song.patternLength - 1, row)), seconds: 0 }
    this.post({ type: 'play', song, order, row: this.pos.row, loop: this.loop })
    this.emit()
  }

  stop(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    this.post({ type: 'stop' })
    this.pos = { ...this.pos, playing: false }
    this.emit()
  }

  seek(order: number, row: number): void {
    this.post({ type: 'seek', order, row })
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    this.post({ type: 'loop', loop })
  }
  get looping(): boolean {
    return this.loop
  }

  setVolume(value: number): void {
    this.volume = value
    this.post({ type: 'volume', value })
  }

  /** Player-level mute for one channel (undefined = follow the song's own muted flag). */
  setMute(index: number, muted: boolean | undefined): void {
    this.mutes[index] = muted
    this.post({ type: 'mute', index, muted })
  }

  /** Play a one-shot audition song (see lib/audition.ts) on top of whatever is playing. */
  async audition(song: Song): Promise<void> {
    await this.ensureRunning()
    this.post({ type: 'audition', song })
  }

  stopAudition(): void {
    this.post({ type: 'stopAudition' })
  }

  dispose(): void {
    this.unbind?.()
    this.unbind = null
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.node?.disconnect()
    void this.ctx?.close()
    this.ctx = null
    this.node = null
    this.initPromise = null
  }
}
