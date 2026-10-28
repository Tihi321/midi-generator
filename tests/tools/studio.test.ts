// compose_track, render_audio and the song-session tools (list_songs, open_song, save_song, delete_song).

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOOD_IDS, readWav, renderSong, serializeProject, songSeconds, validateSong } from '../../src/core'
import { composeSong } from '../../src/tools'
import { channelRows, resultText, songSetup } from './helpers'

const CHIPS = ['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast'] as const
const CALM = ['ambient', 'lullaby', 'peaceful', 'mysterious-calm']

/** The last text item of a result parsed as the JSON object contract. */
function lastJson(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text!)
  return JSON.parse(texts[texts.length - 1]!) as Record<string, unknown>
}

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

describe('composer', () => {
  it('is deterministic for a seed and changes with another seed', () => {
    const a = composeSong({ mood: 'ambient', chip: 'snes', seed: 42, bars: 8 })
    const b = composeSong({ mood: 'ambient', chip: 'snes', seed: 42, bars: 8 })
    b.song.id = a.song.id
    expect(serializeProject(b.song)).toBe(serializeProject(a.song))
    expect([b.bpm, b.key, b.scale, b.chords]).toEqual([a.bpm, a.key, a.scale, a.chords])
    const c = composeSong({ mood: 'ambient', chip: 'snes', seed: 43, bars: 8 })
    c.song.id = a.song.id
    expect(serializeProject(c.song)).not.toBe(serializeProject(a.song))
  })

  it('makes valid, audible songs for every calm mood on every chip', () => {
    for (const mood of CALM) {
      for (const chip of CHIPS) {
        const r = composeSong({ mood, chip, seed: 5, bars: 4 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${mood}/${chip}`).toEqual([])
        expect(r.bpm, `${mood}/${chip} bpm`).toBeGreaterThanOrEqual(60)
        expect(r.bpm, `${mood}/${chip} bpm`).toBeLessThanOrEqual(90)
        expect(r.channels.length, `${mood}/${chip}`).toBeGreaterThanOrEqual(3)
        const out = renderSong(r.song)
        expect(rms(out.L), `${mood}/${chip} audible`).toBeGreaterThan(0.005)
      }
    }
  }, 60000)

  it('composes every mood (also the lively ones) without chip violations', () => {
    for (const mood of MOOD_IDS) {
      const r = composeSong({ mood, seed: 3, bars: 8 })
      expect(validateSong(r.song).filter((i) => i.severity === 'error'), mood).toEqual([])
      expect(r.channels.length, mood).toBeGreaterThan(1)
    }
  })

  it('calm moods default to the SNES, a slow tempo and sparse or no drums', () => {
    for (const mood of ['ambient', 'lullaby', 'peaceful']) {
      const r = composeSong({ mood, seed: 9, bars: 8 })
      expect(r.chip).toBe('snes')
      expect(r.parts.some((p) => p.includes('drums')), mood).toBe(false)
    }
    const m = composeSong({ mood: 'mysterious-calm', seed: 9, bars: 8 })
    expect(m.parts.filter((p) => p.includes('drums')).length).toBeGreaterThan(0)
  })

  it('rounds seconds to whole bars and loops the whole song', () => {
    const r = composeSong({ mood: 'peaceful', chip: 'gb', seed: 2, bpm: 80, seconds: 30 })
    // a bar at 80 BPM is 3 s: 30 s = 10 bars
    expect(r.bars).toBe(10)
    expect(r.loop).toEqual({ startBar: 0, endBar: 10 })
    expect(r.song.loop).toEqual({ order: 0 })
    expect(r.durationSec).toBeCloseTo(30, 1)
    expect(composeSong({ mood: 'peaceful', chip: 'gb', seed: 2, loop: false, bars: 4 }).loop).toBeNull()
  })

  it('rejects unknown moods, channels and presets with a hint', () => {
    expect(() => composeSong({ mood: 'nope', seed: 1 })).toThrow(/Unknown mood/)
    expect(() => composeSong({ mood: 'ambient', chip: 'snes', seed: 1, instruments: { X9: 'lead' } })).toThrow(/no channel "X9"/)
    expect(() => composeSong({ mood: 'ambient', chip: 'snes', seed: 1, instruments: { V4: 'no-such-preset' } })).toThrow(/not a SNES preset/)
  })

  it('uses instrument overrides', () => {
    const r = composeSong({ mood: 'ambient', chip: 'snes', seed: 1, bars: 4, instruments: { V4: 'snes.flute.soft' } })
    expect(r.parts.find((p) => p.startsWith('V4'))).toContain('flute-soft')
  })
})

describe('composer intro', () => {
  const base = { mood: 'ambient', chip: 'snes', seed: 42, bars: 8 }
  it('intro 0 is the same song as no intro', () => {
    const a = composeSong(base)
    const b = composeSong({ ...base, intro: 0 })
    b.song.id = a.song.id
    expect(serializeProject(b.song)).toBe(serializeProject(a.song))
    expect(b.introBars).toBe(0)
  })

  it('puts the intro before the loop: quiet pads and bass, no lead, no drums', () => {
    const a = composeSong({ mood: 'mysterious-calm', chip: 'snes', seed: 42, bars: 8 })
    const r = composeSong({ mood: 'mysterious-calm', chip: 'snes', seed: 42, bars: 8, intro: 2 })
    expect(r.introBars).toBe(2)
    expect(r.loop).toEqual({ startBar: 2, endBar: 10 })
    expect(r.song.loop).toEqual({ order: 1 }) // pattern bars 2
    expect(r.song.orders).toHaveLength(5)
    expect(r.durationSec).toBeCloseTo(songSeconds(a.song) * (10 / 8), 2)
    expect([r.bpm, r.key, r.scale, r.chords]).toEqual([a.bpm, a.key, a.scale, a.chords])
    const rowsOf = (id: string) => channelRows(r.song, id)
    const lead = rowsOf('V4')
    expect(lead.slice(0, 32).every((c) => c === null)).toBe(true)
    expect(lead.slice(32).some((c) => c !== null)).toBe(true)
    // the body is the same music as without an intro (lead notes shifted by two bars)
    expect(lead.slice(32)).toEqual(channelRows(a.song, 'V4'))
    for (const ch of r.channels) {
      const intro = rowsOf(ch).slice(0, 32)
      const drums = r.parts.some((p) => p.startsWith(`${ch} drums`))
      if (drums) expect(intro.every((c) => c === null), `${ch} intro is silent`).toBe(true)
    }
    const bass = rowsOf('V1').slice(0, 32).filter((c) => c !== null)
    expect(bass.length).toBeGreaterThan(0)
    expect(validateSong(r.song).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('picks pattern bars that divide both the intro and the body', () => {
    const r = composeSong({ ...base, bars: 8, intro: 3 })
    expect(r.song.patternLength).toBe(16)
    expect(r.song.orders).toHaveLength(11)
    expect(r.song.loop).toEqual({ order: 3 })
    expect(r.loop).toEqual({ startBar: 3, endBar: 11 })
  })

  it('works on every chip and with loop false', () => {
    for (const chip of CHIPS) {
      for (const mood of ['peaceful', 'heroic']) {
        const r = composeSong({ mood, chip, seed: 3, bars: 4, intro: 4 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${mood}/${chip}`).toEqual([])
      }
    }
    const once = composeSong({ ...base, intro: 2, loop: false })
    expect(once.loop).toBeNull()
    expect(once.song.orders).toHaveLength(5)
  })
})

describe('composer motif', () => {
  const base = { mood: 'ambient', chip: 'snes', seed: 42, bars: 16, key: 'D', scale: 'major' }
  const motif = 'E5:4 G5:2 A5:2 B5:8'
  const pcsAt = (rows: ReturnType<typeof channelRows>, at: number[]) => at.map((r) => (rows[r]?.note as number) % 12)

  it('plays the transposed motif at bar 0 of the lead and again every second phrase', () => {
    const r = composeSong({ ...base, motif, motifKey: 'C' })
    expect(r.motif).toEqual({ bars: 1, transposeSemis: 2, placedAtBars: [0, 8] })
    const lead = channelRows(r.song, 'V4')
    expect(pcsAt(lead, [0, 4, 6, 8])).toEqual([6, 9, 11, 1]) // F# A B C# in D major
    expect(pcsAt(lead, [8 * 16, 8 * 16 + 4])).toEqual([6, 9]) // the repeat keeps the head of the motif
    // the other bars are still generated
    expect(lead.slice(16, 4 * 16).some((c) => c !== null)).toBe(true)
    expect(validateSong(r.song).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('keeps the harmony of the same track without the motif', () => {
    const a = composeSong(base)
    const r = composeSong({ ...base, motif })
    expect([r.bpm, r.key, r.scale, r.chords, r.progression]).toEqual([a.bpm, a.key, a.scale, a.chords, a.progression])
    for (const ch of ['V1', 'V2', 'V3']) expect(channelRows(r.song, ch)).toEqual(channelRows(a.song, ch))
    expect(a.motif).toBeNull()
  })

  it('is deterministic for a seed and motif, also with the motif repeating (development)', () => {
    const o = { ...base, bars: 32, motif: 'E5:4 G5:4 A5:4 B5:2 A5:2 G5:16 E5:8' }
    const a = composeSong(o)
    const b = composeSong(o)
    b.song.id = a.song.id
    expect(serializeProject(b.song)).toBe(serializeProject(a.song))
    expect(a.motif!.placedAtBars).toEqual([0, 8, 16, 24])
    const lead = channelRows(a.song, 'V4')
    // the first repeat only changes the last notes: the head is the same as the statement
    expect(lead.slice(8 * 16, 8 * 16 + 12)).toEqual(lead.slice(0, 12))
  })

  it('moves out-of-scale notes into the scale (a major motif on a minor track)', () => {
    const r = composeSong({ mood: 'ambient', chip: 'snes', seed: 1, bars: 8, key: 'C', scale: 'minor', motif: 'C5:4 E5:4 G5:4 B5:4', motifKey: 'C' })
    const lead = channelRows(r.song, 'V4')
    const pcs = pcsAt(lead, [0, 4, 8, 12])
    for (const pc of pcs) expect([0, 2, 3, 5, 7, 8, 10]).toContain(pc)
    expect(pcs[0]).toBe(0) // in-scale notes stay as written
    expect(pcs[2]).toBe(7)
  })

  it('rejects a motif longer than 4 bars, instrument/volume/chord tokens and bad notes (with the column)', () => {
    expect(() => composeSong({ ...base, motif: 'C5:16 D5:16 E5:16 F5:16 G5:16' })).toThrow(/at most 4 bars/)
    expect(() => composeSong({ ...base, motif: 'C5:4 @lead D5:4' })).toThrow(/col 6, "@lead"/)
    expect(() => composeSong({ ...base, motif: 'v8 C5:4' })).toThrow(/col 1/)
    expect(() => composeSong({ ...base, motif: '{C5 E5 G5}:8' })).toThrow(/chord/)
    expect(() => composeSong({ ...base, motif: 'C5:4 Z9:4' })).toThrow(/motif: [\s\S]*col 6/)
    expect(() => composeSong({ ...base, motif: 'r:4' })).toThrow(/no notes/)
    expect(() => composeSong({ ...base, motif, motifKey: 'H' })).toThrow(/Invalid motifKey/)
  })

  it('a 4-bar motif with a tie and rests works on every chip', () => {
    for (const chip of CHIPS) {
      const r = composeSong({ mood: 'heroic', chip, seed: 6, bars: 16, motif: 'E5:4 r:2 G5:2 ~:8 A5:16 B5:16 C6:16' })
      expect(validateSong(r.song).filter((i) => i.severity === 'error'), chip).toEqual([])
      expect(r.motif?.bars, chip).toBe(4)
    }
  })
})

describe('composer variation', () => {
  const base = { mood: 'heroic', chip: 'nes', seed: 8, bars: 16 }
  const ser = (o: Parameters<typeof composeSong>[0]) => {
    const r = composeSong(o)
    r.song.id = 'x'
    return { r, text: serializeProject(r.song) }
  }

  it('variation 0 is the original track', () => {
    expect(ser({ ...base, variation: 0 }).text).toBe(ser(base).text)
    expect(ser(base).r.variation).toBe(0)
  })

  it('keeps key, scale, tempo, chords and instruments and changes the lead (and often more)', () => {
    for (const o of [base, { mood: 'ambient', chip: 'snes', seed: 4, bars: 16 }, { mood: 'lullaby', chip: 'gb', seed: 12, bars: 16 }]) {
      const a = composeSong(o)
      const lead = o.chip === 'snes' ? 'V4' : o.chip === 'gb' ? 'P1' : 'P1'
      let changedLead = 0
      for (const k of [1, 2, 3, 4]) {
        const v = composeSong({ ...o, variation: k })
        expect([v.bpm, v.key, v.scale, v.chords, v.progression, v.parts]).toEqual([a.bpm, a.key, a.scale, a.chords, a.progression, a.parts])
        expect(v.variation).toBe(k)
        expect(v.song.instruments.map((i) => i.name)).toEqual(a.song.instruments.map((i) => i.name))
        expect(validateSong(v.song).filter((i) => i.severity === 'error')).toEqual([])
        if (JSON.stringify(channelRows(v.song, lead)) !== JSON.stringify(channelRows(a.song, lead))) changedLead++
      }
      expect(changedLead, `${o.mood}: lead differs`).toBeGreaterThanOrEqual(3)
    }
  })

  it('is deterministic per (seed, variation) and the variations differ from each other', () => {
    const a = ser({ ...base, variation: 2 }).text
    expect(ser({ ...base, variation: 2 }).text).toBe(a)
    expect(ser({ ...base, variation: 3 }).text).not.toBe(a)
    expect(a).not.toBe(ser(base).text)
  })

  it('keeps the motif and changes its development', () => {
    const o = { mood: 'ambient', chip: 'snes', seed: 3, bars: 32, key: 'C', scale: 'major', motif: 'C5:4 E5:4 G5:8' }
    const a = composeSong(o)
    const v = composeSong({ ...o, variation: 1 })
    expect(v.motif).toEqual(a.motif)
    const la = channelRows(a.song, 'V4')
    const lv = channelRows(v.song, 'V4')
    expect(lv.slice(0, 16)).toEqual(la.slice(0, 16)) // the statement is the same
    expect(lv.slice(16, 8 * 16)).not.toEqual(la.slice(16, 8 * 16)) // the generated bars after it are not
  })

  it('works on every chip and mood family', () => {
    for (const chip of CHIPS) {
      for (const mood of ['peaceful', 'heroic', 'mysterious-calm']) {
        const r = composeSong({ mood, chip, seed: 2, bars: 8, variation: 5, intro: 1 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${mood}/${chip}`).toEqual([])
      }
    }
  })
})

describe('compose_track tool with synth moods', () => {
  it('opens a synthwave song on the PS1 and an outrun song on the Dreamcast by default', async () => {
    const t = songSetup()
    const a = lastJson(await t.ok('compose_track', { mood: 'synthwave', seed: 1, bars: 4 }))
    expect(a).toMatchObject({ chip: 'ps1', mood: 'synthwave', bars: 4 })
    expect(t.session.song.chip).toBe('ps1')
    const b = lastJson(await t.ok('compose_track', { mood: 'drive', seed: 1, bars: 4 })) // alias of outrun
    expect(b).toMatchObject({ chip: 'dreamcast', mood: 'outrun' })
    const c = lastJson(await t.ok('compose_track', { mood: 'darkwave', chip: 'snes', seed: 1, bars: 4 }))
    expect(c).toMatchObject({ chip: 'snes', mood: 'darkwave' })
    const bad = await t.call('compose_track', { mood: 'outrun', chip: 'dreamcast', seed: 1, instruments: { V2: 'ps1.lead.saw-detuned' } })
    expect(bad.isError).toBe(true)
  })

  it('every synth mood composes with an intro and a variation on all seven chips', () => {
    for (const chip of CHIPS) {
      for (const mood of ['synthwave', 'outrun', 'darkwave', 'dreamwave']) {
        const r = composeSong({ mood, chip, seed: 2, bars: 4, intro: 2, variation: 3 })
        expect(validateSong(r.song).filter((i) => i.severity === 'error'), `${mood}/${chip}`).toEqual([])
      }
    }
  })
})

describe('compose_track tool', () => {
  it('opens the new song, returns the JSON object last and keeps the replaced song', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('write_melody', { channel: 'P1', melody: 'C4 E4 G4' })
    const before = t.session.song.id
    const r = await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 8, name: 'Calm one' })
    const j = lastJson(r)
    expect(j).toMatchObject({ name: 'Calm one', chip: 'snes', mood: 'ambient', bars: 8, seed: 1, loop: { startBar: 0, endBar: 8 } })
    expect(j['songId']).toBe(t.session.song.id)
    expect(j['durationSec']).toBeCloseTo(songSeconds(t.session.song), 2)
    expect(j['channels']).toEqual(expect.arrayContaining(['V1', 'V4']))
    expect(resultText(r)).toMatch(/Composed "Calm one"/)

    const list = lastJson(await t.ok('list_songs')) as { songs: Array<{ songId: string; current: boolean; chip: string }> }
    expect(list.songs.map((s) => s.songId)).toEqual([j['songId'], before])
    expect(list.songs.map((s) => s.current)).toEqual([true, false])
  })

  it('without a seed it picks one, returns it, and it reproduces the song', async () => {
    const t = songSetup()
    const a = lastJson(await t.ok('compose_track', { mood: 'lullaby', bars: 4 }))
    expect(typeof a['seed']).toBe('number')
    const b = lastJson(await t.ok('compose_track', { mood: 'lullaby', bars: 4, seed: a['seed'] }))
    expect({ ...b, songId: 0 }).toEqual({ ...a, songId: 0 })
  })

  it('undo brings the previous song back', async () => {
    const t = songSetup()
    const before = t.session.song.id
    await t.ok('compose_track', { mood: 'peaceful', chip: 'nes', seed: 1, bars: 4 })
    expect(t.session.song.id).not.toBe(before)
    t.session.undo()
    expect(t.session.song.id).toBe(before)
  })

  it('reports a bad mood as an error result', async () => {
    const t = songSetup()
    const r = await t.call('compose_track', { mood: 'nope' })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/Unknown mood/)
  })
})

describe('compose_track intro through the tools', () => {
  it('reports introBars and the loop after the intro; render_audio starts the loop at the intro end', async () => {
    const t = songSetup()
    const c = lastJson(await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4, intro: 2 }))
    expect(c).toMatchObject({ bars: 4, introBars: 2, loop: { startBar: 2, endBar: 6 } })
    expect(c['durationSec'] as number).toBeCloseTo(songSeconds(t.session.song), 2)
    const j = lastJson(await t.ok('render_audio', { path: '/mem/out/intro.wav', format: 'wav' }))
    const introSec = (2 * 4 * 60) / t.session.song.timing.bpm
    expect(j['loopStartSec'] as number).toBeCloseTo(introSec, 2)
    expect(j['loopEndSec'] as number).toBeCloseTo(c['durationSec'] as number, 2)
    const text = resultText(await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4, intro: 2 }))
    expect(text).toMatch(/2-bar intro plays once/)
    expect((await t.call('compose_track', { mood: 'ambient', intro: 5 })).isError).toBe(true)
  })
})

describe('compose_track motif through the tools', () => {
  it('returns the motif placement and mentions it; bad motifs are error results', async () => {
    const t = songSetup()
    const r = await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 16, motif: 'E5:4 G5:4 A5:8', motifKey: 'C' })
    const j = lastJson(r)
    expect(j['motif']).toMatchObject({ bars: 1, placedAtBars: [0, 8] })
    expect(resultText(r)).toMatch(/Motif \(1 bar, transposed .* semitones\) plays at loop bars 0, 8/)
    const none = await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4 })
    expect(lastJson(none)['motif']).toBeNull()
    expect(resultText(none)).not.toMatch(/Motif/)
    const bad = await t.call('compose_track', { mood: 'ambient', motif: '@lead C5' })
    expect(bad.isError).toBe(true)
  })
})

describe('compose_track variation through the tools', () => {
  it('echoes the variation in the JSON and the text; out-of-range values are errors', async () => {
    const t = songSetup()
    const r = await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4, variation: 3 })
    expect(lastJson(r)['variation']).toBe(3)
    expect(resultText(r)).toMatch(/seed 1, variation 3\./)
    const plain = await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4 })
    expect(lastJson(plain)['variation']).toBe(0)
    expect(resultText(plain)).not.toMatch(/, variation/)
    expect((await t.call('compose_track', { mood: 'ambient', variation: 100 })).isError).toBe(true)
  })
})

describe('render_audio', () => {
  it('writes a WAV that ends exactly at the loop end, with the loop points in the JSON and the smpl chunk', async () => {
    const t = songSetup()
    const c = lastJson(await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 8 }))
    const r = await t.ok('render_audio', { path: '/mem/out/calm.wav', format: 'wav' })
    const j = lastJson(r)
    const wav = readWav(t.services.files.get('/mem/out/calm.wav')!)
    expect(j).toMatchObject({ path: '/mem/out/calm.wav', format: 'wav', sampleRate: 44100, loopStartSec: 0, loopStartSample: 0 })
    expect(j['loopEndSample']).toBe(wav.length)
    expect(j['loopEndSec']).toBeCloseTo(wav.length / 44100, 5)
    expect(j['durationSec']).toBeCloseTo(wav.length / 44100, 5)
    // the file is exactly the song: 8 bars, no tail
    expect(c['durationSec'] as number).toBeCloseTo(wav.length / 44100, 2)
    expect(Math.abs(wav.length - songSeconds(t.session.song) * 44100)).toBeLessThanOrEqual(2)
    // smpl chunk: forward loop over the whole file (the chunk stores the inclusive last sample)
    expect(wav.loops).toHaveLength(1)
    expect(wav.loops[0]!.start).toBe(0)
    expect(wav.loops[0]!.end).toBe(wav.length - 1)
  })

  it('with an intro the loop starts after it and the file still ends at the loop end', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'peaceful', chip: 'gb', seed: 4, bars: 8 }) // 2 order rows of 4 bars
    await t.ok('set_loop', { order: 1 })
    const j1 = lastJson(await t.ok('render_audio', { path: '/mem/a.wav', format: 'wav' }))
    const j2 = lastJson(await t.ok('render_audio', { path: '/mem/b.wav', format: 'wav', loops: 2 }))
    const sr = 44100
    const introSec = (4 * 4 * 60) / t.session.song.timing.bpm
    expect(j1['loopStartSec'] as number).toBeCloseTo(introSec, 2)
    expect(j1['loopEndSec']).toBe(j1['durationSec'])
    expect((j1['loopEndSample'] as number) - (j1['loopStartSample'] as number)).toBeCloseTo(introSec * sr, -1)
    // loops: 2 = intro + two bodies; the loop is the last body
    expect(j2['durationSec'] as number).toBeCloseTo(introSec * 3, 1)
    expect((j2['loopEndSample'] as number) - (j2['loopStartSample'] as number)).toBeCloseTo(introSec * sr, -1)
    expect(j2['loopEndSec']).toBe(j2['durationSec'])
    expect(readWav(t.services.files.get('/mem/b.wav')!).length).toBe(j2['loopEndSample'])
  })

  it('a fade-out makes it non-looping and longer', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 4, bars: 4 })
    const plain = lastJson(await t.ok('render_audio', { path: '/mem/a.wav', format: 'wav' }))
    const faded = lastJson(await t.ok('render_audio', { path: '/mem/b.wav', format: 'wav', fadeOutSec: 3 }))
    expect(faded['loopStartSec']).toBeNull()
    expect(faded['loopEndSample']).toBeNull()
    expect(faded['durationSec'] as number).toBeCloseTo((plain['durationSec'] as number) + 3, 1)
  })

  it('a one-shot song has no loop points', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 4, bars: 4, loop: false })
    const j = lastJson(await t.ok('render_audio', { path: '/mem/a.wav', format: 'wav' }))
    expect([j['loopStartSec'], j['loopEndSec'], j['loopStartSample'], j['loopEndSample']]).toEqual([null, null, null, null])
  })

  it('without an encoder ogg falls back to a WAV next to the path and says so', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 4, bars: 4 })
    const j = lastJson(await t.ok('render_audio', { path: '/mem/out/theme.ogg' }))
    expect(j['format']).toBe('wav')
    expect(j['path']).toBe('/mem/out/theme.wav')
    expect(String(j['warning'])).toMatch(/wav/i)
    expect(t.services.files.has('/mem/out/theme.wav')).toBe(true)
  })

  it('uses the encoder service for ogg and passes the WAV with its loop chunk', async () => {
    const t = songSetup()
    let seen: { path: string; format: string; loops: number } | null = null
    t.services.encodeAudio = async (wav, path, format) => {
      seen = { path, format, loops: readWav(wav).loops.length }
      return { path, format }
    }
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 4, bars: 4 })
    const j = lastJson(await t.ok('render_audio', { path: '/mem/out/theme.ogg' }))
    expect(seen).toEqual({ path: '/mem/out/theme.ogg', format: 'ogg', loops: 1 })
    expect(j).toMatchObject({ path: '/mem/out/theme.ogg', format: 'ogg' })
    expect(j['warning']).toBeUndefined()
  })

  it('refuses a silent song and renders a held song by id without switching to it', async () => {
    const t = songSetup()
    expect((await t.call('render_audio', { path: '/mem/x.wav', format: 'wav' })).isError).toBe(true)
    const first = lastJson(await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 1, bars: 4 }))
    await t.ok('compose_track', { mood: 'peaceful', chip: 'nes', seed: 1, bars: 4 })
    const current = t.session.song.id
    const j = lastJson(await t.ok('render_audio', { song: first['songId'], path: '/mem/first.wav', format: 'wav' }))
    expect(j['durationSec'] as number).toBeCloseTo(first['durationSec'] as number, 1)
    expect(t.session.song.id).toBe(current)
    expect((await t.call('render_audio', { song: 'song-nope', path: '/mem/x.wav', format: 'wav' })).isError).toBe(true)
  })
})

describe('song session tools', () => {
  it('save_song, open_song and delete_song round trip', async () => {
    const t = songSetup()
    const a = lastJson(await t.ok('compose_track', { mood: 'ambient', chip: 'snes', seed: 1, bars: 4 }))
    const saved = lastJson(await t.ok('save_song', { path: '/mem/songs/a.ctune' }))
    expect(saved).toEqual({ songId: a['songId'], path: '/mem/songs/a.ctune' })
    const b = lastJson(await t.ok('compose_track', { mood: 'peaceful', chip: 'nes', seed: 2, bars: 4 }))

    const list = lastJson(await t.ok('list_songs')) as { songs: Array<{ songId: string; path: string | null; current: boolean }> }
    expect(list.songs).toHaveLength(2)
    expect(list.songs.find((s) => s.songId === a['songId'])).toMatchObject({ path: '/mem/songs/a.ctune', current: false })
    expect(list.songs.find((s) => s.songId === b['songId'])).toMatchObject({ path: null, current: true })

    const opened = lastJson(await t.ok('open_song', { path: '/mem/songs/a.ctune' }))
    expect(opened).toMatchObject({ songId: a['songId'], name: a['name'], path: '/mem/songs/a.ctune' })
    expect(t.session.song.id).toBe(a['songId'])
    const list2 = lastJson(await t.ok('list_songs')) as { songs: Array<{ songId: string; current: boolean }> }
    expect(list2.songs.map((s) => s.songId).sort()).toEqual([a['songId'], b['songId']].sort())
    expect(list2.songs.find((s) => s.current)!.songId).toBe(a['songId'])

    expect(lastJson(await t.ok('delete_song', { song: b['songId'] }))).toEqual({ deleted: true })
    expect(((lastJson(await t.ok('list_songs')) as { songs: unknown[] }).songs)).toHaveLength(1)
    // deleting the open song falls back to an empty one; the file stays
    await t.ok('delete_song', { song: a['songId'] })
    expect(t.session.song.name).toBe('Untitled')
    expect(t.services.files.has('/mem/songs/a.ctune')).toBe(true)
    expect((await t.call('delete_song', { song: 'song-nope' })).isError).toBe(true)
  })

  it('open_song with exportTo exports the looping audio on save_song', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 1, bars: 4 })
    await t.ok('save_song', { path: '/mem/songs/l.ctune' })
    await t.ok('open_song', { path: '/mem/songs/l.ctune', exportTo: '/mem/exports/l.wav', exportFormat: 'wav' })
    expect(t.services.files.has('/mem/exports/l.wav')).toBe(false)
    await t.ok('save_song', { path: '/mem/songs/l.ctune' })
    const wav = readWav(t.services.files.get('/mem/exports/l.wav')!)
    expect(wav.loops).toHaveLength(1)
    const side = JSON.parse(new TextDecoder().decode(t.services.files.get('/mem/exports/l.wav.json')!)) as Record<string, unknown>
    expect(Object.keys(side).sort()).toEqual(['durationSec', 'loopEndSec', 'loopStartSec', 'sampleRate'])
    expect(side['loopStartSec']).toBe(0)
    expect(side['sampleRate']).toBe(44100)
    expect(side['loopEndSec'] as number).toBeCloseTo(wav.length / 44100, 5)
    expect(side['durationSec']).toBe(side['loopEndSec'])
  })

  it('the sidecar follows the actually written file when ogg falls back to wav', async () => {
    const t = songSetup()
    await t.ok('compose_track', { mood: 'lullaby', chip: 'gb', seed: 1, bars: 4 })
    await t.ok('save_song', { path: '/mem/s.ctune' })
    await t.ok('open_song', { path: '/mem/s.ctune', exportTo: '/mem/exports/s.ogg' })
    await t.ok('save_song', { path: '/mem/s.ctune' })
    expect(t.services.files.has('/mem/exports/s.wav.json')).toBe(true)
    expect(t.services.files.has('/mem/exports/s.ogg.json')).toBe(false)
  })

  it('the new tools return normal text first and one JSON object last', async () => {
    const t = songSetup()
    for (const [name, args] of [
      ['compose_track', { mood: 'peaceful', chip: 'gb', seed: 1, bars: 4 }],
      ['render_audio', { path: '/mem/x.wav', format: 'wav' }],
      ['save_song', { path: '/mem/x.ctune' }],
      ['list_songs', {}],
      ['open_song', { path: '/mem/x.ctune' }],
      ['delete_song', { song: 'x' }]
    ] as const) {
      const r = await t.call(name, args)
      if (name === 'delete_song') {
        expect(r.isError).toBe(true)
        continue
      }
      expect(r.isError, `${name}: ${resultText(r)}`).toBeFalsy()
      expect(r.content.length, name).toBeGreaterThanOrEqual(2)
      expect(r.content[0]!.type).toBe('text')
      expect(() => lastJson(r), name).not.toThrow()
    }
  })
})
describe('synth moods through the tool host with render_audio', () => {
  /** Output folder of the checks (virtual: the test services keep files in memory). */
  const out = (name: string): string => join(process.cwd(), '.claude/temp/mdi10', name).replace(/\\/g, '/')

  function wavStats(bytes: Uint8Array): { seconds: number; peak: number; rms: number } {
    const w = readWav(bytes)
    const L = w.channels[0]!
    let peak = 0
    for (const ch of w.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v))
    return { seconds: L.length / w.sampleRate, peak, rms: rms(L) }
  }

  it('compose_track synthwave on the PS1: chip, instrument override, loop after the intro and an audible file', async () => {
    const t = songSetup()
    const c = lastJson(await t.ok('compose_track', { mood: 'synthwave', seed: 1, bars: 8, intro: 2, instruments: { V2: 'ps1.lead.sync' } }))
    expect(c).toMatchObject({ chip: 'ps1', mood: 'synthwave', bars: 8, introBars: 2, seed: 1 })
    expect(t.session.song.instruments.some((i) => i.presetId === 'ps1.lead.sync')).toBe(true)
    const path = out('synthwave-e2.wav')
    const r = await t.ok('render_audio', { path, format: 'wav' })
    const j = lastJson(r)
    expect(j['path']).toBe(path)
    expect(j['loopStartSec'] as number).toBeCloseTo((2 * 4 * 60) / (c['bpm'] as number), 2)
    expect(j['durationSec'] as number).toBeCloseTo(c['durationSec'] as number, 2)
    const s = wavStats(t.services.files.get(path)!)
    expect(s.seconds).toBeCloseTo(j['durationSec'] as number, 2)
    expect(s.peak).toBeGreaterThan(0.05)
    expect(s.peak).toBeLessThanOrEqual(1)
    expect(s.rms).toBeGreaterThan(0.01)
    // the text ends with one JSON item
    const texts = r.content.filter((x) => x.type === 'text')
    expect(() => JSON.parse((texts[texts.length - 1] as { text: string }).text)).not.toThrow()
  }, 60000)

  it('outrun on the Dreamcast, converted to the SNES, still renders', async () => {
    const t = songSetup()
    const c = lastJson(await t.ok('compose_track', { mood: 'outrun', chip: 'dreamcast', seed: 1, bars: 4, intro: 2 }))
    expect(c).toMatchObject({ chip: 'dreamcast', mood: 'outrun', introBars: 2 })
    const dc = lastJson(await t.ok('render_audio', { path: out('outrun-e2.wav'), format: 'wav' }))
    expect(dc['loopStartSec'] as number).toBeCloseTo((2 * 4 * 60) / (c['bpm'] as number), 2)
    expect(wavStats(t.services.files.get(out('outrun-e2.wav'))!).peak).toBeGreaterThan(0.05)
    await t.ok('convert_chip', { chip: 'snes' })
    expect(t.session.song.chip).toBe('snes')
    const snes = lastJson(await t.ok('render_audio', { path: out('outrun-snes-e2.wav'), format: 'wav' }))
    expect(snes['durationSec'] as number).toBeCloseTo(c['durationSec'] as number, 1)
    expect(wavStats(t.services.files.get(out('outrun-snes-e2.wav'))!).rms).toBeGreaterThan(0.005)
  }, 60000)

  it('compose_sfx on the PS1 renders in the same call', async () => {
    const t = songSetup()
    const j = lastJson(await t.ok('compose_sfx', { kind: 'stinger', sound: 'success', chip: 'ps1', seed: 3, path: out('success-ps1-e2.wav'), format: 'wav' }))
    expect(j).toMatchObject({ kind: 'stinger', sound: 'success', chip: 'ps1' })
    expect(wavStats(t.services.files.get(out('success-ps1-e2.wav'))!).peak).toBeGreaterThan(0.05)
  }, 60000)

  it('the tool texts name the seven chips, the synth moods and their default chips', () => {
    const t = songSetup()
    const props = (name: string): Record<string, { description?: string }> => (t.registry.defs().find((d) => d.name === name)!.parameters as { properties: Record<string, { description?: string }> }).properties
    const desc = (name: string): string => t.registry.defs().find((d) => d.name === name)!.description
    for (const chip of CHIPS) {
      expect(props('compose_track')['chip']!.description, `compose_track ${chip}`).toContain(chip)
      expect(props('compose_sfx')['chip']!.description, `compose_sfx ${chip}`).toContain(chip)
      expect(desc('new_song'), `new_song ${chip}`).toContain(chip === 'ps1' || chip === 'dreamcast' ? `"${chip}"` : chip)
      expect(props('get_mood_recipe')['chip']!.description, `get_mood_recipe ${chip}`).toContain(chip)
    }
    const track = desc('compose_track')
    for (const mood of ['synthwave', 'outrun', 'darkwave', 'dreamwave']) expect(track, mood).toContain(mood)
    expect(track).toContain('default to PS1 (synthwave, darkwave) and Dreamcast (outrun, dreamwave)')
    expect(track).toContain('"V2":"dreamcast.lead.sync"')
    expect(props('compose_track')['instruments']!.description).toContain('{"V2":"ps1.lead.sync"}')
    expect(desc('new_song')).toContain('"voices":24')
    expect(desc('new_song')).toContain('"reverb":{"preset":"hall"}')
    expect(desc('new_song')).toContain('"dsp":{"preset":"chorus-hall"}')
    expect(desc('set_song_info')).toContain('PS1 reverb, Dreamcast dsp')
    expect(desc('get_mood_recipe')).toContain('synthwave, outrun, darkwave, dreamwave')
    const kinds = (t.registry.defs().find((d) => d.name === 'add_instrument')!.parameters as { properties: { params: { description: string } } }).properties.params.description
    expect(kinds).toContain('psx-sample (PS1) {sample, baseNote, fine?, adsr:')
    expect(kinds).toContain('aica-sample (Dreamcast) {sample, baseNote, fine?, format:')
  })

  it('get_mood_recipe lists the synth moods and plans the crash on V16 and names the toms on V12', async () => {
    const t = songSetup()
    const list = await t.text('get_mood_recipe')
    for (const mood of ['synthwave', 'outrun', 'darkwave', 'dreamwave']) expect(list).toContain(`${mood}: `)
    for (const chip of ['ps1', 'dreamcast']) {
      const r = await t.text('get_mood_recipe', { mood: 'retrowave', chip })
      expect(r, chip).toContain('V16 (crash): crash cymbal (first bar of a phrase); the toms play on V12')
      expect(r, chip).toContain('toms V12, kick V13')
      expect(r, chip).not.toContain('toms and crash')
      expect(r, chip).toContain('V13 (kick): kick')
    }
  })
})
