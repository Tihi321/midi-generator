// MDI-10 Phase B0 scaffolding for the PS1 and Dreamcast chips: sample targets, channel plans, mood plans, stem ids.

import { describe, expect, it } from 'vitest'
import { chipSlots } from '../../src/core/codecs/slots'
import { MOODS } from '../../src/core/theory'
import { createSong, defaultChipConfig, estimateSampleLength } from '../../src/core'
import { aicaByteSize, aicaTargetFor, getSampleTarget, psxByteSize, resolveSlot, sampleTargetBytes, tryPeekSampleLength } from '../../src/core/synth/samplegen'
import type { SampleSlot } from '../../src/core/types'
import { auxStemIds } from '../../src/renderer/lib/exporter'

const slot: SampleSlot = { id: 'k', name: 'Kick', source: { kind: 'recipe', recipe: 'kick', params: {} } }

describe('PS1 and Dreamcast sample targets', () => {
  it('registers psx, aica16, aica8 and aica-adpcm', () => {
    for (const id of ['psx', 'aica16', 'aica8', 'aica-adpcm']) expect(getSampleTarget(id), id).toBeDefined()
  })
  it('reports the chip RAM size of a sample', () => {
    expect(psxByteSize(28)).toBe(16)
    expect(psxByteSize(29)).toBe(32)
    expect(sampleTargetBytes('psx', 1000)).toBe(Math.ceil(1000 / 28) * 16)
    expect(sampleTargetBytes('aica16', 100)).toBe(200)
    expect(sampleTargetBytes('aica8', 100)).toBe(100)
    expect(sampleTargetBytes('aica-adpcm', 101)).toBe(51)
    expect(aicaByteSize('pcm16', 10)).toBe(20)
    expect(aicaByteSize('adpcm', 10)).toBe(5)
    expect(aicaTargetFor('pcm16')).toBe('aica16')
    expect(aicaTargetFor('pcm8')).toBe('aica8')
    expect(aicaTargetFor('adpcm')).toBe('aica-adpcm')
  })
  it('resolves a recipe slot per target (no BRR) and estimates its length from the target pipeline', () => {
    for (const target of ['psx', 'aica16', 'aica8', 'aica-adpcm']) {
      const r = resolveSlot(slot, target)
      expect(r.pcm.length, target).toBeGreaterThan(0)
      expect(r.sampleRate).toBeGreaterThan(0)
      expect(r.brrBytes).toBeUndefined()
      expect(tryPeekSampleLength(slot, target)).toBe(r.pcm.length)
      expect(estimateSampleLength(slot, undefined, target)).toBe(r.pcm.length)
    }
    // the SNES pipeline is separate (its own cache key, BRR)
    expect(resolveSlot(slot, 'snes').brrBytes).toBeGreaterThan(0)
  })
})

describe('PS1 and Dreamcast channel plans', () => {
  it('import/convert plan: bass V1, lead V2, harmony V3..V12, drums V13..V16 for every voice count', () => {
    for (const [chip, voices] of [['ps1', 16], ['ps1', 24], ['dreamcast', 16], ['dreamcast', 32], ['dreamcast', 64]] as const) {
      const cfg = createSong({ chip, chipConfig: { voices } as never }).chipConfig
      const withDrums = chipSlots(chip, cfg, true)
      expect(withDrums).toEqual({
        bass: 'V1', lead: 'V2', harmony: ['V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12'], drumLow: 'V13', drumHigh: 'V14'
      })
      expect(chipSlots(chip, cfg, false).harmony).toEqual([...withDrums.harmony, 'V15', 'V16'])
    }
  })
  it('every mood has a plan for both chips on the shared V1..V16 layout', () => {
    for (const m of MOODS) {
      for (const chip of ['ps1', 'dreamcast'] as const) {
        const ids = m.chips[chip].channels.map((c) => c.channel)
        expect(ids, `${m.id} ${chip}`).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V13', 'V14', 'V15', 'V16'])
        expect(m.chips[chip].idioms.length).toBeGreaterThan(2)
      }
      expect(m.chips.ps1.channels.map((c) => c.role)).toEqual(m.chips.dreamcast.channels.map((c) => c.role))
    }
  })
})

describe('shared bus stems', () => {
  it('auxStemIds names the effect bus stem of the chip', () => {
    const ids = (chip: Parameters<typeof createSong>[0]['chip']): string[] => auxStemIds(createSong({ chip, chipConfig: defaultChipConfig(chip) }))
    expect(ids('snes')).toEqual(['_echo'])
    expect(ids('ps1')).toEqual(['_reverb'])
    expect(ids('dreamcast')).toEqual(['_dsp'])
    for (const chip of ['nes', 'gb', 'genesis', 'pce'] as const) expect(ids(chip)).toEqual([])
  })
})
