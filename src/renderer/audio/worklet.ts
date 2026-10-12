// AudioWorklet processor: runs the same SongPlayer as the offline renderer, 128 frames per block.
//
// The main thread (audioEngine.ts) sends the song by structured clone; edits are hot-swapped into the running
// player (`setSong`), which keeps the playhead. The processor reports its position ~30 times a second and
// tells the main thread when playback ended (one-shot song finished, or the loop point was reached with
// looping off). A second, short-lived player renders audition notes on top of the song.
//
// Imports only core/synth (no zod, no theory data) to keep this bundle small.

import { SongPlayer } from '../../core/synth'
import { type FromWorklet, type ToWorklet, POSITION_HZ, WORKLET_NAME } from './protocol'

// AudioWorkletGlobalScope globals (not in the DOM lib).
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

/** Silence kept after a one-shot song or a loop-less wrap so release/echo tails ring out. */
const TAIL_SEC = 1
/** Audition note length (note + release tail). */
const AUDITION_SEC = 1.6

class SongProcessor extends AudioWorkletProcessor {
  private player: SongPlayer | null = null
  private playing = false
  private loop = true
  private volume = 0.8
  private mutes: (boolean | undefined)[] = []
  private sinceReport = 0
  private reportEvery: number
  private lastSeconds = 0
  private tailFrames = -1
  private audition: SongPlayer | null = null
  private auditionFramesLeft = 0
  private scratchL = new Float32Array(128)
  private scratchR = new Float32Array(128)

  constructor() {
    super()
    this.reportEvery = Math.max(128, Math.round(sampleRate / POSITION_HZ))
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data)
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg)
  }

  private applyMutes(): void {
    if (!this.player) return
    this.mutes.forEach((m, i) => this.player!.setMute(i, m))
  }

  private onMessage(m: ToWorklet): void {
    switch (m.type) {
      case 'play':
        this.player = new SongPlayer(m.song, sampleRate, { startOrder: m.order, startRow: m.row })
        this.applyMutes()
        this.loop = m.loop
        this.playing = true
        this.tailFrames = -1
        this.lastSeconds = this.player.position().seconds
        this.sinceReport = this.reportEvery
        break
      case 'song':
        if (this.player) this.player.setSong(m.song)
        break
      case 'stop':
        this.playing = false
        this.player = null
        this.post({ type: 'pos', playing: false, order: 0, row: 0, seconds: 0 })
        break
      case 'seek':
        this.player?.seek({ order: m.order, row: m.row })
        this.tailFrames = -1
        this.lastSeconds = this.player ? this.player.position().seconds : 0
        break
      case 'loop':
        this.loop = m.loop
        break
      case 'volume':
        this.volume = Math.max(0, Math.min(1.5, m.value))
        break
      case 'mute':
        this.mutes[m.index] = m.muted
        this.player?.setMute(m.index, m.muted)
        break
      case 'audition':
        this.audition = new SongPlayer(m.song, sampleRate)
        this.auditionFramesLeft = Math.round(AUDITION_SEC * sampleRate)
        break
      case 'stopAudition':
        this.audition = null
        break
    }
  }

  private finish(): void {
    this.playing = false
    this.player = null
    this.post({ type: 'ended' })
    this.post({ type: 'pos', playing: false, order: 0, row: 0, seconds: 0 })
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const L = out?.[0]
    if (!out || !L) return true
    const R = out[1] ?? L
    const n = L.length
    const vol = this.volume

    if (this.player && this.playing) {
      const p = this.player
      p.process(L, R)
      for (let i = 0; i < n; i++) {
        L[i] = L[i]! * vol
        if (R !== L) R[i] = R[i]! * vol
      }
      this.sinceReport += n
      if (this.tailFrames >= 0) {
        this.tailFrames += n
        if (this.tailFrames >= TAIL_SEC * sampleRate) this.finish()
      } else if (p.finished) {
        this.tailFrames = 0
      }
      if (this.player && this.sinceReport >= this.reportEvery) {
        this.sinceReport = 0
        const pos = p.position()
        if (!this.loop && this.tailFrames < 0 && pos.seconds < this.lastSeconds - 0.05) {
          // The song wrapped to its loop point: with looping off, ring out and stop.
          this.tailFrames = 0
        }
        this.lastSeconds = pos.seconds
        this.post({ type: 'pos', playing: true, order: pos.order, row: pos.row, seconds: pos.seconds })
      }
    } else {
      L.fill(0)
      if (R !== L) R.fill(0)
    }

    if (this.audition) {
      if (this.scratchL.length < n) {
        this.scratchL = new Float32Array(n)
        this.scratchR = new Float32Array(n)
      }
      const sl = this.scratchL.subarray(0, n)
      const sr = this.scratchR.subarray(0, n)
      this.audition.process(sl, sr)
      for (let i = 0; i < n; i++) {
        L[i] = L[i]! + sl[i]! * vol
        if (R !== L) R[i] = R[i]! + sr[i]! * vol
      }
      this.auditionFramesLeft -= n
      if (this.auditionFramesLeft <= 0) this.audition = null
    }
    return true
  }
}

registerProcessor(WORKLET_NAME, SongProcessor)
