// Seeded sample generators for the SNES sample bank (and the DPCM / DAC sample channels).
// Nintendo samples can't be shipped, so every sound is synthesised here: additive single/multi-cycle loops,
// Karplus-Strong plucks, a tiny 2-operator FM voice (bells, e-piano) and drum recipes. All randomness comes
// from a seeded PRNG, so the same recipe + params always give the same samples.
// A generator returns floating point audio (`RawSample`); the bank turns it into PCM16 and runs the BRR round trip.

import { clamp, midiToHz } from '../tables'

export interface RawSample {
  data: Float64Array
  /** Native sample rate in Hz (looped tonal samples are tuned by choosing this rate). */
  rate: number
  /** Loop start in samples (a multiple of 16 for looped samples), absent = one-shot. */
  loopStart?: number
  /** MIDI note at which the sample sounds at its native rate. */
  baseNote: number
}

// ---------------------------------------------------------------------------------------------
// PRNG

/** mulberry32: small, fast, deterministic. */
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** Uniform in [-1, 1). */
  noise(): number {
    return this.next() * 2 - 1
  }
}

/** FNV-1a hash of a string to a 32-bit seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------------------------
// Small DSP helpers (in place on Float64Array)

export function lowpass(buf: Float64Array, fc: number, sr: number, passes = 1): void {
  const k = 1 - Math.exp((-2 * Math.PI * clamp(fc, 1, sr * 0.49)) / sr)
  for (let p = 0; p < passes; p++) {
    let y = 0
    for (let i = 0; i < buf.length; i++) {
      y += k * (buf[i]! - y)
      buf[i] = y
    }
  }
}

export function highpass(buf: Float64Array, fc: number, sr: number, passes = 1): void {
  const rc = 1 / (2 * Math.PI * clamp(fc, 1, sr * 0.49))
  const a = rc / (rc + 1 / sr)
  for (let p = 0; p < passes; p++) {
    let px = 0
    let py = 0
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]!
      py = a * (py + x - px)
      px = x
      buf[i] = py
    }
  }
}

/** RBJ band-pass biquad (constant 0 dB peak gain). */
export function bandpass(buf: Float64Array, fc: number, q: number, sr: number): void {
  const w = (2 * Math.PI * clamp(fc, 20, sr * 0.45)) / sr
  const alpha = Math.sin(w) / (2 * q)
  const b0 = alpha
  const b2 = -alpha
  const a0 = 1 + alpha
  const a1 = -2 * Math.cos(w)
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    buf[i] = y
  }
}

export function peakOf(buf: ArrayLike<number>): number {
  let p = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]!)
    if (a > p) p = a
  }
  return p
}

/** Scale to the given peak (no-op for silence). */
export function normalize(buf: Float64Array, peak = 0.9): void {
  const p = peakOf(buf)
  if (p <= 1e-12) return
  const g = peak / p
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g
}

/** Catmull-Rom interpolation between y1 and y2 at t in [0,1). */
export function cubic(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3
  const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c = -0.5 * y0 + 0.5 * y2
  return ((a * t + b) * t + c) * t + y1
}

/** Resample with a low-pass before decimation and cubic interpolation. Returns a new array. */
export function resample(data: ArrayLike<number>, from: number, to: number): Float64Array {
  const src = Float64Array.from(data as ArrayLike<number>)
  if (from === to || src.length === 0) return src
  if (to < from) lowpass(src, to * 0.45, from, 4)
  const n = Math.max(1, Math.round((src.length * to) / from))
  const out = new Float64Array(n)
  const step = from / to
  const at = (i: number): number => src[i < 0 ? 0 : i >= src.length ? src.length - 1 : i]!
  for (let i = 0; i < n; i++) {
    const p = i * step
    const i0 = Math.floor(p)
    out[i] = cubic(at(i0 - 1), at(i0), at(i0 + 1), at(i0 + 2), p - i0)
  }
  return out
}

export function toInt16(buf: ArrayLike<number>): Int16Array {
  const out = new Int16Array(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(buf[i]! * 32767)))
  return out
}

function roundUp16(n: number): number {
  return Math.ceil(n / 16) * 16
}

// ---------------------------------------------------------------------------------------------
// Additive loops

export interface AdditiveSpec {
  /** MIDI note the sample is tuned to. */
  note: number
  /** Loop length in samples (multiple of 16). */
  loopLen: number
  /** Amplitude of harmonic h (1-based) whose frequency is hz. */
  harmonics: (h: number, hz: number) => number
  /** Extra detuned copy of every harmonic, shifted by this many bins (cycles per loop); 0 = none. */
  detuneBins?: number
  /** Level of the detuned copy relative to the main one (default 0.7). */
  chorusMix?: number
  /** Non-looped intro length in samples (multiple of 16): harmonics bloom while it plays. */
  intro?: number
  /** Noise burst (chiff / breath attack) at the start of the intro, 0..1. */
  introNoise?: number
  /** Periodic breath noise inside the loop, 0..1. */
  breath?: number
  seed: number
}

/** Tuned loop: the loop holds a whole number of cycles per partial, and the native rate is chosen so the pitch is exact. */
export function additiveLoop(spec: AdditiveSpec): RawSample {
  const L = roundUp16(spec.loopLen)
  const I = spec.intro ? roundUp16(spec.intro) : 0
  const baseHz = midiToHz(spec.note)
  const m = Math.max(1, Math.round((baseHz * L) / 32000))
  const rate = (baseHz * L) / m
  const hMax = Math.max(1, Math.min(48, Math.floor((0.46 * rate) / baseHz)))
  const rng = new Rng(spec.seed)
  const amps: number[] = []
  const ph1: number[] = []
  const ph2: number[] = []
  for (let h = 1; h <= hMax; h++) {
    amps.push(spec.harmonics(h, h * baseHz))
    ph1.push(rng.next() * 2 * Math.PI)
    ph2.push(rng.next() * 2 * Math.PI)
  }
  const det = spec.detuneBins ?? 0
  const mix = spec.chorusMix ?? 0.7
  const data = new Float64Array(I + L)
  const w = (2 * Math.PI) / L
  for (let n = -I; n < L; n++) {
    const bloom = n >= 0 ? 1 : (n + I + 1) / (I + 1)
    let s = 0
    for (let h = 1; h <= hMax; h++) {
      let a = amps[h - 1]!
      if (a === 0) continue
      if (n < 0) a *= Math.pow(bloom, 0.35 * (h - 1))
      s += a * Math.sin(w * h * m * n + ph1[h - 1]!)
      if (det !== 0) s += a * mix * Math.sin(w * (h * m + det) * n + ph2[h - 1]!)
    }
    data[n + I] = n >= 0 ? s : s * Math.sqrt(bloom)
  }
  const sc = peakOf(data) || 1
  for (let i = 0; i < data.length; i++) data[i] = (data[i]! / sc) * 0.8
  if (spec.breath && spec.breath > 0) {
    const nb = new Float64Array(L)
    for (let i = 0; i < L; i++) nb[i] = rng.noise()
    bandpass(nb, Math.min(rate * 0.3, 3200), 0.8, rate)
    // make the noise loop seamless: cross-fade the end into the start
    const f = Math.min(64, L >> 2)
    for (let i = 0; i < f; i++) {
      const g = (i + 1) / (f + 1)
      nb[L - f + i] = nb[L - f + i]! * (1 - g) + nb[i]! * g
    }
    normalize(nb, spec.breath * 0.5)
    for (let i = 0; i < data.length; i++) data[i] = data[i]! + nb[(i - I + L * 4) % L]!
  }
  if (I > 0 && spec.introNoise && spec.introNoise > 0) {
    const nb = new Float64Array(I)
    for (let i = 0; i < I; i++) nb[i] = rng.noise()
    bandpass(nb, Math.min(rate * 0.3, 2600), 0.9, rate)
    normalize(nb, spec.introNoise * 0.6)
    for (let i = 0; i < I; i++) data[i] = data[i]! + nb[i]! * Math.exp((-4 * i) / I)
  }
  normalize(data, 0.85)
  return { data, rate, loopStart: I, baseNote: spec.note }
}

// ---------------------------------------------------------------------------------------------
// Karplus-Strong

export interface PluckSpec {
  note: number
  rate: number
  seconds: number
  /** Loss per pass 0.9..1 (closer to 1 = longer ring). */
  decay: number
  /** 0.5 = darkest (2-point average) .. 0.98 = brightest. */
  bright: number
  /** Excitation: white noise, smoothed noise (harp) or a comb-filtered pick (guitar). */
  burst: 'noise' | 'smooth' | 'pick'
  /** Pick position 0..0.5 along the string (comb filter on the excitation). */
  pickPos?: number
  /** Add an inharmonic partial (koto / kalimba flavour), 0..1. */
  metallic?: number
  seed: number
}

export function karplusStrong(spec: PluckSpec): RawSample {
  const f0 = midiToHz(spec.note)
  const w = clamp(spec.bright, 0.5, 0.98)
  const D = Math.max(2, Math.round(spec.rate / f0 - (1 - w)))
  const rate = f0 * (D + (1 - w))
  const N = roundUp16(Math.round(spec.seconds * rate))
  const rng = new Rng(spec.seed)
  const ex = new Float64Array(D)
  for (let i = 0; i < D; i++) ex[i] = rng.noise()
  if (spec.burst === 'smooth') lowpass(ex, f0 * 5, rate, 2)
  else if (spec.burst === 'pick') {
    const k = Math.max(1, Math.round((spec.pickPos ?? 0.2) * D))
    const c = new Float64Array(D)
    for (let i = 0; i < D; i++) c[i] = ex[i]! - ex[(i - k + D) % D]!
    ex.set(c)
    lowpass(ex, Math.min(rate * 0.3, f0 * 14), rate, 1)
  }
  // remove DC from the excitation
  let mean = 0
  for (let i = 0; i < D; i++) mean += ex[i]!
  mean /= D
  for (let i = 0; i < D; i++) ex[i] = ex[i]! - mean
  const y = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    if (n < D) y[n] = ex[n]!
    else y[n] = spec.decay * (w * y[n - D]! + (1 - w) * (n - D - 1 >= 0 ? y[n - D - 1]! : 0))
  }
  if (spec.metallic && spec.metallic > 0) {
    // an inharmonic partial rung by the same excitation energy (stiff-string / kalimba tine)
    const m = new Float64Array(N)
    const fm = f0 * 2.76
    for (let n = 0; n < N; n++) m[n] = Math.sin((2 * Math.PI * fm * n) / rate) * Math.exp((-n / rate) * 7)
    normalize(m, spec.metallic * 0.4 * (peakOf(y) || 1))
    for (let n = 0; n < N; n++) y[n] = y[n]! + m[n]!
  }
  // tiny fade-out so the one-shot ends silent
  const f = Math.min(N >> 2, 256)
  for (let i = 0; i < f; i++) y[N - f + i] = y[N - f + i]! * (1 - (i + 1) / f)
  normalize(y, 0.85)
  return { data: y, rate, baseNote: spec.note }
}

// ---------------------------------------------------------------------------------------------
// 2-operator FM (self contained; independent of the Genesis YM2612 engine)

export interface FmToneSpec {
  note: number
  rate: number
  seconds: number
  /** Modulator frequency / carrier frequency. */
  ratio: number
  /** Peak modulation index and the time constant (s) it decays with. */
  index: number
  indexTau: number
  /** Amplitude decay time constant (s). */
  ampTau: number
  /** Secondary stack (higher partial) level 0..1, ratio and decay. */
  partial?: { level: number; ratio: number; tau: number; index?: number }
  /** Short noise click at the start, 0..1. */
  click?: number
  seed: number
}

export function fmTone(spec: FmToneSpec): RawSample {
  const f0 = midiToHz(spec.note)
  const N = roundUp16(Math.round(spec.seconds * spec.rate))
  const out = new Float64Array(N)
  const rng = new Rng(spec.seed)
  for (let n = 0; n < N; n++) {
    const t = n / spec.rate
    const idx = spec.index * Math.exp(-t / spec.indexTau)
    let s = Math.exp(-t / spec.ampTau) * Math.sin(2 * Math.PI * f0 * t + idx * Math.sin(2 * Math.PI * f0 * spec.ratio * t))
    const p = spec.partial
    if (p) {
      const pi = (p.index ?? 1.5) * Math.exp(-t / p.tau)
      s += p.level * Math.exp(-t / p.tau) * Math.sin(2 * Math.PI * f0 * p.ratio * t + pi * Math.sin(2 * Math.PI * f0 * p.ratio * 1.41 * t))
    }
    out[n] = s
  }
  if (spec.click && spec.click > 0) {
    const nb = Math.min(N, Math.round(spec.rate * 0.004))
    for (let i = 0; i < nb; i++) out[i] = out[i]! + rng.noise() * spec.click * 0.5 * (1 - i / nb)
  }
  const f = Math.min(N >> 2, 128)
  for (let i = 0; i < f; i++) out[N - f + i] = out[N - f + i]! * (1 - (i + 1) / f)
  normalize(out, 0.85)
  return { data: out, rate: spec.rate, baseNote: spec.note }
}

// ---------------------------------------------------------------------------------------------
// Drums (one-shots; baseNote 60)

function fadeTail(buf: Float64Array, n: number): void {
  const f = Math.min(buf.length >> 2, n)
  for (let i = 0; i < f; i++) buf[buf.length - f + i] = buf[buf.length - f + i]! * (1 - (i + 1) / f)
}

function finish(buf: Float64Array, rate: number, peak = 0.9): RawSample {
  const padded = new Float64Array(roundUp16(buf.length))
  padded.set(buf)
  fadeTail(padded, 96)
  normalize(padded, peak)
  return { data: padded, rate, baseNote: 60 }
}

export function kickDrum(o: { rate: number; seconds: number; startHz: number; endHz: number; click: number; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const out = new Float64Array(N)
  const rng = new Rng(o.seed)
  let phase = 0
  const sweep = 0.035
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    const f = o.endHz + (o.startHz - o.endHz) * Math.exp(-t / sweep)
    phase += (2 * Math.PI * f) / o.rate
    out[n] = Math.sin(phase) * Math.exp(-t / (o.seconds * 0.32)) * (1 - Math.exp(-t / 0.0006))
  }
  const click = new Float64Array(Math.min(N, Math.round(o.rate * 0.004)))
  for (let i = 0; i < click.length; i++) click[i] = rng.noise() * (1 - i / click.length)
  lowpass(click, 2500, o.rate)
  for (let i = 0; i < click.length; i++) out[i] = out[i]! + click[i]! * o.click
  return finish(out, o.rate)
}

export function snareDrum(o: { rate: number; seconds: number; toneHz: number; noise: number; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const tone = new Float64Array(N)
  const noise = new Float64Array(N)
  let phase = 0
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    const f = o.toneHz * (1 + 0.5 * Math.exp(-t / 0.012))
    phase += (2 * Math.PI * f) / o.rate
    tone[n] = Math.sin(phase) * Math.exp(-t / 0.05)
    noise[n] = rng.noise()
  }
  bandpass(noise, 2200, 0.7, o.rate)
  const ng = o.noise
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    out[n] = tone[n]! * 0.8 + noise[n]! * ng * 1.6 * Math.exp(-t / (o.seconds * 0.34)) * (1 - Math.exp(-t / 0.0005))
  }
  return finish(out, o.rate)
}

const METAL_HZ = [205.3, 304.4, 369.6, 522.7, 540, 800]

function metallic(N: number, rate: number, scale: number): Float64Array {
  const out = new Float64Array(N)
  for (const f0 of METAL_HZ) {
    const f = f0 * scale
    if (f >= rate * 0.49) continue
    const inc = f / rate
    let p = 0
    for (let n = 0; n < N; n++) {
      out[n] = out[n]! + (p < 0.5 ? 1 : -1)
      p += inc
      if (p >= 1) p -= 1
    }
  }
  return out
}

export function hiHat(o: { rate: number; seconds: number; open: boolean; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 6500, o.rate, 2)
  const met = metallic(N, o.rate, 4)
  highpass(met, 5000, o.rate, 2)
  const tau = o.open ? o.seconds * 0.38 : o.seconds * 0.22
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    out[n] = (noise[n]! * 0.8 + met[n]! * 0.12) * Math.exp(-t / tau)
  }
  return finish(out, o.rate, 0.8)
}

export function crashCymbal(o: { rate: number; seconds: number; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  highpass(noise, 3500, o.rate, 2)
  const met = metallic(N, o.rate, 3.1)
  highpass(met, 3000, o.rate, 2)
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    out[n] = (noise[n]! * 0.7 + met[n]! * 0.2) * (1 - Math.exp(-t / 0.004)) * Math.exp(-t / (o.seconds * 0.3))
  }
  return finish(out, o.rate, 0.8)
}

export function tomDrum(o: { rate: number; seconds: number; hz: number; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const out = new Float64Array(N)
  let phase = 0
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    const f = o.hz * (1 + 0.6 * Math.exp(-t / 0.04))
    phase += (2 * Math.PI * f) / o.rate
    out[n] = Math.sin(phase) * Math.exp(-t / (o.seconds * 0.35))
  }
  const click = Math.min(N, Math.round(o.rate * 0.003))
  for (let i = 0; i < click; i++) out[i] = out[i]! + rng.noise() * 0.25 * (1 - i / click)
  return finish(out, o.rate)
}

export function handClap(o: { rate: number; seconds: number; seed: number }): RawSample {
  const N = Math.round(o.rate * o.seconds)
  const rng = new Rng(o.seed)
  const noise = new Float64Array(N)
  for (let n = 0; n < N; n++) noise[n] = rng.noise()
  bandpass(noise, 1300, 0.9, o.rate)
  const out = new Float64Array(N)
  const bursts = [0, 0.011, 0.022, 0.034]
  for (let n = 0; n < N; n++) {
    const t = n / o.rate
    let e = 0
    for (let b = 0; b < bursts.length; b++) {
      const dt = t - bursts[b]!
      if (dt < 0) continue
      e += b === bursts.length - 1 ? Math.exp(-dt / (o.seconds * 0.3)) : Math.exp(-dt / 0.003) * 0.8
    }
    out[n] = noise[n]! * e
  }
  return finish(out, o.rate)
}
