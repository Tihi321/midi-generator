// The synth moods of compose_track (synthwave, outrun, darkwave, dreamwave): default chips, arrangement extras on PS1 and
// Dreamcast, chip effects, and that they stay playable on every other chip. They use the synthwave preset ids of
// D1 (ps1.lead.saw-detuned, dreamcast.snare.gated, ...): a missing id is an error, never a silent fallback.

import { describe, expect, it } from 'vitest'
import { CHIP_IDS, MOODS, PROGRESSIONS, PRESET_BANKS, renderSong, requireMood, serializeProject, validateSong } from '../../src/core'
import type { ChipId, Song } from '../../src/core'
import { composeSong } from '../../src/tools'
import { channelRows, resultText, songSetup } from './helpers'

interface SynthMood {
  id: string
  chip: ChipId
  bpm: [number, number]
  drums: string
  /** Notes per bar on the bass channel. */
  bassPerBar: number
}

const SYNTH: SynthMood[] = [
  { id: 'synthwave', chip: 'ps1', bpm: [96, 118], drums: 'synthwave-gated', bassPerBar: 8 },
  { id: 'outrun', chip: 'dreamcast', bpm: [108, 118], drums: 'outrun-four', bassPerBar: 16 },
  { id: 'darkwave', chip: 'ps1', bpm: [88, 112], drums: 'darkwave-pulse', bassPerBar: 8 },
  { id: 'dreamwave', chip: 'dreamcast', bpm: [80, 100], drums: 'dreamwave-half', bassPerBar: 2 }
]
const BIG: ChipId[] = ['ps1', 'dreamcast']

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

/** Numeric notes in one bar (16 rows) of a channel. */
function notesInBar(song: Song, channel: string, bar: number): number {
  return channelRows(song, channel).slice(bar * 16, bar * 16 + 16).filter((c) => typeof c?.note === 'number').length
}

const instName = (song: Song, channel: string): string | undefined => {
  const cell = channelRows(song, channel).find((c) => typeof c?.note === 'number')
  return cell?.inst === undefined ? undefined : song.instruments[cell.inst]?.presetId
}

describe('synth moods', () => {
  it.each(SYNTH)('$id: the same seed gives the same song, another seed another one', (m) => {
    const a = composeSong({ mood: m.id, seed: 11, bars: 8 })
    const b = composeSong({ mood: m.id, seed: 11, bars: 8 })
    b.song.id = a.song.id
    expect(serializeProject(b.song)).toBe(serializeProject(a.song))
    const c = composeSong({ mood: m.id, seed: 12, bars: 8 })
    c.song.id = a.song.id
    expect(serializeProject(c.song)).not.toBe(serializeProject(a.song))
    // the arrangement variation re-rolls the track as for the other moods
    const v = composeSong({ mood: m.id, seed: 11, bars: 8, variation: 2 })
    v.song.id = a.song.id
    expect(serializeProject(v.song)).not.toBe(serializeProject(a.song))
    expect(v.chords).toEqual(a.chords)
  })

  it.each(SYNTH)('$id: default chip, BPM, key, minor-family scale and a progression of the mood', (m) => {
    const mood = requireMood(m.id)
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = composeSong({ mood: m.id, seed, bars: 8 })
      expect(r.chip, `seed ${seed}`).toBe(m.chip)
      expect(r.bpm).toBeGreaterThanOrEqual(m.bpm[0])
      expect(r.bpm).toBeLessThanOrEqual(m.bpm[1])
      expect(mood.keys).toContain(r.key)
      expect(mood.scales).toContain(r.scale)
      expect(['minor', 'dorian', 'phrygian', 'harmonic-minor']).toContain(r.scale)
      expect(mood.progressions).toContain(r.progression)
      expect(PROGRESSIONS.find((p) => p.id === r.progression)!.mode).toBe('minor')
      expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${m.id} seed ${seed}`).toEqual([])
    }
  })

  it.each(SYNTH)('$id: harmony, key and tempo do not depend on the chip (the main RNG is untouched)', (m) => {
    const ref = composeSong({ mood: m.id, seed: 7, bars: 8, chip: 'ps1' })
    for (const chip of CHIP_IDS) {
      const r = composeSong({ mood: m.id, seed: 7, bars: 8, chip })
      expect([r.bpm, r.key, r.scale, r.progression, r.chords], chip).toEqual([ref.bpm, ref.key, ref.scale, ref.progression, ref.chords])
    }
  })

  it('is audible on PS1 and Dreamcast and on every other chip, without validation errors', () => {
    for (const m of SYNTH) {
      for (const chip of CHIP_IDS) {
        const r = composeSong({ mood: m.id, chip, seed: 5, bars: 4 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${m.id}/${chip}`).toEqual([])
        expect(r.channels.length, `${m.id}/${chip}`).toBeGreaterThanOrEqual(4)
        expect(r.parts.some((p) => p.includes('drums')), `${m.id}/${chip} drums`).toBe(true)
        const out = renderSong(r.song)
        expect(rms(out.L), `${m.id}/${chip} audible`).toBeGreaterThan(0.005)
      }
    }
  }, 120000)

  it('writes the bass as straight eighths (synthwave, darkwave), rolling sixteenths (outrun) or root and fifth (dreamwave)', () => {
    for (const m of SYNTH) {
      for (const chip of BIG) {
        const r = composeSong({ mood: m.id, chip, seed: 3, bars: 8 })
        for (let bar = 0; bar < 8; bar++) {
          const n = notesInBar(r.song, 'V1', bar)
          // dreamwave changes the chord every 2 bars: the bass pattern still plays every bar
          expect(n, `${m.id}/${chip} bar ${bar}`).toBe(m.bassPerBar)
        }
      }
    }
    // the octave on the last eighth of the synthwave bass
    const r = composeSong({ mood: 'synthwave', chip: 'ps1', seed: 3, bars: 4 })
    const rows = channelRows(r.song, 'V1').slice(0, 16)
    const root = rows[0]!.note as number
    expect(rows.map((c) => (c ? (c.note as number) - root : null))).toEqual([0, null, 0, null, 0, null, 0, null, 0, null, 0, null, 0, null, 12, null])
  })

  it('the arp is a 16th-note arpeggio on PS1 and Dreamcast and keeps its eighths on chips with fewer voices', () => {
    for (const m of SYNTH) {
      for (const chip of BIG) {
        const r = composeSong({ mood: m.id, chip, seed: 3, bars: 8 })
        for (let bar = 0; bar < 8; bar++) expect(notesInBar(r.song, 'V7', bar), `${m.id}/${chip} bar ${bar}`).toBe(16)
        // chord tones only, spread over two octaves
        const notes = channelRows(r.song, 'V7').slice(0, 16).map((c) => (c!.note as number) % 12)
        const chord = r.chords[0]!
        expect(new Set(notes).size, `${m.id}/${chip} ${chord}`).toBeGreaterThanOrEqual(3)
      }
    }
    const snes = composeSong({ mood: 'synthwave', chip: 'snes', seed: 3, bars: 4 })
    expect(notesInBar(snes.song, 'V6', 0)).toBe(8)
  })

  it('has three chord voices and a lead double an octave down with G02 on PS1 and Dreamcast', () => {
    for (const m of SYNTH) {
      for (const chip of BIG) {
        const r = composeSong({ mood: m.id, chip, seed: 4, bars: 8 })
        for (const id of ['V4', 'V5', 'V6']) expect(notesInBar(r.song, id, 0), `${m.id}/${chip} ${id}`).toBe(1)
        expect(r.parts.some((p) => p.startsWith('V3 lead double'))).toBe(true)
        const lead = channelRows(r.song, 'V2')
        const dbl = channelRows(r.song, 'V3')
        const sounding = lead.map((c, i) => [c, dbl[i]] as const).filter(([c]) => typeof c?.note === 'number')
        expect(sounding.length).toBeGreaterThan(8)
        for (const [c, d] of sounding) {
          expect(d, `${m.id}/${chip}`).not.toBeNull()
          expect((d!.note as number) % 12).toBe((c!.note as number) % 12)
          expect(c!.note as number).toBeGreaterThan(d!.note as number)
          expect(d!.fx).toEqual([{ code: 'G', param: 2 }])
          expect(d!.vol!).toBeLessThan(c!.vol!)
        }
      }
    }
    // chips with fewer voices keep two (or one) chord voices and no double
    const nes = composeSong({ mood: 'synthwave', chip: 'nes', seed: 4, bars: 4 })
    expect(nes.parts.some((p) => p.includes('lead double'))).toBe(false)
    const gen = composeSong({ mood: 'outrun', chip: 'genesis', seed: 4, bars: 4 })
    expect(gen.parts.some((p) => p.includes('brass') || p.includes('lead double'))).toBe(false)
  })

  it('outrun adds brass stabs on V10 on the chord changes (PS1 and Dreamcast only)', () => {
    for (const chip of BIG) {
      const r = composeSong({ mood: 'outrun', chip, seed: 2, bars: 8 })
      expect(r.parts.some((p) => p.startsWith('V10 brass'))).toBe(true)
      expect(instName(r.song, 'V10')).toBe(`${chip}.brass.synth-stab`)
      const rows = channelRows(r.song, 'V10')
      for (let bar = 0; bar < 8; bar++) expect(typeof rows[bar * 16]?.note, `${chip} bar ${bar}`).toBe('number')
    }
    for (const mood of ['synthwave', 'darkwave', 'dreamwave']) {
      expect(composeSong({ mood, chip: 'ps1', seed: 2, bars: 8 }).parts.some((p) => p.startsWith('V10'))).toBe(false)
    }
  })

  it('uses the synthwave presets and the gated snare, with the crash on the first bar of each phrase', () => {
    for (const m of SYNTH) {
      for (const chip of BIG) {
        const r = composeSong({ mood: m.id, chip, seed: 6, bars: 8 })
        expect(instName(r.song, 'V14'), `${m.id}/${chip} snare`).toBe(`${chip}.snare.gated`)
        expect(instName(r.song, 'V13')).toBe(`${chip}.kick.linn`)
        expect(instName(r.song, 'V15')).toBe(`${chip}.hat.linn`)
        expect(instName(r.song, 'V2')).toBe(`${chip}.lead.saw-detuned`)
        expect(instName(r.song, 'V3')).toBe(`${chip}.lead.saw-detuned`)
        expect(instName(r.song, 'V7')).toBe(`${chip}.pluck.arp`)
        expect(instName(r.song, 'V1')).toBe(m.id === 'darkwave' ? `${chip}.bass.fm` : `${chip}.bass.analog`)
        expect(instName(r.song, 'V4')).toBe(`${chip}.pad.supersaw`)
        expect(instName(r.song, 'V5')).toBe(m.id === 'dreamwave' ? `${chip}.epiano.dx` : `${chip}.pad.juno`)
        const crash = channelRows(r.song, 'V16')
        const bars = crash.map((c, i) => (typeof c?.note === 'number' ? Math.floor(i / 16) : -1)).filter((b) => b >= 0)
        expect(bars, `${m.id}/${chip} crash`).toEqual([0, 4])
        // toms play in the fills
        expect(instName(r.song, 'V12'), `${m.id}/${chip} tom`).toBe(`${chip}.tom.linn`)
      }
    }
    expect(composeSong({ mood: 'outrun', chip: 'ps1', seed: 6, bars: 4 }).parts.some((p) => p.includes('hihat+openhat'))).toBe(true)
  })

  it('kicks and snares follow the mood\'s drum style', () => {
    const r = composeSong({ mood: 'synthwave', chip: 'ps1', seed: 6, bars: 4 })
    const kick = channelRows(r.song, 'V13').slice(0, 16).map((c) => (typeof c?.note === 'number' ? 'x' : '.')).join('')
    const snare = channelRows(r.song, 'V14').slice(0, 16).map((c) => (typeof c?.note === 'number' ? 'x' : '.')).join('')
    expect(kick).toBe('x.....x.x.......')
    expect(snare).toBe('....x.......x...')
  })

  it('sets the chip effect of the mood (PS1 reverb, Dreamcast DSP with a dotted-8th delay)', () => {
    const reverb: Record<string, string> = { synthwave: 'hall', outrun: 'hall', darkwave: 'studio-large', dreamwave: 'space-echo' }
    for (const m of SYNTH) {
      const p = composeSong({ mood: m.id, chip: 'ps1', seed: 1, bars: 4 })
      expect(p.song.chipConfig).toMatchObject({ chip: 'ps1', reverb: { preset: reverb[m.id] } })
      const d = composeSong({ mood: m.id, chip: 'dreamcast', seed: 1, bars: 4 })
      expect(d.song.chipConfig).toMatchObject({ chip: 'dreamcast', dsp: { preset: m.id === 'outrun' ? 'chorus-delay' : 'chorus-hall', delayMs: Math.round((60000 / d.bpm) * 0.75) } })
    }
  })

  it('works with an intro, a motif and instrument overrides', () => {
    const r = composeSong({ mood: 'synthwave', chip: 'ps1', seed: 2, bars: 8, intro: 2, motif: 'E5:4 G5:4 A5:8' })
    expect(validateSong(r.song).filter((i) => i.severity === 'error')).toEqual([])
    expect(r.introBars).toBe(2)
    expect(r.loop).toEqual({ startBar: 2, endBar: 10 })
    expect(r.motif).not.toBeNull()
    // no lead and no double in the intro
    expect(channelRows(r.song, 'V3').slice(0, 32).every((c) => c === null)).toBe(true)
    const o = composeSong({ mood: 'outrun', chip: 'dreamcast', seed: 2, bars: 4, instruments: { V2: 'dreamcast.lead.sync', V1: 'dreamcast.bass.sub' } })
    expect(instName(o.song, 'V2')).toBe('dreamcast.lead.sync')
    expect(instName(o.song, 'V1')).toBe('dreamcast.bass.sub')
  })

  it('fails loudly when a synthwave preset id is missing (no silent fallback)', () => {
    const bank = PRESET_BANKS.ps1
    const at = bank.findIndex((p) => p.id === 'ps1.snare.gated')
    expect(at, 'the synthwave presets must exist').toBeGreaterThanOrEqual(0)
    const [removed] = bank.splice(at, 1)
    try {
      expect(() => composeSong({ mood: 'synthwave', chip: 'ps1', seed: 1, bars: 4 })).toThrow(/ps1\.snare\.gated/)
    } finally {
      bank.splice(at, 0, removed!)
    }
  })

  it('every contract id the composer uses exists on both chips', () => {
    for (const chip of BIG) {
      for (const id of ['lead.saw-detuned', 'pad.supersaw', 'pad.juno', 'bass.analog', 'bass.fm', 'pluck.arp', 'brass.synth-stab', 'epiano.dx', 'kick.linn', 'snare.gated', 'hat.linn', 'openhat.linn', 'tom.linn', 'crash.linn']) {
        expect(PRESET_BANKS[chip].some((p) => p.id === `${chip}.${id}`), `${chip}.${id}`).toBe(true)
      }
    }
  })
})

describe('synth moods: recipes and lookup', () => {
  it('get_mood_recipe returns the four moods with a channel plan for all 7 chips', async () => {
    const t = songSetup()
    const listing = await t.text('get_mood_recipe')
    for (const m of SYNTH) expect(listing, m.id).toContain(`${m.id}:`)
    for (const m of SYNTH) {
      for (const chip of CHIP_IDS) {
        const text = resultText(await t.ok('get_mood_recipe', { mood: m.id, chip }))
        expect(text, `${m.id}/${chip}`).toContain(`Channel plan for ${chip.toUpperCase()}:`)
        expect(text).toContain('Techniques:')
        expect(requireMood(m.id).chips[chip].channels.length).toBeGreaterThan(3)
      }
    }
  })

  it('has the aliases and keeps dreamy as ambient', () => {
    const alias: Record<string, string> = {
      retrowave: 'synthwave', synth: 'synthwave', '80s': 'synthwave', chase: 'outrun', drive: 'outrun', coldwave: 'darkwave', goth: 'darkwave',
      chillwave: 'dreamwave', dreamsynth: 'dreamwave', dreamy: 'ambient'
    }
    for (const [a, id] of Object.entries(alias)) expect(requireMood(a).id, a).toBe(id)
    expect(composeSong({ mood: 'retrowave', seed: 1, bars: 4 }).mood).toBe('synthwave')
  })

  it('compose_track composes a synth mood through the tool on its default chip', async () => {
    const t = songSetup()
    const r = await t.ok('compose_track', { mood: 'synthwave', seed: 1, bars: 4 })
    const texts = r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)
    const j = JSON.parse(texts[texts.length - 1]!) as Record<string, unknown>
    expect(j).toMatchObject({ chip: 'ps1', mood: 'synthwave', bars: 4, seed: 1 })
    expect(t.session.song.chip).toBe('ps1')
  })

  it('the moods have sections and the loop of the plan', () => {
    for (const m of MOODS.filter((x) => SYNTH.some((s) => s.id === x.id))) {
      expect(m.arrangement.loopFrom).toBe('A')
      expect(m.arrangement.sections[0]).toEqual({ name: 'Intro', bars: 4 })
    }
    expect(requireMood('synthwave').arrangement.sections.map((s) => `${s.name} ${s.bars}`)).toEqual(['Intro 4', 'A 8', 'B 8', 'A 8', 'Bridge 4'])
  })
})
