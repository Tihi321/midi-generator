// Chord progressions tagged by mood. Numerals are major-scale relative (see chords.ts).

import type { PitchClass } from '../types'
import { type RomanChord, romanToChord } from './chords'

export interface Progression {
  id: string
  name: string
  mode: 'major' | 'minor'
  numerals: string[]
  /** Mood ids (see moods.ts). */
  moods: string[]
  description: string
  /** Bars per chord (default 1). */
  barsPerChord?: number
}

const P = (
  id: string, name: string, mode: 'major' | 'minor', numerals: string, moods: string[], description: string, barsPerChord?: number
): Progression => ({ id, name, mode, numerals: numerals.split(/\s+/), moods, description, ...(barsPerChord ? { barsPerChord } : {}) })

export const PROGRESSIONS: Progression[] = [
  // ---- major
  P('pop', 'Pop (I-V-vi-IV)', 'major', 'I V vi IV', ['heroic', 'overworld', 'title', 'victory'], 'The ubiquitous hopeful loop.'),
  P('fifties', '50s (I-vi-IV-V)', 'major', 'I vi IV V', ['town', 'shop', 'chill'], 'Doo-wop; warm and nostalgic.'),
  P('authentic', 'Authentic cadence (I-IV-V-I)', 'major', 'I IV V I', ['victory', 'town'], 'Plain, strong, resolved.'),
  P('overworld-walk', 'Walking (I-IV-vi-V)', 'major', 'I IV vi V', ['overworld', 'title'], 'Optimistic motion that keeps going.'),
  P('axis', 'Axis (vi-IV-I-V)', 'major', 'vi IV I V', ['heroic', 'overworld', 'sad'], 'Same chords as pop, starting on the minor: yearning.'),
  P('canon', 'Canon (I-V-vi-iii-IV-I-IV-V)', 'major', 'I V vi iii IV I IV V', ['title', 'castle', 'town', 'sad'], 'Eight-chord Pachelbel pattern; stately, builds slowly.'),
  P('jazz-251', 'ii-V-I', 'major', 'ii7 V7 Imaj7 Imaj7', ['shop', 'chill'], 'Jazz turnaround; smooth shop/lounge feel.', 1),
  P('jazz-1625', 'I-vi-ii-V (jazz)', 'major', 'Imaj7 vi7 ii7 V7', ['shop', 'chill', 'town'], 'Rhythm-changes turnaround with sevenths.'),
  P('mixo-rock', 'Mixolydian (I-bVII-IV-I)', 'major', 'I bVII IV I', ['heroic', 'overworld'], 'Rock adventure; the bVII gives it swagger.'),
  P('rock-climb', 'Rock climb (I-bVII-bVI-bVII)', 'major', 'I bVII bVI bVII', ['heroic', 'battle'], 'Rising/falling power-chord riff feel.'),
  P('town-stroll', 'Stroll (I-iii-IV-V)', 'major', 'I iii IV V', ['town', 'overworld'], 'Easy ascending motion.'),
  P('open-road', 'Open road (IV-I-V-vi)', 'major', 'IV I V vi', ['overworld', 'chill'], 'Starts away from home, floats.'),
  P('lydian-float', 'Lydian float (Imaj7-IVmaj7)', 'major', 'Imaj7 II Imaj7 II', ['underwater', 'chill', 'overworld'], 'Major I and II: wonder, shimmer.'),
  P('secondary-dom', 'Secondary dominant (I-V/V-V-I)', 'major', 'I V/V V I', ['castle', 'victory', 'town'], 'A borrowed lift into the dominant.'),
  P('plagal-victory', 'Victory (I-IV-V-IV)', 'major', 'I IV V IV', ['victory', 'town'], 'Cheerful fanfare loop.'),
  P('rock-bIII', 'Rock (I-bIII-IV-V)', 'major', 'I bIII IV V', ['heroic', 'battle'], 'Borrowed bIII gives a power-chord edge.'),
  P('triumph', 'Triumph (I-bVI-bVII-I)', 'major', 'I bVI bVII I', ['heroic', 'victory'], 'Borrowed chords for epic arrivals; great for fanfares.'),
  P('shop-bossa', 'Soft major (Imaj7-IVmaj7-iii7-vi7)', 'major', 'Imaj7 IVmaj7 iii7 vi7', ['shop', 'chill', 'town'], 'Sevenths stepping down in fourths.'),
  P('title-sus', 'Suspended wonder (I-V-vi-IVsus2)', 'major', 'I V vi IVsus2', ['title', 'overworld', 'underwater'], 'Open, spacious.'),
  P('fanfare', 'Fanfare (I-V-I-V)', 'major', 'I V I V', ['victory', 'heroic'], 'Two-chord bounce; bright and short.'),
  P('desert-flat2', 'Phrygian major (I-bII-I-bII)', 'major', 'I bII I bII', ['desert'], 'Exotic flat-2 vamp; use with phrygian-dominant.'),
  P('desert-bass', 'Desert (I-bII-bVII-I)', 'major', 'I bII bVII I', ['desert'], 'Flat-2 tension resolved back home.'),
  // ---- minor
  P('epic-minor', 'Epic minor (i-bVI-bIII-bVII)', 'minor', 'i bVI bIII bVII', ['heroic', 'battle', 'overworld', 'castle'], 'The big cinematic loop.'),
  P('andalusian', 'Andalusian (i-bVII-bVI-V)', 'minor', 'i bVII bVI V', ['battle', 'boss', 'castle', 'desert'], 'Descending tragic line ending on the dominant.'),
  P('dungeon-walk', 'Dungeon walk (i-iv-v-i)', 'minor', 'i iv v i', ['dungeon', 'sad'], 'Natural-minor plod; patient and ominous.'),
  P('adventure-minor', 'Adventure (i-iv-bVII-bIII)', 'minor', 'i iv bVII bIII', ['overworld', 'heroic'], 'Minor with lift.'),
  P('boss-climb', 'Boss climb (i-bVI-iv-V)', 'minor', 'i bVI iv V', ['boss', 'castle'], 'Pressure builds into a major dominant.'),
  P('battle-vamp', 'Battle vamp (i-bVII-i-bVII)', 'minor', 'i bVII i bVII', ['battle', 'dungeon'], 'Driving two-chord ostinato.'),
  P('phrygian-vamp', 'Phrygian (i-bII-i-bII)', 'minor', 'i bII i bII', ['spooky', 'boss', 'dungeon'], 'Flat-2 menace.'),
  P('phrygian-return', 'Phrygian return (i-bII-bVII-i)', 'minor', 'i bII bVII i', ['spooky', 'dungeon', 'desert'], 'Dark and sneaking.'),
  P('dominant-pulse', 'Dominant pulse (i-V-i-V)', 'minor', 'i V i V', ['battle', 'boss'], 'Harmonic-minor tension, fast.'),
  P('castle-cadence', 'Castle cadence (i-iv-i-V)', 'minor', 'i iv i V', ['castle', 'sad', 'game-over'], 'Gothic and stately; V is major (harmonic minor).'),
  P('sorrow', 'Sorrow (i-bVI-bVII-i)', 'minor', 'i bVI bVII i', ['sad', 'heroic'], 'Falls and returns; bittersweet.'),
  P('lament', 'Lament (i-bIII-bVII-iv)', 'minor', 'i bIII bVII iv', ['sad', 'chill'], 'Slow and wistful.'),
  P('minor-lounge', 'Minor lounge (i7-iv7-bVII-bIII)', 'minor', 'i7 iv7 bVII bIII', ['chill', 'shop', 'sad'], 'Sevenths soften the minor.'),
  P('minor-ii-v', 'Minor ii-V-i', 'minor', 'iiø V7 i i', ['castle', 'spooky', 'shop'], 'Classic minor cadence; half-diminished colour.'),
  P('vamp-dominant7', 'Seventh vamp (i-V7-i-V7)', 'minor', 'i V7 i V7', ['boss', 'castle', 'battle'], 'Insistent leading-tone pull.'),
  P('boss-pedal', 'Boss pedal (i-bVI-V-V)', 'minor', 'i bVI V V', ['boss', 'castle'], 'Heavy approach landing hard on V.'),
  P('game-over', 'Game over (i-bVI-iv-i)', 'minor', 'i bVI iv i', ['game-over', 'sad'], 'Falling and settling, final.'),
  P('tritone-dread', 'Tritone dread (i-bV-i-bV)', 'minor', 'i bV i bV', ['spooky', 'dungeon'], 'Diabolus in musica.', 1),
  P('desert-minor', 'Desert (i-bII-V-i)', 'minor', 'i bII V i', ['desert', 'battle'], 'Flat-2 and dominant: exotic (phrygian-dominant).'),
  P('sad-turn', 'Sad turn (i-bIII-iv-i)', 'minor', 'i bIII iv i', ['sad', 'game-over'], 'Gentle fall to the subdominant, then home.'),
  P('epic-climb', 'Epic climb (bVI-bVII-i-i)', 'minor', 'bVI bVII i i', ['heroic', 'battle', 'boss'], 'Rises into the tonic like a cadence.'),
  P('underwater-minor', 'Drift (i-bVII-bVI-bVII)', 'minor', 'i bVII bVI bVII', ['underwater', 'dungeon', 'chill'], 'Slow oscillation between neighbours; hypnotic.'),
  P('spooky-dim', 'Diminished creep (i-iio-i-iio)', 'minor', 'i ii° i ii°', ['spooky', 'dungeon'], 'Chromatic dread.'),
  // ---- calm (slow harmonic rhythm: the composer plays each chord for two bars)
  P('calm-float', 'Float (Imaj7-IVmaj7-vi7-IVmaj7)', 'major', 'Imaj7 IVmaj7 vi7 IVmaj7', ['ambient', 'peaceful', 'lullaby'], 'Soft major sevenths drifting between I, IV and vi.'),
  P('calm-wonder', 'Wonder (Imaj7-II-IVmaj7-Imaj7)', 'major', 'Imaj7 II IVmaj7 Imaj7', ['ambient', 'peaceful'], 'Lydian colour with the major II: open, unresolved.'),
  P('calm-meadow', 'Meadow (I-iii-IV-I)', 'major', 'I iii IV I', ['peaceful', 'lullaby', 'ambient'], 'Plain and warm; moves gently and comes home.'),
  P('lullaby-rock', 'Lullaby (I-IV-I-V)', 'major', 'I IV I V', ['lullaby', 'peaceful'], 'The simplest rocking changes; no surprises.'),
  P('lullaby-sweet', 'Sweet (I-vi-IV-I)', 'major', 'I vi IV I', ['lullaby', 'peaceful'], 'Tender and nostalgic, resolves at home.'),
  P('calm-sus', 'Suspended calm (Isus2-IVsus2-Isus2-Vsus4)', 'major', 'Isus2 IVsus2 Isus2 Vsus4', ['ambient', 'mysterious-calm', 'peaceful'], 'No thirds: open fifths and seconds, very still.'),
  P('calm-hush', 'Hush (i7-bVII-bVI-bVII)', 'minor', 'i7 bVII bVI bVII', ['ambient', 'mysterious-calm'], 'Slow oscillation in the minor; soft, not sad.'),
  P('calm-curious', 'Curious (i-bIII-IV-i)', 'minor', 'i bIII IV i', ['mysterious-calm', 'ambient'], 'The major IV over minor (dorian) lifts the mood a little.'),
  P('calm-veil', 'Veil (i-bVII-i-bII)', 'minor', 'i bVII i bII', ['mysterious-calm'], 'Quiet doubt with a soft flat-2 glance.')
]

export function findProgression(id: string): Progression | undefined {
  const k = id.trim().toLowerCase()
  return PROGRESSIONS.find((p) => p.id === k)
}

export function requireProgression(id: string): Progression {
  const p = findProgression(id)
  if (!p) throw new Error(`Unknown progression "${id}". Valid ids: ${PROGRESSIONS.map((x) => x.id).join(', ')}.`)
  return p
}

export interface ProgressionQuery {
  mood?: string
  mode?: 'major' | 'minor'
  limit?: number
}

export function suggestProgressions(q: ProgressionQuery = {}): Progression[] {
  const mood = q.mood ? q.mood.trim().toLowerCase().replace(/[\s_]+/g, '-') : undefined
  let list = PROGRESSIONS.filter((p) => (!mood || p.moods.includes(mood)) && (!q.mode || p.mode === q.mode))
  if (q.limit !== undefined) list = list.slice(0, q.limit)
  return list
}

/** Chords of a progression in a key (one chord per `barsPerChord` bars). */
export function realizeProgression(prog: Progression, key: PitchClass | string, octave = 3): RomanChord[] {
  return prog.numerals.map((n) => romanToChord(n, key, octave))
}
