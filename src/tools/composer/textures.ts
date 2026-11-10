// compose_track textures for the gm chip: how the harmony, bass and accompaniment of a track are played. The melody is
// the composer's own phrase generator (composer.ts); a texture decides what is under it and how busy the melody may be.
//
//   pad-lead        sustained pads and a plain bass under the lead (today's arrangement, with real instruments)
//   broken-chord    a piano / harp / guitar plays the chord as eighth-note arpeggios, a soft pad holds it
//   ostinato        a short repeated figure of chord tones (a 2-bar riff), sparse bass
//   chorale         four voices sing or play the chords in blocks (choir, organ, strings); the melody is sparse
//   march           oom-pah: bass on 1 and 3, chord stabs on 2 and 4
//   bossa           syncopated comping with a bossa bass (the cafe groove)
//   lullaby-rock    a rocking three-note figure (3 against 4), soft pads, a celesta now and then
//   pizzicato-walk  a walking bass of short notes and staccato dyads on 2 and 4
//
// Textures write into channels given by the composer (parts); every part knows its channel and instrument. Pure and
// deterministic; the only randomness is the texture RNG the composer passes in.

import type { DrumRole } from '../../core'
import type { PercKind, TextureId } from './palettes'

export interface TexturePart {
  /** Channel index in song.channels. */
  ch: number
  /** Instrument index in song.instruments. */
  inst: number
}

export interface TextureChord {
  /** Root pitch class 0..11. */
  root: number
  intervals: number[]
}

export interface TextureEnv {
  bars: number
  introBars: number
  chordBars: number
  calm: boolean
  rng: () => number
  chordAt(bar: number): TextureChord
  introChord(bar: number): TextureChord
  sectionAt(bar: number): 'A' | 'B'
  /** Write a note (MIDI) at a row of the body (the loop, after the intro). */
  note(part: TexturePart, row: number, midi: number, vol: number): void
  /** Release the note of a part at a body row. */
  rel(part: TexturePart, row: number): void
  /** Write a note at the first row of an intro bar. */
  introNote(part: TexturePart, bar: number, midi: number, vol: number): void
  bass?: TexturePart
  /** Sustained voices, up to four (the first two are the usual pad pair). */
  pads: TexturePart[]
  /** Accompaniment voices, up to three (one for arpeggios, three for chord stabs). */
  comp: TexturePart[]
  sparkle?: TexturePart
}

export interface TextureDef {
  id: TextureId
  description: string
  /** How many pad voices and comp voices the texture uses (the composer creates them). */
  pads: number
  comp: number
  sparkle: boolean
  /** Melody changes: the probability that a bar of the melody is silent and the note density, replacing the mood's. */
  lead?: { restBars?: number; density?: 'sparse' | 'medium' | 'busy' }
  /** null = the composer's own pad / bass / arp code (the arrangement it has always had). */
  write: ((env: TextureEnv) => void) | null
}

const ROWS = 16

/** The MIDI note with pitch class `pc` closest to `center`. */
export function nearPitch(pc: number, center: number): number {
  let m = center + (((pc - center) % 12) + 12) % 12
  if (m - center > 6) m -= 12
  return m
}

const pcOf = (c: TextureChord, i: number): number => (c.root + (c.intervals[Math.min(i, c.intervals.length - 1)] ?? 0)) % 12

/** `count` chord tones as close together as possible around `center`, lowest first (octave doubles when the chord has fewer). */
function voicing(c: TextureChord, center: number, count: number): number[] {
  const pcs = [...new Set(c.intervals.map((i) => (c.root + i) % 12))]
  const base = pcs.map((pc) => nearPitch(pc, center)).sort((a, b) => a - b)
  const out = [...base]
  while (out.length < count) out.push(out[out.length - base.length]! + 12)
  return out.slice(0, count)
}

function writeIntro(env: TextureEnv): void {
  for (let bar = 0; bar < env.introBars; bar++) {
    if (bar !== 0 && bar !== env.introBars - 1) continue
    const c = env.introChord(bar)
    if (env.bass) env.introNote(env.bass, bar, 36 + c.root, 8)
    env.pads.slice(0, 2).forEach((p, k) => env.introNote(p, bar, k === 0 ? nearPitch(pcOf(c, 1), 60) : nearPitch(pcOf(c, 2), 66), 5))
  }
}

function eachBar(env: TextureEnv, fn: (bar: number, c: TextureChord, newChord: boolean, base: number) => void): void {
  for (let bar = 0; bar < env.bars; bar++) fn(bar, env.chordAt(bar), bar % env.chordBars === 0, bar * ROWS)
}

function brokenChord(env: TextureEnv): void {
  writeIntro(env)
  const [arp] = env.comp
  const A = [0, 1, 2, 3, 2, 1, 2, 1]
  const B = [0, 2, 1, 3, 1, 2, 3, 2]
  eachBar(env, (bar, c, newChord, base) => {
    const low = nearPitch(c.root, 52)
    const tones = [low, low + (c.intervals[1] ?? 4), low + (c.intervals[2] ?? 7), low + 12]
    const order = env.sectionAt(bar) === 'A' ? A : B
    if (arp) for (let k = 0; k < 8; k++) env.note(arp, base + k * 2, tones[order[k]!]!, k % 4 === 0 ? 9 : 6)
    if (newChord) {
      if (env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 62), 6)
      if (env.bass) env.note(env.bass, base, 36 + c.root, 11)
    }
    if (env.bass && bar % env.chordBars === 0) env.note(env.bass, base + 8, 36 + c.root + 7, 8)
    if (env.sparkle && bar % 2 === 1) env.note(env.sparkle, base + 12, nearPitch(pcOf(c, 2), 79), 4)
  })
}

function ostinato(env: TextureEnv): void {
  writeIntro(env)
  const [fig] = env.comp
  const FIG: [number, number][][] = [
    [[0, 0], [3, 2], [6, 1], [8, 2], [11, 3], [14, 1]],
    [[0, 0], [3, 1], [6, 2], [8, 1], [11, 2], [14, 3]]
  ]
  const FIG_B: [number, number][] = [[0, 2], [2, 1], [4, 0], [8, 1], [10, 2], [12, 3]]
  eachBar(env, (bar, c, newChord, base) => {
    const low = nearPitch(c.root, 55)
    const tones = [low, low + (c.intervals[1] ?? 4), low + (c.intervals[2] ?? 7), low + 12]
    const pattern = env.sectionAt(bar) === 'B' ? FIG_B : FIG[bar % 2]!
    if (fig) pattern.forEach(([row, idx], k) => env.note(fig, base + row, tones[idx]!, k === 0 ? 9 : 6))
    if (newChord) {
      if (env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 62), 6)
      if (env.bass) env.note(env.bass, base, 36 + c.root, 11)
    } else if (env.bass && bar % 2 === 1) env.note(env.bass, base + 8, 36 + c.root + 7, 7)
    if (env.sparkle && bar % 4 === 3) env.note(env.sparkle, base + 8, nearPitch(c.root, 84), 4)
  })
}

function chorale(env: TextureEnv): void {
  writeIntro(env)
  const voices = env.pads
  eachBar(env, (bar, c, newChord, base) => {
    const notes = voicing(c, 63, Math.max(1, voices.length))
    // the lowest voice is the last pad (so the first pad carries the top line)
    voices.forEach((p, k) => {
      const midi = notes[voices.length - 1 - k] ?? notes[0]!
      env.note(p, base, midi, 9 - Math.min(3, k))
      env.note(p, base + 8, midi, 6 - Math.min(2, k))
    })
    if (newChord && env.bass) env.note(env.bass, base, 36 + c.root, 11)
    if (env.sparkle && newChord && env.sectionAt(bar) === 'B') env.note(env.sparkle, base + 8, nearPitch(c.root, 79), 4)
  })
}

function march(env: TextureEnv): void {
  writeIntro(env)
  eachBar(env, (bar, c, newChord, base) => {
    const bassRows: [number, number, number][] = [[0, 0, 12], [4, 7, 9], [8, 0, 11], [12, 7, 9]]
    if (env.bass) {
      for (const [row, semis, vol] of bassRows) {
        env.note(env.bass, base + row, 36 + c.root + semis, vol)
        env.rel(env.bass, base + row + 2)
      }
    }
    const notes = voicing(c, env.sectionAt(bar) === 'B' ? 67 : 62, Math.max(1, env.comp.length))
    for (const row of [4, 12]) {
      env.comp.forEach((p, k) => {
        env.note(p, base + row, notes[k] ?? notes[0]!, 8)
        env.rel(p, base + row + 2)
      })
    }
    if (newChord && env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 64), 5)
    if (env.sparkle && bar % 4 === 3) env.note(env.sparkle, base + 14, nearPitch(pcOf(c, 2), 84), 5)
  })
}

function bossa(env: TextureEnv): void {
  writeIntro(env)
  const A0 = [0, 6, 10]
  const A1 = [3, 6, 12]
  eachBar(env, (bar, c, newChord, base) => {
    if (env.bass) {
      const rows: [number, number, number][] = [[0, 0, 12], [6, 7, 9], [8, 0, 10], [14, 7, 8]]
      for (const [row, semis, vol] of rows) env.note(env.bass, base + row, 36 + c.root + semis, vol)
    }
    const notes = voicing(c, 64, Math.max(1, env.comp.length))
    const rows = bar % 2 === 0 ? A0 : A1
    rows.forEach((row, k) => {
      env.comp.forEach((p, i) => {
        env.note(p, base + row, notes[i] ?? notes[0]!, k === 1 ? 6 : 7)
        env.rel(p, base + row + 2)
      })
    })
    if (newChord && env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 62), 5)
    if (env.sparkle && bar % 4 === 2) env.note(env.sparkle, base + 4, nearPitch(pcOf(c, 2), 76), 4)
  })
}

function lullabyRock(env: TextureEnv): void {
  writeIntro(env)
  const [rock] = env.comp
  eachBar(env, (bar, c, newChord, base) => {
    const notes = [nearPitch(c.root, 55), nearPitch(pcOf(c, 2), 62), nearPitch(pcOf(c, 1), 67)]
    if (rock) [0, 5, 11].forEach((row, k) => env.note(rock, base + row, notes[k]!, k === 0 ? 7 : 5))
    if (newChord) {
      if (env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 62), 6)
      if (env.pads[1]) env.note(env.pads[1], base + 4, nearPitch(pcOf(c, 2), 68), 6)
      if (env.bass) env.note(env.bass, base, 36 + c.root, 10)
    } else if (env.bass) env.note(env.bass, base + 8, 36 + c.root + 7, 6)
    if (env.sparkle && bar % 2 === 1) env.note(env.sparkle, base + 8, nearPitch(pcOf(c, 2), 84), 4)
  })
}

function pizzicatoWalk(env: TextureEnv): void {
  writeIntro(env)
  eachBar(env, (bar, c, newChord, base) => {
    if (env.bass) {
      const third = c.intervals[1] ?? 4
      const fifth = c.intervals[2] ?? 7
      const walk = [0, third, fifth, third]
      const lastOfChord = bar % env.chordBars === env.chordBars - 1
      const next = env.chordAt(bar + 1 < env.bars ? bar + 1 : 0)
      walk.forEach((semis, k) => {
        let midi = 36 + c.root + semis
        // the last quarter before a chord change steps into the next root from below or above
        if (k === 3 && lastOfChord) midi = 36 + next.root + (bar % 2 === 0 ? -1 : 1)
        env.note(env.bass!, base + k * 4, midi, k === 0 ? 12 : 9)
        env.rel(env.bass!, base + k * 4 + 3)
      })
    }
    const notes = [nearPitch(pcOf(c, 1), 62), nearPitch(pcOf(c, 2), 67)]
    for (const row of [4, 12]) {
      env.comp.slice(0, 2).forEach((p, k) => {
        env.note(p, base + row, notes[k]!, 7)
        env.rel(p, base + row + 2)
      })
    }
    if (newChord && env.pads[0]) env.note(env.pads[0], base, nearPitch(pcOf(c, 1), 64), 5)
    if (env.sparkle && bar % 2 === 1) env.note(env.sparkle, base + 14, nearPitch(pcOf(c, 2), 84), 4)
  })
}

export const TEXTURES: Record<TextureId, TextureDef> = {
  'pad-lead': { id: 'pad-lead', description: 'Sustained pads and a plain bass under the melody: the classic calm arrangement.', pads: 2, comp: 1, sparkle: false, write: null },
  'broken-chord': { id: 'broken-chord', description: 'A piano, harp or guitar plays the chord as eighth-note arpeggios under a soft pad.', pads: 1, comp: 1, sparkle: true, write: brokenChord },
  ostinato: { id: 'ostinato', description: 'A short repeated figure of chord tones (a two-bar riff), a held pad and a sparse bass.', pads: 1, comp: 1, sparkle: true, lead: { restBars: 0.1 }, write: ostinato },
  chorale: { id: 'chorale', description: 'Four voices (choir, organ, strings) play the chords in blocks; the melody is sparse.', pads: 4, comp: 0, sparkle: true, lead: { density: 'sparse', restBars: 0.4 }, write: chorale },
  march: { id: 'march', description: 'Oom-pah: the bass on 1 and 3, chord stabs on 2 and 4.', pads: 1, comp: 3, sparkle: true, write: march },
  bossa: { id: 'bossa', description: 'Syncopated chord comping over a bossa-nova bass: the cafe groove.', pads: 1, comp: 3, sparkle: true, lead: { restBars: 0.06 }, write: bossa },
  'lullaby-rock': { id: 'lullaby-rock', description: 'A rocking three-note figure (3 against 4), soft pads and a celesta: a lullaby.', pads: 2, comp: 1, sparkle: true, write: lullabyRock },
  'pizzicato-walk': { id: 'pizzicato-walk', description: 'A walking bass of short notes and staccato dyads on beats 2 and 4: playful.', pads: 1, comp: 2, sparkle: true, lead: { density: 'medium' }, write: pizzicatoWalk }
}

export const TEXTURE_IDS = Object.keys(TEXTURES) as TextureId[]

// ---------------------------------------------------------------------------------------------- calm percussion

export interface PercHit {
  /** gm drum channel id. */
  channel: 'D1' | 'D2' | 'D3'
  /** Preset id (sf-drum) and its role, for the drum map of the composer. */
  preset: string
  role: DrumRole
  /** Rows of a bar. */
  rows: number[]
  vol: number
}

/** Light percussion for calm tracks: what plays on which drum channel (every bar). */
export function percussionPlan(kind: PercKind): PercHit[] {
  switch (kind) {
    case 'shaker':
      return [{ channel: 'D3', preset: 'gm.hihat.shaker', role: 'hihat', rows: [2, 6, 10, 14], vol: 4 }]
    case 'side-stick':
      return [{ channel: 'D2', preset: 'gm.snare.side-stick', role: 'snare', rows: [4, 12], vol: 5 }]
    case 'brush':
      return [
        { channel: 'D2', preset: 'gm.snare.brush-snare', role: 'snare', rows: [0, 4, 8, 12], vol: 4 },
        { channel: 'D1', preset: 'gm.kick.brush-kick', role: 'kick', rows: [0, 8], vol: 5 }
      ]
    case 'triangle':
      return [{ channel: 'D3', preset: 'gm.hihat.triangle', role: 'hihat', rows: [0, 8], vol: 4 }]
    case 'woodblock':
      return [{ channel: 'D3', preset: 'gm.hihat.woodblock', role: 'hihat', rows: [4, 12], vol: 5 }]
    default:
      return []
  }
}
