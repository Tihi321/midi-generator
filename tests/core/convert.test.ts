import { describe, expect, it } from 'vitest'
import { type ChipId, type Song, buildNoteTimeline, convertChip, createSong, getPattern, importMidi, missingPresetSample, resolvePreset, validateSong } from '../../src/core'
import { type MidiEvent, encodeSmf, metaTempo } from '../../src/core/codecs/midiFile'

function nesSource(): Song {
  const song = createSong({ chip: 'nes', name: 'Hero', patternLength: 16, bpm: 140, key: 'A', scale: 'minor' })
  song.instruments.push(
    resolvePreset('nes', 'lead', 'pulse'),
    resolvePreset('nes', 'arp', 'pulse'),
    resolvePreset('nes', 'bass', 'triangle'),
    resolvePreset('nes', 'kick', 'noise'),
    resolvePreset('nes', 'snare', 'noise'),
    resolvePreset('nes', 'hihat', 'noise')
  )
  song.orders = [song.channels.map(() => 0), song.channels.map(() => 1)]
  song.loop = { order: 1 }
  const lead = getPattern(song, 'P1', 0)
  lead.rows[0] = { note: 69, inst: 0, vol: 14, fx: [{ code: 'W', param: 2 }] }
  lead.rows[4] = { note: 72 }
  lead.rows[8] = { note: 76, fx: [{ code: '4', param: 0x34 }] }
  lead.rows[12] = { note: 'off' }
  getPattern(song, 'P1', 1).rows[0] = { note: 67, inst: 0, vol: 12 }
  const arp = getPattern(song, 'P2', 0)
  arp.rows[0] = { note: 57, inst: 1, vol: 9, fx: [{ code: '0', param: 0x37 }] }
  arp.rows[8] = { note: 53, fx: [{ code: 'F', param: 0x90 }, { code: '0', param: 0x47 }] }
  const bass = getPattern(song, 'TR', 0)
  bass.rows[0] = { note: 33, inst: 2 }
  bass.rows[8] = { note: 41 }
  getPattern(song, 'TR', 1).rows[0] = { note: 31, inst: 2 }
  const dr = getPattern(song, 'NO', 0)
  for (const [row, inst] of [[0, 3], [2, 5], [4, 4], [6, 5], [8, 3], [10, 5], [12, 4], [14, 5]] as const) dr.rows[row] = { note: 60, inst, vol: row % 4 ? 8 : 15 }
  return song
}

function role(song: Song, ch: string, order: number, row: number): string | undefined {
  const ci = song.channels.findIndex((c) => c.id === ch)
  const pat = song.patterns.get(`${ch}:${song.orders[order]![ci]!}`)
  const cell = pat?.rows[row]
  if (!cell || cell.inst === undefined) return undefined
  return song.instruments[cell.inst]?.role
}

const errorsOf = (s: Song): string[] => validateSong(s).filter((i) => i.severity === 'error').map((i) => i.message)

describe('convertChip', () => {
  it('NES -> Genesis: roles map to FM voices, timing/orders/loop/meta are kept', () => {
    const src = nesSource()
    const { song, report } = convertChip(src, 'genesis')
    expect(song.chip).toBe('genesis')
    expect(song.channels.map((c) => c.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'S1', 'S2', 'S3', 'NO'])
    expect(song.timing).toEqual(src.timing)
    expect(song.patternLength).toBe(16)
    expect(song.orders).toHaveLength(2)
    expect(song.loop).toEqual({ order: 1 })
    expect(song.meta.key).toBe('A')
    expect(song.meta.scale).toBe('minor')
    expect(song.name).toBe('Hero')
    // bass on F1, lead on F2, the arpeggio voice on a harmony FM channel
    const bassCell = getPattern(song, 'F1', song.orders[0]![0]!).rows[0]!
    expect(song.instruments[bassCell.inst!]).toMatchObject({ kind: 'fm', role: 'bass' })
    expect(song.instruments[getPattern(song, 'F2', song.orders[0]![1]!).rows[0]!.inst!]).toMatchObject({ kind: 'fm', role: 'lead' })
    expect(getPattern(song, 'F3', song.orders[0]![2]!).rows[0]).toMatchObject({ note: 57, fx: [{ code: '0', param: 0x37 }] })
    // the pulse-duty effect does not exist on FM: dropped and reported; the arpeggio survives
    expect(getPattern(song, 'F2', song.orders[0]![1]!).rows[0]!.fx).toBeUndefined()
    const text = report.join('\n')
    expect(text).toMatch(/Dropped effects.*W on F2/)
    expect(text).toMatch(/P1 .*-> F2 FM 2 \[lead\]/)
    expect(text).toMatch(/TR .*-> F1 FM 1 \[bass\]/)
    expect(errorsOf(song)).toEqual([])
  })

  it('keeps the drums by role and uses the target convention for the noise note', () => {
    const src = nesSource()
    const { song } = convertChip(src, 'genesis')
    for (const row of [0, 2, 4, 6, 8, 10, 12, 14]) expect(role(song, 'NO', 0, row)).toBe(role(src, 'NO', 0, row))
    const cell = getPattern(song, 'NO', song.orders[0]![9]!).rows[0]!
    expect(cell.note).toBe(60)
    expect(song.instruments[cell.inst!]!.kind).toBe('psg-noise')
    expect(cell.vol).toBe(15)
    // with the DAC channel the kicks move to F6 and the rest stay on the PSG noise
    const dac = convertChip(src, 'genesis', { chipConfig: { fm6Dac: true } }).song
    expect(role(dac, 'F6', 0, 0)).toBe('kick')
    expect(role(dac, 'F6', 0, 2)).toBeUndefined()
    expect(role(dac, 'NO', 0, 4)).toBe('snare')
    expect(errorsOf(dac)).toEqual([])
  })

  it('Genesis -> NES folds ten channels into five and keeps the tempo effects', () => {
    const gen = createSong({ chip: 'genesis', name: 'Boss', patternLength: 16 })
    gen.instruments.push(resolvePreset('genesis', 'bass', 'fm'), resolvePreset('genesis', 'lead', 'fm'), resolvePreset('genesis', 'pad', 'fm'), resolvePreset('genesis', 'hihat', 'psg-noise'), resolvePreset('genesis', 'lead', 'psg-square'))
    const set = (ch: string, row: number, note: number, inst?: number): void => {
      getPattern(gen, ch, 0).rows[row] = { note, ...(inst !== undefined ? { inst } : {}) }
    }
    for (const [i, ch] of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].entries()) {
      for (let r = 0; r < 16; r += 4) set(ch, r, 40 + i * 5 + (r % 7), i === 0 ? 0 : i === 1 ? 1 : 2)
    }
    for (const ch of ['S1', 'S2']) for (let r = 0; r < 16; r += 2) set(ch, r, 60 + r, 4)
    for (let r = 0; r < 16; r += 2) set('NO', r, 60, 3)
    getPattern(gen, 'S3', 0).rows[3] = { fx: [{ code: 'F', param: 0xa0 }] } // an otherwise empty channel carrying tempo
    const { song, report } = convertChip(gen, 'nes')
    expect(song.channels.map((c) => c.id)).toEqual(['P1', 'P2', 'TR', 'NO'])
    const text = report.join('\n')
    expect(text).toMatch(/Dropped F\d/)
    expect(text).toMatch(/S1 .*-> P1 Pulse 1 \[lead\]/)
    expect(text).toMatch(/Moved 1 flow effect/)
    expect(text).toMatch(/-> TR Triangle \[bass\]/)
    const fx = [...song.patterns.values()].flatMap((p) => p.rows.flatMap((c) => c?.fx ?? []))
    expect(fx).toContainEqual({ code: 'F', param: 0xa0 })
    // hi-hat hits kept on the noise channel
    expect(role(song, 'NO', 0, 0)).toBe('hihat')
    expect(errorsOf(song)).toEqual([])
  })

  it('NES -> SNES adds the sample slots the preset instruments need', () => {
    const { song } = convertChip(nesSource(), 'snes')
    expect(song.samples.length).toBeGreaterThan(0)
    expect(song.instruments.every((i) => i.kind === 'snes-sample')).toBe(true)
    for (const inst of song.instruments) if (inst.kind === 'snes-sample') expect(song.samples.some((s) => s.id === inst.sample)).toBe(true)
    // bass on V1, lead V4, drums V7 (kick) and V8
    expect(role(song, 'V1', 0, 0)).toBe('bass')
    expect(role(song, 'V4', 0, 0)).toBe('lead')
    expect(role(song, 'V7', 0, 0)).toBe('kick')
    expect(role(song, 'V8', 0, 4)).toBe('snare')
    expect(errorsOf(song)).toEqual([])
  })

  it('GB -> PCE moves the wave bass to C1 and the drums to the noise channels', () => {
    const gb = createSong({ chip: 'gb', name: 'Town', patternLength: 16 })
    gb.instruments.push(resolvePreset('gb', 'lead', 'pulse'), resolvePreset('gb', 'bass', 'wave'), resolvePreset('gb', 'kick', 'noise'), resolvePreset('gb', 'snare', 'noise'))
    getPattern(gb, 'P1', 0).rows[0] = { note: 72, inst: 0, vol: 15 }
    getPattern(gb, 'P1', 0).rows[4] = { note: 74 }
    getPattern(gb, 'WV', 0).rows[0] = { note: 36, inst: 1, vol: 8 }
    getPattern(gb, 'NO', 0).rows[0] = { note: 60, inst: 2 }
    getPattern(gb, 'NO', 0).rows[4] = { note: 60, inst: 3 }
    const { song, report } = convertChip(gb, 'pce')
    expect(role(song, 'C1', 0, 0)).toBe('bass')
    expect(role(song, 'C2', 0, 0)).toBe('lead')
    expect(role(song, 'C5', 0, 0)).toBe('kick')
    expect(role(song, 'C6', 0, 4)).toBe('snare')
    expect(report.join('\n')).toMatch(/WV .*-> C1 Wave 1 \[bass\]/)
    expect(errorsOf(song)).toEqual([])
  })

  it('transposes notes into the target range and says so', () => {
    const gen = createSong({ chip: 'genesis', name: 'Low', patternLength: 16 })
    gen.instruments.push(resolvePreset('genesis', 'lead', 'psg-square'))
    getPattern(gen, 'S1', 0).rows[0] = { note: 57, inst: 0 }
    getPattern(gen, 'S1', 0).rows[4] = { note: 60 }
    const pce = convertChip(gen, 'nes').song
    expect(getPattern(pce, 'P1', 0).rows[0]!.note).toBe(57) // in range: untouched
    const nes = createSong({ chip: 'nes', patternLength: 16 })
    nes.instruments.push(resolvePreset('nes', 'bass', 'triangle'))
    getPattern(nes, 'TR', 0).rows[0] = { note: 24, inst: 0 }
    getPattern(nes, 'TR', 0).rows[4] = { note: 26 }
    getPattern(nes, 'P1', 0).rows[0] = { note: 40, inst: undefined }
    const out = convertChip(nes, 'genesis')
    // TR bass maps to F1 (range 24..107): nothing to move
    expect(getPattern(out.song, 'F1', 0).rows[0]!.note).toBe(24)
    const psgOnly = createSong({ chip: 'gb', patternLength: 16, name: 'x' })
    psgOnly.instruments.push(resolvePreset('gb', 'lead', 'pulse'))
    getPattern(psgOnly, 'P1', 0).rows[0] = { note: 37, inst: 0 }
    const toGen = convertChip(psgOnly, 'genesis')
    expect(errorsOf(toGen.song)).toEqual([])
  })

  it('reports when the song is already on that chip and when only the config changes', () => {
    const src = nesSource()
    const same = convertChip(src, 'nes')
    expect(same.report[0]).toMatch(/already a NES song/)
    expect(same.song).not.toBe(src)
    const dpcm = convertChip(src, 'nes', { chipConfig: { dpcm: true } })
    expect(dpcm.song.channels.map((c) => c.id)).toContain('DM')
    expect(role(dpcm.song, 'DM', 0, 0)).toBe('kick')
    expect(role(dpcm.song, 'NO', 0, 4)).toBe('snare')
    expect(errorsOf(dpcm.song)).toEqual([])
  })

  it('does not modify the source song', () => {
    const src = nesSource()
    const before = JSON.stringify([src.orders, [...src.patterns], src.instruments])
    convertChip(src, 'genesis')
    expect(JSON.stringify([src.orders, [...src.patterns], src.instruments])).toBe(before)
  })

  it('every chip converts to every other chip and validates', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), { tick: 0, kind: 'program', channel: 0, program: 80 }, { tick: 1, kind: 'program', channel: 1, program: 33 }, { tick: 2, kind: 'program', channel: 2, program: 48 }]
    for (let i = 0; i < 24; i++) {
      ev.push({ tick: i * 240, kind: 'noteOn', channel: 0, note: 72 + (i % 5), velocity: 90 }, { tick: i * 240 + 200, kind: 'noteOff', channel: 0, note: 72 + (i % 5), velocity: 0 })
      ev.push({ tick: i * 240, kind: 'noteOn', channel: 1, note: 36 + (i % 3) * 7, velocity: 110 }, { tick: i * 240 + 200, kind: 'noteOff', channel: 1, note: 36 + (i % 3) * 7, velocity: 0 })
      ev.push({ tick: i * 480, kind: 'noteOn', channel: 2, note: 60, velocity: 70 }, { tick: i * 480, kind: 'noteOn', channel: 2, note: 64, velocity: 70 }, { tick: i * 480 + 400, kind: 'noteOff', channel: 2, note: 60, velocity: 0 }, { tick: i * 480 + 400, kind: 'noteOff', channel: 2, note: 64, velocity: 0 })
      const d = i % 2 ? 38 : 36
      ev.push({ tick: i * 240, kind: 'noteOn', channel: 9, note: d, velocity: 100 }, { tick: i * 240 + 50, kind: 'noteOff', channel: 9, note: d, velocity: 0 })
      ev.push({ tick: i * 240 + 120, kind: 'noteOn', channel: 9, note: 42, velocity: 80 }, { tick: i * 240 + 150, kind: 'noteOff', channel: 9, note: 42, velocity: 0 })
    }
    ev.sort((a, b) => a.tick - b.tick)
    const data = encodeSmf([ev])
    const chips: ChipId[] = ['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast']
    for (const from of chips) {
      const src = importMidi(data, { chip: from }).song
      const srcDrums = buildNoteTimeline(src).events.filter((e) => e.percussion).length
      expect(srcDrums).toBeGreaterThan(20)
      for (const to of chips) {
        if (to === from) continue
        const { song, report } = convertChip(src, to)
        const errors = errorsOf(song)
        expect(errors, `${from} -> ${to}: ${errors.join('; ')}\n${report.join('\n')}`).toEqual([])
        const drums = buildNoteTimeline(song).events.filter((e) => e.percussion).length
        expect(drums, `${from} -> ${to} drums`).toBeGreaterThanOrEqual(srcDrums * 0.7)
      }
    }
  })
})

// ---- the sample chips (PS1 24 / Dreamcast 64 voices)

/** A song with `melodic` melodic voices (V1..V12, then V17..) and kick/snare on V13/V14, `notes` notes per voice. */
function voiceSong(chip: ChipId, voices: number | undefined, melodic: number, notes = 8): Song {
  const song = createSong({ chip, name: 'Many', patternLength: 16, ...(voices ? { chipConfig: { chip, voices } as never } : {}) })
  const roles = ['bass', 'lead', 'pad', 'arp', 'pluck'] as const
  const ids = song.channels.map((c) => c.id).filter((id) => ![13, 14, 15, 16].includes(Number(id.slice(1)))).slice(0, melodic)
  ids.forEach((id, i) => {
    const inst = resolvePreset(chip, i === 0 ? 'bass' : roles[1 + (i % 4)]!)
    const idx = song.instruments.push(inst) - 1
    const slot = missingPresetSample(song, inst)
    if (slot) song.samples.push(slot)
    const pat = getPattern(song, id, 0)
    for (let n = 0; n < notes; n++) pat.rows[n * 2] = { note: (i === 0 ? 36 : 60) + ((i + n) % 7), ...(n === 0 ? { inst: idx } : {}) }
  })
  const kick = song.instruments.push(resolvePreset(chip, 'kick')) - 1
  const snare = song.instruments.push(resolvePreset(chip, 'snare')) - 1
  for (const inst of song.instruments) {
    const slot = missingPresetSample(song, inst)
    if (slot) song.samples.push(slot)
  }
  for (let n = 0; n < 8; n++) {
    getPattern(song, 'V13', 0).rows[n * 2] = { note: 60, ...(n === 0 ? { inst: kick } : {}) }
    getPattern(song, 'V14', 0).rows[n * 2 + 1] = { note: 60, ...(n === 0 ? { inst: snare } : {}) }
  }
  return song
}

const noteCount = (s: Song, percussion: boolean): number => buildNoteTimeline(s).events.filter((e) => !!e.percussion === percussion).length

describe('convertChip with PS1 and Dreamcast', () => {
  it('SNES -> PS1 goes voice to voice by role, adds the sample slots and keeps the reverb send', () => {
    const snes = createSong({ chip: 'snes', name: 'Snes', patternLength: 16 })
    for (const [role, ch] of [['bass', 'V1'], ['lead', 'V4'], ['pad', 'V3'], ['kick', 'V7'], ['snare', 'V8']] as const) {
      const inst = resolvePreset('snes', role)
      const idx = snes.instruments.push(inst) - 1
      const slot = missingPresetSample(snes, inst)
      if (slot) snes.samples.push(slot)
      for (let n = 0; n < 4; n++) getPattern(snes, ch, 0).rows[n * 4] = { note: role === 'bass' ? 36 : 60, ...(n === 0 ? { inst: idx } : {}) }
    }
    const { song, report } = convertChip(snes, 'ps1')
    expect(song.channels).toHaveLength(16)
    expect(song.instruments.length).toBeGreaterThan(0)
    expect(song.instruments.every((i) => i.kind === 'psx-sample')).toBe(true)
    for (const inst of song.instruments) if (inst.kind === 'psx-sample') expect(song.samples.some((s) => s.id === inst.sample)).toBe(true)
    expect(role(song, 'V1', 0, 0)).toBe('bass')
    // voices that exist on both chips keep their id (V3 pad, V4 lead); the drums go to V13/V14
    expect(role(song, 'V3', 0, 0)).toBe('pad')
    expect(role(song, 'V4', 0, 0)).toBe('lead')
    expect(role(song, 'V13', 0, 0)).toBe('kick')
    expect(role(song, 'V14', 0, 0)).toBe('snare')
    // echo -> reverb send: the SNES lead and pad presets are echoed, the converted ones keep the send
    const leadInst = song.instruments[getPattern(song, 'V4', song.orders[0]![3]!).rows[0]!.inst!]!
    expect(leadInst.kind === 'psx-sample' && leadInst.reverb).toBe(true)
    expect(report.join('\n')).toMatch(/-> V4 /)
    expect(errorsOf(song)).toEqual([])
    expect(noteCount(song, false)).toBe(noteCount(snes, false))
    expect(noteCount(song, true)).toBe(noteCount(snes, true))
  })

  it('PS1 -> Dreamcast keeps every channel, and the round trip keeps the note counts', () => {
    const ps1 = voiceSong('ps1', 24, 12)
    const { song, report } = convertChip(ps1, 'dreamcast')
    expect(song.chip).toBe('dreamcast')
    expect(song.instruments.every((i) => i.kind === 'aica-sample')).toBe(true)
    expect(role(song, 'V1', 0, 0)).toBe('bass')
    expect(role(song, 'V13', 0, 0)).toBe('kick')
    expect(role(song, 'V14', 0, 1)).toBe('snare')
    expect(report.join('\n')).not.toMatch(/Dropped V/)
    expect(errorsOf(song)).toEqual([])
    expect(noteCount(song, false)).toBe(12 * 8)
    expect(noteCount(song, false)).toBe(noteCount(ps1, false))
    expect(noteCount(song, true)).toBe(noteCount(ps1, true))
    const back = convertChip(song, 'ps1').song
    expect(noteCount(back, false)).toBe(noteCount(ps1, false))
    expect(noteCount(back, true)).toBe(noteCount(ps1, true))
    expect(errorsOf(back)).toEqual([])
  })

  it('Dreamcast 64 voices -> NES drops the extra channels and keeps the report readable', () => {
    const dc = voiceSong('dreamcast', 64, 40)
    expect(dc.channels).toHaveLength(64)
    const { song, report } = convertChip(dc, 'nes')
    expect(song.chip).toBe('nes')
    expect(errorsOf(song)).toEqual([])
    // three melodic channels (P1, P2, TR) survive with all their notes; the other 37 are dropped
    expect(noteCount(song, false)).toBe(3 * 8)
    const dropLines = report.filter((l) => /^Dropped V/.test(l))
    expect(dropLines.length).toBeLessThanOrEqual(11)
    expect(dropLines.filter((l) => /^Dropped V\d+ \(/.test(l))).toHaveLength(10)
    expect(report.join('\n')).toMatch(/Dropped 27 more channel\(s\) \(216 notes in total.*\): V\d+, .* \.\.\. V\d+; NES has no free melodic channel/)
    expect(report.length).toBeLessThan(40)
    // the drums are still placed on the noise channel
    expect(noteCount(song, true)).toBeGreaterThan(0)
  })

  it('Genesis -> Dreamcast and NES -> PS1 map the roles and keep the notes', () => {
    const gen = createSong({ chip: 'genesis', name: 'Gen', patternLength: 16 })
    gen.instruments.push(resolvePreset('genesis', 'bass', 'fm'), resolvePreset('genesis', 'lead', 'fm'), resolvePreset('genesis', 'hihat', 'psg-noise'))
    for (let n = 0; n < 4; n++) {
      getPattern(gen, 'F1', 0).rows[n * 4] = { note: 36, ...(n === 0 ? { inst: 0 } : {}) }
      getPattern(gen, 'F2', 0).rows[n * 4] = { note: 64, ...(n === 0 ? { inst: 1 } : {}) }
      getPattern(gen, 'NO', 0).rows[n * 4 + 2] = { note: 60, ...(n === 0 ? { inst: 2 } : {}) }
    }
    const dc = convertChip(gen, 'dreamcast').song
    expect(role(dc, 'V1', 0, 0)).toBe('bass')
    expect(role(dc, 'V2', 0, 0)).toBe('lead')
    expect(noteCount(dc, false)).toBe(8)
    expect(noteCount(dc, true)).toBe(4)
    expect(errorsOf(dc)).toEqual([])
    expect(dc.instruments.every((i) => i.kind === 'aica-sample')).toBe(true)

    const nes = nesSource()
    const ps1 = convertChip(nes, 'ps1').song
    expect(role(ps1, 'V1', 0, 0)).toBe('bass')
    expect(role(ps1, 'V2', 0, 0)).toBe('lead')
    expect(role(ps1, 'V13', 0, 0)).toBe('kick')
    expect(errorsOf(ps1)).toEqual([])
    expect(noteCount(ps1, false)).toBe(noteCount(nes, false))
    expect(noteCount(ps1, true)).toBe(noteCount(nes, true))
    const back = convertChip(ps1, 'nes').song
    expect(noteCount(back, false)).toBe(noteCount(nes, false))
    expect(errorsOf(back)).toEqual([])
  })
})
