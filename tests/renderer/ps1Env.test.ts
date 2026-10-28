import { describe, expect, it } from 'vitest'
import { PS1_REVERB_PRESETS, type PsxAdsr, SPU_RAM_BYTES, SPU_RESERVED_BYTES, psxAttackSeconds, spuRamUsage } from '../../src/core'
import { PS1_REVERB_LABELS, formatSeconds, ps1RamMeter, psxAdsrTimes, psxEnvelopeCurve, psxSustainLevel } from '../../src/renderer/lib/ps1Env'
import { createStarterSong } from '../../src/renderer/lib/newSong'

const BASE: PsxAdsr = { attack: 0, attackExp: false, decay: 8, sustainLevel: 7, sustainRate: 127, sustainDir: 'dec', sustainExp: true, release: 12, releaseExp: true }

describe('ps1 envelope', () => {
  it('the linear attack time follows the psx-spx rate formula (same numbers as the preset mapper)', () => {
    for (const rate of [0, 20, 40, 60, 80]) {
      const t = psxAdsrTimes({ ...BASE, attack: rate }).attackSec
      expect(t).toBeCloseTo(psxAttackSeconds(rate), 3)
    }
    // rate 40: shift 10, step 7: 14 per sample -> 32767 / 14 samples
    expect(psxAdsrTimes({ ...BASE, attack: 40 }).attackSec).toBeCloseTo(32767 / 14 / 44100, 3)
    expect(psxAdsrTimes({ ...BASE, attack: 0 }).attackSec).toBeLessThan(0.001)
  })

  it('an exponential attack is slower than the linear one at the same rate', () => {
    const lin = psxAdsrTimes({ ...BASE, attack: 56 }).attackSec
    const exp = psxAdsrTimes({ ...BASE, attack: 56, attackExp: true }).attackSec
    expect(exp).toBeGreaterThan(lin)
    expect(exp).toBeLessThan(lin * 4)
  })

  it('a linear release of shift 11 takes 32767 / 8 samples', () => {
    expect(psxAdsrTimes({ ...BASE, release: 11, releaseExp: false }).releaseSec).toBeCloseTo(32767 / 8 / 44100, 3)
    // the exponential release of the same shift is longer (it ends in a tail of 1-unit steps)
    expect(psxAdsrTimes({ ...BASE, release: 11, releaseExp: true }).releaseSec).toBeGreaterThan(0.09)
  })

  it('the sustain level register is (n + 1) / 16 of full level; a full level has no decay time', () => {
    expect(psxSustainLevel({ ...BASE, sustainLevel: 7 })).toBe(8 * 0x800)
    expect(psxSustainLevel({ ...BASE, sustainLevel: 15 })).toBe(0x7fff)
    expect(psxAdsrTimes({ ...BASE, sustainLevel: 15 }).decaySec).toBe(0)
    expect(psxAdsrTimes({ ...BASE, sustainLevel: 3 }).decaySec).toBeGreaterThan(0)
  })

  it('the curve attacks, decays to the sustain level, holds and releases', () => {
    // attack rate 40 (53 ms), decay shift 12 (time constant 0.19 s)
    const c = psxEnvelopeCurve({ ...BASE, attack: 40, decay: 12 }, { points: 140 })
    expect(c).toHaveLength(140)
    expect(c[0]!).toBeLessThan(0.2)
    expect(Math.max(...c)).toBeGreaterThan(0.9)
    // the key goes up at 1 / 1.4 of the graph: sustain level 7 = 8/16 of full
    expect(c[99]!).toBeGreaterThan(0.45)
    expect(c[99]!).toBeLessThan(0.55)
    expect(c.at(-1)!).toBeLessThan(c[99]! * 0.2)
  })

  it('a rising sustain climbs back to full level', () => {
    const c = psxEnvelopeCurve({ ...BASE, attack: 40, sustainLevel: 3, sustainRate: 20, sustainDir: 'inc', sustainExp: false }, { points: 140 })
    expect(Math.min(...c.slice(10, 100))).toBeGreaterThan(0.2)
    expect(c[99]!).toBeGreaterThan(0.99)
  })

  it('a slow envelope stays finite and quick to compute', () => {
    const slow: PsxAdsr = { ...BASE, attack: 127, decay: 15, sustainRate: 127, release: 31 }
    const t = psxAdsrTimes(slow)
    expect(t.attackSec === Infinity || t.attackSec > 60).toBe(true)
    const c = psxEnvelopeCurve(slow, { points: 50 })
    expect(c.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('formats seconds for the readout', () => {
    expect(formatSeconds(0.00001)).toBe('< 1 ms')
    expect(formatSeconds(0.004)).toBe('4.0 ms')
    expect(formatSeconds(0.05)).toBe('50 ms')
    expect(formatSeconds(0.42)).toBe('0.42 s')
    expect(formatSeconds(12.34)).toBe('12.3 s')
    expect(formatSeconds(500)).toBe('> 60 s')
    expect(formatSeconds(Infinity)).toBe('never')
  })
})

describe('ps1 transport helpers', () => {
  it('names every reverb preset', () => {
    expect(Object.keys(PS1_REVERB_LABELS).sort()).toEqual([...PS1_REVERB_PRESETS].sort())
  })

  it('the RAM meter is the core SPU usage: samples + reverb work area + reserved against 512 KB', () => {
    const song = createStarterSong({ chip: 'ps1', name: 'x', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 16 })
    const ram = ps1RamMeter(song)
    const core = spuRamUsage(song)
    expect(ram.totalBytes).toBe(SPU_RAM_BYTES)
    expect(ram.usedBytes).toBe(core.total)
    expect(ram.sampleBytes).toBe(core.sampleBytes)
    expect(ram.effectBytes).toBe(core.reverbBytes + SPU_RESERVED_BYTES)
    expect(ram.sampleBytes).toBeGreaterThan(0)
    expect(ram.usedBytes).toBe(ram.sampleBytes + ram.effectBytes)
    expect(ram.usedBytes).toBeLessThan(ram.totalBytes)
    // a smaller reverb preset frees RAM; off leaves only the reserved area as effect bytes
    const reverb = (song.chipConfig as { reverb: { preset: string } }).reverb
    reverb.preset = 'hall'
    const hall = ps1RamMeter(song).effectBytes
    reverb.preset = 'room'
    expect(ps1RamMeter(song).effectBytes).toBeLessThan(hall)
    reverb.preset = 'off'
    expect(ps1RamMeter(song).effectBytes).toBe(SPU_RESERVED_BYTES)
    song.instruments = []
    expect(ps1RamMeter(song).sampleBytes).toBe(0)
  })
})
