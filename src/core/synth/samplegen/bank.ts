// The sample bank: a registry of generator recipes, a cache, slot resolution (recipe + user PCM slots), the SNES
// processing pipeline (resample to 32 kHz, loop alignment to 16, BRR encode/decode round trip), the NES DPCM
// encoder and the 8-bit DAC quantiser used by the Genesis F6 channel.
//
// Projects store only { recipe, params } (or user PCM16); everything else is regenerated deterministically.

import type { Role, SampleSlot } from '../../types'
import { base64ToBytes, bytesToBase64 } from '../../codecs/png'
import { brrByteSize, encodeBrr } from './brr'
import {
  type RawSample,
  additiveLoop,
  crashCymbal,
  fmTone,
  handClap,
  hashSeed,
  hiHat,
  karplusStrong,
  kickDrum,
  resample,
  snareDrum,
  tomDrum,
  toInt16
} from './generators'

export type ParamValue = number | string | boolean
export type RecipeParams = Record<string, ParamValue>

export interface ParamSpec {
  key: string
  type: 'number' | 'enum' | 'boolean'
  default: ParamValue
  min?: number
  max?: number
  options?: string[]
  description: string
}

export interface RecipeInfo {
  id: string
  label: string
  role: Role
  description: string
  /** True when the sample has a loop (sustained instruments); false for one-shots (plucks, drums). */
  loops: boolean
  params: ParamSpec[]
}

interface RecipeDef extends RecipeInfo {
  build(p: RecipeParams): RawSample
}

export interface SampleResult {
  /** PCM16 mono. For `generateSample` this is what the SNES plays (after the BRR round trip). */
  pcm: Int16Array
  sampleRate: number
  /** Loop start in samples (multiple of 16 for BRR samples). */
  loopStart?: number
  /** MIDI note at which the sample plays at its native rate. */
  baseNote: number
  /** BRR size in bytes (SNES results only). */
  brrBytes?: number
}

// ---------------------------------------------------------------------------------------------
// Parameter helpers

const num = (key: string, def: number, min: number, max: number, description: string): ParamSpec => ({ key, type: 'number', default: def, min, max, description })
const flag = (key: string, def: boolean, description: string): ParamSpec => ({ key, type: 'boolean', default: def, description })
const choice = (key: string, def: string, options: string[], description: string): ParamSpec => ({ key, type: 'enum', default: def, options, description })

const NOTE = (def: number): ParamSpec => num('note', def, 12, 108, `MIDI note the sample is tuned to (base note), default ${def}.`)
const SEED: ParamSpec = num('seed', 0, 0, 4294967295, 'Random seed (0 = the recipe\'s fixed default).')
const LOOP: ParamSpec = flag('loop', true, 'Loop the sustained part (true) or play once (false).')
const SECONDS = (def: number, max = 3): ParamSpec => num('seconds', def, 0.03, max, `Length in seconds (memory is ~9 bytes per 16 samples).`)
const RATE = (def: number): ParamSpec => num('rate', def, 4000, 32000, `Sample rate in Hz (lower = smaller and grittier), default ${def}.`)

const n = (p: RecipeParams, k: string): number => p[k] as number
const s = (p: RecipeParams, k: string): string => p[k] as string

function seedOf(id: string, p: RecipeParams): number {
  const v = n(p, 'seed')
  return v > 0 ? v >>> 0 : hashSeed(id)
}

function maybeLoop(raw: RawSample, p: RecipeParams): RawSample {
  if (p['loop'] === false && raw.loopStart !== undefined) {
    const { loopStart: _drop, ...rest } = raw
    void _drop
    return rest
  }
  return raw
}

const FORMANTS: Record<string, [number, number, number][]> = {
  aah: [[800, 130, 1], [1150, 150, 0.5], [2900, 300, 0.15]],
  ooh: [[350, 100, 1], [700, 120, 0.4], [2700, 300, 0.05]],
  eeh: [[270, 90, 1], [2300, 200, 0.5], [3000, 300, 0.25]]
}

// ---------------------------------------------------------------------------------------------
// Recipes

const RECIPES: RecipeDef[] = [
  {
    id: 'strings',
    label: 'Strings',
    role: 'strings',
    description: 'Ensemble strings: bowed sawtooth-like additive loop with a chorus-detuned copy and a bow-noise attack.',
    loops: true,
    params: [NOTE(60), num('bright', 0.55, 0, 1, 'Spectral brightness 0 (dark) .. 1 (bright).'), num('chorus', 1, 0, 4, 'Detuned copy in loop bins (0 = none).'), LOOP, SEED],
    build: (p) =>
      maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 2048,
          intro: 512,
          introNoise: 0.25,
          detuneBins: n(p, 'chorus'),
          harmonics: (h) => Math.pow(h, -(1.5 - n(p, 'bright'))),
          seed: seedOf('strings', p)
        }),
        p
      )
  },
  {
    id: 'choir',
    label: 'Choir',
    role: 'choir',
    description: 'Sung vowel pad: harmonics shaped by three formants, two detuned voices.',
    loops: true,
    params: [NOTE(60), choice('vowel', 'aah', ['aah', 'ooh', 'eeh'], 'Vowel formants.'), LOOP, SEED],
    build: (p) => {
      const fm = FORMANTS[s(p, 'vowel')] ?? FORMANTS['aah']!
      return maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 2048,
          intro: 256,
          introNoise: 0.1,
          detuneBins: 2,
          harmonics: (h, hz) => {
            let a = 0.04
            for (const [f, bw, g] of fm) a += g * Math.exp(-(((hz - f) / bw) ** 2))
            return a * Math.pow(h, -0.4)
          },
          seed: seedOf('choir', p)
        }),
        p
      )
    }
  },
  {
    id: 'organ',
    label: 'Organ',
    role: 'organ',
    description: 'Drawbar organ: a handful of harmonics (1, 2, 3, 4, 6, 8).',
    loops: true,
    params: [NOTE(60), choice('draw', 'full', ['full', 'soft', 'flute'], 'Drawbar registration.'), LOOP, SEED],
    build: (p) => {
      const bars: Record<string, Record<number, number>> = {
        full: { 1: 1, 2: 0.8, 3: 0.6, 4: 0.5, 6: 0.35, 8: 0.3 },
        soft: { 1: 1, 2: 0.4, 4: 0.15 },
        flute: { 1: 1, 3: 0.35, 5: 0.12 }
      }
      const d = bars[s(p, 'draw')] ?? bars['full']!
      return maybeLoop(additiveLoop({ note: n(p, 'note'), loopLen: 512, harmonics: (h) => d[h] ?? 0, seed: seedOf('organ', p) }), p)
    }
  },
  {
    id: 'flute',
    label: 'Flute',
    role: 'flute',
    description: 'Breathy flute: weak harmonics, periodic breath noise and a chiff.',
    loops: true,
    params: [NOTE(72), num('breath', 0.3, 0, 1, 'Breath noise amount.'), LOOP, SEED],
    build: (p) =>
      maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 1024,
          intro: 512,
          introNoise: 0.5,
          breath: n(p, 'breath'),
          harmonics: (h) => (h === 1 ? 1 : h === 2 ? 0.3 : h === 3 ? 0.12 : h === 4 ? 0.05 : h === 5 ? 0.02 : 0),
          seed: seedOf('flute', p)
        }),
        p
      )
  },
  {
    id: 'brass',
    label: 'Brass',
    role: 'brass',
    description: 'Brassy sawtooth with a spectrum that blooms during the attack (blat).',
    loops: true,
    params: [NOTE(60), num('bright', 0.6, 0, 1, 'Spectral brightness.'), LOOP, SEED],
    build: (p) =>
      maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 1024,
          intro: 768,
          introNoise: 0.08,
          harmonics: (h) => Math.pow(h, -(1.4 - n(p, 'bright') * 0.8)) * (h <= 3 ? 1.2 : 1),
          seed: seedOf('brass', p)
        }),
        p
      )
  },
  {
    id: 'pad',
    label: 'Pad',
    role: 'pad',
    description: 'Detuned chorus pad: long multi-cycle loop with two detuned copies (shimmering beat).',
    loops: true,
    params: [NOTE(60), choice('wave', 'saw', ['saw', 'square', 'tri'], 'Base waveform.'), num('chorus', 2, 1, 6, 'Detune in loop bins.'), LOOP, SEED],
    build: (p) => {
      const w = s(p, 'wave')
      return maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 4096,
          detuneBins: n(p, 'chorus'),
          chorusMix: 0.9,
          harmonics: (h) => (w === 'saw' ? 1 / h : w === 'square' ? (h % 2 === 1 ? 1 / h : 0) : h % 2 === 1 ? 1 / (h * h) : 0),
          seed: seedOf('pad', p)
        }),
        p
      )
    }
  },
  {
    id: 'bass',
    label: 'Bass',
    role: 'bass',
    description: 'Synth or pick bass: low-passed sawtooth loop (synth) or a plucked attack with a mellow sustain (pick).',
    loops: true,
    params: [NOTE(36), choice('style', 'synth', ['synth', 'pick'], 'Synth (sustained) or pick (plucked attack).'), num('cutoff', 900, 150, 4000, 'Low-pass cutoff in Hz.'), LOOP, SEED],
    build: (p) => {
      const pick = s(p, 'style') === 'pick'
      const cutoff = n(p, 'cutoff')
      return maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 512,
          intro: pick ? 256 : 0,
          introNoise: pick ? 0.35 : 0,
          harmonics: (h, hz) => (pick ? (h === 1 ? 1 : 0.7 / Math.pow(h, 1.3)) : 1 / h) * Math.exp(-hz / (cutoff * 2)),
          seed: seedOf('bass', p)
        }),
        p
      )
    }
  },
  {
    id: 'lead',
    label: 'Lead',
    role: 'lead',
    description: 'Single-cycle lead waveform: saw, square, pulse (duty) or triangle.',
    loops: true,
    params: [NOTE(72), choice('wave', 'saw', ['saw', 'square', 'pulse', 'tri'], 'Waveform.'), num('duty', 0.25, 0.1, 0.5, 'Pulse duty for wave "pulse".'), num('chorus', 0, 0, 4, 'Detuned copy in loop bins.'), LOOP, SEED],
    build: (p) => {
      const w = s(p, 'wave')
      const duty = n(p, 'duty')
      return maybeLoop(
        additiveLoop({
          note: n(p, 'note'),
          loopLen: 256,
          detuneBins: n(p, 'chorus'),
          harmonics: (h) =>
            w === 'saw' ? 1 / h : w === 'square' ? (h % 2 === 1 ? 1 / h : 0) : w === 'pulse' ? Math.abs(Math.sin(Math.PI * h * duty)) / h : h % 2 === 1 ? 1 / (h * h) : 0,
          seed: seedOf('lead', p)
        }),
        p
      )
    }
  },
  {
    id: 'harp',
    label: 'Harp',
    role: 'pluck',
    description: 'Harp: Karplus-Strong string excited by smoothed noise, long ring.',
    loops: false,
    params: [NOTE(60), SECONDS(0.55), RATE(22050), SEED],
    build: (p) => karplusStrong({ note: n(p, 'note'), rate: n(p, 'rate'), seconds: n(p, 'seconds'), decay: 0.9985, bright: 0.55, burst: 'smooth', seed: seedOf('harp', p) })
  },
  {
    id: 'pluck',
    label: 'Pluck',
    role: 'pluck',
    description: 'Short bright plucked string (Karplus-Strong).',
    loops: false,
    params: [NOTE(60), SECONDS(0.3), RATE(22050), SEED],
    build: (p) => karplusStrong({ note: n(p, 'note'), rate: n(p, 'rate'), seconds: n(p, 'seconds'), decay: 0.994, bright: 0.5, burst: 'noise', seed: seedOf('pluck', p) })
  },
  {
    id: 'guitar',
    label: 'Guitar',
    role: 'pluck',
    description: 'Picked guitar string: comb-filtered excitation (pick position) and a warm decay.',
    loops: false,
    params: [NOTE(52), SECONDS(0.5), RATE(22050), num('pickPos', 0.18, 0.05, 0.5, 'Pick position along the string.'), SEED],
    build: (p) =>
      karplusStrong({ note: n(p, 'note'), rate: n(p, 'rate'), seconds: n(p, 'seconds'), decay: 0.9965, bright: 0.52, burst: 'pick', pickPos: n(p, 'pickPos'), seed: seedOf('guitar', p) })
  },
  {
    id: 'koto',
    label: 'Koto',
    role: 'pluck',
    description: 'Koto / kalimba-like pluck: bright string plus an inharmonic tine partial.',
    loops: false,
    params: [NOTE(64), SECONDS(0.4), RATE(22050), SEED],
    build: (p) =>
      karplusStrong({ note: n(p, 'note'), rate: n(p, 'rate'), seconds: n(p, 'seconds'), decay: 0.9975, bright: 0.7, burst: 'pick', pickPos: 0.12, metallic: 0.5, seed: seedOf('koto', p) })
  },
  {
    id: 'bell',
    label: 'Bell',
    role: 'bell',
    description: 'FM bell: inharmonic 2-operator stack with a decaying modulation index and a strike partial.',
    loops: false,
    params: [NOTE(72), SECONDS(0.5), RATE(22050), SEED],
    build: (p) =>
      fmTone({
        note: n(p, 'note'),
        rate: n(p, 'rate'),
        seconds: n(p, 'seconds'),
        ratio: 3.5,
        index: 3.5,
        indexTau: 0.18,
        ampTau: 0.22,
        partial: { level: 0.35, ratio: 5.4, tau: 0.07, index: 1.2 },
        click: 0.15,
        seed: seedOf('bell', p)
      })
  },
  {
    id: 'epiano',
    label: 'E-piano',
    role: 'arp',
    description: 'FM electric piano: 1:1 body with a short bright tine (14:1) on the attack.',
    loops: false,
    params: [NOTE(60), SECONDS(0.5), RATE(16000), SEED],
    build: (p) =>
      fmTone({
        note: n(p, 'note'),
        rate: n(p, 'rate'),
        seconds: n(p, 'seconds'),
        ratio: 1,
        index: 1.8,
        indexTau: 0.3,
        ampTau: 0.28,
        partial: { level: 0.25, ratio: 14, tau: 0.03, index: 0.8 },
        click: 0.1,
        seed: seedOf('epiano', p)
      })
  },
  {
    id: 'kick',
    label: 'Kick',
    role: 'kick',
    description: 'Kick drum: sine sweep 150 Hz to 45 Hz plus a click.',
    loops: false,
    params: [SECONDS(0.2, 1), RATE(16000), num('startHz', 150, 80, 300, 'Sweep start.'), num('endHz', 45, 30, 90, 'Sweep end.'), num('click', 0.6, 0, 1.5, 'Beater click level.'), SEED],
    build: (p) => kickDrum({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), startHz: n(p, 'startHz'), endHz: n(p, 'endHz'), click: n(p, 'click'), seed: seedOf('kick', p) })
  },
  {
    id: 'snare',
    label: 'Snare',
    role: 'snare',
    description: 'Snare: 180 Hz tone plus band-passed noise.',
    loops: false,
    params: [SECONDS(0.18, 1), RATE(22050), num('toneHz', 180, 100, 400, 'Body tone.'), num('noise', 0.8, 0, 1.5, 'Noise level.'), SEED],
    build: (p) => snareDrum({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), toneHz: n(p, 'toneHz'), noise: n(p, 'noise'), seed: seedOf('snare', p) })
  },
  {
    id: 'hat',
    label: 'Closed hi-hat',
    role: 'hihat',
    description: 'Closed hi-hat: high-passed noise with a short decay.',
    loops: false,
    params: [SECONDS(0.06, 0.5), RATE(32000), SEED],
    build: (p) => hiHat({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), open: false, seed: seedOf('hat', p) })
  },
  {
    id: 'openhat',
    label: 'Open hi-hat',
    role: 'openhat',
    description: 'Open hi-hat: high-passed noise plus metallic squares, longer decay.',
    loops: false,
    params: [SECONDS(0.22, 1), RATE(32000), SEED],
    build: (p) => hiHat({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), open: true, seed: seedOf('openhat', p) })
  },
  {
    id: 'crash',
    label: 'Crash cymbal',
    role: 'crash',
    description: 'Crash cymbal: noise and metallic squares with a long decay.',
    loops: false,
    params: [SECONDS(0.55, 2), RATE(22050), SEED],
    build: (p) => crashCymbal({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), seed: seedOf('crash', p) })
  },
  {
    id: 'tom',
    label: 'Tom',
    role: 'tom',
    description: 'Tom drum: pitched sine with a short sweep.',
    loops: false,
    params: [SECONDS(0.25, 1), RATE(16000), num('hz', 110, 60, 300, 'Tom pitch.'), SEED],
    build: (p) => tomDrum({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), hz: n(p, 'hz'), seed: seedOf('tom', p) })
  },
  {
    id: 'clap',
    label: 'Clap',
    role: 'clap',
    description: 'Hand clap: three short noise bursts and a tail.',
    loops: false,
    params: [SECONDS(0.15, 1), RATE(22050), SEED],
    build: (p) => handClap({ rate: n(p, 'rate'), seconds: n(p, 'seconds'), seed: seedOf('clap', p) })
  }
]

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]))

/** All recipes with their parameters (for list_samples and the UI). */
export function listRecipes(): RecipeInfo[] {
  return RECIPES.map(({ build: _b, ...info }) => {
    void _b
    return { ...info, params: info.params.map((x) => ({ ...x })) }
  })
}

export function getRecipe(id: string): RecipeInfo | undefined {
  const r = BY_ID.get(id)
  if (!r) return undefined
  const { build: _b, ...info } = r
  void _b
  return info
}

export function recipeIds(): string[] {
  return RECIPES.map((r) => r.id)
}

/** Fill defaults and validate; throws with the valid parameters when something is wrong. */
export function normalizeRecipeParams(recipe: string, params: Record<string, unknown> = {}): RecipeParams {
  const def = BY_ID.get(recipe)
  if (!def) throw new Error(`Unknown sample recipe "${recipe}". Recipes: ${recipeIds().join(', ')}.`)
  const out: RecipeParams = {}
  for (const spec of def.params) out[spec.key] = spec.default
  for (const [k, v] of Object.entries(params)) {
    const spec = def.params.find((x) => x.key === k)
    if (!spec) throw new Error(`Recipe "${recipe}" has no parameter "${k}". Parameters: ${def.params.map((x) => x.key).join(', ')}.`)
    if (spec.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Parameter "${k}" of "${recipe}" must be a number ${spec.min}..${spec.max}.`)
      if (v < spec.min! || v > spec.max!) throw new Error(`Parameter "${k}" of "${recipe}" must be ${spec.min}..${spec.max} (got ${v}).`)
      out[k] = v
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') throw new Error(`Parameter "${k}" of "${recipe}" must be true or false.`)
      out[k] = v
    } else {
      if (typeof v !== 'string' || !spec.options!.includes(v)) throw new Error(`Parameter "${k}" of "${recipe}" must be one of ${spec.options!.join(', ')}.`)
      out[k] = v
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Cache

const CACHE_LIMIT = 64
const cache = new Map<string, SampleResult>()

function remember(key: string, value: SampleResult): SampleResult {
  if (cache.size >= CACHE_LIMIT) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value)
  return value
}

export function clearSampleCache(): void {
  cache.clear()
  dpcmCache.clear()
}

function paramKey(p: RecipeParams): string {
  return Object.keys(p)
    .sort()
    .map((k) => `${k}=${String(p[k])}`)
    .join('&')
}

// ---------------------------------------------------------------------------------------------
// Pipelines

/** Raw PCM16 of a recipe (before any chip processing). */
export function generateRaw(recipe: string, params: Record<string, unknown> = {}): SampleResult {
  const p = normalizeRecipeParams(recipe, params)
  const key = `raw|${recipe}|${paramKey(p)}`
  const hit = cache.get(key)
  if (hit) return hit
  const raw = BY_ID.get(recipe)!.build(p)
  return remember(key, {
    pcm: toInt16(raw.data),
    sampleRate: Math.round(raw.rate),
    ...(raw.loopStart !== undefined ? { loopStart: raw.loopStart } : {}),
    baseNote: raw.baseNote
  })
}

export interface SnesProcessOptions {
  /** Resample to 32 kHz first (user PCM). Default false: generated samples keep their tuned native rate. */
  to32k?: boolean
}

/**
 * The SNES pipeline: optional resample to 32 kHz with a low-pass, loop alignment to 16 samples, then a real BRR
 * encode + decode round trip. The result is what the DSP plays.
 */
export function processForSnes(raw: SampleResult, opts: SnesProcessOptions = {}): SampleResult {
  let pcm = raw.pcm
  let rate = raw.sampleRate
  let loopStart = raw.loopStart
  if (opts.to32k && rate !== 32000) {
    const f = Float64Array.from(pcm, (v) => v / 32768)
    const r = resample(f, rate, 32000)
    if (loopStart !== undefined) loopStart = Math.round((loopStart * 32000) / rate)
    pcm = toInt16(r)
    rate = 32000
  }
  if (pcm.length < 16) {
    const padded = new Int16Array(16)
    padded.set(pcm)
    pcm = padded
  }
  if (loopStart !== undefined) {
    loopStart = Math.max(0, Math.min(pcm.length - 16, Math.floor(loopStart / 16) * 16))
    // the loop must hold whole blocks, otherwise padding silence would sit inside the loop
    const loopLen = Math.max(16, Math.floor((pcm.length - loopStart) / 16) * 16)
    pcm = pcm.subarray(0, loopStart + loopLen)
  }
  const enc = encodeBrr(pcm, loopStart !== undefined ? { loopStart } : {})
  return {
    pcm: enc.decoded,
    sampleRate: rate,
    ...(enc.loopStart !== undefined ? { loopStart: enc.loopStart } : {}),
    baseNote: raw.baseNote,
    brrBytes: enc.bytes.length
  }
}

/** A recipe through the SNES pipeline (cached): { pcm (decoded BRR), sampleRate, loopStart?, baseNote }. */
export function generateSample(recipe: string, params: Record<string, unknown> = {}): SampleResult {
  const p = normalizeRecipeParams(recipe, params)
  const key = `snes|${recipe}|${paramKey(p)}`
  const hit = cache.get(key)
  if (hit) return hit
  return remember(key, processForSnes(generateRaw(recipe, p)))
}

function userPcm(slot: SampleSlot & { source: { kind: 'pcm' } }): SampleResult {
  const bytes = base64ToBytes(slot.source.data)
  const len = bytes.length >> 1
  const pcm = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    const v = bytes[2 * i]! | (bytes[2 * i + 1]! << 8)
    pcm[i] = v > 32767 ? v - 65536 : v
  }
  return { pcm, sampleRate: slot.source.sampleRate, ...(slot.loopStart !== undefined ? { loopStart: slot.loopStart } : {}), baseNote: 60 }
}

/** Encode mono PCM16 samples as the base64 string of a `pcm` sample slot. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) {
    bytes[2 * i] = pcm[i]! & 255
    bytes[2 * i + 1] = (pcm[i]! >> 8) & 255
  }
  return bytesToBase64(bytes)
}

export type SampleTarget = 'snes' | 'raw'

/**
 * Resolve a song's sample slot. 'snes' (default): the BRR-processed sample the SPC700 plays; 'raw': PCM16 at the
 * sample's own rate (NES DPCM, Genesis DAC). Recipe slots use `slot.loopStart` when set, else the recipe's loop.
 * Returns undefined for an unknown id; throws for a broken recipe slot.
 */
export function resolveSampleSlot(song: { samples: readonly SampleSlot[] }, id: string, target: SampleTarget = 'snes'): SampleResult | undefined {
  const slot = song.samples.find((x) => x.id === id)
  if (!slot) return undefined
  return resolveSlot(slot, target)
}

export function resolveSlot(slot: SampleSlot, target: SampleTarget = 'snes'): SampleResult {
  if (slot.source.kind === 'recipe') {
    const p = normalizeRecipeParams(slot.source.recipe, slot.source.params)
    const base = target === 'snes' ? generateSample(slot.source.recipe, p) : generateRaw(slot.source.recipe, p)
    if (slot.loopStart === undefined || slot.loopStart === base.loopStart) return base
    const raw = generateRaw(slot.source.recipe, p)
    const key = `${target}|${slot.source.recipe}|${paramKey(p)}|loop=${slot.loopStart}`
    const hit = cache.get(key)
    if (hit) return hit
    const withLoop: SampleResult = { ...raw, loopStart: slot.loopStart }
    return remember(key, target === 'snes' ? processForSnes(withLoop) : withLoop)
  }
  const src = slot.source
  const key = `pcm|${target}|${slot.id}|${src.sampleRate}|${slot.loopStart ?? ''}|${src.data.length}|${src.data.slice(0, 32)}|${src.data.slice(-32)}`
  const hit = cache.get(key)
  if (hit) return hit
  const raw = userPcm(slot as SampleSlot & { source: { kind: 'pcm' } })
  return remember(key, target === 'snes' ? processForSnes(raw, { to32k: true }) : raw)
}

/** Like resolveSampleSlot but never throws (the audio path): undefined when the slot is missing or broken. */
export function tryResolveSampleSlot(song: { samples: readonly SampleSlot[] }, id: string, target: SampleTarget = 'snes'): SampleResult | undefined {
  try {
    return resolveSampleSlot(song, id, target)
  } catch {
    return undefined
  }
}

/** Length in samples of a slot after the SNES pipeline (used by the ARAM budget). Never throws (8192 when broken). */
export function peekSampleLength(slot: SampleSlot): number {
  return tryPeekSampleLength(slot) ?? 8192
}

/** Length in samples after the SNES pipeline, or undefined when the slot cannot be generated (unknown recipe, ...). */
export function tryPeekSampleLength(slot: SampleSlot): number | undefined {
  try {
    return resolveSlot(slot, 'snes').pcm.length
  } catch {
    return undefined
  }
}

/** BRR bytes of a slot: ceil(samples / 16) * 9. */
export function sampleByteSize(slot: SampleSlot): number {
  return brrByteSize(peekSampleLength(slot))
}

/** sample id -> length in PCM samples for every slot of the song (feeds validateSong's `sampleSizes`). */
export function sampleSizes(song: { samples: readonly SampleSlot[] }): Record<string, number> {
  const out: Record<string, number> = {}
  for (const slot of song.samples) out[slot.id] = peekSampleLength(slot)
  return out
}

// ---------------------------------------------------------------------------------------------
// NES DPCM

/** DPCM playback rates in CPU cycles per bit, index 0..15 (NTSC / PAL). */
export const DPCM_PERIODS_NTSC: readonly number[] = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54]
export const DPCM_PERIODS_PAL: readonly number[] = [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50]
const CPU_NTSC = 1789773
const CPU_PAL = 1662607

/** DPCM bit rates in Hz for the 16 rate indices. */
export function dpcmRates(region: 'ntsc' | 'pal' = 'ntsc'): number[] {
  const cpu = region === 'pal' ? CPU_PAL : CPU_NTSC
  return (region === 'pal' ? DPCM_PERIODS_PAL : DPCM_PERIODS_NTSC).map((p) => cpu / p)
}

export interface DpcmEncoded {
  /** 1-bit delta stream, LSB first, length = 16 * k + 1 bytes (like $4013). */
  bytes: Uint8Array
  /** Number of meaningful bits (bytes * 8). */
  bits: number
  /** Rate (Hz) the signal was resampled to before encoding. */
  rate: number
  /** The 7-bit counter value the stream starts from. */
  startLevel: number
}

export const DPCM_START_LEVEL = 48
/** Counter swing (levels) a full-scale sample maps to. */
const DPCM_SWING = 44

/** Encode PCM16 as 1-bit delta DPCM: the counter moves +-2 per bit around the start level (48). */
export function encodeDpcm(pcm: ArrayLike<number>, srcRate: number, targetRate: number): DpcmEncoded {
  const f = resample(Float64Array.from(pcm as ArrayLike<number>, (v) => v / 32768), srcRate, targetRate)
  const nBytes = Math.max(1, Math.ceil((f.length / 8 - 1) / 16)) * 16 + 1
  const bytes = new Uint8Array(nBytes)
  let level = DPCM_START_LEVEL
  const total = nBytes * 8
  for (let i = 0; i < total; i++) {
    const target = i < f.length ? DPCM_START_LEVEL + f[i]! * DPCM_SWING : DPCM_START_LEVEL
    const up = target > level
    if (up) {
      if (level <= 125) level += 2
      bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7))
    } else if (level >= 2) level -= 2
  }
  return { bytes, bits: total, rate: targetRate, startLevel: DPCM_START_LEVEL }
}

/** Decode a DPCM stream to the 7-bit counter value after each bit (what the DAC outputs). */
export function decodeDpcm(bytes: Uint8Array, startLevel = DPCM_START_LEVEL): Uint8Array {
  const out = new Uint8Array(bytes.length * 8)
  let level = startLevel
  for (let i = 0; i < out.length; i++) {
    if (bytes[i >> 3]! & (1 << (i & 7))) {
      if (level <= 125) level += 2
    } else if (level >= 2) level -= 2
    out[i] = level
  }
  return out
}

const dpcmCache = new Map<string, { levels: Uint8Array; rate: number }>()

/** Counter levels per bit for a slot encoded for the given playback rate (cached). Undefined when the slot is missing. */
export function prepareDpcm(song: { samples: readonly SampleSlot[] }, id: string, targetRate: number): { levels: Uint8Array; rate: number } | undefined {
  const raw = tryResolveSampleSlot(song, id, 'raw')
  if (!raw) return undefined
  const slot = song.samples.find((x) => x.id === id)!
  const key = `${id}|${targetRate}|${raw.pcm.length}|${raw.sampleRate}|${slot.source.kind === 'recipe' ? JSON.stringify(slot.source.params) + slot.source.recipe : slot.source.data.length}`
  const hit = dpcmCache.get(key)
  if (hit) return hit
  const enc = encodeDpcm(raw.pcm, raw.sampleRate, targetRate)
  const v = { levels: decodeDpcm(enc.bytes, enc.startLevel), rate: targetRate }
  if (dpcmCache.size >= CACHE_LIMIT) dpcmCache.delete(dpcmCache.keys().next().value!)
  dpcmCache.set(key, v)
  return v
}

// ---------------------------------------------------------------------------------------------
// Genesis DAC

/** The YM2612 DAC is 9 bits wide but drivers feed it 8-bit unsigned samples; this quantises PCM16 to signed 8-bit. */
export function dacQuantize(pcm: ArrayLike<number>): Int8Array {
  const out = new Int8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-128, Math.min(127, Math.round(pcm[i]! / 256)))
  return out
}
