// compose_track variety: song forms (A / AB / ABA / AABA), the fingerprint of a finished track and the avoid rule that keeps
// the tracks of one work apart (never the same texture or lead, tempos at least 8 BPM apart, another key than the last).

import type { ChipId, MoodRecipe, PitchClass } from '../../core'
import { PALETTE_LIBRARY, type Palette, type TextureId, findPaletteById, palettesFor } from './palettes'
import { createRng } from './rng'
import { TEXTURE_IDS } from './textures'

export type FormId = 'A' | 'AB' | 'ABA' | 'AABA'
export const FORMS: readonly FormId[] = ['A', 'AB', 'ABA', 'AABA']

// AB is two halves, ABA is A (half) B (quarter) A (quarter), AABA is four equal parts, the third being B.
const QUARTER_SPLIT: Record<FormId, number[]> = { A: [4], AB: [2, 2], ABA: [2, 1, 1], AABA: [1, 1, 1, 1] }
const SECTION_LETTERS: Record<FormId, ('A' | 'B')[]> = { A: ['A'], AB: ['A', 'B'], ABA: ['A', 'B', 'A'], AABA: ['A', 'A', 'B', 'A'] }

export interface FormSection {
  letter: 'A' | 'B'
  /** First bar of the body (0-based) and the bar after the last one. */
  start: number
  end: number
}

/** Smallest body (in bars) a form needs: two bars per quarter, or two chords per quarter. */
export function minBarsForForm(form: FormId, chordBars: number): number {
  return form === 'A' ? 1 : 4 * Math.max(2, chordBars)
}

/** The sections of a form over `bars` bars; boundaries sit on chord changes (multiples of `chordBars`). */
export function formSections(form: FormId, bars: number, chordBars: number): FormSection[] {
  const quarters = QUARTER_SPLIT[form]
  const letters = SECTION_LETTERS[form]
  const out: FormSection[] = []
  let cum = 0
  let start = 0
  quarters.forEach((q, i) => {
    cum += q
    const isLast = i === quarters.length - 1
    let end = isLast ? bars : Math.round(((cum / 4) * bars) / chordBars) * chordBars
    end = Math.min(bars, Math.max(start + chordBars, end))
    out.push({ letter: letters[i]!, start, end })
    start = end
  })
  return out
}

export interface Fingerprint {
  texture: string
  /** Preset ids of the lead, the first pad and the bass. */
  lead: string
  pad: string
  bass: string
  bpm: number
  key: string
  scale: string
  form: FormId
}

export type AvoidRule = 'texture' | 'lead' | 'tempo' | 'key'

export const TEMPO_GAP = 8

/**
 * The avoid rules a candidate breaks: its texture or lead equals one of an earlier track, its tempo is less than 8 BPM from
 * one, or its key equals the key of the last track. `texture` null skips the texture rule (chips without textures); an
 * empty `lead` skips the lead rule.
 */
export function avoidViolations(c: { texture: string | null; lead: string; bpm: number; key: string }, avoid: readonly Fingerprint[]): AvoidRule[] {
  const out: AvoidRule[] = []
  if (c.texture !== null && avoid.some((f) => f.texture === c.texture)) out.push('texture')
  if (c.lead !== '' && avoid.some((f) => f.lead === c.lead)) out.push('lead')
  if (avoid.some((f) => Math.abs(f.bpm - c.bpm) < TEMPO_GAP)) out.push('tempo')
  const last = avoid[avoid.length - 1]
  if (last && last.key === c.key) out.push('key')
  return out
}

export function describeViolations(rules: readonly AvoidRule[], c: { texture: string | null; lead: string; bpm: number; key: string }): string {
  const text: Record<AvoidRule, string> = {
    texture: `texture "${c.texture}" is used by an earlier track`,
    lead: `lead "${c.lead}" is used by an earlier track`,
    tempo: `${c.bpm} BPM is less than ${TEMPO_GAP} BPM from an earlier track`,
    key: `key ${c.key} is the key of the last earlier track`
  }
  return rules.map((r) => text[r]).join('; ')
}

// ---------------------------------------------------------------------------------------------- choosing the variety

export interface VarietyInput {
  mood: MoodRecipe
  chip: ChipId
  /** Synth moods keep their own arrangement (no palette, texture or default form). */
  synth: boolean
  opts: { seed: number; texture?: string; form?: string; palette?: string; avoid?: Fingerprint[]; bpm?: number; key?: string }
  /** The key and tempo the seed gives without the avoid rule. */
  key: PitchClass
  bpm: number
}

export interface Variety {
  palette: Palette | null
  texture: TextureId
  form: FormId
  key: PitchClass
  bpm: number
  warnings: string[]
  /** A random stream for everything below the choice (the B progression, the textures). Never the composer's main RNG. */
  rng: () => number
}

const ALL_KEYS: PitchClass[] = ['C', 'D', 'E', 'F', 'G', 'A', 'A#', 'D#', 'F#', 'B', 'C#', 'G#']
const FORM_WEIGHTS: [FormId, number][] = [['A', 0.3], ['AB', 0.4], ['ABA', 0.15], ['AABA', 0.15]]

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * Pick the palette, texture and form of a track, then apply the avoid rule: a pair that does not repeat the texture or the
 * lead of an earlier track, a tempo 8+ BPM from them and a key other than the last one. Without `avoid` the seed's own pick
 * stands. All randomness comes from a stream of its own, so the key, tempo and harmony of a seed do not depend on it.
 */
export function resolveVariety(a: VarietyInput): Variety {
  const { mood, chip, opts } = a
  const warnings: string[] = []
  const rng = createRng((opts.seed ^ 0x9e3779b9 ^ 0x7661) >>> 0)
  const gmNew = chip === 'gm' && !a.synth

  let palettes: Palette[] = gmNew ? palettesFor(mood.id, chip) : []
  if (opts.palette !== undefined) {
    if (!gmNew) warnings.push(`palette "${opts.palette}" only applies to the gm chip (and not to the synth moods); ignored.`)
    else {
      const p = findPaletteById(opts.palette)
      if (!p) throw new Error(`Unknown palette "${opts.palette}". Palettes: ${PALETTE_LIBRARY.map((x) => x.id).join(', ')}.`)
      palettes = [p]
    }
  }
  let textureFixed: TextureId | undefined
  if (opts.texture !== undefined) {
    const id = opts.texture.trim().toLowerCase()
    if (!(TEXTURE_IDS as string[]).includes(id)) throw new Error(`Unknown texture "${opts.texture}". Textures: ${TEXTURE_IDS.join(', ')}.`)
    if (!gmNew && id !== 'pad-lead') warnings.push(`texture "${id}" is only available on the gm chip (and not for the synth moods); used pad-lead.`)
    else textureFixed = id as TextureId
  }
  const pairs: { palette: Palette; texture: TextureId }[] = []
  const avoidAsked = (opts.avoid?.length ?? 0) > 0
  if (gmNew) {
    for (const palette of palettes) {
      for (const texture of textureFixed ? [textureFixed] : palette.textures) {
        pairs.push({ palette, texture })
        // lead variants of the palette are only tried when the avoid rule asks for another lead
        if (avoidAsked) for (const lead of palette.leads ?? []) pairs.push({ palette: { ...palette, lead }, texture })
      }
    }
  }
  const natural = pairs.length > 0 ? pairs[Math.floor(rng() * pairs.length)]! : null
  const formRoll = rng()
  let form: FormId = 'A'
  if (opts.form !== undefined) {
    const f = opts.form.trim().toUpperCase() as FormId
    if (!FORMS.includes(f)) throw new Error(`Unknown form "${opts.form}". Forms: ${FORMS.join(', ')}.`)
    form = f
  } else if (gmNew) {
    let r = formRoll
    for (const [f, w] of FORM_WEIGHTS) {
      r -= w
      if (r < 0) {
        form = f
        break
      }
    }
  }

  let pair = natural
  let bpm = a.bpm
  let key = a.key
  const avoid = opts.avoid ?? []
  if (avoid.length > 0) {
    if (pairs.length > 1 && natural) {
      const order = [natural, ...shuffled(pairs.filter((p) => p !== natural), rng)]
      const bad = (p: { palette: Palette; texture: TextureId }): number =>
        avoidViolations({ texture: p.texture, lead: p.palette.lead, bpm, key }, avoid).filter((r) => r === 'texture' || r === 'lead').length
      pair = order.reduce((best, p) => (bad(p) < bad(best) ? p : best), order[0]!)
    }
    if (opts.bpm === undefined && avoidViolations({ texture: null, lead: '', bpm, key }, avoid).includes('tempo')) {
      const lo = Math.max(48, mood.bpm[0] - 14)
      const hi = Math.min(150, mood.bpm[1] + 16)
      const all: number[] = []
      for (let b = lo; b <= hi; b++) all.push(b)
      const hit = shuffled(all, rng).find((b) => !avoidViolations({ texture: null, lead: '', bpm: b, key }, avoid).includes('tempo'))
      if (hit !== undefined) bpm = hit
    }
    const last = avoid[avoid.length - 1]!
    if (opts.key === undefined && last.key === key) {
      const next = [...mood.keys, ...ALL_KEYS].find((k) => k !== last.key)
      if (next) key = next
    }
  }
  return { palette: pair?.palette ?? null, texture: pair?.texture ?? 'pad-lead', form, key, bpm, warnings, rng }
}
