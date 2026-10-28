// The PS1 SPU and Dreamcast AICA chips through the tools (MDI-10 Phase B0 scaffolding): songs can be created, edited,
// validated and saved; rendering is refused until the voice modules call markChipPlayable.

import { describe, expect, it } from 'vitest'
import { type ChipId, isChipPlayable, parseProject, serializeProject } from '../../src/core'
import { chipIsPlayable } from '../../src/tools/util'
import { resultText, songSetup } from './helpers'

const NEW_CHIPS = [
  { chip: 'ps1', kind: 'psx-sample', voices: 24 },
  { chip: 'dreamcast', kind: 'aica-sample', voices: 64 }
] as const

describe('PS1 and Dreamcast songs through the tools', () => {
  for (const { chip, kind, voices } of NEW_CHIPS) {
    it(`${chip}: new_song with ${voices} voices, presets by role, notes on the first and last voice, clean analysis`, async () => {
      const t = songSetup()
      const created = await t.text('new_song', { chip, name: 'Sample Chip', chipConfig: { voices } })
      expect(created).toContain(`Created a new ${chip.toUpperCase()} song`)
      expect(t.session.song.channels).toHaveLength(voices)
      expect(t.session.song.channels[voices - 1]!.id).toBe(`V${voices}`)
      expect(t.session.song.chipConfig).toMatchObject({ chip, voices })

      expect(resultText(await t.ok('add_instrument', { preset: 'bass', channel: 'V1' }))).toMatch(new RegExp(`${chip}\\.bass\\.synth.*Added sample "bass"`))
      await t.ok('add_instrument', { preset: 'lead', channel: 'V2' })
      await t.ok('add_instrument', { preset: 'kick', channel: 'V13' })
      expect(t.session.song.instruments.map((i) => i.kind)).toEqual([kind, kind, kind])
      expect(t.session.song.samples.map((s) => s.id)).toEqual(['bass', 'lead-saw', 'kick'])

      await t.ok('write_melody', { channel: 'V1', melody: '@bass D2:4 D2:4 A1:4 A1:4' })
      await t.ok('write_melody', { channel: 'V2', melody: '@lead v12 A5:8 G5:4 F5:4' })
      await t.ok('write_drums', { channel: 'V13', legend: { K: 'kick' }, steps: 'K...K...K...K...' })
      await t.ok('write_pattern', { text: `channels: V${voices}\n 0 | D-4 @lead v10 E01\n 8 | A-3` })
      expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)
      expect(t.session.song.chip).toBe(chip)
    })

    it(`${chip}: set_song_info merges the nested effect settings and refuses voices`, async () => {
      const t = songSetup()
      await t.ok('new_song', { chip })
      const before = JSON.stringify(t.session.song.chipConfig)
      const refused = await t.text('set_song_info', { chipConfig: { voices } })
      expect(refused).toMatch(/voices.*cannot be edited in place.*new_song/)
      expect(JSON.stringify(t.session.song.chipConfig)).toBe(before)
      if (chip === 'ps1') {
        await t.ok('set_song_info', { chipConfig: { reverb: { preset: 'hall' } } })
        expect(t.session.song.chipConfig).toMatchObject({ voices: 16, reverb: { preset: 'hall', depth: 0.5, inputVol: 1 } })
      } else {
        await t.ok('set_song_info', { chipConfig: { dsp: { preset: 'delay', delayMs: 375 } } })
        expect(t.session.song.chipConfig).toMatchObject({ voices: 16, dsp: { preset: 'delay', delayMs: 375, mix: 0.35 } })
      }
    })

    it(`${chip}: save_project and open_project keep the voices and the instruments`, async () => {
      const t = songSetup()
      await t.ok('new_song', { chip, chipConfig: { voices: voices === 24 ? 24 : 32 } })
      await t.ok('add_instrument', { preset: 'pad', channel: 'V4' })
      await t.ok('write_pattern', { text: 'channels: V4\n0 | C-4 @pad v12\n8 | rel' })
      await t.ok('save_project', { path: 'sample chip' })
      const file = new TextDecoder().decode(t.services.files.get('/mem/projects/sample chip.ctune')!)
      const original = serializeProject(parseProject(serializeProject(t.song)))
      const back = parseProject(file)
      expect(back.channels).toHaveLength(voices === 24 ? 24 : 32)
      expect(back.instruments[0]!.kind).toBe(kind)
      await t.ok('new_song', { chip: 'nes' })
      expect(t.song.chip).toBe('nes')
      expect(await t.text('open_project', { path: 'sample chip' })).toContain('Opened /mem/projects/sample chip.ctune')
      expect(serializeProject(parseProject(serializeProject(t.song)))).toBe(original)
      expect(t.song.chip).toBe(chip)
    })

    it(`${chip}: new_song refuses a voice count the chip does not have`, async () => {
      const t = songSetup()
      const res = await t.call('new_song', { chip, chipConfig: { voices: 20 } })
      expect(res.isError).toBe(true)
      expect(resultText(res)).toMatch(/voices must be/)
      expect(t.session.song.chip).toBe('nes')
    })
  }

  it('lists the chips, with the sound engine note only for chips that are not playable yet', async () => {
    const t = songSetup()
    const all = await t.text('list_chips')
    for (const id of ['ps1', 'dreamcast'] as const) {
      expect(all).toContain(`${id} - `)
      expect(/\[coming/.test(all.split('\n').find((l) => l.startsWith(`${id} - `))!)).toBe(!chipIsPlayable(id))
    }
    expect(await t.text('list_chips', { chip: 'ps1' })).toContain('V16')
  })

  it('refuses to render a chip until its voice module marks it playable', async () => {
    for (const chip of ['ps1', 'dreamcast'] as ChipId[]) {
      // MDI-10 Phases B and C call markChipPlayable from spu.ts / aica.ts; this test then skips the refusal
      if (isChipPlayable(chip)) {
        expect(chipIsPlayable(chip)).toBe(true)
        continue
      }
      expect(chipIsPlayable(chip)).toBe(false)
      const t = songSetup()
      await t.ok('new_song', { chip })
      await t.ok('add_instrument', { preset: 'lead', channel: 'V2' })
      await t.ok('write_pattern', { text: 'channels: V2\n0 | C-5 @lead v12\n8 | rel' })
      const wav = await t.call('export_wav', { path: 'x' })
      expect(wav.isError).toBe(true)
      expect(resultText(wav)).toMatch(new RegExp(`${chip.toUpperCase()} sound engine and preset bank are not available yet`))
      const audio = await t.call('render_audio', { path: 'x.ogg' })
      expect(audio.isError).toBe(true)
      expect(resultText(audio)).toMatch(/not available yet/)
    }
  })

  it('the five existing chips stay playable', () => {
    for (const chip of ['nes', 'gb', 'genesis', 'snes', 'pce'] as ChipId[]) {
      expect(isChipPlayable(chip), chip).toBe(true)
      expect(chipIsPlayable(chip), chip).toBe(true)
    }
  })
})
