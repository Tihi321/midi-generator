import { describe, expect, it } from 'vitest'
import { AICA_RAM_BYTES, DC_DSP_PRESETS, type AicaAeg, type AicaSampleInstrument, aicaAttackSeconds, aicaFallSeconds, aicaRamUsage } from '../../src/core'
import { DC_DSP_LABELS, aicaAegTimes, aicaDecayLevel, aicaEnvelopeCurve, dcRamMeter } from '../../src/renderer/lib/aicaEnv'
import { createStarterSong } from '../../src/renderer/lib/newSong'

const AEG: AicaAeg = { ar: 31, d1r: 31, d2r: 0, rr: 31, dl: 10 }

describe('dreamcast envelope', () => {
  it('times come from the core rate functions; rate 0 never changes', () => {
    const t = aicaAegTimes({ ar: 20, d1r: 16, d2r: 8, rr: 12, dl: 16 })
    expect(t.attackSec).toBe(aicaAttackSeconds(20))
    expect(t.decay2Sec).toBe(aicaFallSeconds(8))
    expect(t.releaseSec).toBe(aicaFallSeconds(12))
    // DL 16 = 48 dB = half of the 96 dB fall
    expect(t.decay1Sec).toBeCloseTo(aicaFallSeconds(16) / 2, 6)
    expect(aicaAegTimes({ ...AEG, ar: 0 }).attackSec).toBe(Infinity)
    expect(aicaAegTimes({ ...AEG, d2r: 0 }).decay2Sec).toBe(Infinity)
    expect(aicaAegTimes({ ...AEG, dl: 0 }).decay1Sec).toBe(0)
  })

  it('DL is 3 dB per step', () => {
    expect(aicaDecayLevel({ ...AEG, dl: 0 })).toBe(1)
    expect(aicaDecayLevel({ ...AEG, dl: 10 })).toBeCloseTo(10 ** (-30 / 20), 6)
  })

  it('the curve attacks, falls to the decay level, holds and releases', () => {
    const c = aicaEnvelopeCurve(AEG, { points: 140 })
    expect(c).toHaveLength(140)
    // a quick attack and fall: the graph's first points may already be on the decay level
    expect(Math.max(...c)).toBeGreaterThan(aicaDecayLevel(AEG) * 0.85)
    expect(c[99]!).toBeGreaterThan(aicaDecayLevel(AEG) * 0.85)
    expect(c[99]!).toBeLessThan(aicaDecayLevel(AEG) * 1.15)
    expect(c.at(-1)!).toBeLessThan(0.05)
    // never rises after the peak
    const peak = c.indexOf(Math.max(...c))
    for (let i = peak + 1; i < c.length; i++) expect(c[i]!).toBeLessThanOrEqual(c[i - 1]! + 1e-9)
  })

  it('a slow attack ramps up before the decay', () => {
    // the slowest attack that still finishes inside the 1 s hold
    let ar = 1
    while (ar < 31 && aicaAttackSeconds(ar + 1) > 0.5) ar++
    const aeg = { ...AEG, ar: ar + 1 }
    const c = aicaEnvelopeCurve(aeg, { points: 140 })
    expect(c[0]!).toBeLessThan(0.2)
    expect(c[10]!).toBeGreaterThan(c[2]!)
    expect(Math.max(...c)).toBeGreaterThan(aicaDecayLevel(AEG) * 0.85)
  })

  it('RR 0 does not release; AR 0 never starts', () => {
    const held = aicaEnvelopeCurve({ ...AEG, rr: 0 }, { points: 140 })
    expect(held.at(-1)!).toBeCloseTo(held[99]!, 3)
    expect(aicaEnvelopeCurve({ ...AEG, ar: 0 }, { points: 60 }).every((v) => v === 0)).toBe(true)
  })
})

describe('dreamcast transport helpers', () => {
  it('names every DSP preset', () => {
    expect(Object.keys(DC_DSP_LABELS).sort()).toEqual([...DC_DSP_PRESETS].sort())
  })

  it('the RAM meter is the core AICA usage: samples by format + DSP buffer against 2 MB', () => {
    const song = createStarterSong({ chip: 'dreamcast', name: 'x', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 16 })
    const pcm16 = dcRamMeter(song)
    const core = aicaRamUsage(song)
    expect(pcm16.totalBytes).toBe(AICA_RAM_BYTES)
    expect(pcm16.usedBytes).toBe(core.total)
    expect(pcm16.sampleBytes).toBe(core.sampleBytes)
    expect(pcm16.effectBytes).toBe(core.dspBytes)
    expect(pcm16.sampleBytes).toBeGreaterThan(0)
    expect(pcm16.usedBytes).toBe(pcm16.sampleBytes + pcm16.effectBytes)
    expect(pcm16.usedBytes).toBeLessThan(pcm16.totalBytes)
    for (const inst of song.instruments) (inst as AicaSampleInstrument).format = 'adpcm'
    expect(dcRamMeter(song).sampleBytes).toBeLessThan(pcm16.sampleBytes * 0.3)
    // the DSP buffer follows the preset
    const dsp = (song.chipConfig as { dsp: { preset: string } }).dsp
    dsp.preset = 'off'
    expect(dcRamMeter(song).effectBytes).toBe(0)
    dsp.preset = 'hall'
    expect(dcRamMeter(song).effectBytes).toBeGreaterThan(0)
    song.instruments = []
    expect(dcRamMeter(song).sampleBytes).toBe(0)
  })
})
