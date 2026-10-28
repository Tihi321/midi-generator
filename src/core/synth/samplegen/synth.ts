// Synthwave sample generators for the PS1 SPU and the Dreamcast AICA (they run at 44.1 kHz, so these aim at 44.1 kHz).
// Everything is synthesised here (no sample files, no ROM samples) and seeded, so the same params give the same samples.
//
// Loops are built additively on a power-free grid: a loop of L samples holds a whole number of cycles for every partial,
// so the partials are integer "bins" of L and the loop is seamless. Detuned saws are quantised to bins (a partial h of a
// saw detuned by c cents sits at bin h*m + round(h*m*(2^(c/1200) - 1))), which is what makes a long loop shimmer without a
// click at the seam. Loop lengths and intros are multiples of 112 = lcm(16, 28): whole BRR and PS-X ADPCM blocks, so the
// sample targets neither trim nor resample the loops (which would detune them). A loop of 16k samples is 9 KB of SPU RAM.
//
// One-shots (plucks, FM tones, drums) are generated in the time domain: a polyBLEP saw through a decaying state-variable
// low-pass, 2-operator FM, and noise/sine drums. The gated snare bakes a small Freeverb-style tail and a hard gate.

import { clamp, midiToHz } from '../tables'
import { type RawSample, Rng, bandpass, cubic, highpass, normalize } from './generators'

const TAU = 2 * Math.PI

/** Loop and intro lengths are multiples of 112 = lcm(16, 28): whole BRR (16) and PS-X ADPCM (28) blocks. */
export const SYNTH_LOOP_UNIT = 112

const unit = (samples: number): number => Math.max(SYNTH_LOOP_UNIT, Math.round(samples / SYNTH_LOOP_UNIT) * SYNTH_LOOP_UNIT)
const up16 = (n: number): number => Math.ceil(n / 16) * 16
const mod = (a: number, n: number): number => ((a % n) + n) % n

// ---------------------------------------------------------------------------------------------
// Additive loops on an integer-bin grid

const sinTables = new Map<number, Float64Array>()

function sinTable(L: number): Float64Array {
  let t = sinTables.get(L)
  if (!t) {
    t = new Float64Array(L)
    for (let i = 0; i < L; i++) t[i] = Math.sin((TAU * i) / L)
    sinTables.set(L, t)
  }
  return t
}

/** out[n] += amp * sin(2 pi (bin * n + idx) / L) for n in 0..L-1 (bin and idx integers, via the sine table). */
function addPartial(out: Float64Array, tab: Float64Array, bin: number, amp: number, idx: number): void {
  const L = out.length
  let i = mod(idx, L)
  const step = mod(bin, L)
  for (let n = 0; n < L; n++) {
    out[n] = out[n]! + amp * tab[i]!
    i += step
    if (i >= L) i -= L
  }
}

export interface StackVoice {
  /** Detune in cents against the note. */
  cents: number
  level: number
  /** Frequency multiplier, a power of two (0.5 = a sub octave, 2 = an octave up). Default 1. */
  octave?: number
  /** Pulse duty 0..1; absent = a sawtooth. */
  duty?: number
}

export interface StackSpec {
  note: number
  /** Rate (Hz) the native rate is chosen near. */
  rate: number
  /** Loop length in samples, a multiple of 112. */
  loopLen: number
  voices: StackVoice[]
  /** Spectral shaping: amplitude factor of harmonic h whose frequency at the native rate is hz. */
  amp: (h: number, hz: number) => number
  seed: number
}

export interface Period {
  /** One loop (L samples, peak-normalised to 1). */
  data: Float64Array
  /** Native rate: the loop holds `m` cycles of the note. */
  rate: number
  m: number
}

/** A stack of band-limited saws / pulses, each detuned and with its own random phase. Exactly periodic in L. */
export function stackPeriod(spec: StackSpec): Period {
  const L = spec.loopLen
  const baseHz = midiToHz(spec.note)
  const octs = spec.voices.map((v) => v.octave ?? 1)
  const mult = Math.max(1, Math.round(1 / Math.min(...octs)))
  const m = mult * Math.max(1, Math.round((baseHz * L) / (spec.rate * mult)))
  const rate = (baseHz * L) / m
  const tab = sinTable(L)
  const rng = new Rng(spec.seed)
  const out = new Float64Array(L)
  for (const v of spec.voices) {
    const mv = Math.max(1, Math.round(m * (v.octave ?? 1)))
    const ratio = Math.pow(2, v.cents / 1200)
    const off = Math.floor((rng.next() * L) / mv)
    for (let h = 1; h <= 96; h++) {
      const bin = h * mv + Math.round(h * mv * (ratio - 1))
      if (bin > 0.46 * L) break
      const hz = (bin * rate) / L
      const base = v.duty === undefined ? 2 / (Math.PI * h) : (2 * Math.sin(Math.PI * h * v.duty)) / (Math.PI * h)
      const a = base * v.level * spec.amp(h, hz)
      if (Math.abs(a) < 1e-5) continue
      // a pulse is a cosine series shifted by half the duty; a saw is a sine series (both shifted by the random start offset)
      let idx = bin * off
      if (v.duty !== undefined) idx += Math.round(L * 0.25 - h * v.duty * L * 0.5)
      addPartial(out, tab, bin, a, idx)
    }
  }
  normalize(out, 1)
  return { data: out, rate, m }
}

/** Fractional-delay chorus baked into a periodic loop (LFO cycles are integers per loop, so it stays periodic). */
function bakeChorus(P: Float64Array, rate: number, taps: { delayMs: number; depthMs: number; cycles: number; phase: number; level: number }[]): Float64Array {
  const L = P.length
  const out = Float64Array.from(P)
  for (const t of taps) {
    for (let n = 0; n < L; n++) {
      const d = ((t.delayMs + t.depthMs * Math.sin(TAU * ((t.cycles * n) / L + t.phase))) * rate) / 1000
      const pos = n - d
      const i0 = Math.floor(pos)
      out[n] = out[n]! + t.level * cubic(P[mod(i0 - 1, L)]!, P[mod(i0, L)]!, P[mod(i0 + 1, L)]!, P[mod(i0 + 2, L)]!, pos - i0)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Filters in the time domain

/** Cytomic-style trapezoidal state-variable low-pass with a per-sample cutoff (Hz) and a fixed Q. */
function svfLow(x: Float64Array, rate: number, fcAt: (i: number) => number, q: number): Float64Array {
  const out = new Float64Array(x.length)
  const k = 1 / q
  let ic1 = 0
  let ic2 = 0
  for (let i = 0; i < x.length; i++) {
    const g = Math.tan((Math.PI * clamp(fcAt(i), 20, rate * 0.45)) / rate)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = x[i]! - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    out[i] = v2
  }
  return out
}

/** Gain of two cascaded 2-pole low-passes (24 dB/oct) at hz, for the additive (static) filters of the bass loops. */
function lp24(hz: number, fc: number, q: number): number {
  const x = hz / fc
  const h = 1 / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2)
  return h * h
}

interface IntroSpec {
  /** Filter cutoff (Hz) at the start and at the end of the intro (exponential sweep). */
  fc0: number
  fc1: number
  q: number
  /** Amplitude at the start (0..1) and the curve exponent of the rise to 1. */
  ampStart: number
  ampCurve: number
}

/**
 * The non-looped intro of a loop: the periodic `src` (read backwards from the loop start by wrapping) through a sweeping
 * low-pass, cross-faded into the periodic `target` (the steady loop) so the last intro sample meets the loop start exactly.
 */
function introBlend(src: Float64Array, target: Float64Array, I: number, rate: number, o: IntroSpec): Float64Array {
  const L = src.length
  const x = new Float64Array(I)
  for (let i = 0; i < I; i++) x[i] = src[mod(i - I, L)]!
  const f = svfLow(x, rate, (i) => o.fc0 * Math.pow(o.fc1 / o.fc0, (i + 1) / I), o.q)
  const out = new Float64Array(I)
  for (let i = 0; i < I; i++) {
    const u = (i + 1) / I
    const w = u * u * (3 - 2 * u)
    const amp = o.ampStart + (1 - o.ampStart) * Math.pow(u, o.ampCurve)
    out[i] = amp * (f[i]! * (1 - w) + target[mod(i - I, L)]! * w)
  }
  return out
}

function joinIntro(intro: Float64Array, loop: Float64Array, rate: number, note: number, peak = 0.85): RawSample {
  const data = new Float64Array(intro.length + loop.length)
  data.set(intro, 0)
  data.set(loop, intro.length)
  normalize(data, peak)
  return { data, rate, loopStart: intro.length, baseNote: note }
}

// ---------------------------------------------------------------------------------------------
// Pads and leads

export interface SuperSawSpec {
  note: number
  rate: number
  voices: number
  detune: number
  bright: number
  seed: number
}

/** Supersaw: N detuned saws (the centre one louder), a 16k-sample loop with no intro. */
export function superSaw(o: SuperSawSpec): RawSample {
  const N = Math.max(3, Math.min(9, Math.round(o.voices)))
  const voices: StackVoice[] = []
  for (let i = 0; i < N; i++) {
    const x = (i - (N - 1) / 2) / ((N - 1) / 2)
    voices.push({ cents: o.detune * x, level: i === (N - 1) / 2 ? 1 : 0.75 })
  }
  const fc = 1500 + o.bright * 9000
  const p = stackPeriod({ note: o.note, rate: o.rate, loopLen: unit(16352), voices, amp: (_h, hz) => 1 / (1 + (hz / fc) ** 2), seed: o.seed })
  normalize(p.data, 0.85)
  return { data: p.data, rate: p.rate, loopStart: 0, baseNote: o.note }
}

export interface SawLeadSpec {
  note: number
  rate: number
  detune: number
  octave: number
  bright: number
  seed: number
}

/** Detuned saw lead: two saws (+- detune/2 cents), an optional saw an octave up, a short loop. */
export function sawLead(o: SawLeadSpec): RawSample {
  const voices: StackVoice[] = [
    { cents: -o.detune / 2, level: 1 },
    { cents: o.detune / 2, level: 1 }
  ]
  if (o.octave > 0) voices.push({ cents: 0, level: o.octave, octave: 2 })
  const fc = 2500 + o.bright * 10000
  const p = stackPeriod({ note: o.note, rate: o.rate, loopLen: unit(8064), voices, amp: (_h, hz) => 1 / (1 + (hz / fc) ** 2), seed: o.seed })
  normalize(p.data, 0.85)
  return { data: p.data, rate: p.rate, loopStart: 0, baseNote: o.note }
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

export interface SyncSawSpec {
  note: number
  rate: number
  ratio: number
  sweep: number
  seed: number
}

/**
 * Hard-sync saw: a slave saw at `ratio` times the note restarts with every cycle of the master. The ratio swings by
 * `sweep` once per loop (a sine whose start phase comes from the seed), so the sync "tear" moves. Time domain with polyBLEP on the slave wraps and the master reset.
 */
export function syncSaw(o: SyncSawSpec): RawSample {
  const L = unit(12096)
  const baseHz = midiToHz(o.note)
  const m = Math.max(1, Math.round((baseHz * L) / o.rate))
  const rate = (baseHz * L) / m
  const dtm = m / L
  const out = new Float64Array(L)
  const sweepPhase = new Rng(o.seed).next() * TAU
  for (let n = 0; n < L; n++) {
    const pm = ((n * m) % L) / L
    const r = Math.max(1.05, o.ratio + o.sweep * Math.sin((TAU * n) / L + sweepPhase))
    const ps = pm * r
    const fs = ps - Math.floor(ps)
    let y = 2 * fs - 1 - polyBlep(fs, r * dtm)
    // at the master reset the slave jumps from 2*frac(r)-1 back to -1
    y -= (r - Math.floor(r)) * polyBlep(pm, dtm)
    out[n] = y
  }
  let mean = 0
  for (let n = 0; n < L; n++) mean += out[n]!
  mean /= L
  for (let n = 0; n < L; n++) out[n] = out[n]! - mean
  // a gentle high-cut keeps the sync's top end from turning into hiss when the sample is pitched up
  const low = svfLow(Float64Array.from([...out, ...out, ...out]), rate, () => 9000, 0.6)
  const mid = low.subarray(L, 2 * L)
  const data = Float64Array.from(mid)
  normalize(data, 0.85)
  return { data, rate, loopStart: 0, baseNote: o.note }
}

export interface JunoPadSpec {
  note: number
  rate: number
  chorus: number
  bright: number
  bloom: number
  seed: number
}

/** Juno-style pad: four stacked pulse widths with small detunes, a baked two-tap chorus and a slow filter/amplitude bloom intro. */
export function junoPad(o: JunoPadSpec): RawSample {
  const L = unit(16352)
  const fc = 1200 + o.bright * 7000
  const voices: StackVoice[] = [
    { cents: -9, level: 1, duty: 0.5 },
    { cents: -3, level: 0.9, duty: 0.36 },
    { cents: 4, level: 0.9, duty: 0.27 },
    { cents: 10, level: 1, duty: 0.44 }
  ]
  const p = stackPeriod({ note: o.note, rate: o.rate, loopLen: L, voices, amp: (_h, hz) => 1 / (1 + (hz / fc) ** 2), seed: o.seed })
  let loop = p.data
  if (o.chorus > 0) {
    loop = bakeChorus(loop, p.rate, [
      { delayMs: 9, depthMs: 0.35, cycles: 1, phase: 0, level: 0.7 * o.chorus },
      { delayMs: 14, depthMs: 0.3, cycles: 1, phase: 0.5, level: 0.7 * o.chorus }
    ])
  }
  const I = unit(o.bloom * p.rate)
  const intro = introBlend(loop, loop, I, p.rate, { fc0: 260, fc1: 12000, q: 0.8, ampStart: 0, ampCurve: 1.6 })
  return joinIntro(intro, loop, p.rate, o.note)
}

// ---------------------------------------------------------------------------------------------
// Basses

export interface AnalogBassSpec {
  note: number
  rate: number
  cutoff: number
  res: number
  saw: number
  sub: number
  /** Octave of the sub square against the note: -1 (default) is an octave below, 0 is at the note's pitch. */
  subOct: number
  pluck: boolean
  seed: number
}

/** Analog bass: a saw plus a square (an octave down by default) through a 24 dB low-pass (static in the loop), optionally with a filter-pluck intro. */
export function analogBass(o: AnalogBassSpec): RawSample {
  const L = unit(4032)
  const q = 0.7 + o.res * 4
  const voices: StackVoice[] = []
  if (o.saw > 0) voices.push({ cents: 0, level: o.saw })
  if (o.sub > 0) voices.push({ cents: 0, level: o.sub, octave: o.subOct < 0 ? 0.5 : 1, duty: 0.5 })
  if (voices.length === 0) voices.push({ cents: 0, level: 1 })
  const raw = stackPeriod({ note: o.note, rate: o.rate, loopLen: L, voices, amp: () => 1, seed: o.seed })
  const filt = stackPeriod({ note: o.note, rate: o.rate, loopLen: L, voices, amp: (_h, hz) => lp24(hz, o.cutoff, q), seed: o.seed })
  // the loop is the statically filtered stack; the pluck intro sweeps a low-pass over the raw stack and settles into it
  let loop = filt.data
  if (o.pluck) {
    const I = unit(0.14 * raw.rate)
    const intro = introBlend(raw.data, loop, I, raw.rate, { fc0: Math.max(3500, o.cutoff * 7), fc1: o.cutoff * 1.05, q, ampStart: 1, ampCurve: 1 })
    return joinIntro(intro, loop, raw.rate, o.note)
  }
  loop = Float64Array.from(loop)
  normalize(loop, 0.85)
  return { data: loop, rate: raw.rate, loopStart: 0, baseNote: o.note }
}

export interface FmBassSpec {
  note: number
  rate: number
  index: number
  sustain: number
  ratio: number
  seed: number
}

/** 2-operator FM bass: the modulation index snaps down from `index` to `sustain` over the intro, then the loop holds it. */
export function fmBass(o: FmBassSpec): RawSample {
  const L = unit(4032)
  const baseHz = midiToHz(o.note)
  const m = Math.max(1, Math.round((baseHz * L) / o.rate))
  const rate = (baseHz * L) / m
  const ratio = Math.max(1, Math.round(o.ratio))
  const I = unit(0.12 * rate)
  const data = new Float64Array(I + L)
  const rng = new Rng(o.seed)
  for (let j = 0; j < I + L; j++) {
    const n = j - I
    const u = j < I ? j / I : 1
    const idx = o.sustain + (o.index - o.sustain) * Math.pow(1 - u, 2.5)
    const c = mod(m * n, L) / L
    const mc = mod(ratio * m * n, L) / L
    data[j] = Math.sin(TAU * c + idx * Math.sin(TAU * mc))
  }
  const nb = Math.round(rate * 0.004)
  for (let i = 0; i < nb; i++) data[i] = data[i]! + rng.noise() * 0.25 * (1 - i / nb)
  normalize(data, 0.85)
  return { data, rate, loopStart: I, baseNote: o.note }
}

// ---------------------------------------------------------------------------------------------
// Pluck, brass

export interface SynthPluckSpec {
  note: number
  rate: number
  seconds: number
  cutoff: number
  decay: number
  detune: number
  seed: number
}

/** Band-limited (polyBLEP) saw added into `out`; `hz` constant, random start phase. */
function addBlepSaw(out: Float64Array, hz: number, rate: number, phase0: number, level: number): void {
  const dt = hz / rate
  let ph = phase0
  for (let n = 0; n < out.length; n++) {
    out[n] = out[n]! + level * (2 * ph - 1 - polyBlep(ph, dt))
    ph += dt
    if (ph >= 1) ph -= 1
  }
}

/** Arp pluck: two detuned polyBLEP saws through a resonant low-pass whose cutoff falls with `decay`, an exponential amplitude decay. */
export function synthPluck(o: SynthPluckSpec): RawSample {
  const N = up16(Math.round(o.seconds * o.rate))
  const f0 = midiToHz(o.note)
  const rng = new Rng(o.seed)
  const src = new Float64Array(N)
  addBlepSaw(src, f0 * Math.pow(2, -o.detune / 2400), o.rate, rng.next(), 1)
  addBlepSaw(src, f0 * Math.pow(2, o.detune / 2400), o.rate, rng.next(), 1)
  const fcEnd = Math.max(200, Math.min(o.cutoff * 0.12, 900))
  const y = svfLow(src, o.rate, (i) => fcEnd + (o.cutoff - fcEnd) * Math.exp(-i / (o.rate * o.decay)), 2.2)
  const tau = o.seconds * 0.38
  for (let n = 0; n < N; n++) y[n] = y[n]! * Math.exp(-n / (o.rate * tau)) * (1 - Math.exp(-n / (o.rate * 0.0008)))
  fade(y, 96)
  normalize(y, 0.88)
  return { data: y, rate: o.rate, baseNote: o.note }
}

export interface SynthBrassSpec {
  note: number
  rate: number
  bright: number
  swell: number
  detune: number
  seed: number
}

/** Synth brass: three detuned saws with a baked filter swell (low-pass opening over `swell` seconds) and then a loop. */
export function synthBrass(o: SynthBrassSpec): RawSample {
  const L = unit(8064)
  const fc = 2200 + o.bright * 9000
  const voices: StackVoice[] = [
    { cents: -o.detune, level: 0.8 },
    { cents: 0, level: 1 },
    { cents: o.detune, level: 0.8 }
  ]
  const p = stackPeriod({ note: o.note, rate: o.rate, loopLen: L, voices, amp: (_h, hz) => 1 / (1 + (hz / fc) ** 2), seed: o.seed })
  const I = unit(o.swell * p.rate)
  const intro = introBlend(p.data, p.data, I, p.rate, { fc0: 220, fc1: fc * 1.4, q: 1.4, ampStart: 0.35, ampCurve: 0.7 })
  return joinIntro(intro, p.data, p.rate, o.note)
}

// ---------------------------------------------------------------------------------------------
// One-shots: drums, FM

function fade(buf: Float64Array, n: number): void {
  const f = Math.min(buf.length >> 2, n)
  for (let i = 0; i < f; i++) buf[buf.length - f + i] = buf[buf.length - f + i]! * (1 - (i + 1) / f)
}

/** Pad to a multiple of 16, fade the tail, normalise: the shape of every drum one-shot. */
function shot(buf: Float64Array, rate: number, note = 60, peak = 0.9, tailFade = 96): RawSample {
  const padded = new Float64Array(up16(buf.length))
  padded.set(buf)
  fade(padded, tailFade)
  normalize(padded, peak)
  return { data: padded, rate, baseNote: note }
}

const softClip = (x: number, drive: number): number => Math.tanh(x * drive) / Math.tanh(drive)

export interface LinnKickSpec {
  rate: number
  seconds: number
  startHz: number
  endHz: number
  click: number
  seed: number
}

/** LinnDrum-style kick: a fast pitch drop on a sine, a punchy decay, a noise click and a little saturation. */
export function linnKick(o: LinnKickSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  let ph = 0
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    ph += (TAU * (o.endHz + (o.startHz - o.endHz) * Math.exp(-t / 0.02))) / o.rate
    out[n] = Math.sin(ph) * Math.exp(-t / (o.seconds * 0.3)) * (1 - Math.exp(-t / 0.0004))
  }
  const nc = Math.min(N, Math.round(o.rate * 0.003))
  const click = new Float64Array(nc)
  for (let i = 0; i < nc; i++) click[i] = rng.noise() * (1 - i / nc)
  for (let i = 0; i < nc; i++) out[i] = out[i]! + click[i]! * o.click
  for (let n = 0; n < N; n++) out[n] = softClip(out[n]!, 1.6)
  return shot(out, o.rate)
}

export interface Kick808Spec {
  rate: number
  seconds: number
  decay: number
  hz: number
  seed: number
}

/** 808-style kick: a long sine boom (exponential decay `decay` seconds to -20 dB), a quick drop from ~2.6x, soft-clipped. */
export function kick808(o: Kick808Spec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  let ph = 0
  const tau = o.decay / 2.3
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    ph += (TAU * (o.hz + o.hz * 1.6 * Math.exp(-t / 0.028))) / o.rate
    out[n] = Math.sin(ph) * Math.exp(-t / tau) * (1 - Math.exp(-t / 0.0008))
  }
  const nc = Math.min(N, Math.round(o.rate * 0.002))
  for (let i = 0; i < nc; i++) out[i] = out[i]! + rng.noise() * 0.12 * (1 - i / nc)
  for (let n = 0; n < N; n++) out[n] = softClip(out[n]!, 1.9)
  return shot(out, o.rate, 60, 0.9, 256)
}

function snareCore(rate: number, N: number, toneHz: number, noiseAmt: number, noiseTau: number, seed: number): Float64Array {
  const rng = new Rng(seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 1300, rate, 2)
  const out = new Float64Array(N)
  let ph = 0
  for (let n = 0; n < N; n++) {
    const t = n / rate
    ph += (TAU * toneHz * (1 + 0.4 * Math.exp(-t / 0.011))) / rate
    const tone = Math.sin(ph) * Math.exp(-t / 0.05) * 0.75
    const nz = noise[n]! * noiseAmt * Math.exp(-t / noiseTau) * (1 - Math.exp(-t / 0.0004))
    out[n] = tone + nz * 1.1
  }
  return out
}

export interface LinnSnareSpec {
  rate: number
  seconds: number
  toneHz: number
  noise: number
  seed: number
}

/** LinnDrum-style snare: a pitched tone plus bright noise (high-passed), driven into a soft clip. */
export function linnSnare(o: LinnSnareSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const out = snareCore(o.rate, N, o.toneHz, o.noise, o.seconds * 0.3, o.seed)
  for (let n = 0; n < N; n++) out[n] = softClip(out[n]!, 1.4)
  return shot(out, o.rate)
}

/** A Freeverb-style tail (six damped combs and two all-passes) with an RT60 of `rt60` seconds; returns the wet signal. */
function reverbTail(x: Float64Array, rate: number, rt60: number, damp: number): Float64Array {
  const scale = rate / 44100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => Math.max(8, Math.round(d * scale)))
  const aps = [556, 441].map((d) => Math.max(4, Math.round(d * scale)))
  const wet = new Float64Array(x.length)
  for (const d of combs) {
    const g = Math.pow(10, (-3 * d) / (rate * rt60))
    const buf = new Float64Array(d)
    let p = 0
    let lp = 0
    for (let n = 0; n < x.length; n++) {
      const y = buf[p]!
      lp = y * (1 - damp) + lp * damp
      buf[p] = x[n]! + lp * g
      wet[n] = wet[n]! + y
      if (++p >= d) p = 0
    }
  }
  for (const d of aps) {
    const buf = new Float64Array(d)
    let p = 0
    for (let n = 0; n < x.length; n++) {
      const b = buf[p]!
      const v = wet[n]!
      buf[p] = v + b * 0.5
      wet[n] = b - v
      if (++p >= d) p = 0
    }
  }
  for (let n = 0; n < x.length; n++) wet[n] = wet[n]! / combs.length
  return wet
}

export interface GatedSnareSpec {
  rate: number
  gate: number
  reverb: number
  toneHz: number
  seed: number
}

/**
 * Gated-reverb snare: a snare through a dense baked reverb, then a hard gate at `gate` seconds (the last 3 ms fade to zero),
 * so the tail stops dead like the 80s drum sound. The sample is exactly `gate` seconds long (padded to blocks with zeros).
 */
export function gatedSnare(o: GatedSnareSpec): RawSample {
  const N = Math.round(o.rate * o.gate)
  const dry = snareCore(o.rate, N, o.toneHz, 1, 0.14, o.seed)
  const wet = reverbTail(dry, o.rate, 0.75, 0.25)
  const out = new Float64Array(up16(N))
  for (let n = 0; n < N; n++) out[n] = dry[n]! * 0.7 + wet[n]! * 1.1 * o.reverb
  const f = Math.max(8, Math.round(o.rate * 0.003))
  for (let i = 0; i < f; i++) out[N - f + i] = out[N - f + i]! * ((f - 1 - i) / f)
  for (let n = 0; n < N; n++) out[n] = softClip(out[n]!, 1.3)
  normalize(out, 0.9)
  return { data: out, rate: o.rate, baseNote: 60 }
}

export interface LinnClapSpec {
  rate: number
  seconds: number
  seed: number
}

/** LinnDrum-style clap: three tight band-passed noise bursts and a short tail with a touch of room. */
export function linnClap(o: LinnClapSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 500, o.rate, 1)
  bandpass(noise, 1500, 0.9, o.rate)
  const bursts = [0, 0.011, 0.023, 0.036]
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    let e = 0
    for (let b = 0; b < bursts.length; b++) {
      const dt = t - bursts[b]!
      if (dt < 0) continue
      e += b === bursts.length - 1 ? Math.exp(-dt / (o.seconds * 0.22)) : Math.exp(-dt / 0.0028) * 0.9
    }
    out[n] = noise[n]! * e
  }
  const wet = reverbTail(out, o.rate, 0.3, 0.4)
  for (let n = 0; n < N; n++) out[n] = out[n]! + wet[n]! * 0.9
  return shot(out, o.rate)
}

const HAT_PARTIALS = [5113, 6711, 7893, 9371, 10412]

export interface LinnHatSpec {
  rate: number
  seconds: number
  open: boolean
  seed: number
}

/** LinnDrum-style hi-hat: high-passed noise plus a few inharmonic sines; closed is a tick, open rings and then chokes. */
export function linnHat(o: LinnHatSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 7000, o.rate, 2)
  const tau = o.seconds * (o.open ? 0.3 : 0.2)
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    let m = 0
    for (const f of HAT_PARTIALS) if (f < o.rate * 0.47) m += Math.sin(TAU * f * t)
    out[n] = (noise[n]! * 0.85 + m * 0.07) * Math.exp(-t / tau) * (1 - Math.exp(-t / 0.0003))
  }
  return shot(out, o.rate, 60, 0.8)
}

export interface LinnTomSpec {
  rate: number
  seconds: number
  hz: number
  seed: number
}

/** LinnDrum-style tom: a pitched sine with a downward sweep plus a quieter overtone and a click. Base note C-4. */
export function linnTom(o: LinnTomSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  let ph = 0
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    ph += (TAU * o.hz * (1 + 0.55 * Math.exp(-t / 0.035))) / o.rate
    out[n] = (Math.sin(ph) + 0.25 * Math.sin(2.1 * ph)) * Math.exp(-t / (o.seconds * 0.3))
  }
  const nc = Math.min(N, Math.round(o.rate * 0.003))
  for (let i = 0; i < nc; i++) out[i] = out[i]! + rng.noise() * 0.3 * (1 - i / nc)
  for (let n = 0; n < N; n++) out[n] = softClip(out[n]!, 1.3)
  return shot(out, o.rate)
}

const CRASH_PARTIALS = [2381, 3217, 4106, 5230, 6577, 7421, 8892]

export interface LinnCrashSpec {
  rate: number
  seconds: number
  seed: number
}

/** Crash cymbal: high-passed noise and inharmonic partials under a slow exponential decay. */
export function linnCrash(o: LinnCrashSpec): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 3000, o.rate, 2)
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    let m = 0
    for (let k = 0; k < CRASH_PARTIALS.length; k++) {
      const f = CRASH_PARTIALS[k]!
      if (f < o.rate * 0.47) m += Math.sin(TAU * f * t) * Math.exp(-t / (o.seconds * (0.18 + 0.05 * k)))
    }
    out[n] = (noise[n]! * 0.8 + m * 0.1) * (1 - Math.exp(-t / 0.003)) * Math.exp(-t / (o.seconds * 0.3))
  }
  return shot(out, o.rate, 60, 0.85, 512)
}

export interface DxToneSpec {
  note: number
  rate: number
  seconds: number
  seed: number
}

/** DX-style e-piano: a 1:1 FM body with a bright 14:1 tine on the attack and a slow decay. */
export function dxEpiano(o: DxToneSpec & { tine: number }): RawSample {
  const N = up16(Math.round(o.seconds * o.rate))
  const f0 = midiToHz(o.note)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    const idx = 1.6 * Math.exp(-t / 0.35) + 0.35
    let s = Math.exp(-t / (o.seconds * 0.4)) * Math.sin(TAU * f0 * t + idx * Math.sin(TAU * f0 * t))
    // the tine: a short 14:1 burst
    s += o.tine * 0.5 * Math.exp(-t / 0.03) * Math.sin(TAU * f0 * 14 * t + 0.8 * Math.sin(TAU * f0 * 14 * 1.41 * t))
    out[n] = s
  }
  const nb = Math.min(N, Math.round(o.rate * 0.004))
  for (let i = 0; i < nb; i++) out[i] = out[i]! + rng.noise() * 0.06 * (1 - i / nb)
  fade(out, 160)
  normalize(out, 0.85)
  return { data: out, rate: o.rate, baseNote: o.note }
}

/** DX-style bell: inharmonic 3.5:1 FM with a long decaying index and a high strike partial. */
export function dxBell(o: DxToneSpec): RawSample {
  const N = up16(Math.round(o.seconds * o.rate))
  const f0 = midiToHz(o.note)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    const idx = 3.2 * Math.exp(-t / 0.45)
    let s = Math.exp(-t / (o.seconds * 0.38)) * Math.sin(TAU * f0 * t + idx * Math.sin(TAU * f0 * 3.5 * t))
    s += 0.3 * Math.exp(-t / 0.12) * Math.sin(TAU * f0 * 5.4 * t + 1.2 * Math.sin(TAU * f0 * 7.6 * t))
    out[n] = s
  }
  const nb = Math.min(N, Math.round(o.rate * 0.003))
  for (let i = 0; i < nb; i++) out[i] = out[i]! + rng.noise() * 0.12 * (1 - i / nb)
  fade(out, 160)
  normalize(out, 0.85)
  return { data: out, rate: o.rate, baseNote: o.note }
}
