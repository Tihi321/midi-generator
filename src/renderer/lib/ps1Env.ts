// The PS1 SPU envelope for the editor: the ADSR rules of psx-spx (15-bit level, shift/step rate formula, linear or
// exponential modes, exponential rates slowed above 0x6000), run as events at the 44.1 kHz SPU rate, plus readable
// times and the SPU reverb preset names for the transport. Pure.

import { type Ps1ReverbPreset, type PsxAdsr, type Song, spuRamUsage } from '../../core'

const RATE = 44100
const MAX_LEVEL = 0x7fff
/** Exponential increase is 4x slower above this level. */
const EXP_KNEE = 0x6000

export interface EnvCurveOptions {
  /** Seconds the key is held before the release (default 1). */
  holdSec?: number
  /** Seconds shown after the key-off (default 0.4). */
  releaseSec?: number
  /** Number of points returned (default 160). */
  points?: number
}

type Phase = 'attack' | 'decay' | 'sustain' | 'release'

/** Sustain level register 0..15 as a 15-bit level ((n + 1) * 0x800, psx-spx). */
export function psxSustainLevel(adsr: PsxAdsr): number {
  return Math.min(MAX_LEVEL, (adsr.sustainLevel + 1) * 0x800)
}

interface Rate {
  /** Samples between two envelope steps. */
  cycles: number
  /** Level change per step (before the exponential scaling). */
  delta: number
}

/** The psx-spx rate formula: cycles = 1 << max(0, shift - 11), step = stepValue << max(0, 11 - shift). */
function rateOf(shift: number, stepValue: number, exp: boolean, increase: boolean, level: number): Rate {
  let cycles = 2 ** Math.max(0, shift - 11)
  let delta = stepValue * 2 ** Math.max(0, 11 - shift)
  if (exp) {
    if (increase) {
      if (level > EXP_KNEE) cycles *= 4
    } else {
      // exponential decrease: the step scales with the level (arithmetic shift, so it always moves at least 1)
      delta = Math.floor((delta * level) / 0x8000)
    }
  }
  return { cycles, delta }
}

function phaseRate(a: PsxAdsr, phase: Phase, level: number): Rate {
  switch (phase) {
    case 'attack':
      return rateOf(a.attack >> 2, 7 - (a.attack & 3), a.attackExp, true, level)
    case 'decay':
      return rateOf(a.decay, -8, true, false, level)
    case 'sustain': {
      const inc = a.sustainDir === 'inc'
      return rateOf(a.sustainRate >> 2, inc ? 7 - (a.sustainRate & 3) : -8 + (a.sustainRate & 3), a.sustainExp, inc, level)
    }
    default:
      return rateOf(a.release, -8, a.releaseExp, false, level)
  }
}

interface Point {
  /** Time in samples. */
  t: number
  level: number
}

interface Start {
  phase: Phase
  level: number
}

/**
 * Event list of one note: the level at each envelope step from `start` until `maxSamples`; the key goes up at
 * `holdSamples` (switching to the release). The list ends when the level reaches 0 in the release.
 */
function run(a: PsxAdsr, start: Start, holdSamples: number, maxSamples: number): Point[] {
  const pts: Point[] = [{ t: 0, level: start.level }]
  let t = 0
  let level = start.level
  let phase = start.phase
  const sustainAt = psxSustainLevel(a)
  // a frozen level (zero step) would never end: the sample count is the stop
  for (let guard = 0; guard < 400000 && t < maxSamples; guard++) {
    const r = phaseRate(a, phase, level)
    const next = t + r.cycles
    if (phase !== 'release' && next > holdSamples) {
      t = holdSamples
      phase = 'release'
      pts.push({ t, level })
      continue
    }
    t = next
    if (r.delta === 0) continue
    level = Math.max(0, Math.min(MAX_LEVEL, level + r.delta))
    pts.push({ t, level })
    if (phase === 'attack' && level >= MAX_LEVEL) phase = 'decay'
    if (phase === 'decay' && level <= sustainAt) phase = 'sustain'
    if (phase === 'release' && level <= 0) break
  }
  return pts
}

/** First time (samples) the level passes `done`; Infinity when it never does within the run. */
function firstTime(pts: Point[], done: (level: number) => boolean): number {
  for (const p of pts) if (done(p.level)) return p.t
  return Infinity
}

const LONG = 3600 * RATE

export interface PsxEnvTimes {
  /** Silence to full level, seconds. */
  attackSec: number
  /** Full level down to the sustain level, seconds (0 when the sustain level is full). */
  decaySec: number
  /** Full level to silence after the key-off, seconds. */
  releaseSec: number
}

/** Readable times of an ADSR (Infinity = never within an hour). */
export function psxAdsrTimes(adsr: PsxAdsr): PsxEnvTimes {
  const up = run(adsr, { phase: 'attack', level: 0 }, LONG, LONG)
  const attack = firstTime(up, (l) => l >= MAX_LEVEL)
  const down = run(adsr, { phase: 'decay', level: MAX_LEVEL }, LONG, LONG)
  const sustainAt = psxSustainLevel(adsr)
  const decay = sustainAt >= MAX_LEVEL ? 0 : firstTime(down, (l) => l <= sustainAt)
  const rel = run(adsr, { phase: 'release', level: MAX_LEVEL }, 0, LONG)
  const release = firstTime(rel, (l) => l <= 0)
  return { attackSec: attack / RATE, decaySec: decay / RATE, releaseSec: release / RATE }
}

/** Seconds for the attack to reach full level (the editor's readout). */
export function psxAttackSecondsOf(adsr: PsxAdsr): number {
  return psxAdsrTimes(adsr).attackSec
}

/** Envelope level 0..1 sampled over hold + release. */
export function psxEnvelopeCurve(adsr: PsxAdsr, opts: EnvCurveOptions = {}): number[] {
  const hold = Math.round((opts.holdSec ?? 1) * RATE)
  const total = hold + Math.round((opts.releaseSec ?? 0.4) * RATE)
  const points = Math.max(2, opts.points ?? 160)
  const pts = run(adsr, { phase: 'attack', level: 0 }, hold, total)
  const out: number[] = []
  let i = 0
  let level = 0
  for (let k = 0; k < points; k++) {
    const t = (k / (points - 1)) * total
    while (i < pts.length && pts[i]!.t <= t) level = pts[i++]!.level
    out.push(level / MAX_LEVEL)
  }
  return out
}

/** "3 ms", "0.42 s", "12 s", "never" (a stopped or longer-than-a-minute envelope shows as "> 60 s"). */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return 'never'
  if (sec > 60) return '> 60 s'
  if (sec < 0.0005) return '< 1 ms'
  if (sec < 0.1) return `${(sec * 1000).toFixed(sec < 0.01 ? 1 : 0)} ms`
  return `${sec.toFixed(sec < 10 ? 2 : 1)} s`
}

/** PS1 reverb presets for the transport: label and a short description (psx-spx register sets). */
export const PS1_REVERB_LABELS: Record<Ps1ReverbPreset, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'No reverb (the voices still send, the bus stays silent)' },
  room: { label: 'Room', hint: 'Small room, short tail' },
  'studio-small': { label: 'Studio small', hint: 'Small studio, tight tail' },
  'studio-medium': { label: 'Studio medium', hint: 'Medium studio' },
  'studio-large': { label: 'Studio large', hint: 'Large studio, the default: a long, smooth tail' },
  hall: { label: 'Hall', hint: 'Concert hall, long and wide' },
  'half-echo': { label: 'Half echo', hint: 'Half echo: a single slow repeat with some reverb' },
  'space-echo': { label: 'Space echo', hint: 'Long metallic repeats' },
  echo: { label: 'Echo', hint: 'Clear repeats (uses most of the reverb work area)' },
  delay: { label: 'Delay', hint: 'Pure delay line (uses most of the reverb work area)' }
}

// ---------------------------------------------------------------- RAM meter

/** What the transport's RAM meters show: bytes used against the chip's sound RAM. */
export interface RamMeter {
  usedBytes: number
  totalBytes: number
  /** Samples the instruments play. */
  sampleBytes: number
  /** Effect work area (PS1 reverb, Dreamcast DSP buffer) plus reserved bytes. */
  effectBytes: number
}

/** SPU RAM usage for the transport: samples + reverb work area + reserved bytes against 512 KB (core `spuRamUsage`). */
export function ps1RamMeter(song: Song): RamMeter {
  const u = spuRamUsage(song)
  return { usedBytes: u.total, totalBytes: u.budget, sampleBytes: u.sampleBytes, effectBytes: u.reverbBytes + u.reservedBytes }
}
