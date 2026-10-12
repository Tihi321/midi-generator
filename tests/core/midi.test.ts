import { describe, expect, it } from 'vitest'
import {
  type ChipId,
  type Song,
  buildNoteTimeline,
  buildTimeline,
  createSong,
  exportMidi,
  getPattern,
  importMidi,
  keySignatureFor,
  parseMidi,
  pickRowsPerBeat,
  resolvePreset,
  validateSong,
  writeMidi
} from '../../src/core'
import { type MidiEvent, encodeSmf, metaKeySignature, metaString, metaTempo, metaTimeSignature, metaText } from '../../src/core/codecs/midiFile'
import { gmDrumNoteFor, gmProgramFor, roleForGmDrumNote, roleForGmProgram } from '../../src/core/codecs/gmMap'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

function nesSong(opts: { patternLength?: number; orders?: number } = {}): Song {
  const song = createSong({ chip: 'nes', name: 'T', patternLength: opts.patternLength ?? 16 })
  song.loop = null
  song.instruments.push(resolvePreset('nes', 'lead', 'pulse'), resolvePreset('nes', 'bass', 'triangle'))
  song.instruments.push(resolvePreset('nes', 'kick', 'noise'), resolvePreset('nes', 'snare', 'noise'), resolvePreset('nes', 'hihat', 'noise'))
  if (opts.orders && opts.orders > 1) song.orders = Array.from({ length: opts.orders }, (_, i) => song.channels.map(() => i))
  return song
}

const on = (tick: number, channel: number, note: number, velocity = 100): MidiEvent => ({ tick, kind: 'noteOn', channel, note, velocity })
const off = (tick: number, channel: number, note: number): MidiEvent => ({ tick, kind: 'noteOff', channel, note, velocity: 0 })
const program = (tick: number, channel: number, p: number): MidiEvent => ({ tick, kind: 'program', channel, program: p })

function notesOf(song: Song, channel: string): string[] {
  return buildNoteTimeline(song)
    .events.filter((e) => e.channel === channel)
    .map((e) => `${e.absRow}:${e.midi}:${e.length}`)
}

describe('midi export', () => {
  it('writes a byte-exact tiny file', () => {
    const song = createSong({ chip: 'nes', name: 'T', patternLength: 4 })
    song.loop = null
    song.instruments.push(resolvePreset('nes', 'lead', 'pulse'))
    const p = getPattern(song, 'P1', 0)
    p.rows[0] = { note: 60, inst: 0, vol: 15 }
    p.rows[2] = { note: 'off' }
    const r = exportMidi(song)
    expect(hex(r.data)).toBe(
      // header: type 1, 2 tracks, 480 PPQ
      '4d546864' + '00000006' + '0001' + '0002' + '01e0' +
        // track 0: name, tempo 500000, 4/4, C major, "order 0", end at tick 480
        '4d54726b' + '0000002a' +
        '00ff030154' +
        '00ff510307a120' +
        '00ff5804040218' + '08' +
        '00ff59020000' +
        '00ff06076f7264657220' + '30' +
        '8360ff2f00' +
        // track 1: name "Pulse 1", CC7=100, CC10=64, RPN 0 = 12 semitones, program 80, note 60 on/off, end
        '4d54726b' + '00000035' +
        '00ff030750756c736520' + '31' +
        '00b00764' + '000a40' + '006500' + '006400' + '00060c' + '002600' + '00657f' + '00647f' +
        '00c050' +
        '00903c7f' +
        '8170803c00' +
        '8170ff2f00'
    )
    expect(r.tracks).toBe(2)
    expect(r.notes).toBe(1)
    expect(r.ticks).toBe(480)
    expect(r.seconds).toBeCloseTo(0.5, 6)
  })

  it('parses back with the expected structure', () => {
    const song = nesSong({ orders: 2 })
    getPattern(song, 'P1', 0).rows[0] = { note: 64, inst: 0, vol: 12 }
    getPattern(song, 'TR', 1).rows[4] = { note: 36, inst: 1 }
    const out = exportMidi(song)
    const m = parseMidi(out.data)
    expect(m.format).toBe(1)
    expect(m.division).toBe(480)
    expect(m.tracks).toHaveLength(3) // conductor + P1 + TR
    const p1 = m.tracks[1]!
    expect(p1.find((e) => e.kind === 'program')).toMatchObject({ program: 80 })
    expect(m.tracks[2]!.find((e) => e.kind === 'program')).toMatchObject({ program: 38 })
    const n = p1.find((e) => e.kind === 'noteOn')
    expect(n).toMatchObject({ note: 64, velocity: Math.round((12 * 127) / 15), channel: 0, tick: 0 })
    const tr = m.tracks[2]!.find((e) => e.kind === 'noteOn')
    expect(tr).toMatchObject({ note: 36, tick: 16 * 120 + 4 * 120, channel: 1 })
    expect(out.trackNames).toEqual(['Pulse 1', 'Triangle'])
  })

  it('maps noise and drum-role instruments to channel 10 with GM drum notes', () => {
    const song = nesSong()
    const no = getPattern(song, 'NO', 0)
    no.rows[0] = { note: 60, inst: 2 }
    no.rows[4] = { note: 60, inst: 3 }
    no.rows[6] = { note: 60, inst: 4 }
    const m = parseMidi(writeMidi(song))
    const track = m.tracks[1]!
    const notes = track.filter((e) => e.kind === 'noteOn')
    expect(notes.map((e) => (e.kind === 'noteOn' ? [e.channel, e.note] : []))).toEqual([[9, 36], [9, 38], [9, 42]])
    expect(track.some((e) => e.kind === 'program')).toBe(false)
  })

  it('exposes the GM tables', () => {
    expect(roleForGmDrumNote(36)).toBe('kick')
    expect(roleForGmDrumNote(46)).toBe('openhat')
    expect(roleForGmProgram(38)).toBe('bass')
    expect(roleForGmProgram(80)).toBe('lead')
    const lead = resolvePreset('nes', 'lead', 'pulse')
    expect(gmProgramFor(lead)).toBe(80)
    expect(gmProgramFor({ ...lead, role: undefined, gm: { program: 61 } })).toBe(61)
    expect(gmProgramFor({ ...lead, role: undefined, gm: undefined, kind: 'nes-tri', macros: {} })).toBe(38)
    expect(gmDrumNoteFor(resolvePreset('nes', 'crash', 'noise'), 'noise')).toBe(49)
    expect(gmDrumNoteFor(lead, 'pulse')).toBeUndefined()
    expect(gmDrumNoteFor({ ...resolvePreset('nes', 'kick', 'noise'), gm: { drumNote: 41 } }, 'noise')).toBe(41)
  })

  it('emits tempo changes for Fxx and keeps the audio duration', () => {
    const song = nesSong({ orders: 1 })
    song.timing.bpm = 120
    const p = getPattern(song, 'P1', 0)
    p.rows[0] = { note: 60, inst: 0 }
    p.rows[4] = { note: 62, fx: [{ code: 'F', param: 0x90 }] } // 144 BPM from row 4
    p.rows[8] = { note: 64, fx: [{ code: 'F', param: 3 }] } // speed 3: rows are half as long
    const out = exportMidi(song)
    expect(out.tempoChanges).toBe(2)
    const m = parseMidi(out.data)
    const tempos = m.tracks[0]!.filter((e) => e.kind === 'meta' && e.type === 0x51).map((e) => {
      const d = (e as Extract<MidiEvent, { kind: 'meta' }>).data
      return [e.tick, (d[0]! << 16) | (d[1]! << 8) | d[2]!]
    })
    expect(tempos[0]).toEqual([0, 500000])
    expect(tempos[1]).toEqual([480, Math.round(60_000_000 / 144)])
    // speed 3 at 144 BPM with base speed 6: the tempo doubles (rows keep their length in MIDI ticks)
    expect(tempos[2]).toEqual([960, Math.round(60_000_000 / 288)])
    expect(out.seconds).toBeCloseTo(buildTimeline(song).introSeconds, 3)
  })

  it('keeps the groove as unequal row lengths and the duration of the audio', () => {
    const song = nesSong()
    song.timing.groove = [7, 5]
    getPattern(song, 'P1', 0).rows[1] = { note: 60, inst: 0 }
    getPattern(song, 'P1', 0).rows[2] = { note: 62, inst: 0 }
    const out = exportMidi(song)
    const m = parseMidi(out.data)
    const ons = m.tracks[1]!.filter((e) => e.kind === 'noteOn').map((e) => e.tick)
    expect(ons).toEqual([140, 240])
    expect(out.seconds).toBeCloseTo(buildTimeline(song).introSeconds, 3)
  })

  it('writes loop markers and CC111 at the loop start, and unrolls loops', () => {
    const song = nesSong({ orders: 2 })
    song.loop = { order: 1 }
    getPattern(song, 'P1', 0).rows[0] = { note: 60, inst: 0 }
    getPattern(song, 'P1', 1).rows[0] = { note: 62, inst: 0 }
    const once = exportMidi(song)
    expect(once.loop).toEqual({ startTick: 16 * 120, endTick: 32 * 120 })
    const cond = parseMidi(once.data).tracks[0]!
    const markers = cond.filter((e) => e.kind === 'meta' && e.type === 0x06).map((e) => [e.tick, metaString(e)])
    expect(markers).toContainEqual([1920, 'loopStart'])
    expect(markers).toContainEqual([3840, 'loopEnd'])
    expect(markers).toContainEqual([0, 'order 0'])
    expect(cond.filter((e) => e.kind === 'cc' && e.controller === 111)).toEqual([{ tick: 1920, kind: 'cc', channel: 0, controller: 111, value: 0 }])
    const twice = exportMidi(song, { loops: 2 })
    expect(twice.loop).toEqual({ startTick: 1920, endTick: 32 * 120 + 16 * 120 })
    const notes = parseMidi(twice.data).tracks[1]!.filter((e) => e.kind === 'noteOn').map((e) => (e.kind === 'noteOn' ? e.note : 0))
    expect(notes).toEqual([60, 62, 62])
  })

  it('writes time and key signatures', () => {
    const song = nesSong()
    song.timing.beatsPerBar = 3
    song.meta.key = 'D'
    song.meta.scale = 'minor'
    const meta = parseMidi(writeMidi(song)).tracks[0]!
    const ts = meta.find((e) => e.kind === 'meta' && e.type === 0x58) as Extract<MidiEvent, { kind: 'meta' }>
    expect(Array.from(ts.data.subarray(0, 2))).toEqual([3, 2])
    const ks = meta.find((e) => e.kind === 'meta' && e.type === 0x59) as Extract<MidiEvent, { kind: 'meta' }>
    expect(Array.from(ks.data)).toEqual([0xff, 1]) // D minor: one flat, minor
    expect(keySignatureFor('C', 'major')).toEqual({ sharps: 0, minor: false })
    expect(keySignatureFor('A', 'minor')).toEqual({ sharps: 0, minor: true })
    expect(keySignatureFor('F#', 'major')).toEqual({ sharps: 6, minor: false })
  })

  it('turns slides, portamento and vibrato into pitch bend', () => {
    const song = nesSong()
    const p = getPattern(song, 'P1', 0)
    p.rows[0] = { note: 60, inst: 0, fx: [{ code: '1', param: 0x10 }] } // slide up 1 semitone per 16 ticks... 1/16 per tick: 5 ticks per row
    p.rows[4] = { note: 64, inst: 0, fx: [{ code: '1', param: 0 }, { code: '4', param: 0x48 }] } // vibrato, depth 8/16
    p.rows[8] = { note: 67, inst: 0, fx: [{ code: '4', param: 0 }, { code: '2', param: 0x40 }] } // slide down 4/16 per tick
    const m = parseMidi(writeMidi(song))
    const t = m.tracks[1]!
    expect(t.filter((e) => e.kind === 'cc' && e.controller === 6)).toMatchObject([{ value: 12 }]) // RPN range +-12
    const bends = t.filter((e) => e.kind === 'pitchBend').map((e) => (e.kind === 'pitchBend' ? e.value : 0))
    expect(bends.length).toBeGreaterThan(4)
    expect(Math.max(...bends)).toBeGreaterThan(8192)
    expect(Math.min(...bends)).toBeLessThan(8192)
    // the second note resets the bend before it sounds
    const firstReset = t.findIndex((e) => e.kind === 'pitchBend' && e.value === 8192)
    const secondOn = t.findIndex((e, i) => e.kind === 'noteOn' && e.note === 64 && i > 0)
    expect(firstReset).toBeGreaterThan(-1)
    expect(firstReset).toBeLessThan(secondOn)
  })

  it('exports 0xy arpeggios as fast notes, chords or plain notes', () => {
    const song = nesSong()
    getPattern(song, 'P1', 0).rows[0] = { note: 60, inst: 0, fx: [{ code: '0', param: 0x47 }] }
    getPattern(song, 'P1', 0).rows[1] = { note: 'off', fx: [{ code: '0', param: 0 }] }
    const ons = (mode: 'notes' | 'chord' | 'ignore'): [number, number][] =>
      parseMidi(writeMidi(song, { arpMode: mode }))
        .tracks[1]!.filter((e) => e.kind === 'noteOn')
        .map((e) => (e.kind === 'noteOn' ? [e.tick, e.note] : [0, 0]))
    // 6 ticks per row = 20 MIDI ticks per tick: 60 64 67 60 64 67
    expect(ons('notes')).toEqual([[0, 60], [20, 64], [40, 67], [60, 60], [80, 64], [100, 67]])
    expect(ons('chord')).toEqual([[0, 60], [0, 64], [0, 67]])
    expect(ons('ignore')).toEqual([[0, 60]])
  })

  it('adds CC11 when the volume changes under a held note', () => {
    const song = nesSong()
    const p = getPattern(song, 'P1', 0)
    p.rows[0] = { note: 60, inst: 0, vol: 15 }
    p.rows[2] = { vol: 7 }
    const t = parseMidi(writeMidi(song)).tracks[1]!
    const cc11 = t.filter((e) => e.kind === 'cc' && e.controller === 11)
    expect(cc11).toHaveLength(1)
    expect(cc11[0]).toMatchObject({ tick: 240, value: Math.round((127 * 7) / 15) })
  })

  it('ends a note at the next note, a note-off or a cut', () => {
    const song = nesSong()
    const p = getPattern(song, 'P1', 0)
    p.rows[0] = { note: 60, inst: 0 }
    p.rows[2] = { note: 62 }
    p.rows[4] = { note: 64, fx: [{ code: 'S', param: 3 }] } // cut after 3 of 6 ticks
    const t = parseMidi(writeMidi(song)).tracks[1]!
    const offs = t.filter((e) => e.kind === 'noteOff').map((e) => [e.tick, e.kind === 'noteOff' ? e.note : 0])
    expect(offs).toEqual([[240, 60], [480, 62], [540, 64]])
  })

  it('exports an empty song', () => {
    const song = createSong({ chip: 'gb' })
    const r = exportMidi(song)
    expect(r.notes).toBe(0)
    expect(parseMidi(r.data).tracks).toHaveLength(1)
  })
})

describe('midi file reader', () => {
  it('handles running status, sysex, format 0 and tempo meta', () => {
    const tracks: MidiEvent[][] = [[metaText(0, 0x03, 'one'), metaTempo(0, 400000), on(0, 0, 60), on(0, 0, 64), off(480, 0, 60), off(480, 0, 64)]]
    const data = encodeSmf(tracks, 480)
    // patch the header to format 0
    data[9] = 0
    // insert a sysex event before the first note by building the bytes by hand
    const m = parseMidi(data)
    expect(m.format).toBe(0)
    expect(m.tracks[0]!.filter((e) => e.kind === 'noteOn')).toHaveLength(2)
    const manual = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 22,
      0x00, 0xf0, 0x03, 0x7e, 0x7f, 0xf7, // sysex
      0x00, 0x90, 0x3c, 0x40, // note on
      0x10, 0x3e, 0x40, // running status note on
      0x10, 0x3c, 0x00, // running status note on vel 0 = off
      0x00, 0xff, 0x2f, 0x00
    ])
    manual[21] = manual.length - 22
    const r = parseMidi(manual)
    expect(r.tracks[0]!.map((e) => e.kind)).toEqual(['noteOn', 'noteOn', 'noteOff', 'meta'])
    expect(r.tracks[0]![1]!.tick).toBe(16)
  })

  it('rejects non-MIDI data and SMPTE timing with clear errors', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3]))).toThrow(/MThd/)
    const smpte = encodeSmf([[]], 480)
    smpte[12] = 0xe7
    expect(() => parseMidi(smpte)).toThrow(/SMPTE/)
  })
})

describe('midi import', () => {
  it('round-trips a quantized song: notes, timing, drums, loop', () => {
    const song = nesSong({ orders: 2 })
    song.loop = { order: 1 }
    song.timing.bpm = 138
    song.meta.key = 'A'
    song.meta.scale = 'minor'
    const lead = getPattern(song, 'P1', 0)
    lead.rows[0] = { note: 69, inst: 0, vol: 15 }
    lead.rows[2] = { note: 72, vol: 10 }
    lead.rows[4] = { note: 76 }
    lead.rows[6] = { note: 'off' }
    lead.rows[8] = { note: 74 }
    lead.rows[12] = { note: 72 }
    const lead2 = getPattern(song, 'P1', 1)
    lead2.rows[0] = { note: 71, inst: 0, vol: 15 }
    lead2.rows[4] = { note: 69 }
    const bass = getPattern(song, 'TR', 0)
    bass.rows[0] = { note: 45, inst: 1 }
    bass.rows[8] = { note: 43 }
    getPattern(song, 'TR', 1).rows[0] = { note: 41, inst: 1 }
    const dr = getPattern(song, 'NO', 0)
    dr.rows[0] = { note: 60, inst: 2 }
    dr.rows[4] = { note: 60, inst: 3 }
    dr.rows[6] = { note: 60, inst: 4 }
    dr.rows[8] = { note: 60, inst: 2 }
    dr.rows[12] = { note: 60, inst: 3 }

    const out = exportMidi(song)
    const { song: back, report } = importMidi(out.data, { chip: 'nes' })
    expect(back.timing.rowsPerBeat).toBe(4)
    expect(back.timing.bpm).toBe(138)
    expect(back.patternLength).toBe(16)
    expect(back.orders).toHaveLength(2)
    expect(back.loop).toEqual({ order: 1 })
    expect(back.meta.key).toBe('A')
    expect(back.meta.scale).toBe('minor')
    expect(notesOf(back, 'P1')).toEqual(notesOf(song, 'P1'))
    expect(notesOf(back, 'TR')).toEqual(notesOf(song, 'TR'))
    // drums: same rows, same roles
    const role = (s: Song, ch: string, order: number, row: number): string | undefined => {
      const ci = s.channels.findIndex((c) => c.id === ch)
      const cell = getPattern(s, ch, s.orders[order]![ci]!).rows[row]
      return cell?.inst === undefined ? undefined : s.instruments[cell.inst]?.role
    }
    for (const row of [0, 4, 6, 8, 12]) expect(role(back, 'NO', 0, row)).toBe(role(song, 'NO', 0, row))
    // velocities survive as volume
    expect(getPattern(back, 'P1', back.orders[0]![0]!).rows[2]!.vol).toBe(10)
    expect(validateSong(back).filter((i) => i.severity === 'error')).toEqual([])
    expect(report.some((l) => l.includes('P1') && l.includes('lead'))).toBe(true)
    expect(report.some((l) => l.includes('TR') && l.includes('[bass]'))).toBe(true)
    expect(report.some((l) => /Drums/.test(l))).toBe(true)
  })

  it('maps GM drum notes to roles on the noise channel and reports unmapped ones', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000)]
    const hits = [36, 38, 42, 46, 49, 45, 54, 80]
    hits.forEach((n, i) => {
      ev.push(on(i * 480, 9, n), off(i * 480 + 60, 9, n))
    })
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'nes', rowsPerBeat: 4 })
    const roles = hits.map((_, i) => {
      const cell = getPattern(song, 'NO', song.orders[Math.floor((i * 4) / song.patternLength)]![3]!).rows[(i * 4) % song.patternLength]
      return cell?.inst === undefined ? undefined : song.instruments[cell.inst]!.role
    })
    expect(roles).toEqual(['kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'hihat', undefined])
    expect(report.join('\n')).toMatch(/GM 80/)
    expect(song.channels.map((c) => c.id)).toEqual(['P1', 'P2', 'TR', 'NO'])
  })

  it('splits kick/tom and the other drums over two channels where the chip has them', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), on(0, 9, 36), on(0, 9, 38), on(0, 9, 42), off(100, 9, 36), off(100, 9, 38), off(100, 9, 42)]
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'snes' })
    const cell = (ch: string): { inst?: number } | null => getPattern(song, ch, 0).rows[0] ?? null
    expect(song.instruments[cell('V7')!.inst!]!.role).toBe('kick')
    expect(song.instruments[cell('V8')!.inst!]!.role).toBe('snare') // snare beats hat on the shared channel
    expect(report.join('\n')).toMatch(/Dropped 1 simultaneous drum hit/)
  })

  it('picks the grid with the least error', () => {
    const q = (n: number): number[] => Array.from({ length: 32 }, (_, i) => (i * 480) / n)
    expect(pickRowsPerBeat(q(4), 480).rowsPerBeat).toBe(4)
    expect(pickRowsPerBeat(q(2), 480).rowsPerBeat).toBe(4)
    expect(pickRowsPerBeat(q(3), 480).rowsPerBeat).toBe(3)
    expect(pickRowsPerBeat(q(6), 480).rowsPerBeat).toBe(6)
    expect(pickRowsPerBeat(q(8), 480).rowsPerBeat).toBe(8)
    // slightly humanised sixteenths still pick 4
    const human = q(4).map((t, i) => t + ((i * 7) % 9) - 4)
    expect(pickRowsPerBeat(human, 480).rowsPerBeat).toBe(4)
    const trip = Array.from({ length: 24 }, (_, i) => i * 160)
    const ev: MidiEvent[] = [metaTempo(0, 500000)]
    trip.forEach((t) => ev.push(on(t, 0, 60 + (t % 7)), off(t + 100, 0, 60 + (t % 7))))
    expect(importMidi(encodeSmf([ev]), { chip: 'nes' }).song.timing.rowsPerBeat).toBe(3)
    expect(importMidi(encodeSmf([ev]), { chip: 'nes', rowsPerBeat: 6 }).song.timing.rowsPerBeat).toBe(6)
  })

  it('folds up to two extra chord tones into a 0xy arpeggio and drops the rest', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), program(0, 0, 80)]
    // bar 1: C major triad (fold), bar 2: five-note cluster (too many: top voice only)
    for (const n of [60, 64, 67]) ev.push(on(0, 0, n), off(480, 0, n))
    for (const n of [60, 62, 64, 67, 71]) ev.push(on(480, 0, n), off(960, 0, n))
    // a single note afterwards must clear the arpeggio
    ev.push(on(960, 0, 62), off(1440, 0, 62))
    ev.sort((a, b) => a.tick - b.tick)
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'nes', patternLength: 16 })
    const rows = getPattern(song, 'P1', song.orders[0]![0]!).rows
    expect(rows[0]).toMatchObject({ note: 60, fx: [{ code: '0', param: 0x47 }] })
    expect(rows[4]).toMatchObject({ note: 71 })
    expect(rows[4]!.fx).toEqual([{ code: '0', param: 0 }]) // clears the previous arpeggio
    expect(rows[8]).toMatchObject({ note: 62 })
    expect(report.join('\n')).toMatch(/1 chord\(s\) folded into 0xy/)
    expect(report.join('\n')).toMatch(/4 chord tone\(s\) dropped/)
    const noFold = importMidi(encodeSmf([ev]), { chip: 'nes', patternLength: 16, foldChords: false }).song
    expect(getPattern(noFold, 'P1', noFold.orders[0]![0]!).rows[0]!.note).toBe(67)
  })

  it('removes duplicate patterns', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000)]
    for (let bar = 0; bar < 4; bar++) {
      for (const [i, n] of [60, 64, 67, 64].entries()) ev.push(on(bar * 1920 + i * 480, 0, n), off(bar * 1920 + i * 480 + 400, 0, n))
    }
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'nes', patternLength: 16 })
    expect(song.orders).toHaveLength(4)
    const p1 = song.orders.map((r) => r[0])
    expect(new Set(p1).size).toBe(1)
    expect([...song.patterns.keys()].filter((k) => k.startsWith('P1:'))).toHaveLength(1)
    expect(report.join('\n')).toMatch(/reduced to \d+ unique/)
  })

  it('ranks tracks into bass, lead and harmony and drops what does not fit', () => {
    const ev = (ch: number, notes: number[], prog: number): MidiEvent[] => {
      const out: MidiEvent[] = [program(0, ch, prog)]
      notes.forEach((n, i) => out.push(on(i * 240, ch, n), off(i * 240 + 200, ch, n)))
      return out
    }
    const tracks = [
      [metaTempo(0, 500000)],
      ev(0, [72, 74, 76, 77, 79, 81, 83, 84], 80), // lead: many high notes
      ev(1, [60, 64, 67, 64], 48), // strings harmony
      ev(2, [36, 36, 43, 43], 33), // bass
      ev(3, [55, 59, 62, 59], 89), // pad: one too many for NES
      ev(4, [64, 66], 73) // flute
    ]
    const { song, report } = importMidi(encodeSmf(tracks), { chip: 'nes' })
    const text = report.join('\n')
    expect(text).toMatch(/-> TR Triangle as bass/)
    expect(text).toMatch(/-> P1 Pulse 1 as lead/)
    expect(text).toMatch(/-> P2 Pulse 2/)
    expect(text).toMatch(/Dropped part/)
    expect(getPattern(song, 'TR', song.orders[0]![2]!).rows[0]!.note).toBe(36)
    // maxChannels limits the melodic parts
    const small = importMidi(encodeSmf(tracks), { chip: 'genesis', maxChannels: 2 })
    expect(small.report.join('\n')).toMatch(/maxChannels is 2/)
  })

  it('transposes by octaves into the channel range and says so', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), program(0, 0, 80)]
    ;[24, 26, 28, 31].forEach((n, i) => ev.push(on(i * 480, 0, n), off(i * 480 + 400, 0, n)))
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'nes' })
    const cell = getPattern(song, 'P1', song.orders[0]![0]!).rows[0]!
    expect(cell.note).toBe(36)
    expect(report.join('\n')).toMatch(/transposed \+12/)
  })

  it('applies tempo changes as Fxx and detects the loop from CC111', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), on(0, 0, 60), off(400, 0, 60), metaTempo(1920, 400000), on(1920, 0, 62), off(2300, 0, 62), { tick: 1920, kind: 'cc', channel: 0, controller: 111, value: 0 }]
    const { song, report } = importMidi(encodeSmf([ev]), { chip: 'nes', patternLength: 16 })
    expect(song.timing.bpm).toBe(120)
    expect(getPattern(song, 'P1', song.orders[1]![0]!).rows[0]!.fx).toContainEqual({ code: 'F', param: 150 })
    expect(song.loop).toEqual({ order: 1 })
    expect(report.join('\n')).toMatch(/1 tempo change/)
  })

  it('imports a type-0 file onto every chip without chip-rule errors', () => {
    const ev: MidiEvent[] = [metaTempo(0, 500000), metaTimeSignature(0, 4, 2), metaKeySignature(0, 0, false), program(0, 0, 80), program(1, 1, 33), program(2, 2, 48)]
    for (let i = 0; i < 16; i++) {
      ev.push(on(i * 240, 0, 72 + (i % 5)), off(i * 240 + 200, 0, 72 + (i % 5)))
      ev.push(on(i * 240, 1, 36 + (i % 3) * 7), off(i * 240 + 200, 1, 36 + (i % 3) * 7))
      ev.push(on(i * 480, 2, 60), on(i * 480, 2, 64), on(i * 480, 2, 67), off(i * 480 + 400, 2, 60), off(i * 480 + 400, 2, 64), off(i * 480 + 400, 2, 67))
      ev.push(on(i * 240, 9, i % 2 ? 38 : 36), off(i * 240 + 50, 9, i % 2 ? 38 : 36), on(i * 240, 9, 42), off(i * 240 + 50, 9, 42))
    }
    ev.sort((a, b) => a.tick - b.tick)
    const data = encodeSmf([ev])
    data[9] = 0 // format 0
    for (const chip of ['nes', 'gb', 'genesis', 'snes', 'pce'] as ChipId[]) {
      const { song } = importMidi(data, { chip })
      const errors = validateSong(song).filter((i) => i.severity === 'error')
      expect(errors, `${chip}: ${errors.map((e) => e.message).join('; ')}`).toEqual([])
      expect(buildNoteTimeline(song).events.length).toBeGreaterThan(30)
    }
  })

  it('refuses a file without notes', () => {
    expect(() => importMidi(encodeSmf([[metaTempo(0, 500000)]]))).toThrow(/no notes/)
  })
})
