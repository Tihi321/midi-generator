import { describe, expect, it } from 'vitest'
import { snesAttackSeconds, snesEnvelopeCurve } from '../../src/renderer/lib/snesEnv'
import { SNES_FIR_PRESETS, firPresetName } from '../../src/renderer/lib/snesEcho'
import { createStarterSong } from '../../src/renderer/lib/newSong'
import { validateSong } from '../../src/core'

describe('snes envelope graph', () => {
  it('ADSR: attack rises, decays to the sustain level, releases to zero', () => {
    const c = snesEnvelopeCurve({ adsr: [14, 0, 3, 0] }, { points: 140 })
    expect(c).toHaveLength(140)
    expect(c[0]!).toBeLessThan(0.2)
    expect(Math.max(...c)).toBeGreaterThan(0.95)
    // held part ends around sustain level 3 (0x300..0x3FF of 0x7FF)
    expect(c[99]!).toBeGreaterThan(0.35)
    expect(c[99]!).toBeLessThan(0.55)
    expect(c.at(-1)!).toBe(0)
  })

  it('GAIN: direct holds a level, linear increase ramps up', () => {
    const direct = snesEnvelopeCurve({ gain: { mode: 'direct', rate: 64 } }, { points: 50 })
    expect(direct[10]!).toBeCloseTo(1024 / 2047, 2)
    const inc = snesEnvelopeCurve({ gain: { mode: 'linear-inc', rate: 8 } }, { points: 50 })
    expect(inc[20]!).toBeGreaterThan(inc[5]!)
  })

  it('attack time follows the rate table', () => {
    expect(snesAttackSeconds({ adsr: [0, 0, 0, 0] })).toBeCloseTo(4.032, 2)
    expect(snesAttackSeconds({ adsr: [8, 0, 0, 0] })).toBeCloseTo(0.0945, 3)
    expect(snesAttackSeconds({ adsr: [15, 0, 0, 0] })).toBeLessThan(0.001)
  })
})

describe('snes echo controls', () => {
  it('FIR presets are recognised and stay stable (|sum| below 1.6)', () => {
    for (const [name, taps] of Object.entries(SNES_FIR_PRESETS)) {
      expect(firPresetName(taps)).toBe(name)
      expect(taps).toHaveLength(8)
      expect(Math.abs(taps.reduce((a, b) => a + Math.abs(b), 0))).toBeLessThan(1.8)
    }
    expect(firPresetName([1, 0, 0, 0, 0, 0, 0, 0])).toBe('custom')
  })
})

describe('starter songs with sample presets', () => {
  it('a new SNES song comes with the sample slots its starter instruments need', () => {
    const song = createStarterSong({ chip: 'snes', name: 'x', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 32 })
    expect(song.instruments.length).toBeGreaterThan(0)
    expect(song.samples.length).toBeGreaterThan(0)
    expect(validateSong(song).filter((i) => i.severity === 'error')).toEqual([])
  })
})
