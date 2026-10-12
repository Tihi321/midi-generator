// Chords: qualities, Roman numerals -> MIDI, chord symbols, chord -> arpeggio parameter, chord identification.
//
// Roman numerals are relative to the MAJOR scale of the key, with explicit accidentals, in every mode:
// in A minor, "i bVII bVI V" is Am G F E. Upper case = major, lower case = minor.
// Suffixes: 7 (dominant on upper case, minor 7th on lower case), maj7, 6, 9, sus2, sus4, add9, 5, + (aug),
// o or dim (diminished), o7 (dim7), ø (half-diminished). Secondary chords: "V/V", "V7/ii", "vii°/V".

import type { PitchClass } from '../types'
import { PITCH_CLASSES, normalizePitchClass, pitchClassIndex, pitchClassOf } from '../notes'

export interface ChordQuality {
  id: string
  /** Suffix used in chord names ("m7"). */
  symbol: string
  intervals: number[]
}

export const CHORD_QUALITIES: Record<string, ChordQuality> = {
  maj: { id: 'maj', symbol: '', intervals: [0, 4, 7] },
  min: { id: 'min', symbol: 'm', intervals: [0, 3, 7] },
  dim: { id: 'dim', symbol: 'dim', intervals: [0, 3, 6] },
  aug: { id: 'aug', symbol: 'aug', intervals: [0, 4, 8] },
  sus2: { id: 'sus2', symbol: 'sus2', intervals: [0, 2, 7] },
  sus4: { id: 'sus4', symbol: 'sus4', intervals: [0, 5, 7] },
  power: { id: 'power', symbol: '5', intervals: [0, 7] },
  maj7: { id: 'maj7', symbol: 'maj7', intervals: [0, 4, 7, 11] },
  dom7: { id: 'dom7', symbol: '7', intervals: [0, 4, 7, 10] },
  min7: { id: 'min7', symbol: 'm7', intervals: [0, 3, 7, 10] },
  minmaj7: { id: 'minmaj7', symbol: 'mMaj7', intervals: [0, 3, 7, 11] },
  dim7: { id: 'dim7', symbol: 'dim7', intervals: [0, 3, 6, 9] },
  m7b5: { id: 'm7b5', symbol: 'm7b5', intervals: [0, 3, 6, 10] },
  sixth: { id: 'sixth', symbol: '6', intervals: [0, 4, 7, 9] },
  min6: { id: 'min6', symbol: 'm6', intervals: [0, 3, 7, 9] },
  add9: { id: 'add9', symbol: 'add9', intervals: [0, 4, 7, 14] },
  madd9: { id: 'madd9', symbol: 'madd9', intervals: [0, 3, 7, 14] },
  dom9: { id: 'dom9', symbol: '9', intervals: [0, 4, 7, 10, 14] },
  maj9: { id: 'maj9', symbol: 'maj9', intervals: [0, 4, 7, 11, 14] },
  min9: { id: 'min9', symbol: 'm9', intervals: [0, 3, 7, 10, 14] },
  dom7sus4: { id: 'dom7sus4', symbol: '7sus4', intervals: [0, 5, 7, 10] }
}

const MAJOR_OFFSETS: Record<string, number> = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 }

const UPPER_SUFFIX: Record<string, string> = {
  '': 'maj', '7': 'dom7', maj7: 'maj7', M7: 'maj7', '6': 'sixth', '9': 'dom9', maj9: 'maj9', sus2: 'sus2', sus4: 'sus4',
  '7sus4': 'dom7sus4', add9: 'add9', '+': 'aug', aug: 'aug', '5': 'power', '°': 'dim', o: 'dim', dim: 'dim',
  '°7': 'dim7', o7: 'dim7', dim7: 'dim7', 'ø': 'm7b5', 'ø7': 'm7b5', m7b5: 'm7b5', m: 'min', m7: 'min7'
}
const LOWER_SUFFIX: Record<string, string> = {
  '': 'min', '7': 'min7', maj7: 'minmaj7', M7: 'minmaj7', '6': 'min6', '9': 'min9', sus2: 'sus2', sus4: 'sus4', add9: 'madd9',
  '5': 'power', '+': 'aug', aug: 'aug', '°': 'dim', o: 'dim', dim: 'dim', '°7': 'dim7', o7: 'dim7', dim7: 'dim7',
  'ø': 'm7b5', 'ø7': 'm7b5', m7b5: 'm7b5'
}

interface ParsedNumeral {
  accidental: number
  degree: string
  lower: boolean
  quality: string
  /** Offset (semitones from the tonic) of the chord root. */
  offset: number
}

const NUMERAL_RE = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/

function parseSimpleNumeral(text: string, original: string): ParsedNumeral {
  const m = NUMERAL_RE.exec(text)
  if (!m) {
    throw new Error(
      `"${original}" is not a Roman numeral chord. Use I..VII (upper = major, lower = minor) with optional b/# prefix and suffix, e.g. "V7", "bVII", "ii7", "vii°", "V/V".`
    )
  }
  const accidental = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0
  const degree = m[2]!
  const lower = degree === degree.toLowerCase()
  const suffix = m[3]!
  const quality = (lower ? LOWER_SUFFIX : UPPER_SUFFIX)[suffix]
  if (!quality) {
    throw new Error(`Unknown chord suffix "${suffix}" in "${original}". Supported: ${Object.keys(lower ? LOWER_SUFFIX : UPPER_SUFFIX).filter(Boolean).join(' ')}.`)
  }
  return { accidental, degree, lower, quality, offset: (MAJOR_OFFSETS[degree.toUpperCase()]! + accidental + 12) % 12 }
}

export interface RomanChord {
  numeral: string
  /** Root pitch class 0..11. */
  root: number
  quality: string
  /** e.g. "Am7" */
  name: string
  /** MIDI notes ascending, root in `octave`. */
  notes: number[]
  intervals: number[]
}

export function chordName(rootPc: number, quality: string): string {
  return `${PITCH_CLASSES[((rootPc % 12) + 12) % 12]!}${CHORD_QUALITIES[quality]?.symbol ?? ''}`
}

/**
 * Roman numeral -> chord in a key. The root sits in `octave` (C-3 = MIDI 48 for key C at octave 3).
 * Supports accidentals (bVII), seventh/extension suffixes and secondary chords ("V/V").
 */
export function romanToChord(numeral: string, key: PitchClass | string, octave = 3): RomanChord {
  const tonic = pitchClassIndex(key)
  if (tonic === null) throw new Error(`Unknown key "${key}". Use a note name such as C, F#, Bb.`)
  const text = numeral.trim()
  const slash = text.indexOf('/')
  let rootPc: number
  let parsed: ParsedNumeral
  if (slash > 0) {
    const target = parseSimpleNumeral(text.slice(slash + 1), numeral)
    parsed = parseSimpleNumeral(text.slice(0, slash), numeral)
    rootPc = (tonic + target.offset + parsed.offset) % 12
  } else {
    parsed = parseSimpleNumeral(text, numeral)
    rootPc = (tonic + parsed.offset) % 12
  }
  const q = CHORD_QUALITIES[parsed.quality]!
  const base = (octave + 1) * 12 + rootPc
  return {
    numeral: text,
    root: rootPc,
    quality: q.id,
    name: chordName(rootPc, q.id),
    notes: q.intervals.map((i) => base + i),
    intervals: [...q.intervals]
  }
}

/** Parse a chord symbol ("Am7", "F#m", "Bb", "Csus4", "G7") into MIDI notes with the root in `octave`. */
export function parseChordSymbol(symbol: string, octave = 3): RomanChord {
  const m = /^([A-Ga-g][#b]?)(.*)$/.exec(symbol.trim())
  if (!m) throw new Error(`"${symbol}" is not a chord symbol. Examples: C, Am, F#m7, Bbmaj7, Gsus4, E7.`)
  const root = pitchClassIndex(m[1]!)!
  const suffix = m[2]!
  const found = Object.values(CHORD_QUALITIES).find((q) => q.symbol === suffix) ??
    (suffix === 'min' ? CHORD_QUALITIES.min : suffix === 'M' || suffix === 'maj' ? CHORD_QUALITIES.maj : suffix === 'min7' ? CHORD_QUALITIES.min7 : suffix === '+' ? CHORD_QUALITIES.aug : suffix === 'o' || suffix === '°' ? CHORD_QUALITIES.dim : undefined)
  if (!found) {
    throw new Error(`Unknown chord quality "${suffix}" in "${symbol}". Supported: ${Object.values(CHORD_QUALITIES).map((q) => q.symbol || 'maj').join(' ')}.`)
  }
  const base = (octave + 1) * 12 + root
  return { numeral: symbol, root, quality: found.id, name: chordName(root, found.id), notes: found.intervals.map((i) => base + i), intervals: [...found.intervals] }
}

export interface ArpResult {
  /** Arp effect parameter 0xy as a byte (x = first interval, y = second). */
  param: number
  /** Effect code and two-digit hex text, e.g. "047". */
  text: string
  /** Lowest note (the cell's note). */
  root: number
  /** Notes that did not fit into the 0xy effect (only for chords with more than 3 distinct notes). */
  dropped: number[]
}

/**
 * Chord -> arpeggio parameter: the lowest note is the cell note and 0xy adds the next two notes
 * (C E G -> 0x47). Chords with 4+ distinct notes drop the fifth (keeping the 3rd and 7th) unless
 * `strict` is set, in which case they throw. Intervals above 15 semitones cannot be written.
 */
export function chordToArp(notes: number[], opts: { strict?: boolean } = {}): ArpResult {
  const sorted = [...new Set(notes)].sort((a, b) => a - b)
  if (sorted.length === 0) throw new Error('A chord needs at least one note.')
  const root = sorted[0]!
  let rest = sorted.slice(1)
  const dropped: number[] = []
  if (rest.length > 2) {
    if (opts.strict) {
      throw new Error(`A chord of ${sorted.length} notes does not fit one arpeggio effect (0xy holds 2 intervals above the root); drop notes to a triad.`)
    }
    // Prefer to drop the fifth (7 semitones above the root, mod 12), then the highest extras.
    const fifthIdx = rest.findIndex((n) => (n - root) % 12 === 7)
    if (fifthIdx >= 0) {
      dropped.push(rest[fifthIdx]!)
      rest = rest.filter((_, i) => i !== fifthIdx)
    }
    while (rest.length > 2) dropped.push(rest.pop()!)
  }
  const [a, b] = rest
  for (const n of rest) {
    if (n - root > 15) {
      throw new Error(
        `Chord interval ${n - root} semitones above the lowest note exceeds 15 (the arpeggio effect is 4 bits per interval); keep the chord within an octave and a minor third, or move the high note down an octave.`
      )
    }
  }
  const x = a === undefined ? 0 : a - root
  const y = b === undefined ? 0 : b - root
  const param = (x << 4) | y
  return { param, text: `0${param.toString(16).toUpperCase().padStart(2, '0')}`, root, dropped }
}

/** Inverse of chordToArp: the notes an arpeggio parameter cycles through. */
export function arpNotes(root: number, param: number): number[] {
  const x = (param >> 4) & 15
  const y = param & 15
  const out = [root]
  if (x > 0) out.push(root + x)
  if (y > 0) out.push(root + y)
  return out
}

export interface IdentifiedChord {
  root: number
  quality: string
  name: string
  /** 0..1 how well the pitch classes match the template. */
  score: number
}

/** Best-matching chord for a set of weighted pitch classes (weights by pitch class 0..11). */
export function identifyChord(weights: number[], bassPc?: number): IdentifiedChord | null {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  let best: IdentifiedChord | null = null
  const candidates = ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4', 'dom7', 'maj7', 'min7', 'm7b5', 'dim7', 'power']
  for (let root = 0; root < 12; root++) {
    for (const qid of candidates) {
      const q = CHORD_QUALITIES[qid]!
      const pcs = new Set(q.intervals.map((i) => (root + i) % 12))
      let inside = 0
      for (const pc of pcs) inside += weights[pc] ?? 0
      const outside = total - inside
      let covered = 0
      for (const pc of pcs) if ((weights[pc] ?? 0) > 0) covered++
      // Reward matched weight, penalize foreign notes and missing chord tones; prefer triads over extensions.
      let score = inside / total - 0.6 * (outside / total) - 0.12 * (pcs.size - covered)
      if (qid === 'power' || qid === 'sus2' || qid === 'sus4' || qid === 'aug') score -= 0.05
      if (pcs.size > 3) score -= 0.04
      if (bassPc !== undefined && bassPc === root) score += 0.05
      if (!best || score > best.score) best = { root, quality: qid, name: chordName(root, qid), score }
    }
  }
  if (!best) return null
  best.score = Math.max(0, Math.min(1, best.score))
  return best
}

/** Convenience for tests and tools: normalize a root name. */
export function rootName(pc: number): PitchClass {
  return normalizePitchClass(PITCH_CLASSES[pitchClassOf(pc)]!)!
}
