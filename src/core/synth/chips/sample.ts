// Generic sample voices: NES DPCM (DM channel) and the Genesis F6 DAC. Both play a SampleInstrument
// (kind 'sample') from the song's sample slots, resolved through the sample bank (recipes or user PCM).
//
// NES DPCM: the slot is encoded as a 1-bit delta stream (counter moves +-2 around the start level) for the
//   playback rate of the instrument's base note; the note then picks one of the 16 hardware rates like
//   FamiTracker (rate index = 12 + note - baseNote, clamped), so higher notes play the same bits faster.
//   Output is the 7-bit counter in raw DAC units; the mixer's DPCM term and the NES filters shape it.
// Genesis DAC: the slot is quantised to 8 bit and played with sample-and-hold at the note's rate (capped at the
//   ~26 kHz a 68000 driver can feed the YM2612); pitch = playback rate relative to baseNote (default C-4).
//
// A 'rel' (^^^) lets the sample ring out; 'off' / note cut stops it. Volume (Genesis only) is the cell volume.

import type { Instrument, SampleInstrument, Song } from '../../types'
import type { ChannelControl } from '../sequencer'
import { DPCM_START_LEVEL, dacQuantize, dpcmRates, prepareDpcm, tryResolveSampleSlot } from '../samplegen/bank'
import { clamp, midiToHz } from '../tables'
import { type ChipVoice, type VoiceArgs, registerVoice } from './types'

const DAC_MAX_RATE = 26000
/** DPCM rate index that plays the instrument's base note. */
export const DPCM_BASE_RATE_INDEX = 12

const dacCache = new WeakMap<Int16Array, Int8Array>()

function quantized(pcm: Int16Array): Int8Array {
  let q = dacCache.get(pcm)
  if (!q) {
    q = dacQuantize(pcm)
    dacCache.set(pcm, q)
  }
  return q
}

function sampleInst(inst: Instrument | undefined): SampleInstrument | null {
  return inst && inst.kind === 'sample' ? inst : null
}

/** Genesis F6 DAC. */
export class DacVoice implements ChipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.4
  private song: Song
  private q: Int8Array = new Int8Array(0)
  private pcmRate = 22050
  private loopStart = -1
  private baseNote = 60
  private playing = false
  private pos = 0
  private tickAcc = 0
  private level = 0
  private vol = 1
  private srcStep = 22050
  private dacClock = 22050
  private readonly invOut: number

  constructor(args: VoiceArgs) {
    this.song = args.song
    this.invOut = 1 / args.sampleRate
    this.warm()
  }

  private warm(): void {
    for (const i of this.song.instruments) if (i.kind === 'sample') tryResolveSampleSlot(this.song, i.sample, 'raw')
  }

  setSong(song: Song): void {
    this.song = song
    this.warm()
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const e = sampleInst(inst)
    if (c.gate || c.vol > 0) this.vol = c.vol
    if (c.trigger && e) {
      const r = tryResolveSampleSlot(this.song, e.sample, 'raw')
      if (r && r.pcm.length > 0) {
        this.q = quantized(r.pcm)
        this.pcmRate = r.sampleRate
        this.loopStart = r.loopStart !== undefined ? r.loopStart : -1
        this.baseNote = e.baseNote ?? 60
        this.pos = 0
        this.tickAcc = 1
        this.playing = true
      } else this.playing = false
    }
    if (!c.gate && !c.release && !c.trigger) this.playing = false
    if (this.playing) {
      const ratio = c.freqHz / midiToHz(this.baseNote)
      this.srcStep = this.pcmRate * ratio
      this.dacClock = Math.min(this.srcStep, DAC_MAX_RATE)
    }
  }

  render(buf: Float32Array, from: number, to: number): void {
    const q = this.q
    for (let i = from; i < to; i++) {
      if (this.playing) {
        this.tickAcc += this.dacClock * this.invOut
        while (this.tickAcc >= 1 && this.playing) {
          this.tickAcc -= 1
          let idx = Math.floor(this.pos)
          if (idx >= q.length) {
            if (this.loopStart >= 0 && this.loopStart < q.length) {
              this.pos = this.loopStart + (this.pos - q.length)
              idx = Math.floor(this.pos)
            } else {
              this.playing = false
              break
            }
          }
          this.level = q[idx]! / 128
          this.pos += this.srcStep / this.dacClock
        }
      } else if (this.level !== 0) this.level = Math.abs(this.level) < 1e-4 ? 0 : this.level * 0.99 // the DAC output relaxes to zero (no click, no held DC)
      buf[i] = this.level * this.vol
    }
  }

  reset(): void {
    this.playing = false
    this.pos = 0
    this.tickAcc = 0
    this.level = 0
    this.vol = 1
  }
}

/** NES DM channel: 1-bit delta DPCM. */
export class DpcmVoice implements ChipVoice {
  readonly mixGroup = 'dpcm' as const
  readonly linearGain = 0.0055
  private song: Song
  private readonly rates: number[]
  private readonly invOut: number
  private levels: Uint8Array = new Uint8Array(0)
  private playing = false
  private bit = 0
  private acc = 0
  private rate = 16000
  private level = 0

  constructor(args: VoiceArgs) {
    this.song = args.song
    this.rates = dpcmRates(args.song.chipConfig.chip === 'nes' ? args.song.chipConfig.region : 'ntsc')
    this.invOut = 1 / args.sampleRate
    this.warm()
  }

  private warm(): void {
    for (const i of this.song.instruments) if (i.kind === 'sample') prepareDpcm(this.song, i.sample, this.rates[DPCM_BASE_RATE_INDEX]!)
  }

  setSong(song: Song): void {
    this.song = song
    this.warm()
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const e = sampleInst(inst)
    if (c.trigger && e) {
      const data = prepareDpcm(this.song, e.sample, this.rates[DPCM_BASE_RATE_INDEX]!)
      if (data) {
        const idx = clamp(DPCM_BASE_RATE_INDEX + Math.round(c.note) - (e.baseNote ?? 60), 0, 15)
        this.levels = data.levels
        this.rate = this.rates[idx]!
        this.bit = 0
        this.acc = 0
        this.level = DPCM_START_LEVEL
        this.playing = true
      }
    }
    if (!c.gate && !c.release && !c.trigger) this.playing = false
  }

  render(buf: Float32Array, from: number, to: number): void {
    const levels = this.levels
    for (let i = from; i < to; i++) {
      if (this.playing) {
        this.acc += this.rate * this.invOut
        while (this.acc >= 1) {
          this.acc -= 1
          if (this.bit >= levels.length) {
            this.playing = false
            break
          }
          this.level = levels[this.bit++]!
        }
      }
      buf[i] = this.level
    }
  }

  reset(): void {
    this.playing = false
    this.bit = 0
    this.acc = 0
    this.level = 0
  }
}

registerVoice('nes', 'dpcm', (a): ChipVoice => new DpcmVoice(a))
registerVoice('genesis', 'sample', (a): ChipVoice => new DacVoice(a))
