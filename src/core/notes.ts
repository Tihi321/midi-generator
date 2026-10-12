// Note names <-> MIDI numbers, frequencies and pitch-class helpers. Pure TypeScript.
//
// Tracker convention: C-4 = MIDI 60, A-4 = MIDI 69 = 440 Hz. Naturals are written "C-4", sharps "C#4";
// the parser also accepts "C4", flats ("Db4"), lowercase letters and "off"/"rel" are NOT note names.
// Octave numbers run 0..9 (MIDI 12..127); there is no octave -1 in tracker text.

import type { PitchClass } from './types'

export const PITCH_CLASSES: readonly PitchClass[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export const MIDI_MIN = 12
export const MIDI_MAX = 127

/** Pitch class index 0..11 of a MIDI note (negative numbers wrap correctly). */
export function pitchClassOf(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12
}

/** Octave number in tracker notation (MIDI 60 -> 4). */
export function octaveOf(midi: number): number {
  return Math.floor(midi / 12) - 1
}

/** Index 0..11 of a pitch-class name; accepts sharps and flats ("C#", "Db", "Bb", "e"). Returns null when invalid. */
export function pitchClassIndex(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)$/.exec(name.trim())
  if (!m) return null
  const base = LETTER_PC[m[1]!.toUpperCase()]!
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (base + acc + 12) % 12
}

/** Normalise a key name to a sharp-spelled PitchClass ("Bb" -> "A#"). Returns null when invalid. */
export function normalizePitchClass(name: string): PitchClass | null {
  const i = pitchClassIndex(name)
  return i === null ? null : PITCH_CLASSES[i]!
}

export function isValidMidi(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MIDI_MAX
}

/** Tracker spelling: "C-4", "C#4". Throws for notes outside C-0..G-9 (MIDI 12..127). */
export function formatNote(midi: number): string {
  if (!Number.isInteger(midi) || midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new RangeError(`Note ${midi} is outside the tracker range C-0..G-9 (MIDI ${MIDI_MIN}..${MIDI_MAX}).`)
  }
  const pc = PITCH_CLASSES[pitchClassOf(midi)]!
  const oct = octaveOf(midi)
  return pc.length === 1 ? `${pc}-${oct}` : `${pc}${oct}`
}

/** Compact spelling without the dash ("C4", "F#5"), used by the melody notation. */
export function formatNoteCompact(midi: number): string {
  if (!Number.isInteger(midi) || midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new RangeError(`Note ${midi} is outside the range C0..G9 (MIDI ${MIDI_MIN}..${MIDI_MAX}).`)
  }
  return `${PITCH_CLASSES[pitchClassOf(midi)]!}${octaveOf(midi)}`
}

/** Same as formatNote but never throws: out-of-range notes print as "MIDI<n>". */
export function describeNote(midi: number): string {
  try {
    return formatNote(midi)
  } catch {
    return `MIDI${midi}`
  }
}

/** Flat spelling, e.g. "Db4" (for human-facing text in flat keys). */
export function formatNoteFlat(midi: number): string {
  const pc = FLAT_NAMES[pitchClassOf(midi)]!
  const oct = octaveOf(midi)
  return pc.length === 1 ? `${pc}-${oct}` : `${pc}${oct}`
}

const NOTE_RE = /^([A-Ga-g])([#b-]?)(\d)$/

/** True when the token has the shape of a note name (C-4, C4, C#4, Db4). */
export function looksLikeNote(token: string): boolean {
  return NOTE_RE.test(token)
}

/**
 * Parse "C-4", "C4", "C#4", "Db4", "c4". Returns the MIDI number or null when the token is not a valid
 * note (wrong shape, or outside MIDI 0..127).
 */
export function parseNote(token: string): number | null {
  const m = NOTE_RE.exec(token.trim())
  if (!m) return null
  const base = LETTER_PC[m[1]!.toUpperCase()]!
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const midi = (Number(m[3]) + 1) * 12 + base + acc
  return midi >= 0 && midi <= MIDI_MAX ? midi : null
}

/** Like parseNote but throws with a helpful message. */
export function requireNote(token: string): number {
  const n = parseNote(token)
  if (n === null) {
    throw new Error(`"${token}" is not a note. Use C-4, C#4 or Db4 style names (octave 0..9, C-4 = middle C = MIDI 60).`)
  }
  return n
}

/** Frequency in Hz with A4 (MIDI 69) = 440 Hz. Accepts fractional MIDI numbers. */
export function midiToHz(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Fractional MIDI number of a frequency. */
export function hzToMidi(hz: number, a4 = 440): number {
  return 69 + 12 * Math.log2(hz / a4)
}

/** Cents between two frequencies (positive when b is higher). */
export function centsBetween(aHz: number, bHz: number): number {
  return 1200 * Math.log2(bHz / aHz)
}

/** Interval class 0..6 between two notes (6 = tritone). */
export function intervalClass(a: number, b: number): number {
  const d = Math.abs(pitchClassOf(a) - pitchClassOf(b))
  return Math.min(d, 12 - d)
}

/** Move a note by a number of semitones, clamped to the tracker range. */
export function transposeNote(midi: number, semitones: number): number {
  return Math.max(MIDI_MIN, Math.min(MIDI_MAX, midi + semitones))
}
