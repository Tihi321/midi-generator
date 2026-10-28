import { describe, expect, it } from 'vitest'
import {
  CHORD_QUALITIES, DRUM_STYLES, MOODS, MOOD_IDS, PROGRESSIONS, SCALES, analyzeSong, arpNotes, chordToArp, combineLanes, degreeToMidi,
  describeScale, detectKey, drumStylesForMood, findMood, getDrumPattern, identifyChord, isInScale, parseChordSymbol, realizeProgression,
  requireDrumStyle, requireMood, requireProgression, requireScale, romanToChord, scaleNotes, scalePitchClasses, suggestProgressions,
  transposeDiatonic
} from '../../src/core/theory'
import { CHIP_IDS } from '../../src/core/types'
import { parseNote } from '../../src/core/notes'
import { createSong, getPattern } from '../../src/core/model'
import { chipChannels } from '../../src/core/chips'
import { songWithPresets } from './helpers'

describe('scales', () => {
  it('has the required scales with correct intervals', () => {
    for (const id of ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor', 'melodic-minor',
      'major-pentatonic', 'minor-pentatonic', 'blues', 'whole-tone', 'phrygian-dominant', 'hirajoshi']) {
      expect(SCALES[id], id).toBeDefined()
    }
    expect(SCALES.major!.intervals).toEqual([0, 2, 4, 5, 7, 9, 11])
    expect(SCALES['phrygian-dominant']!.intervals).toEqual([0, 1, 4, 5, 7, 8, 10])
    expect(SCALES.hirajoshi!.intervals).toEqual([0, 2, 3, 7, 8])
    expect(SCALES['whole-tone']!.intervals).toHaveLength(6)
    expect(requireScale('Natural Minor').id).toBe('minor')
    expect(() => requireScale('klingon')).toThrow(/Valid scales: major/)
  })
  it('lists pitch classes, notes and degrees in a key', () => {
    expect(scalePitchClasses('D', 'major')).toEqual([2, 4, 6, 7, 9, 11, 1])
    expect(isInScale(63, 'C', 'minor')).toBe(true) // Eb
    expect(isInScale(64, 'C', 'minor')).toBe(false)
    expect(scaleNotes('C', 'major-pentatonic', 60, 72)).toEqual([60, 62, 64, 67, 69, 72])
    expect(degreeToMidi('C', 'major', 0, 4)).toBe(60)
    expect(degreeToMidi('C', 'major', 7, 4)).toBe(72)
    expect(degreeToMidi('A', 'minor', 2, 4)).toBe(72)
    expect(describeScale('F#', 'major').pitchClasses.slice(0, 3)).toEqual(['F#', 'G#', 'A#'])
  })
  it('transposes diatonically', () => {
    expect(transposeDiatonic(60, 1, 'C', 'major')).toBe(62)
    expect(transposeDiatonic(71, 1, 'C', 'major')).toBe(72)
    expect(transposeDiatonic(60, -1, 'C', 'major')).toBe(59)
    expect(transposeDiatonic(60, 7, 'C', 'major')).toBe(72)
    expect(transposeDiatonic(64, 2, 'A', 'minor')).toBe(67)
    expect(transposeDiatonic(61, 1, 'C', 'major')).toBe(62) // snaps down to C, then up a step
  })
})

describe('chords', () => {
  const names = (n: string, key = 'C'): { name: string; notes: number[] } => {
    const c = romanToChord(n, key, 3)
    return { name: c.name, notes: c.notes }
  }
  it('builds Roman numerals in major and with accidentals', () => {
    expect(names('I')).toEqual({ name: 'C', notes: [48, 52, 55] })
    expect(names('V7')).toEqual({ name: 'G7', notes: [55, 59, 62, 65] })
    expect(names('vi')).toEqual({ name: 'Am', notes: [57, 60, 64] })
    expect(names('bVII').name).toBe('A#')
    expect(names('bVII', 'A').name).toBe('G')
    expect(names('ii7').name).toBe('Dm7')
    expect(names('IVmaj7').name).toBe('Fmaj7')
    expect(names('vii°').name).toBe('Bdim')
    expect(names('iiø').name).toBe('Dm7b5')
    expect(names('Isus4').name).toBe('Csus4')
    expect(names('bII', 'E').name).toBe('F')
    expect(names('i', 'A').name).toBe('Am')
    expect(names('bVI', 'A').name).toBe('F')
  })
  it('handles secondary dominants', () => {
    expect(names('V/V').name).toBe('D')
    expect(names('V7/V').name).toBe('D7')
    expect(names('V/ii').name).toBe('A')
    expect(names('vii°/V').name).toBe('F#dim')
    expect(names('V/V', 'G').name).toBe('A')
  })
  it('reports bad numerals', () => {
    expect(() => romanToChord('X', 'C')).toThrow(/not a Roman numeral/)
    expect(() => romanToChord('Iblah', 'C')).toThrow(/Unknown chord suffix/)
    expect(() => romanToChord('I', 'H')).toThrow(/Unknown key/)
  })
  it('parses chord symbols', () => {
    expect(parseChordSymbol('Am7').notes).toEqual([57, 60, 64, 67])
    expect(parseChordSymbol('F#m').name).toBe('F#m')
    expect(parseChordSymbol('Bbmaj7').name).toBe('A#maj7')
    expect(() => parseChordSymbol('Cwhatever')).toThrow(/Unknown chord quality/)
  })
  it('converts chords to arpeggio parameters', () => {
    expect(chordToArp([60, 64, 67])).toMatchObject({ param: 0x47, text: '047', root: 60 })
    expect(chordToArp([57, 60, 64]).param).toBe(0x37)
    expect(chordToArp([67, 60, 64]).param).toBe(0x47) // order does not matter
    expect(chordToArp([60, 67]).param).toBe(0x70)
    expect(chordToArp([60]).param).toBe(0)
    expect(chordToArp([60, 64, 67, 70])).toMatchObject({ param: 0x4a, dropped: [67] })
    expect(() => chordToArp([60, 64, 67, 70], { strict: true })).toThrow(/does not fit/)
    expect(() => chordToArp([60, 64, 79])).toThrow(/exceeds 15/)
    expect(arpNotes(60, 0x47)).toEqual([60, 64, 67])
    expect(arpNotes(60, 0x70)).toEqual([60, 67])
  })
  it('identifies chords from pitch-class weights', () => {
    const w = new Array<number>(12).fill(0)
    for (const pc of [0, 4, 7]) w[pc] = 4
    expect(identifyChord(w, 0)!.name).toBe('C')
    const m = new Array<number>(12).fill(0)
    for (const pc of [9, 0, 4]) m[pc] = 3
    expect(identifyChord(m, 9)!.name).toBe('Am')
    const seventh = new Array<number>(12).fill(0)
    for (const pc of [7, 11, 2, 5]) seventh[pc] = 3
    expect(identifyChord(seventh, 7)!.name).toBe('G7')
    expect(identifyChord(new Array<number>(12).fill(0))).toBeNull()
    expect(Object.keys(CHORD_QUALITIES).length).toBeGreaterThan(15)
  })
})

describe('progressions', () => {
  it('has about 40 progressions that all realize in every key', () => {
    expect(PROGRESSIONS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(PROGRESSIONS.map((p) => p.id)).size).toBe(PROGRESSIONS.length)
    for (const p of PROGRESSIONS) {
      for (const key of ['C', 'F#', 'A#']) expect(realizeProgression(p, key).length, p.id).toBe(p.numerals.length)
      for (const m of p.moods) expect(MOOD_IDS, p.id).toContain(m)
    }
  })
  it('finds progressions by mood and mode', () => {
    expect(suggestProgressions({ mood: 'heroic' }).length).toBeGreaterThan(2)
    expect(suggestProgressions({ mood: 'spooky', mode: 'major' })).toEqual([])
    expect(suggestProgressions({ mood: 'game over' }).length).toBeGreaterThan(0)
    expect(suggestProgressions({ mood: 'sad', limit: 1 })).toHaveLength(1)
    expect(requireProgression('pop').numerals).toEqual(['I', 'V', 'vi', 'IV'])
    expect(() => requireProgression('nope')).toThrow(/Valid ids/)
    expect(realizeProgression(requireProgression('pop'), 'C').map((c) => c.name)).toEqual(['C', 'G', 'Am', 'F'])
    expect(realizeProgression(requireProgression('epic-minor'), 'A').map((c) => c.name)).toEqual(['Am', 'F', 'C', 'G'])
  })
})

describe('drums', () => {
  it('has styles with 16-step lanes', () => {
    expect(DRUM_STYLES.length).toBeGreaterThanOrEqual(15)
    for (const s of DRUM_STYLES) {
      for (const lane of Object.values(s.lanes)) expect(lane, s.id).toMatch(/^[x.]{16}$/)
      expect(Object.keys(s.lanes).length).toBeGreaterThan(0)
    }
    expect(requireDrumStyle('Four Floor').id).toBe('four-floor')
  })
  it('combines lanes by priority into write_drums form', () => {
    const c = combineLanes({ kick: 'x...x...', snare: '....x...', hihat: 'x.x.x.x.' })
    expect(c.steps).toBe('K.h.S.h.')
    expect(c.legend).toEqual({ K: 'kick', S: 'snare', h: 'hihat' })
  })
  it('builds patterns over several bars with a fill', () => {
    const p = getDrumPattern('rock', { bars: 4, fill: true })
    expect(p.steps).toHaveLength(64)
    expect(p.lanes.snare).toHaveLength(64)
    expect(p.lanes.snare!.slice(48)).toBe('........xxxxxxxx')
    expect(p.lanes.snare!.slice(0, 16)).toBe('....x.......x...')
    expect(getDrumPattern('rock').steps).toHaveLength(16)
    expect(() => getDrumPattern('polka')).toThrow(/Valid styles/)
    expect(drumStylesForMood('boss').length).toBeGreaterThan(0)
  })
})

describe('moods', () => {
  it('has the 16 required moods, the 4 calm ones and the 4 synth ones with complete recipes for every chip', () => {
    expect(MOOD_IDS).toEqual([
      'heroic', 'battle', 'boss', 'spooky', 'dungeon', 'chill', 'town', 'overworld', 'victory', 'game-over', 'title', 'shop',
      'underwater', 'desert', 'castle', 'sad', 'ambient', 'lullaby', 'peaceful', 'mysterious-calm',
      'synthwave', 'outrun', 'darkwave', 'dreamwave'
    ])
    for (const m of MOODS) {
      expect(m.bpm[0]).toBeLessThan(m.bpm[1])
      expect(m.bpmDefault).toBeGreaterThanOrEqual(m.bpm[0])
      expect(m.scales.length).toBeGreaterThan(0)
      for (const s of m.scales) expect(SCALES[s], `${m.id}:${s}`).toBeDefined()
      expect(m.progressions.length, m.id).toBeGreaterThan(0)
      expect(m.drumStyles.length, m.id).toBeGreaterThan(0)
      expect(m.arrangement.totalBars).toBe(m.arrangement.sections.reduce((a, s) => a + s.bars, 0))
      expect(m.techniques.length).toBeGreaterThan(2)
      for (const chip of CHIP_IDS) {
        const ids = chipChannels(chip).map((d) => d.id)
        expect(m.chips[chip].channels.length).toBeGreaterThan(3)
        for (const ch of m.chips[chip].channels) expect(ids, `${m.id} ${chip}`).toContain(ch.channel)
        expect(m.chips[chip].idioms.length).toBeGreaterThan(2)
      }
    }
  })
  it('looks moods up by loose names', () => {
    expect(findMood('Game Over')!.id).toBe('game-over')
    expect(findMood('epic')!.id).toBe('heroic')
    expect(requireMood('SPOOKY').id).toBe('spooky')
    expect(() => requireMood('polka')).toThrow(/Valid moods: heroic/)
    expect(requireMood('victory').arrangement.loopFrom).toBeNull()
    expect(requireMood('chill').groove).toEqual([7, 5])
  })
  it('has the synth moods with their recipes, aliases and the old alias for dreamy', () => {
    const synth = ['synthwave', 'outrun', 'darkwave', 'dreamwave'].map((id) => requireMood(id))
    expect(synth.map((m) => m.bpm)).toEqual([[96, 118], [108, 118], [88, 112], [80, 100]])
    expect(requireMood('synthwave').keys).toEqual(['A', 'E', 'D', 'F#', 'C'])
    expect(requireMood('synthwave').scales).toEqual(['minor', 'dorian'])
    expect(requireMood('synthwave').arrangement.sections.map((s) => [s.name, s.bars])).toEqual([['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Bridge', 4]])
    for (const m of synth) {
      expect(m.arrangement.loopFrom, m.id).toBe('A')
      expect(m.techniques.length, m.id).toBeGreaterThanOrEqual(4)
      expect(m.drumStyles.length, m.id).toBeGreaterThan(0)
      expect(m.progressions.length, m.id).toBeGreaterThan(1)
      for (const s of m.scales) expect(SCALES[s]!.intervals, `${m.id}:${s}`).toContain(3) // minor family
    }
    expect(requireMood('synthwave').techniques.join(' ')).toMatch(/detuned saw lead/i)
    for (const [a, id] of [['retrowave', 'synthwave'], ['synth', 'synthwave'], ['80s', 'synthwave'], ['chase', 'outrun'], ['drive', 'outrun'],
      ['coldwave', 'darkwave'], ['goth', 'darkwave'], ['chillwave', 'dreamwave'], ['dreamsynth', 'dreamwave'], ['dreamy', 'ambient']] as const) {
      expect(findMood(a)!.id, a).toBe(id)
    }
  })
  it('tags the progressions and drum styles of the synth moods without changing the other moods', () => {
    const SYNTH_IDS = ['synthwave', 'outrun', 'darkwave', 'dreamwave']
    const newProgs = ['synth-drive', 'synth-rise', 'dark-pulse', 'dream-float']
    expect(PROGRESSIONS.slice(-4).map((p) => p.id)).toEqual(newProgs)
    for (const id of newProgs) expect(PROGRESSIONS.find((p) => p.id === id)!.moods.every((m) => SYNTH_IDS.includes(m)), id).toBe(true)
    // epic-minor is the canonical synthwave loop (no duplicate of its numerals) and the underwater drift carries the dark moods
    expect(requireProgression('epic-minor').moods).toEqual(expect.arrayContaining(['heroic', 'battle', 'overworld', 'castle', 'synthwave', 'outrun']))
    expect(requireProgression('underwater-minor').moods).toEqual(expect.arrayContaining(['underwater', 'dungeon', 'chill', 'darkwave', 'dreamwave']))
    expect(PROGRESSIONS.filter((p) => p.numerals.join(' ') === 'i bVI bIII bVII').map((p) => p.id)).toEqual(['epic-minor'])
    expect(requireMood('synthwave').progressions[0]).toBe('epic-minor')
    expect(realizeProgression(requireProgression('dream-float'), 'A').map((c) => c.name)).toEqual(['Am7', 'Fmaj7', 'Cmaj7', 'G'])
    // the new drum styles are the last ones, tagged only with synth moods, and fill with toms
    const newStyles = ['synthwave-gated', 'outrun-four', 'darkwave-pulse', 'dreamwave-half']
    expect(DRUM_STYLES.slice(-4).map((s) => s.id)).toEqual(newStyles)
    for (const id of newStyles) {
      const s = requireDrumStyle(id)
      expect(s.moods.every((m) => SYNTH_IDS.includes(m)), id).toBe(true)
      expect(s.fill?.tom, id).toBeDefined()
    }
    expect(drumStylesForMood('synthwave').map((s) => s.id)).toEqual(['synthwave-gated', 'outrun-four'])
    expect(drumStylesForMood('outrun')[0]!.id).toBe('outrun-four')
    expect(drumStylesForMood('darkwave').map((s) => s.id)).toEqual(['darkwave-pulse'])
    expect(drumStylesForMood('dreamwave').map((s) => s.id)).toEqual(['dreamwave-half'])
    expect(requireDrumStyle('synthwave-gated').lanes.snare).toBe('....x.......x...')
    // no other mood sees the new entries
    for (const m of MOODS.filter((x) => !SYNTH_IDS.includes(x.id))) {
      for (const id of newProgs) expect(m.progressions, `${m.id} ${id}`).not.toContain(id)
      for (const id of newStyles) expect(m.drumStyles, `${m.id} ${id}`).not.toContain(id)
    }
  })
})

describe('analysis', () => {
  // Twinkle Twinkle in C major, one note per row-pair.
  const twinkle = ['C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4', 'F4', 'F4', 'E4', 'E4', 'D4', 'D4', 'C4']
  it('detects the key of a known melody', () => {
    const hist = new Array<number>(12).fill(0)
    for (const n of twinkle) hist[parseNote(n)! % 12]! += 1
    const best = detectKey(hist)[0]!
    expect(best.key).toBe('C')
    expect(best.mode).toBe('major')
    const am = new Array<number>(12).fill(0)
    for (const n of ['A3', 'C4', 'E4', 'A4', 'G4', 'E4', 'F4', 'E4', 'D4', 'C4', 'B3', 'A3', 'E4', 'A3']) am[parseNote(n)! % 12]! += 1
    const r = detectKey(am)[0]!
    expect(r).toMatchObject({ key: 'A', mode: 'minor' })
  })
  it('analyzes a song: key, chords per bar, clashes, out-of-scale notes and channel stats', () => {
    const { song } = songWithPresets('nes', [{ ref: 'lead' }, { ref: 'arp' }, { ref: 'bass', kind: 'triangle' }, { ref: 'snare', kind: 'noise' }], {
      patternLength: 32, key: 'C', scale: 'major'
    })
    // 2 bars of 16 rows: C major then G major.
    const lead = getPattern(song, 'P1', 0)
    twinkle.forEach((n, i) => {
      lead.rows[i * 2] = { note: parseNote(n)!, inst: 0 }
    })
    const bass = getPattern(song, 'TR', 0)
    bass.rows[0] = { note: 36, inst: 2 }
    bass.rows[16] = { note: 43, inst: 2 }
    getPattern(song, 'P2', 0).rows[0] = { note: 60, inst: 1, fx: [{ code: '0', param: 0x47 }] }
    getPattern(song, 'P2', 0).rows[16] = { note: 67, inst: 1, fx: [{ code: '0', param: 0x47 }] }
    getPattern(song, 'NO', 0).rows[0] = { note: 60, inst: 3 }
    const a = analyzeSong(song)
    expect(a.detected[0]).toMatchObject({ key: 'C', mode: 'major' })
    expect(a.keyAgrees).toBe(true)
    expect(a.chords[0]).toMatchObject({ name: 'C', roman: 'I', bass: 'C' })
    expect(a.chords[1]!.name).toBe('G')
    expect(a.chords[1]!.roman).toBe('V')
    expect(a.outOfScaleTotal).toBe(0)
    expect(a.clashTotal).toBe(0)
    const p1 = a.channels.find((c) => c.id === 'P1')!
    expect(p1.notes).toBe(14)
    expect(p1.lowest).toBe('C-4')
    expect(p1.highest).toBe('A-4')
    expect(a.channels.find((c) => c.id === 'NO')!.percussion).toBe(true)
    expect(a.chipIssues).toEqual([])

    // add a minor-second clash and an out-of-scale note
    getPattern(song, 'P2', 0).rows[1] = { note: 61, inst: 1 }
    const b = analyzeSong(song)
    expect(b.clashTotal).toBeGreaterThan(0)
    expect(b.clashes[0]!.message).toContain('minor second')
    expect(b.outOfScaleTotal).toBe(1)
    expect(b.outOfScale[0]).toMatchObject({ channel: 'P2', count: 1 })
  })
  it('reports a mismatch between declared and detected key', () => {
    const song = createSong({ chip: 'gb', patternLength: 32, key: 'F#', scale: 'major' })
    song.instruments.push({ name: 'p', kind: 'gb-pulse', env: { init: 15, dir: 'down', pace: 0 } })
    const p = getPattern(song, 'P1', 0)
    twinkle.forEach((n, i) => {
      p.rows[i * 2] = { note: parseNote(n)!, inst: 0 }
    })
    const a = analyzeSong(song, { skipChip: true })
    expect(a.keyAgrees).toBe(false)
    expect(a.hints.join(' ')).toContain('Detected key C major')
  })
})
