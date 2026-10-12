import { describe, expect, it } from 'vitest'
import {
  centsBetween, describeNote, formatNote, formatNoteCompact, formatNoteFlat, hzToMidi, intervalClass, looksLikeNote,
  midiToHz, normalizePitchClass, parseNote, pitchClassIndex, pitchClassOf, requireNote, transposeNote
} from '../../src/core/notes'

describe('note names', () => {
  it('maps C-4 to MIDI 60 and A-4 to 69', () => {
    expect(parseNote('C-4')).toBe(60)
    expect(parseNote('A-4')).toBe(69)
    expect(parseNote('C-0')).toBe(12)
    expect(parseNote('G-9')).toBe(127)
  })
  it('parses sharps, flats, no-dash and lowercase forms', () => {
    expect(parseNote('C#4')).toBe(61)
    expect(parseNote('Db4')).toBe(61)
    expect(parseNote('C4')).toBe(60)
    expect(parseNote('c4')).toBe(60)
    expect(parseNote('Bb3')).toBe(58)
    expect(parseNote('B-3')).toBe(59)
    expect(parseNote('E#4')).toBe(65)
  })
  it('rejects things that are not notes', () => {
    expect(parseNote('H-4')).toBeNull()
    expect(parseNote('C-')).toBeNull()
    expect(parseNote('G#9')).toBeNull() // 128
    expect(parseNote('047')).toBeNull()
    expect(looksLikeNote('C-4')).toBe(true)
    expect(looksLikeNote('A02')).toBe(false)
    expect(() => requireNote('Z9')).toThrow(/not a note/)
  })
  it('formats in tracker spelling and round-trips the whole range', () => {
    expect(formatNote(60)).toBe('C-4')
    expect(formatNote(61)).toBe('C#4')
    expect(formatNoteFlat(61)).toBe('Db4')
    expect(formatNoteCompact(66)).toBe('F#4')
    for (let n = 12; n <= 127; n++) expect(parseNote(formatNote(n))).toBe(n)
    expect(() => formatNote(5)).toThrow(RangeError)
    expect(describeNote(5)).toBe('MIDI5')
  })
})

describe('frequency and pitch class', () => {
  it('uses A4 = 440 Hz', () => {
    expect(midiToHz(69)).toBe(440)
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3)
    expect(hzToMidi(440)).toBeCloseTo(69, 10)
    expect(hzToMidi(midiToHz(33))).toBeCloseTo(33, 10)
    expect(centsBetween(440, 880)).toBeCloseTo(1200, 8)
  })
  it('pitch class helpers', () => {
    expect(pitchClassOf(60)).toBe(0)
    expect(pitchClassOf(-1)).toBe(11)
    expect(pitchClassIndex('Bb')).toBe(10)
    expect(normalizePitchClass('Eb')).toBe('D#')
    expect(normalizePitchClass('H')).toBeNull()
    expect(intervalClass(60, 67)).toBe(5)
    expect(intervalClass(60, 66)).toBe(6)
    expect(transposeNote(125, 12)).toBe(127)
  })
})
