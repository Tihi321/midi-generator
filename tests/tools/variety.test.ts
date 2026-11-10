// compose_track variety (MDI-15): the fingerprint is always there, the avoid rule keeps the tracks of one work apart (or says
// which rule it could not meet), and the gm palettes only name presets that exist.

import { describe, expect, it } from 'vitest'
import { MOOD_IDS, PRESET_BANKS, validateSong } from '../../src/core'
import { composeSong } from '../../src/tools'
import type { Fingerprint } from '../../src/tools'
import { PALETTE_LIBRARY } from '../../src/tools/composer/palettes'
import { avoidViolations } from '../../src/tools/composer/variety'

describe('compose_track variety', () => {
  it('chains avoid over 8 tracks: no shared texture or lead, tempos 8+ apart, another key than the last, or a warning that says why', () => {
    const made: Fingerprint[] = []
    for (let i = 0; i < 8; i++) {
      const r = composeSong({ mood: 'storybook', chip: 'gm', seed: 100 + i, bars: 16, avoid: [...made] })
      const f = r.fingerprint
      expect(f.texture && f.lead && f.pad && f.bass && f.bpm && f.key && f.scale && f.form, `track ${i}`).toBeTruthy()
      const broken = avoidViolations(f, made)
      for (const rule of broken) expect(r.warning ?? '', `track ${i} breaks ${rule} without a warning`).toContain(rule)
      if (broken.length === 0) expect(r.warning).toBeUndefined()
      made.push(f)
    }
    // the first tracks of a work are all clean: the pool is far from used up
    expect(made.slice(0, 4).every((f, i) => avoidViolations(f, made.slice(0, i)).length === 0)).toBe(true)
    // and the same options give the same track
    const again = composeSong({ mood: 'storybook', chip: 'gm', seed: 103, bars: 16, avoid: made.slice(0, 3) })
    expect(again.fingerprint).toEqual(made[3])
  })

  it('gm composes every mood with real presets and no validation errors; the palettes name existing presets', () => {
    const ids = new Set(PRESET_BANKS.gm.map((p) => p.id))
    for (const p of PALETTE_LIBRARY) {
      for (const ref of [p.lead, ...(p.leads ?? []), p.pad, p.pad2 ?? p.pad, p.bass, p.comp, p.sparkle ?? p.comp, ...Object.values(p.drums ?? {})]) expect(ids.has(ref), `${p.id}: ${ref}`).toBe(true)
    }
    for (const mood of MOOD_IDS) {
      for (const seed of [1, 2, 3]) {
        const r = composeSong({ mood, chip: 'gm', seed, bars: 16 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${mood}/${seed}`).toEqual([])
        expect(r.fingerprint.lead, `${mood}/${seed} lead`).toMatch(/^gm\./)
      }
    }
  })

  it('texture, form and palette are chosen on request; other chips keep their arrangement', () => {
    const r = composeSong({ mood: 'cafe', chip: 'gm', seed: 5, bars: 16, texture: 'bossa', form: 'ABA', palette: 'vibes-cafe' })
    expect(r.fingerprint).toMatchObject({ texture: 'bossa', form: 'ABA', lead: 'gm.bell.vibes' })
    expect(r.palette).toBe('vibes-cafe')
    // the instruments override resolves a gm preset id on a gm channel (what the Edu and VN planners send)
    const over = composeSong({ mood: 'peaceful', chip: 'gm', seed: 5, bars: 8, texture: 'pad-lead', instruments: { M4: 'gm.lead.clarinet' } })
    expect(over.parts).toContain('M4 pad: clarinet')
    const snes = composeSong({ mood: 'peaceful', chip: 'snes', seed: 5, texture: 'march' })
    expect(snes.fingerprint.texture).toBe('pad-lead')
    expect(snes.warning).toContain('texture')
  })
})
