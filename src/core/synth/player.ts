// SongPlayer: sequencer + chip voices + mixer, driven in blocks of any size (128 frames in the worklet,
// large chunks offline). The hot path (`process`) allocates nothing. Output does not depend on how the
// frames are split into blocks.

import type { Song } from '../types'
import { createVoice, type AuxOutput, type ChipVoice } from './chips/types'
import './chips/index'
import { Mixer, type MixModel, type StemBuffer } from './mixer'
import { Sequencer } from './sequencer'
import { type Timeline, buildTimeline } from './timeline'

export interface PlayerOptions {
  /** Largest chunk rendered at once (scratch size). Default 4096. */
  maxBlock?: number
  /** Override the NES mix model (default: the song's chipConfig.mixModel). */
  mixModel?: MixModel
  startOrder?: number
  startRow?: number
}

export interface PlayerPosition {
  order: number
  row: number
  tick: number
  /** Seconds from the start of the song to the played tick (first-lap timeline position). */
  seconds: number
}

function layoutKey(song: Song): string {
  return song.chip + '|' + song.channels.map((c) => `${c.id}:${c.kind}`).join(',')
}

export class SongPlayer {
  readonly sampleRate: number
  private song: Song
  private seq: Sequencer
  private timeline: Timeline
  private voices: ChipVoice[] = []
  private raw: Float32Array[] = []
  private mixer!: Mixer
  /** Shared buses exposed by voices (the SNES echo), rendered after all voices; one scratch buffer pair per bus. */
  private auxes: AuxOutput[] = []
  private auxBufs: StemBuffer[] = []
  private readonly maxBlock: number
  private readonly mixModel: MixModel | undefined
  private userMute: (boolean | undefined)[] = []
  private key = ''
  /** Exact (fractional) accumulated tick lengths in frames, and frames processed so far. */
  private acc = 0
  private framePos = 0
  private samplesLeft = 0
  private done = false

  constructor(song: Song, sampleRate: number, opts: PlayerOptions = {}) {
    this.song = song
    this.sampleRate = sampleRate
    this.maxBlock = Math.max(16, opts.maxBlock ?? 4096)
    this.mixModel = opts.mixModel
    this.seq = new Sequencer(song, opts.startOrder ?? 0, opts.startRow ?? 0)
    this.timeline = buildTimeline(song)
    this.buildVoices()
    this.done = this.seq.ended
  }

  private buildVoices(): void {
    const song = this.song
    this.key = layoutKey(song)
    this.voices = song.channels.map((channel, index) =>
      createVoice({ song, channel, index, sampleRate: this.sampleRate, maxBlock: this.maxBlock })
    )
    this.raw = this.voices.map(() => new Float32Array(this.maxBlock))
    this.auxes = this.voices.flatMap((v) => (v.aux ? [v.aux] : []))
    this.auxBufs = this.auxes.map(() => ({ L: new Float32Array(this.maxBlock), R: new Float32Array(this.maxBlock) }))
    this.mixer = new Mixer(song, this.voices, { sampleRate: this.sampleRate, maxBlock: this.maxBlock, mixModel: this.mixModel })
    this.applyMutes()
  }

  private applyMutes(): void {
    for (let i = 0; i < this.voices.length; i++) {
      const m = this.userMute[i] ?? this.song.channels[i]?.muted ?? false
      this.mixer.muted[i] = m
      this.voices[i]!.setMuted?.(m)
    }
  }

  /** Ids of the extra stems (shared buses such as '_echo'), in the order process() expects `auxStems`. */
  get auxIds(): string[] {
    return this.auxes.map((a) => a.id)
  }

  /** True once a one-shot song has played to its end (the player keeps producing silence/tails). */
  get finished(): boolean {
    return this.done
  }

  get currentSong(): Song {
    return this.song
  }

  setMute(channelIndex: number, muted: boolean | undefined): void {
    this.userMute[channelIndex] = muted
    this.applyMutes()
  }

  /** Replace the song keeping the playhead (the chip voices are kept when the channel layout is unchanged). */
  setSong(song: Song): void {
    this.song = song
    this.seq.setSong(song)
    this.timeline = buildTimeline(song)
    if (layoutKey(song) !== this.key) {
      this.buildVoices()
      this.seq.reset(this.seq.position().order, this.seq.position().row)
    } else {
      for (const v of this.voices) v.setSong?.(song)
      this.mixer.setSong(song, this.voices)
      this.applyMutes()
    }
    if (!this.seq.ended) this.done = false
  }

  /** Jump to the start of (order,row) without rendering audio; voices are silenced. */
  seek(pos: { order: number; row: number }): void {
    this.seq.seek(pos.order, pos.row)
    for (const v of this.voices) v.reset()
    this.mixer.reset()
    this.acc = this.framePos
    this.samplesLeft = 0
    this.done = this.seq.ended
  }

  position(): PlayerPosition {
    const p = this.seq.position()
    const s = this.timeline.secondsAt(p.order, p.row, p.tick)
    return { order: p.order, row: p.row, tick: p.tick, seconds: s < 0 ? 0 : s }
  }

  /** Frames rendered since construction. */
  get frames(): number {
    return this.framePos
  }

  private startTick(): void {
    const alive = !this.done && this.seq.tick()
    if (!alive) {
      this.done = true
      this.seq.silence()
      this.samplesLeft = this.maxBlock
    }
    const song = this.song
    const controls = this.seq.controls
    for (let c = 0; c < this.voices.length; c++) {
      const ctl = controls[c]
      if (!ctl) continue
      this.voices[c]!.control(ctl, song.instruments[ctl.inst])
      this.mixer.setPan(c, ctl.pan)
    }
    if (alive) {
      this.acc += this.seq.samplesPerTick(this.sampleRate)
      this.samplesLeft = Math.max(1, Math.round(this.acc) - this.framePos)
    }
  }

  /**
   * Render L.length frames into L/R (overwritten). `stems[i]` (optional) receives channel i's stereo stem
   * (pre-limiter), each at least L.length long. `auxStems[j]` receives shared bus j (see `auxIds`), e.g. the SNES echo.
   */
  process(L: Float32Array, R: Float32Array, stems?: readonly StemBuffer[], auxStems?: readonly StemBuffer[]): void {
    const n = L.length
    let off = 0
    while (off < n) {
      if (this.samplesLeft <= 0) this.startTick()
      const chunk = Math.min(n - off, this.samplesLeft, this.maxBlock)
      for (let c = 0; c < this.voices.length; c++) this.voices[c]!.render(this.raw[c]!, 0, chunk)
      for (let a = 0; a < this.auxes.length; a++) this.auxes[a]!.render(this.auxBufs[a]!.L, this.auxBufs[a]!.R, chunk)
      this.mixer.mix(this.raw, chunk, L, R, off, stems, this.auxBufs, auxStems)
      off += chunk
      this.samplesLeft -= chunk
      this.framePos += chunk
    }
  }
}
