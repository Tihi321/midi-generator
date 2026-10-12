// Scales and modes. Pure data + helpers.

import type { PitchClass, ScaleId } from '../types'
import { PITCH_CLASSES, normalizePitchClass, pitchClassOf } from '../notes'

export interface ScaleDef {
  id: ScaleId
  name: string
  /** Semitone offsets from the tonic, ascending, within one octave. */
  intervals: number[]
  description: string
  aliases?: string[]
}

export const SCALES: Record<string, ScaleDef> = {
  major: { id: 'major', name: 'Major (Ionian)', intervals: [0, 2, 4, 5, 7, 9, 11], description: 'Bright, happy, resolved.', aliases: ['ionian'] },
  minor: { id: 'minor', name: 'Natural minor (Aeolian)', intervals: [0, 2, 3, 5, 7, 8, 10], description: 'Sad, serious, epic.', aliases: ['aeolian', 'natural-minor'] },
  dorian: { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10], description: 'Minor with a raised 6th: wistful, folk, adventurous.' },
  phrygian: { id: 'phrygian', name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10], description: 'Minor with a flat 2nd: dark, Spanish, menacing.' },
  lydian: { id: 'lydian', name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11], description: 'Major with a raised 4th: dreamy, floating, wonder.' },
  mixolydian: { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], description: 'Major with a flat 7th: heroic, bluesy, adventurous.' },
  locrian: { id: 'locrian', name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10], description: 'Unstable and dissonant: horror, tension.' },
  'harmonic-minor': { id: 'harmonic-minor', name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11], description: 'Minor with a raised 7th: dramatic, gothic, castle.' },
  'melodic-minor': { id: 'melodic-minor', name: 'Melodic minor (ascending)', intervals: [0, 2, 3, 5, 7, 9, 11], description: 'Minor with raised 6th and 7th: mysterious, jazzy.' },
  'major-pentatonic': { id: 'major-pentatonic', name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9], description: 'Open, folk-like, impossible to clash.', aliases: ['pentatonic'] },
  'minor-pentatonic': { id: 'minor-pentatonic', name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10], description: 'Rock and battle melodies, safe over minor chords.' },
  blues: { id: 'blues', name: 'Blues', intervals: [0, 3, 5, 6, 7, 10], description: 'Minor pentatonic plus the blue note (b5).' },
  'whole-tone': { id: 'whole-tone', name: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10], description: 'Dreamlike, ambiguous: underwater, magic, dream sequences.' },
  'phrygian-dominant': { id: 'phrygian-dominant', name: 'Phrygian dominant', intervals: [0, 1, 4, 5, 7, 8, 10], description: 'Flat 2nd with a major 3rd: desert, Arabic, flamenco.', aliases: ['spanish', 'freygish'] },
  hirajoshi: { id: 'hirajoshi', name: 'Hirajoshi', intervals: [0, 2, 3, 7, 8], description: 'Japanese pentatonic: temple, mystic, serene.' },
  chromatic: { id: 'chromatic', name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], description: 'All 12 notes (no key restriction).' }
}

export const SCALE_IDS: string[] = Object.keys(SCALES)

export function findScale(ref: string): ScaleDef | undefined {
  const k = ref.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (SCALES[k]) return SCALES[k]
  return Object.values(SCALES).find((s) => s.aliases?.includes(k))
}

/** Resolve a scale by id or alias; throws with the valid ids. */
export function requireScale(ref: string): ScaleDef {
  const s = findScale(ref)
  if (!s) throw new Error(`Unknown scale "${ref}". Valid scales: ${SCALE_IDS.join(', ')}.`)
  return s
}

function keyIndex(key: PitchClass | string): number {
  const pc = normalizePitchClass(key)
  if (!pc) throw new Error(`Unknown key "${key}". Use a note name such as C, F#, Bb.`)
  return PITCH_CLASSES.indexOf(pc)
}

/** The scale's pitch classes (0..11) for a key, ascending from the tonic. */
export function scalePitchClasses(key: PitchClass | string, scale: ScaleId): number[] {
  const t = keyIndex(key)
  return requireScale(scale).intervals.map((i) => (t + i) % 12)
}

export function isInScale(midi: number, key: PitchClass | string, scale: ScaleId): boolean {
  return scalePitchClasses(key, scale).includes(pitchClassOf(midi))
}

/** All MIDI notes of the scale between low and high (inclusive). */
export function scaleNotes(key: PitchClass | string, scale: ScaleId, low: number, high: number): number[] {
  const pcs = new Set(scalePitchClasses(key, scale))
  const out: number[] = []
  for (let n = low; n <= high; n++) if (pcs.has(pitchClassOf(n))) out.push(n)
  return out
}

/** MIDI note of a 0-based scale degree in a given octave (degree may exceed the scale size to climb octaves). */
export function degreeToMidi(key: PitchClass | string, scale: ScaleId, degree: number, octave = 4): number {
  const def = requireScale(scale)
  const n = def.intervals.length
  const oct = Math.floor(degree / n)
  const idx = ((degree % n) + n) % n
  return (octave + 1) * 12 + keyIndex(key) + def.intervals[idx]! + oct * 12
}

/**
 * Move a note by diatonic steps within the key's scale. A note outside the scale is first snapped to the
 * nearest scale tone below.
 */
export function transposeDiatonic(midi: number, steps: number, key: PitchClass | string, scale: ScaleId): number {
  const pcs = scalePitchClasses(key, scale)
  const n = pcs.length
  // Find the scale index at or below the note.
  let base = midi
  while (!pcs.includes(pitchClassOf(base))) base--
  const idx = pcs.indexOf(pitchClassOf(base))
  const target = idx + steps
  const octShift = Math.floor(target / n)
  const tIdx = ((target % n) + n) % n
  const tonicPc = pcs[0]!
  const rel = (pcs[tIdx]! - tonicPc + 12) % 12
  const baseRel = (pcs[idx]! - tonicPc + 12) % 12
  return base + (rel - baseRel) + octShift * 12
}

export function describeScale(key: PitchClass | string, scale: ScaleId): { key: string; scale: ScaleDef; pitchClasses: string[]; semitones: number[] } {
  const def = requireScale(scale)
  const pcs = scalePitchClasses(key, scale)
  return { key: normalizePitchClass(key)!, scale: def, pitchClasses: pcs.map((p) => PITCH_CLASSES[p]!), semitones: def.intervals }
}
