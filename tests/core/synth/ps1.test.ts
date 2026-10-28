// MDI-10 Phase B: the PlayStation SPU chip (PS-X ADPCM, voice pitch and ADSR, pitch modulation, noise, hardware reverb,
// SPU RAM budget, determinism) and the golden hash of the PS1 demo song (UPDATE_GOLDEN=1 regenerates it).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRESET_BANKS, SNES_PRESETS, createSong, getChipProfile, missingPresetSample, resolvePreset, validateInstrument } from '../../../src/core'
import { writeWav } from '../../../src/core/codecs/wav'
import { SPU_RAM_BYTES, SPU_RESERVED_BYTES, spuRamUsage } from '../../../src/core/chips/ps1'
import { PS1_PRESETS, psxAttackSeconds, psxReleaseTauSec } from '../../../src/core/instruments/presets/ps1'
import { snesEnvTimes } from '../../../src/core/instruments/presets/snesTimes'
import { SpuVoice } from '../../../src/core/synth/chips/spu'
import { SPU_REVERB_PRESETS, SpuReverb, spuReverbBytes, spuReverbFirstRepeatMs } from '../../../src/core/synth/chips/spuReverb'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { interleave, quantizeStereo } from '../../../src/core/synth/mixer'
import { SongPlayer } from '../../../src/core/synth/player'
import { type RenderResult, renderSong } from '../../../src/core/synth/render'
import { GAUSS, generateRaw, pcmToBase64, resolveSlot, snrDb, tryPeekSampleLength } from '../../../src/core/synth/samplegen'
import { PSX_BLOCK_BYTES, PSX_BLOCK_SAMPLES, decodePsx, encodePsx, processForPsx, processUserPcmForPsx, psxByteSize } from '../../../src/core/synth/samplegen/psxAdpcm'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Ps1ReverbPreset, PsxAdsr, PsxSampleInstrument, Song } from '../../../src/core/types'
import { PS1_REVERB_PRESETS } from '../../../src/core/types'
import { put } from './fixtures'

const SR = 44100
/** Period of the test sine: 16 whole ADPCM blocks (a loop must be a whole number of 28-sample blocks). */
const SINE_LEN = 448
const SINE_HZ = SR / SINE_LEN

// ---------------------------------------------------------------------------------------------
// helpers

function ps1Song(presets: string[], patternLength = 16, voices: 16 | 24 = 16): Song {
  const s = createSong({ chip: 'ps1', patternLength, authenticity: 'relaxed', chipConfig: { chip: 'ps1', voices, reverb: { preset: 'studio-large', depth: 0.5, inputVol: 1 } } })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  for (const id of presets) {
    const inst = resolvePreset('ps1', id)
    const slot = missingPresetSample(s, inst)
    if (slot) s.samples.push(slot)
    s.instruments.push(inst)
  }
  return s
}

const ADSR_HOLD: PsxAdsr = { attack: 0, attackExp: false, decay: 0, sustainLevel: 15, sustainRate: 127, sustainDir: 'dec', sustainExp: true, release: 12, releaseExp: true }

/** A song whose samples are a looping DC and a looping 98.4 Hz sine (448 samples at 44.1 kHz, base note 60), instruments 0..n from `defs`. */
function toneSong(defs: { sample: 'dc' | 'sine' | 'dc-neg'; adsr?: Partial<PsxAdsr>; extra?: Partial<PsxSampleInstrument> }[], dc = 16384): Song {
  const s = createSong({ chip: 'ps1', patternLength: 16, authenticity: 'relaxed' })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  const sine = new Int16Array(SINE_LEN)
  for (let i = 0; i < sine.length; i++) sine[i] = Math.round(16000 * Math.sin((2 * Math.PI * i) / SINE_LEN))
  s.samples.push({ id: 'dc', name: 'dc', source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(new Int16Array(560).fill(dc)) }, loopStart: 0 })
  s.samples.push({ id: 'dc-neg', name: 'dc-neg', source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(new Int16Array(560).fill(-dc)) }, loopStart: 0 })
  s.samples.push({ id: 'sine', name: 'sine', source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(sine) }, loopStart: 0 })
  defs.forEach((d, i) => {
    s.instruments.push({ kind: 'psx-sample', name: `t${i}`, sample: d.sample, baseNote: 60, adsr: { ...ADSR_HOLD, ...d.adsr }, reverb: false, ...d.extra })
  })
  return s
}

function voiceOf(song: Song, index = 0, sampleRate = SR): SpuVoice {
  return createVoice({ song, channel: song.channels[index]!, index, sampleRate, maxBlock: 4096 }) as SpuVoice
}

function noteControl(midi: number, over: Partial<ReturnType<typeof newChannelControl>> = {}, inst = 0): ReturnType<typeof newChannelControl> {
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = 1
  c.rawVol = 1
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.note = midi
  c.inst = inst
  Object.assign(c, over)
  return c
}

function releaseControl(over: Partial<ReturnType<typeof newChannelControl>> = {}): ReturnType<typeof newChannelControl> {
  const c = newChannelControl()
  c.trigger = false
  c.gate = false
  c.vol = 1
  c.release = true
  Object.assign(c, over)
  return c
}

function renderFrames(v: SpuVoice, frames: number): Float32Array {
  const out = new Float32Array(frames)
  for (let off = 0; off < frames; off += 4096) v.render(out.subarray(off, Math.min(frames, off + 4096)), 0, Math.min(4096, frames - off))
  return out
}

function renderNote(song: Song, midi: number, seconds: number, sampleRate = SR): Float32Array {
  const v = voiceOf(song, 0, sampleRate)
  v.control(noteControl(midi), song.instruments[0])
  return renderFrames(v, Math.round(seconds * sampleRate))
}

/** Frames until `pred` holds for the voice's envelope level (rendering `step` frames at a time); -1 when it never does. */
function framesUntil(v: SpuVoice, pred: (level: number) => boolean, max = SR * 4, step = 4): number {
  const buf = new Float32Array(step)
  for (let f = 0; f < max; f += step) {
    v.render(buf, 0, step)
    if (pred(v.envelopeLevel)) return f + step
  }
  return -1
}

function measureHz(x: Float32Array, sr: number): number {
  let mean = 0
  for (const v of x) mean += v
  mean /= x.length
  const cross: number[] = []
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]! - mean
    const b = x[i]! - mean
    if (a < 0 && b >= 0) cross.push(i - 1 + -a / (b - a))
  }
  if (cross.length < 3) return 0
  return ((cross.length - 1) * sr) / (cross.at(-1)! - cross[0]!)
}

/** f0 by normalised autocorrelation with parabolic refinement. */
function autocorrHz(x: Float32Array, sr: number, minHz: number, maxHz: number): number {
  const minLag = Math.floor(sr / maxHz)
  const maxLag = Math.ceil(sr / minHz)
  const n = x.length - maxLag - 1
  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = 0; i < n; i++) s += x[i]! * x[i + lag]!
    r[lag] = s
  }
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag]! > r[best]!) best = lag
  const a = r[best - 1]!
  const b = r[best]!
  const c = r[best + 1]!
  const d = a - 2 * b + c
  return sr / (best + (d === 0 ? 0 : (0.5 * (a - c)) / d))
}

function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function rms(x: Float32Array): number {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / Math.max(1, x.length))
}

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
}

// ---------------------------------------------------------------------------------------------

describe('PS-X ADPCM codec', () => {
  it('has 16-byte blocks of 28 samples and the documented byte size', () => {
    expect(PSX_BLOCK_SAMPLES).toBe(28)
    expect(PSX_BLOCK_BYTES).toBe(16)
    const pcm = new Int16Array(100).map((_, i) => Math.round(8000 * Math.sin(i / 5)))
    const e = encodePsx(pcm)
    expect(e.blocks).toBe(Math.ceil(100 / 28))
    expect(e.bytes.length).toBe(psxByteSize(100))
    expect(e.bytes.length).toBe(e.blocks * 16)
    expect(e.decoded.length).toBe(e.blocks * 28)
    // the last block carries the end flag, no loop
    expect(e.bytes[e.bytes.length - 15]).toBe(1)
    // the decoder reproduces the encoder's closed-loop output exactly
    expect(Array.from(decodePsx(e.bytes).pcm)).toEqual(Array.from(e.decoded))
  })

  it('decodes hand-made blocks (filter 0, filter 1, shift 13 = 9, flags)', () => {
    const block = (header: number, flags: number, nibbles: number[]): number[] => {
      const out = [header, flags]
      for (let i = 0; i < 28; i += 2) out.push(((nibbles[i + 1] ?? 0) & 15) << 4 | ((nibbles[i] ?? 0) & 15))
      return out
    }
    // shift 12, filter 0: the nibble is the sample
    const n0 = [1, 2, 3, 7, -8, -1, 0, 5]
    const b0 = decodePsx(Uint8Array.from(block(12, 4, n0)))
    expect(Array.from(b0.pcm.subarray(0, 8))).toEqual(n0)
    expect(b0.flags).toEqual([4])
    // shift 8 scales by 16
    expect(Array.from(decodePsx(Uint8Array.from(block(8, 0, [1, -2, 7]))).pcm.subarray(0, 3))).toEqual([16, -32, 112])
    // shifts 13..15 behave like 9 (psx-spx): 1 << 12 >> 9 = 8
    expect(decodePsx(Uint8Array.from(block(13, 0, [1]))).pcm[0]).toBe(8)
    expect(decodePsx(Uint8Array.from(block(15, 0, [-1]))).pcm[0]).toBe(-8)
    // filter 1 (60/64) and filter 2 (115/64, -52/64) with an independent reference
    for (const [filter, f0, f1] of [[1, 60, 0], [2, 115, -52], [3, 98, -55], [4, 122, -60]] as const) {
      const nib = [7, 0, 0, -3, 2, 0, 0, 0, 5, 0, 0, 0, -8, 0]
      const got = decodePsx(Uint8Array.from(block(12 | (filter << 4), 0, nib))).pcm
      let p1 = 0
      let p2 = 0
      for (let i = 0; i < 14; i++) {
        let v = nib[i]! + Math.floor((p1 * f0 + p2 * f1 + 32) / 64)
        v = Math.max(-32768, Math.min(32767, v))
        expect(got[i], `filter ${filter} sample ${i}`).toBe(v)
        p2 = p1
        p1 = v
      }
    }
  })

  it('aligns the loop start down to a block, keeps whole loop blocks and flags them', () => {
    const raw = { pcm: new Int16Array(1000).map((_, i) => Math.round(9000 * Math.sin(i / 7))), sampleRate: 22050, loopStart: 100, baseNote: 60 }
    const r = processForPsx(raw)
    expect(r.loopStart! % 28).toBe(0)
    expect(r.pcm.length % 28).toBe(0)
    expect((r.pcm.length - r.loopStart!) % 28).toBe(0)
    // the loop is resampled to whole blocks and the rate scaled with it, so the loop frequency is unchanged
    const loopSec = (raw.pcm.length - raw.loopStart!) / raw.sampleRate
    expect((r.pcm.length - r.loopStart!) / r.sampleRate / loopSec).toBeGreaterThan(0.999)
    expect((r.pcm.length - r.loopStart!) / r.sampleRate / loopSec).toBeLessThan(1.001)
    expect(r.sampleRate).toBeLessThan(22050)
    // already aligned samples are untouched
    const aligned = processForPsx({ pcm: raw.pcm.subarray(0, 28 * 20), sampleRate: 22050, loopStart: 56, baseNote: 60 })
    expect(aligned.loopStart).toBe(56)
    expect(aligned.pcm.length).toBe(28 * 20)
    expect(aligned.sampleRate).toBe(22050)
    const e = encodePsx(aligned.pcm, { loopStart: 56 })
    expect(e.loopStart).toBe(56)
    expect(e.bytes[2 * 16 + 1]! & 4).toBe(4) // loop-start flag
    expect(e.bytes[2 * 16]! >> 4).toBe(0) // the loop-start block uses filter 0 (it does not depend on the history)
    expect(e.bytes[e.bytes.length - 15]).toBe(3) // loop end + repeat
    // a 256-sample loop keeps its pitch (a plain trim to 252 samples would be 27 cents sharp)
    const cyc = new Int16Array(256).map((_, i) => Math.round(9000 * Math.sin((2 * Math.PI * i) / 256)))
    const c = processForPsx({ pcm: cyc, sampleRate: 33488, loopStart: 0, baseNote: 72 })
    expect(c.pcm.length).toBe(252)
    expect(c.pcm.length / c.sampleRate / (256 / 33488)).toBeGreaterThan(0.999)
    expect(c.pcm.length / c.sampleRate / (256 / 33488)).toBeLessThan(1.001)
    // one-shots keep their length rounded up to blocks
    expect(processForPsx({ pcm: new Int16Array(100), sampleRate: 16000, baseNote: 60 }).pcm.length).toBe(112)
    // tiny samples are padded to one block
    expect(processForPsx({ pcm: new Int16Array(5), sampleRate: 16000, baseNote: 60 }).pcm.length).toBe(28)
  })

  it('resamples user PCM above 48 kHz to 44.1 kHz and keeps lower rates', () => {
    const tone = (rate: number): Int16Array => new Int16Array(rate / 2).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)))
    const hi = processUserPcmForPsx({ pcm: tone(96000), sampleRate: 96000, baseNote: 60 })
    expect(hi.sampleRate).toBe(44100)
    expect(hi.pcm.length).toBeGreaterThan(22050 - 30)
    expect(hi.pcm.length).toBeLessThan(22050 + 30)
    expect(processUserPcmForPsx({ pcm: tone(22050), sampleRate: 22050, baseNote: 60 }).sampleRate).toBe(22050)
    expect(processUserPcmForPsx({ pcm: tone(48000), sampleRate: 48000, baseNote: 60 }).sampleRate).toBe(48000)
  })

  it('keeps the strings recipe above 25 dB SNR and the target resolves slots', () => {
    const raw = generateRaw('strings', {})
    // the codec alone (a closed-loop encode of the recipe's PCM)
    expect(snrDb(raw.pcm, encodePsx(raw.pcm, { loopStart: raw.loopStart! }).decoded)).toBeGreaterThan(25)
    // the pipeline also rescales the loop to whole blocks: the level and the loop duration are kept
    const r = processForPsx(raw)
    expect(r.loopStart! % 28).toBe(0)
    expect(rms(Float32Array.from(r.pcm)) / rms(Float32Array.from(raw.pcm))).toBeGreaterThan(0.95)
    expect(rms(Float32Array.from(r.pcm)) / rms(Float32Array.from(raw.pcm))).toBeLessThan(1.05)
    expect((r.pcm.length - r.loopStart!) / r.sampleRate / ((raw.pcm.length - raw.loopStart!) / raw.sampleRate)).toBeGreaterThan(0.999)
    const song = createSong({ chip: 'ps1' })
    song.samples.push({ id: 'st', name: 'st', source: { kind: 'recipe', recipe: 'strings', params: {} } })
    expect(resolveSlot(song.samples[0]!, 'psx').pcm.length).toBe(r.pcm.length)
    expect(tryPeekSampleLength(song.samples[0]!, 'psx')).toBe(r.pcm.length)
  })
})

describe('SPU voice pitch', () => {
  it('plays base note, +-12 and +-24 in tune', () => {
    const song = ps1Song(['ps1.lead.square'])
    const base = 72
    for (const [note, expected] of [[base, midiToHz(base)], [base - 12, midiToHz(base - 12)], [base - 24, midiToHz(base - 24)], [base + 12, midiToHz(base + 12)]] as const) {
      const hz = measureHz(renderNote(song, note, 0.5).subarray(4410), SR)
      expect(hz / expected, `note ${note}`).toBeGreaterThan(0.985)
      expect(hz / expected, `note ${note}`).toBeLessThan(1.015)
    }
  })

  it('clamps the pitch register at 0x4000 and uses 0x1000 = 44.1 kHz', () => {
    const song = ps1Song(['ps1.lead.square'])
    const v = voiceOf(song)
    v.control(noteControl(72 + 40), song.instruments[0])
    expect(v.pitchRegister).toBe(0x4000)
    const w = voiceOf(song)
    w.control(noteControl(72), song.instruments[0])
    const g = resolveSlot(song.samples[0]!, 'psx')
    expect(w.pitchRegister).toBe(Math.round((g.sampleRate / 44100) * 0x1000))
    // a 44.1 kHz sample at its base note is exactly 0x1000
    const t = toneSong([{ sample: 'dc' }])
    const x = voiceOf(t)
    x.control(noteControl(60), t.instruments[0])
    expect(x.pitchRegister).toBe(0x1000)
  })

  it('the Gaussian interpolator keeps DC (taps sum to unity)', () => {
    for (let g = 0; g < 256; g++) expect(Math.abs(GAUSS[255 - g]! + GAUSS[511 - g]! + GAUSS[256 + g]! + GAUSS[g]! - 2048)).toBeLessThanOrEqual(1)
    const song = toneSong([{ sample: 'dc' }], 8192)
    const out = renderNote(song, 64, 0.5)
    const body = out.subarray(8000)
    const mean = body.reduce((a, b) => a + b, 0) / body.length
    expect(mean).toBeGreaterThan(0.05)
    expect(Math.sqrt(body.reduce((a, b) => a + (b - mean) ** 2, 0) / body.length) / mean).toBeLessThan(0.01)
  })
})

/** Full level to within the -5 step the sustain phase takes once (a hold is shift 31: -5 every 2^20 samples). */
const FULL = 0x7fff - 16

describe('SPU ADSR', () => {
  const song = (adsr: Partial<PsxAdsr>): Song => toneSong([{ sample: 'dc', adsr }])

  it('linear attack takes the documented time, an exponential attack is 1.75x slower (slow above 0x6000)', () => {
    const rate = 40 // shift 10, step 7: +14 per sample
    const lin = framesUntil(voiceStarted(song({ attack: rate })), (l) => l >= FULL)
    expect(lin / SR).toBeGreaterThan(psxAttackSeconds(rate) * 0.97)
    expect(lin / SR).toBeLessThan(psxAttackSeconds(rate) * 1.03 + 0.0002)
    const exp = framesUntil(voiceStarted(song({ attack: rate, attackExp: true })), (l) => l >= FULL)
    expect(exp / lin).toBeGreaterThan(1.7)
    expect(exp / lin).toBeLessThan(1.8)
    // rate 0 is the fastest: full level within a handful of samples
    expect(framesUntil(voiceStarted(song({ attack: 0 })), (l) => l >= FULL)).toBeLessThanOrEqual(8)
  })

  function voiceStarted(s: Song): SpuVoice {
    const v = voiceOf(s)
    v.control(noteControl(60), s.instruments[0])
    return v
  }

  it('decays exponentially to the sustain level, then holds or decreases', () => {
    const v = voiceStarted(song({ attack: 0, decay: 6, sustainLevel: 3, sustainRate: 127 }))
    renderFrames(v, 4000)
    expect(v.adsrPhase).toBe(2)
    expect(v.envelopeLevel).toBeGreaterThan(0x2000 - 160)
    expect(v.envelopeLevel).toBeLessThanOrEqual(0x2000)
    const held = v.envelopeLevel
    renderFrames(v, 20000)
    expect(v.envelopeLevel).toBeGreaterThan(held - 4)
    // sustain rate 40 decreasing exponentially (shift 10, step -8 << 1): level += (-16 * level) >> 15 every sample
    const d = voiceStarted(song({ attack: 0, decay: 6, sustainLevel: 7, sustainRate: 40 }))
    renderFrames(d, 400)
    expect(d.adsrPhase).toBe(2)
    let ref = d.envelopeLevel
    expect(ref).toBeLessThanOrEqual(0x4000)
    renderFrames(d, 1500)
    for (let i = 0; i < 1500; i++) ref += (-16 * ref) >> 15
    expect(d.envelopeLevel).toBe(ref)
    // sustain direction 'inc' climbs back to full
    const u = voiceStarted(song({ attack: 0, decay: 6, sustainLevel: 3, sustainRate: 40, sustainDir: 'inc', sustainExp: false }))
    renderFrames(u, 20000)
    expect(u.envelopeLevel).toBeGreaterThan(FULL)
  })

  it('releases with the instrument release on ^^^ and with a fast ramp on a note cut', () => {
    // exponential release, shift 12: time constant 4096 * 2 samples (psxReleaseTauSec)
    const s = song({ release: 12, releaseExp: true })
    const v = voiceStarted(s)
    renderFrames(v, 200)
    expect(v.envelopeLevel).toBeGreaterThan(FULL)
    v.control(releaseControl(), s.instruments[0])
    const t = framesUntil(v, (l) => l <= 0x7fff / Math.E, SR * 4, 8)
    // the hardware's arithmetic shift rounds every decrease down, which makes the real decay a few percent faster than the ideal exponential
    expect(t / SR / psxReleaseTauSec(12)).toBeGreaterThan(0.85)
    expect(t / SR / psxReleaseTauSec(12)).toBeLessThan(1.05)
    // linear release, shift 10 (-16 per sample): 2048 samples to silence, then the voice is off
    const l = song({ release: 10, releaseExp: false })
    const lv = voiceStarted(l)
    renderFrames(lv, 100)
    lv.control(releaseControl(), l.instruments[0])
    const tl = framesUntil(lv, (x) => x === 0, SR, 1)
    expect(tl).toBeGreaterThan(2040)
    expect(tl).toBeLessThan(2060)
    // a note cut (===) ignores the long release
    const c = voiceStarted(s)
    renderFrames(c, 200)
    c.control(releaseControl({ release: false }), s.instruments[0])
    expect(framesUntil(c, (x) => x === 0, SR, 1)).toBeLessThan(400)
  })

  it('a retrigger on a sounding voice fades out first (no click) and then restarts', () => {
    const s = song({ attack: 40 })
    const v = voiceStarted(s)
    renderFrames(v, 3000)
    v.control(noteControl(60), s.instruments[0])
    const out = renderFrames(v, 400)
    let maxStep = 0
    for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!))
    expect(maxStep).toBeLessThan(0.05)
    expect(out[out.length - 1]!).toBeGreaterThan(0.01)
  })

  it('a one-shot sample ends with the end flag: the voice is muted', () => {
    const s = toneSong([{ sample: 'dc' }])
    s.samples[0] = { id: 'dc', name: 'dc', source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(new Int16Array(280).fill(16000)) } }
    const out = renderNote(s, 60, 0.1)
    expect(peak(out.subarray(0, 200))).toBeGreaterThan(0.1)
    expect(peak(out.subarray(1000))).toBe(0)
  })
})

describe('SPU noise', () => {
  const noisy = (shift: number, step = 0): Song => toneSong([{ sample: 'dc', extra: { noise: { shift, step } } }])

  it('is deterministic and replaces the sample only with the noise flag', () => {
    const a = renderNote(noisy(13), 60, 0.3)
    const b = renderNote(noisy(13), 60, 0.3)
    expect(bytesEqual(a, b)).toBe(true)
    expect(rms(a.subarray(2000))).toBeGreaterThan(0.01)
    const spread = (x: Float32Array): number => Math.max(...x.subarray(2000)) - Math.min(...x.subarray(2000))
    expect(spread(a)).toBeGreaterThan(0.1)
    // the same instrument without noise is a flat DC
    const plain = renderNote(toneSong([{ sample: 'dc' }]), 60, 0.3)
    expect(spread(plain)).toBeLessThan(0.001)
  })

  it('a higher shift clocks the LFSR faster (more sign changes) and the step changes the rate a little', () => {
    const flips = (x: Float32Array): number => {
      let n = 0
      for (let i = 3000; i < x.length; i++) if (x[i]! > 0 !== x[i - 1]! > 0) n++
      return n
    }
    const slow = flips(renderNote(noisy(8), 60, 0.5))
    const fast = flips(renderNote(noisy(14), 60, 0.5))
    expect(fast).toBeGreaterThan(slow * 3)
    expect(fast).toBeGreaterThan(1000)
  })

  it('an instrument without noise never touches the generator', () => {
    const s = toneSong([{ sample: 'sine' }])
    const a = renderNote(s, 60, 0.2)
    const b = renderNote(s, 60, 0.2)
    expect(bytesEqual(a, b)).toBe(true)
    expect(measureHz(a.subarray(2000), SR) / SINE_HZ).toBeGreaterThan(0.99)
  })
})

describe('SPU pitch modulation', () => {
  /** V1 plays `modSample` (instrument 0), V2 plays the 100 Hz sine (instrument 1, pmod flag as given); returns V2's output. */
  function v2Output(pmod: boolean, modSample: 'dc' | 'dc-neg' | 'sine', v1Plays: boolean, v2Index = 1): Float32Array {
    const s = toneSong([{ sample: modSample }, { sample: 'sine', extra: pmod ? { pmod: true } : {} }])
    const v1 = voiceOf(s, 0)
    const v2 = voiceOf(s, v2Index)
    if (v1Plays) v1.control(noteControl(60, {}, 0), s.instruments[0])
    v2.control(noteControl(60, {}, 1), s.instruments[1])
    const n = 22050
    const b1 = new Float32Array(4096)
    const b2 = new Float32Array(n)
    for (let off = 0; off < n; off += 4096) {
      const len = Math.min(4096, n - off)
      v1.render(b1, 0, len)
      v2.render(b2.subarray(off, off + len), 0, len)
    }
    return b2
  }

  it('scales the step by 1 + modulator output: a DC of +0.5 gives 1.5x the frequency, -0.5 gives 0.5x', () => {
    const base = measureHz(v2Output(false, 'dc', true).subarray(2000), SR)
    expect(base / SINE_HZ).toBeGreaterThan(0.99)
    expect(base / SINE_HZ).toBeLessThan(1.01)
    const up = measureHz(v2Output(true, 'dc', true).subarray(2000), SR)
    expect(up / base).toBeGreaterThan(1.48)
    expect(up / base).toBeLessThan(1.52)
    const down = measureHz(v2Output(true, 'dc-neg', true).subarray(2000), SR)
    expect(down / base).toBeGreaterThan(0.48)
    expect(down / base).toBeLessThan(0.52)
  })

  it('changes nothing without a modulator voice sounding, and on V1', () => {
    const plain = v2Output(false, 'dc', false)
    expect(bytesEqual(plain, v2Output(true, 'dc', false))).toBe(true)
    // pmod on V1 has no previous voice: the voice plays unmodulated
    const s = toneSong([{ sample: 'sine', extra: { pmod: true } }])
    const s2 = toneSong([{ sample: 'sine' }])
    expect(bytesEqual(renderNote(s, 60, 0.2), renderNote(s2, 60, 0.2))).toBe(true)
    // an audible modulation with a sine modulator differs from the plain voice
    expect(bytesEqual(plain, v2Output(true, 'sine', true))).toBe(false)
  })

  it('reports pmod on V1 as a validation error in strict mode and allows it on V2..', () => {
    const s = toneSong([{ sample: 'sine', extra: { pmod: true } }])
    s.authenticity = 'strict'
    put(s, 'V1', 0, 0, { note: 60, inst: 0, vol: 15 })
    const err = getChipProfile('ps1').validate(s).filter((i) => i.severity === 'error')
    expect(err.map((i) => i.message).join('\n')).toMatch(/V1 has no previous voice to modulate it/)
    const ok = toneSong([{ sample: 'sine', extra: { pmod: true } }])
    ok.authenticity = 'strict'
    put(ok, 'V2', 0, 0, { note: 60, inst: 0, vol: 15 })
    expect(getChipProfile('ps1').validate(ok).filter((i) => i.severity === 'error')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// reverb

function reverbSong(preset: Ps1ReverbPreset, depth = 1): Song {
  const s = createSong({ chip: 'ps1' })
  s.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset, depth, inputVol: 1 } }
  return s
}

/**
 * Drive a reverb bus like the voices do: a block of `len` output frames consumes the DSP steps the 44.1 kHz voice clock
 * takes (the first block of a fresh clock one less than its length). A 0.5 impulse is put on the left (or right) send at step 0.
 */
function runBus(song: Song, total: number, sizes: number[] = [4096], side: 'L' | 'R' = 'L', level = 0.5): { L: Float32Array; R: Float32Array } {
  const bus = new SpuReverb(SR, 4096)
  bus.configure(song)
  const L = new Float32Array(total)
  const R = new Float32Array(total)
  const bl = new Float32Array(4096)
  const br = new Float32Array(4096)
  let frac = 0
  let off = 0
  let i = 0
  while (off < total) {
    const len = Math.min(sizes[i++ % sizes.length]!, total - off)
    let k = 0
    for (let f = 0; f < len; f++) {
      while (frac >= 1) {
        frac -= 1
        k++
      }
      frac += 1
    }
    if (off === 0) (side === 'L' ? bus.sendL : bus.sendR)[0] = level
    bus.steps = k
    bus.render(bl, br, len)
    L.set(bl.subarray(0, len), off)
    R.set(br.subarray(0, len), off)
    off += len
  }
  return { L, R }
}

const impulse = (preset: Ps1ReverbPreset, seconds: number, side: 'L' | 'R' = 'L'): { L: Float32Array; R: Float32Array } => runBus(reverbSong(preset), Math.round(seconds * SR), [4096], side)

describe('SPU reverb', () => {
  it('has a register table for every preset (32 registers, offsets inside the work area)', () => {
    for (const p of PS1_REVERB_PRESETS) {
      if (p === 'off') {
        expect(spuReverbBytes(p)).toBe(0)
        continue
      }
      const t = SPU_REVERB_PRESETS[p]
      expect(t.regs, p).toHaveLength(32)
      expect(spuReverbBytes(p), p).toBeGreaterThanOrEqual(t.bytes)
      expect(spuReverbBytes(p) % 2).toBe(0)
      expect(spuReverbBytes(p)).toBeLessThanOrEqual(0x18040 + 16)
    }
    expect(spuReverbBytes('studio-large')).toBe(0x6fe0)
    expect(spuReverbBytes('hall')).toBe(0xb400)
  })

  it('gives an identical impulse response twice, and off is silent', () => {
    const a = impulse('studio-medium', 0.5)
    const b = impulse('studio-medium', 0.5)
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    const off = impulse('off', 0.5)
    expect(peak(off.L)).toBe(0)
    expect(peak(off.R)).toBe(0)
  })

  it('every preset has a tail and stays finite', () => {
    for (const p of PS1_REVERB_PRESETS) {
      if (p === 'off') continue
      const { L, R } = impulse(p, 1.3)
      const late = L.subarray(Math.round(0.02 * SR))
      expect(peak(late), p).toBeGreaterThan(0.002)
      expect(Number.isFinite(rms(L)) && Number.isFinite(rms(R)), p).toBe(true)
      expect(peak(L), p).toBeLessThanOrEqual(1)
    }
  })

  it('crosses over to the other side (different-side reflections) for the studio and hall presets', () => {
    for (const p of ['studio-small', 'studio-large', 'hall', 'space-echo'] as const) {
      const { R } = impulse(p, 1)
      expect(peak(R), p).toBeGreaterThan(0.002)
    }
  })

  it('echo and delay repeat at the documented delay within 1 ms', () => {
    for (const p of ['echo', 'delay'] as const) {
      const { L } = impulse(p, 1.3)
      const from = Math.round(0.3 * SR)
      let best = from
      for (let i = from; i < L.length; i++) if (Math.abs(L[i]!) > Math.abs(L[best]!)) best = i
      const ms = (best / SR) * 1000
      expect(spuReverbFirstRepeatMs(p), p).toBeGreaterThan(700)
      expect(Math.abs(ms - spuReverbFirstRepeatMs(p)), `${p} repeat at ${ms.toFixed(2)} ms`).toBeLessThan(1)
      expect(Math.abs(L[best]!), p).toBeGreaterThan(0.05)
      // nothing before the repeat: the early part is silent
      expect(peak(L.subarray(Math.round(0.02 * SR), best - 200)), p).toBeLessThan(0.002)
    }
  })

  it('depth scales the output and inputVol scales the input', () => {
    const full = runBus(reverbSong('room', 1), 4096).L
    const half = runBus(reverbSong('room', 0.5), 4096).L
    expect(peak(half) / peak(full)).toBeGreaterThan(0.48)
    expect(peak(half) / peak(full)).toBeLessThan(0.52)
    const quiet = reverbSong('room', 1)
    if (quiet.chipConfig.chip === 'ps1') quiet.chipConfig.reverb.inputVol = 0.5
    expect(peak(runBus(quiet, 4096).L) / peak(full)).toBeGreaterThan(0.48)
    expect(peak(runBus(quiet, 4096).L) / peak(full)).toBeLessThan(0.52)
  })

  it('processes the same output for any block split (odd step counts keep the 22 kHz phase)', () => {
    const song = reverbSong('hall')
    expect(bytesEqual(runBus(song, 20000, [4096]).L, runBus(song, 20000, [1, 7, 333, 1000, 129]).L)).toBe(true)
  })
})

describe('SPU reverb send', () => {
  function reverbEnergy(setup: (v: SpuVoice, s: Song) => void): number {
    const s = toneSong([{ sample: 'sine' }])
    s.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset: 'studio-small', depth: 1, inputVol: 1 } }
    const v = voiceOf(s)
    setup(v, s)
    const L = new Float32Array(4096)
    const R = new Float32Array(4096)
    const buf = new Float32Array(4096)
    let e = 0
    for (let b = 0; b < 8; b++) {
      v.render(buf, 0, 4096)
      v.aux!.render(L, R, 4096)
      for (let i = 0; i < 4096; i++) e += L[i]! * L[i]! + R[i]! * R[i]!
    }
    return e
  }

  it('the instrument flag and Exx pick the send; a muted voice does not feed the reverb', () => {
    const dry = reverbEnergy((v, s) => v.control(noteControl(60), s.instruments[0]))
    expect(dry).toBe(0)
    const wet = reverbEnergy((v, s) => {
      ;(s.instruments[0] as PsxSampleInstrument).reverb = true
      v.control(noteControl(60), s.instruments[0])
    })
    expect(wet).toBeGreaterThan(0.01)
    // Exx overrides the instrument on and off
    expect(reverbEnergy((v, s) => v.control(noteControl(60, { echo: true }), s.instruments[0]))).toBeGreaterThan(0.01)
    expect(
      reverbEnergy((v, s) => {
        ;(s.instruments[0] as PsxSampleInstrument).reverb = true
        v.control(noteControl(60, { echo: false }), s.instruments[0])
      })
    ).toBe(0)
    expect(
      reverbEnergy((v, s) => {
        ;(s.instruments[0] as PsxSampleInstrument).reverb = true
        v.setMuted(true)
        v.control(noteControl(60), s.instruments[0])
      })
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// presets

describe('PS1 baseline presets', () => {
  it('map the SNES bank: every preset resolves, validates, plays and matches the SNES attack and release within 20%', () => {
    expect(PRESET_BANKS.ps1).toBe(PS1_PRESETS)
    PS1_PRESETS.forEach((p, i) => {
      const inst = resolvePreset('ps1', p.id)
      expect(validateInstrument(inst), p.id).toEqual([])
      if (inst.kind !== 'psx-sample') throw new Error('kind')
      const t = snesEnvTimes((SNES_PRESETS[i]!.instrument as { env: Parameters<typeof snesEnvTimes>[0] }).env)
      if (t.attackSec > 0.002) expect(psxAttackSeconds(inst.adsr.attack) / t.attackSec, p.id).toBeGreaterThan(0.8)
      if (t.attackSec > 0.002) expect(psxAttackSeconds(inst.adsr.attack) / t.attackSec, p.id).toBeLessThan(1.2)
      expect(psxReleaseTauSec(inst.adsr.release) / t.releaseTauSec, p.id).toBeGreaterThan(0.8)
      expect(psxReleaseTauSec(inst.adsr.release) / t.releaseTauSec, p.id).toBeLessThan(1.2)
    })
  })

  it('every preset makes sound on V1 and the pitched ones are in tune', () => {
    for (const p of PS1_PRESETS) {
      const song = ps1Song([p.id])
      const out = renderNote(song, 60, 0.3)
      expect(peak(out), p.id).toBeGreaterThan(0.01)
      expect(out.every(Number.isFinite), p.id).toBe(true)
    }
    for (const id of ['ps1.strings.ensemble', 'ps1.choir.aah', 'ps1.organ.drawbar', 'ps1.flute.breathy', 'ps1.brass.section', 'ps1.pad.warm', 'ps1.pluck.pizz', 'ps1.pluck.harp', 'ps1.pluck.guitar', 'ps1.arp.epiano', 'ps1.bass.synth', 'ps1.bass.pick', 'ps1.lead.saw']) {
      const song = ps1Song([id])
      const inst = song.instruments[0] as PsxSampleInstrument
      const out = renderNote(song, inst.baseNote, 0.6)
      const want = midiToHz(inst.baseNote)
      const hz = autocorrHz(out.subarray(8000, 8000 + 8192), SR, want * 0.8, want * 1.25)
      expect(hz / want, id).toBeGreaterThan(0.985)
      expect(hz / want, id).toBeLessThan(1.015)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// song-level: stems, determinism, block parity, budget, golden

/** The PS1 demo: lead, pad chord, bass, drums, an arp, a pitch-modulated voice and a noise hit, reverb on. */
function demoSong(): Song {
  const s = ps1Song(['ps1.lead.saw', 'ps1.pad.warm', 'ps1.bass.synth', 'ps1.kick.drum', 'ps1.snare.drum', 'ps1.hat.closed', 'ps1.pluck.harp'], 32)
  s.timing.bpm = 120
  s.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset: 'studio-large', depth: 0.5, inputVol: 1 } }
  const lead = s.instruments[0] as PsxSampleInstrument
  lead.reverb = true
  ;(s.instruments[1] as PsxSampleInstrument).reverb = true
  ;(s.instruments[4] as PsxSampleInstrument).reverb = true
  s.instruments.push({ ...(structuredClone(s.instruments[5]) as PsxSampleInstrument), name: 'noise hit', noise: { shift: 12, step: 1 }, reverb: false })
  s.instruments.push({ ...(structuredClone(s.instruments[0]) as PsxSampleInstrument), name: 'pm lead', pmod: true, reverb: true })
  for (const [r, n] of [[0, 57], [16, 60]] as const) {
    put(s, 'V2', 0, r, { note: n, inst: 1, vol: 11 })
    put(s, 'V4', 0, r, { note: n + 4, inst: 1, vol: 10 })
  }
  put(s, 'V2', 0, 28, { note: 'rel' })
  put(s, 'V4', 0, 28, { note: 'rel' })
  for (const [r, n] of [[0, 33], [4, 33], [8, 36], [12, 31], [16, 33], [20, 33], [24, 36], [28, 31]] as const) put(s, 'V1', 0, r, { note: n, inst: 2, vol: 14 })
  const arp = [69, 72, 76, 72, 69, 72, 76, 81]
  arp.forEach((n, i) => put(s, 'V7', 0, i * 4, { note: n, inst: 6, vol: 10 }))
  for (const r of [0, 6, 10, 16, 22, 26]) put(s, 'V13', 0, r, { note: 60, inst: 3, vol: 15 })
  for (const r of [8, 24]) put(s, 'V14', 0, r, { note: 60, inst: 4, vol: 13 })
  for (let r = 0; r < 32; r += 2) put(s, 'V15', 0, r, { note: 60, inst: 5, vol: 7 })
  put(s, 'V16', 0, 8, { note: 60, inst: 7, vol: 6 })
  put(s, 'V16', 0, 24, { note: 60, inst: 7, vol: 6 })
  // a modulator on V8 (a held sine-ish pad) and the pitch-modulated lead on V9
  put(s, 'V8', 0, 0, { note: 45, inst: 6, vol: 8, fx: [{ code: 'E', param: 0 }] })
  put(s, 'V9', 0, 0, { note: 81, inst: 8, vol: 9 })
  put(s, 'V9', 0, 12, { note: 'off' })
  put(s, 'V3', 0, 0, { note: 81, inst: 0, vol: 12 })
  put(s, 'V3', 0, 8, { note: 76, inst: 0, vol: 12 })
  put(s, 'V3', 0, 14, { note: 'rel' })
  return s
}

const hashOf = (r: RenderResult): string => {
  const q = quantizeStereo(r.L, r.R)
  const inter = interleave(q.L, q.R)
  return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
}

describe('PS1 songs: stems, determinism and block parity', () => {
  it('two renders are bit-identical, the demo is audible and the reverb stem has a tail', () => {
    const a = renderSong(demoSong(), { sampleRate: SR, stems: true })
    const b = renderSong(demoSong(), { sampleRate: SR, stems: true })
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    expect(bytesEqual(a.stems!['_reverb']!.L, b.stems!['_reverb']!.L)).toBe(true)
    expect(peak(a.L)).toBeGreaterThan(0.05)
    expect(peak(a.L)).toBeLessThan(0.98)
    expect(peak(a.stems!['_reverb']!.L)).toBeGreaterThan(0.01)
    expect(Object.keys(a.stems!).slice(-1)).toEqual(['_reverb'])
  })

  it('channel stems + the _reverb stem add up to the master (linear model, below the limiter)', () => {
    const s = ps1Song(['ps1.pad.warm', 'ps1.pluck.harp'], 16)
    ;(s.instruments[0] as PsxSampleInstrument).reverb = true
    put(s, 'V2', 0, 0, { note: 57, inst: 0, vol: 6 })
    put(s, 'V3', 0, 2, { note: 69, inst: 1, vol: 6, fx: [{ code: 'E', param: 1 }] })
    const r = renderSong(s, { sampleRate: SR, stems: true })
    expect(peak(r.L)).toBeLessThan(0.7)
    expect(peak(r.stems!['_reverb']!.L)).toBeGreaterThan(0.005)
    let worst = 0
    for (let i = 0; i < r.L.length; i++) {
      let l = 0
      let rr = 0
      for (const st of Object.values(r.stems!)) {
        l += st.L[i]!
        rr += st.R[i]!
      }
      worst = Math.max(worst, Math.abs(l - r.L[i]!), Math.abs(rr - r.R[i]!))
    }
    expect(worst).toBeLessThan(1e-5)
  })

  it('reverb preset off leaves a silent _reverb stem', () => {
    const s = demoSong()
    s.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset: 'off', depth: 0.5, inputVol: 1 } }
    const r = renderSong(s, { sampleRate: SR, stems: true })
    expect(peak(r.stems!['_reverb']!.L)).toBe(0)
    expect(peak(r.stems!['_reverb']!.R)).toBe(0)
    expect(peak(r.L)).toBeGreaterThan(0.05)
  })

  it('128-frame and odd blocks give exactly the offline render (noise, pmod and reverb included)', () => {
    const song = demoSong()
    const ref = renderSong(song, { sampleRate: SR })
    for (const sizes of [[128], [1, 7, 333, 1000, 129]]) {
      const L = new Float32Array(ref.L.length)
      const R = new Float32Array(ref.R.length)
      const p = new SongPlayer(song, SR, { maxBlock: 256 })
      let off = 0
      let i = 0
      while (off < L.length) {
        const end = Math.min(L.length, off + sizes[i++ % sizes.length]!)
        p.process(L.subarray(off, end), R.subarray(off, end))
        off = end
      }
      expect(bytesEqual(L, ref.L), `blocks ${sizes.join(',')}`).toBe(true)
      expect(bytesEqual(R, ref.R)).toBe(true)
    }
  })

  it('renders 24 voices, at 48 kHz, loops with a seam and hot-swaps samples', () => {
    const s24 = ps1Song(['ps1.lead.saw'], 16, 24)
    expect(s24.channels).toHaveLength(24)
    put(s24, 'V24', 0, 0, { note: 72, inst: 0, vol: 14 })
    expect(peak(renderSong(s24, { sampleRate: SR }).L)).toBeGreaterThan(0.05)
    const song = demoSong()
    song.loop = { order: 0 }
    const r = renderSong(song, { sampleRate: 48000 })
    expect(r.loopStart).not.toBeNull()
    expect(peak(r.L)).toBeGreaterThan(0.05)
    const p = new SongPlayer(demoSong(), SR)
    p.process(new Float32Array(2000), new Float32Array(2000))
    const edited = demoSong()
    edited.samples.push({ id: 'extra', name: 'extra', source: { kind: 'recipe', recipe: 'bell', params: {} } })
    edited.instruments.push({ kind: 'psx-sample', name: 'x', sample: 'extra', baseNote: 72, adsr: { ...ADSR_HOLD }, reverb: true })
    put(edited, 'V5', 0, 6, { note: 72, inst: 9, vol: 12 })
    p.setSong(edited)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(peak(L)).toBeGreaterThan(0.05)
  })
})

describe('SPU RAM budget', () => {
  const big = (preset: Ps1ReverbPreset, sampleCount: number[]): Song => {
    const s = createSong({ chip: 'ps1', patternLength: 16 })
    s.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset, depth: 0.5, inputVol: 1 } }
    sampleCount.forEach((n, i) => {
      s.samples.push({ id: `p${i}`, name: `p${i}`, source: { kind: 'pcm', sampleRate: 44100, data: pcmToBase64(new Int16Array(n)) } })
      s.instruments.push({ kind: 'psx-sample', name: `p${i}`, sample: `p${i}`, baseNote: 60, adsr: { ...ADSR_HOLD }, reverb: false })
    })
    return s
  }

  it('accepts the demo song and reports its usage', () => {
    const song = demoSong()
    const profile = getChipProfile('ps1')
    expect(profile.validate(song).filter((i) => i.severity === 'error')).toEqual([])
    const u = spuRamUsage(song)
    expect(u.budget).toBe(SPU_RAM_BYTES)
    expect(u.budget).toBe(512 * 1024)
    expect(u.reservedBytes).toBe(SPU_RESERVED_BYTES)
    expect(u.reverbBytes).toBe(spuReverbBytes('studio-large'))
    expect(u.sampleBytes).toBe(u.samples.reduce((a, x) => a + x.bytes, 0))
    expect(u.total).toBe(u.sampleBytes + u.reverbBytes + u.reservedBytes)
    for (const x of u.samples) expect(x.bytes).toBe(psxByteSize(x.length))
    expect(u.total).toBeLessThan(u.budget * 0.5)
  })

  it('rejects an oversized song and names a smaller reverb preset as the fix', () => {
    // ~450 KB of ADPCM + space-echo (62 KB) + 4 KB reserved is over 512 KB by a few KB; hall saves enough
    const song = big('space-echo', [403200, 403200])
    const u = spuRamUsage(song)
    expect(u.total).toBeGreaterThan(u.budget)
    const err = getChipProfile('ps1').validate(song).find((i) => /SPU RAM budget exceeded/.test(i.message))
    expect(err).toBeDefined()
    expect(err!.severity).toBe('error')
    expect(err!.message).toMatch(/lower the reverb preset to hall \(saves \d+ KB\) or drop the largest sample/)
    expect(err!.message).toMatch(/the largest sample is "p0"/)
    // with the suggested preset it fits
    song.chipConfig = { chip: 'ps1', voices: 16, reverb: { preset: 'hall', depth: 0.5, inputVol: 1 } }
    expect(getChipProfile('ps1').validate(song).some((i) => /exceeded/.test(i.message))).toBe(false)
  })

  it('when no preset helps it says to shorten or drop samples; only used samples count', () => {
    const song = big('studio-large', [403200, 403200, 403200])
    const err = getChipProfile('ps1').validate(song).find((i) => /SPU RAM budget exceeded/.test(i.message))
    expect(err!.message).toMatch(/set the reverb preset to off .* and shorten or drop samples/)
    // an unused slot costs nothing
    const unused = big('off', [1000])
    unused.samples.push({ id: 'unused', name: 'unused', source: { kind: 'pcm', sampleRate: 44100, data: pcmToBase64(new Int16Array(900000)) } })
    expect(spuRamUsage(unused).samples.map((x) => x.id)).toEqual(['p0'])
  })

  it('warns when the RAM is nearly full', () => {
    const song = big('off', [403200, 403200])
    const issues = getChipProfile('ps1').validate(song)
    expect(issues.some((i) => /SPU RAM is nearly full/.test(i.message) && i.severity === 'warning')).toBe(true)
  })

  it('counts user PCM above 48 kHz at 44.1 kHz', () => {
    const s = createSong({ chip: 'ps1' })
    s.samples.push({ id: 'hi', name: 'hi', source: { kind: 'pcm', sampleRate: 96000, data: pcmToBase64(new Int16Array(96000)) } })
    s.instruments.push({ kind: 'psx-sample', name: 'hi', sample: 'hi', baseNote: 60, adsr: { ...ADSR_HOLD }, reverb: false })
    expect(spuRamUsage(s).samples[0]!.length).toBe(44100)
  })
})

describe('golden hash', () => {
  const goldenPath = join(__dirname, 'golden-ps1.json')
  const update = process.env.UPDATE_GOLDEN === '1'
  it('ps1 demo song (UPDATE_GOLDEN=1 regenerates)', () => {
    const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
    const r = renderSong(demoSong(), { sampleRate: SR })
    const h = hashOf(r)
    if (update) {
      golden['ps1'] = h
      writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
      return
    }
    if (golden['ps1'] !== h) {
      const dir = join(process.cwd(), '.claude', 'temp')
      mkdirSync(dir, { recursive: true })
      const q = quantizeStereo(r.L, r.R)
      const file = join(dir, 'golden-ps1-actual.wav')
      writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
      throw new Error(`Golden hash mismatch for ps1: expected ${golden['ps1']}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
    }
    expect(h).toBe(golden['ps1'])
  })
})
