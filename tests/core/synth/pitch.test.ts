import { describe, expect, it } from 'vitest'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import {
  gbPulseFreq,
  gbPulsePeriod,
  gbWaveFreq,
  gbWavePeriod,
  midiToHz,
  nesCpuHz,
  nesPulseFreq,
  nesPulsePeriod,
  nesTriFreq,
  nesTriPeriod
} from '../../../src/core/synth/tables'
import { renderSong } from '../../../src/core/synth/render'
import { makeSong, put } from './fixtures'

const SR = 44100

/** Frequency from interpolated rising zero crossings of the mean-removed signal. */
export function measureHz(x: Float32Array, sr: number): number {
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

/** f0 by normalised autocorrelation with parabolic refinement; lag range given in Hz. */
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

function renderVoice(chip: 'nes' | 'gb', channelIndex: number, midi: number, instIndex: number, seconds = 0.5): Float32Array {
  const song = makeSong(chip)
  const channel = song.channels[channelIndex]!
  const voice = createVoice({ song, channel, index: channelIndex, sampleRate: SR, maxBlock: 4096 })
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = 1
  c.rawVol = 1
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.inst = instIndex
  c.note = midi
  voice.control(c, song.instruments[instIndex])
  c.trigger = false
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const tmp = new Float32Array(4096)
  for (let off = 0; off < n; off += 4096) {
    const len = Math.min(4096, n - off)
    voice.render(tmp, 0, len)
    out.set(tmp.subarray(0, len), off)
  }
  return out.subarray(Math.round(0.05 * SR))
}

const cpu = nesCpuHz('ntsc')
const NOTES: [string, number][] = [
  ['C-2', 36],
  ['A-4', 69],
  ['C-6', 84]
]

function check(measured: number, quantized: number, ideal: number): void {
  const quantErr = Math.abs(quantized - ideal) / ideal
  expect(Math.abs(measured - quantized) / quantized).toBeLessThan(0.003)
  expect(Math.abs(measured - ideal) / ideal).toBeLessThan(Math.max(0.005, quantErr + 0.003))
}

describe('pitch accuracy (raw voice output)', () => {
  for (const [name, midi] of NOTES) {
    const f = midiToHz(midi)
    it(`NES pulse ${name}`, () => {
      check(measureHz(renderVoice('nes', 0, midi, 0), SR), nesPulseFreq(nesPulsePeriod(f, cpu), cpu), f)
    })
    it(`NES triangle ${name}`, () => {
      check(measureHz(renderVoice('nes', 2, midi, 1), SR), nesTriFreq(nesTriPeriod(f, cpu), cpu), f)
    })
    it(`GB pulse ${name}`, () => {
      check(measureHz(renderVoice('gb', 0, midi, 3), SR), gbPulseFreq(gbPulsePeriod(f)), f)
    })
    it(`GB wave ${name}`, () => {
      check(measureHz(renderVoice('gb', 2, midi, 1), SR), gbWaveFreq(gbWavePeriod(f)), f)
    })
  }

  it('end-to-end: renderSong A-4 on the NES pulse channel is audible at 440 Hz', () => {
    const song = makeSong('nes', { patternLength: 16, mixModel: 'linear' })
    put(song, 'P1', 0, 0, { note: 69, inst: 0, vol: 15 })
    const r = renderSong(song, { sampleRate: SR })
    const seg = r.L.subarray(Math.round(0.1 * SR), Math.round(0.6 * SR))
    let peak = 0
    for (const v of seg) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.05)
    // the NES high-pass chain turns the pulse into spikes, so use autocorrelation for f0
    const hz = autocorrHz(seg.subarray(0, 8192), SR, 100, 1500)
    expect(Math.abs(hz - 440) / 440).toBeLessThan(0.01)
  })

  it('pulse periods below 8 are muted (very high notes) and the period clamps at 2047', () => {
    expect(nesPulsePeriod(midiToHz(135), cpu)).toBeLessThan(8)
    expect(nesPulsePeriod(10, cpu)).toBe(2047)
    const hi = renderVoice('nes', 0, 135, 0)
    let peak = 0
    for (const v of hi) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThan(1e-6)
  })
})
