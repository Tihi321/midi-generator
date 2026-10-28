// The PS1 SPU sample target ('psx'): PS-X ADPCM, 16-byte blocks of 28 samples (spec: nocash psx-spx, "SPU ADPCM").
//
// Block layout: byte 0 = shift (bits 0..3) | filter (bits 4..6) << 4; byte 1 = flags (bit 0 loop end, bit 1 loop
// repeat, bit 2 loop start); bytes 2..15 = 28 signed 4-bit residuals, the low nibble of a byte first. A sample is
// `(nibble << 12) >> shift` (shift 13..15 behave like 9) plus the filter prediction
// `(p1 * F0[filter] + p2 * F1[filter] + 32) >> 6` of the two previous decoded samples, clamped to 16 bits.
// The encoder is closed-loop like `brr.ts`: for every block it tries the five filters x the shifts 0..12 and keeps the
// combination whose DECODED output is closest to the source, so the pipeline plays exactly what the SPU would decode.
// A loop-start block is coded with filter 0 (no history), so the decoded loop is identical on every pass.
//
// The 'psx' sample target keeps the sample's own rate (the SPU resamples with its 16-bit pitch register). A loop must
// start on a block and hold whole 28-sample blocks: instead of trimming the loop (which would detune short loops, e.g.
// 256 -> 252 samples is 27 cents sharp), the prefix and the loop are each resampled to the nearest whole number of
// blocks and the sample's rate is scaled by the same factor, so the pitch is kept. User PCM above 48 kHz is resampled
// to 44.1 kHz.

import { type SampleResult, registerSampleTarget } from './bank'
import { resample, toInt16 } from './generators'

export const PSX_BLOCK_SAMPLES = 28
export const PSX_BLOCK_BYTES = 16

/** SPU RAM bytes of `samples` PCM samples: ceil(n / 28) * 16. */
export function psxByteSize(samples: number): number {
  return Math.ceil(Math.max(0, samples) / PSX_BLOCK_SAMPLES) * PSX_BLOCK_BYTES
}

/** Filter coefficients / 64 for the previous (F0) and the one before (F1) decoded sample (psx-spx, filters 0..4). */
const F0 = [0, 60, 115, 98, 122] as const
const F1 = [0, 0, -52, -55, -60] as const

const clamp16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v)

export interface PsxEncodeOptions {
  /** Loop start in samples (rounded down to a multiple of 28); absent = no loop. */
  loopStart?: number
  /** Restrict the filters (default 0..4). */
  filters?: number[]
}

export interface PsxEncoded {
  bytes: Uint8Array
  /** What the SPU decodes from `bytes` (blocks * 28 samples). */
  decoded: Int16Array
  blocks: number
  /** Loop start in samples after alignment (multiple of 28), or undefined. */
  loopStart?: number
}

/** Encode PCM16 to PS-X ADPCM. The input is zero-padded to a multiple of 28 samples. */
export function encodePsx(pcm: Int16Array | Float32Array | number[], opts: PsxEncodeOptions = {}): PsxEncoded {
  const n = pcm.length
  const blocks = Math.max(1, Math.ceil(n / PSX_BLOCK_SAMPLES))
  const bytes = new Uint8Array(blocks * PSX_BLOCK_BYTES)
  const decoded = new Int16Array(blocks * PSX_BLOCK_SAMPLES)
  const loopBlock = opts.loopStart !== undefined && opts.loopStart >= 0 ? Math.min(blocks - 1, Math.floor(opts.loopStart / PSX_BLOCK_SAMPLES)) : -1
  const allowed = opts.filters && opts.filters.length > 0 ? opts.filters : [0, 1, 2, 3, 4]
  const out = new Int32Array(PSX_BLOCK_SAMPLES)
  const bestOut = new Int32Array(PSX_BLOCK_SAMPLES)
  const nib = new Int32Array(PSX_BLOCK_SAMPLES)
  const bestNib = new Int32Array(PSX_BLOCK_SAMPLES)
  let p1 = 0
  let p2 = 0

  for (let b = 0; b < blocks; b++) {
    const base = b * PSX_BLOCK_SAMPLES
    const filters = b === loopBlock ? [0] : allowed
    let bestErr = Infinity
    let bestF = 0
    let bestS = 12
    for (const f of filters) {
      const c0 = F0[f]!
      const c1 = F1[f]!
      for (let shift = 12; shift >= 0; shift--) {
        let q1 = p1
        let q2 = p2
        let err = 0
        const step = 1 << (12 - shift)
        for (let i = 0; i < PSX_BLOCK_SAMPLES; i++) {
          const pred = (q1 * c0 + q2 * c1 + 32) >> 6
          const t = pcm[base + i] ?? 0
          let nv = Math.round((t - pred) / step)
          if (nv < -8) nv = -8
          else if (nv > 7) nv = 7
          const o = clamp16(pred + nv * step)
          const d = o - t
          err += d * d
          nib[i] = nv
          out[i] = o
          q2 = q1
          q1 = o
          if (err >= bestErr) break
        }
        if (err < bestErr) {
          bestErr = err
          bestF = f
          bestS = shift
          bestNib.set(nib)
          bestOut.set(out)
        }
        // a quieter block never needs the coarser shifts once the error is zero
        if (bestErr === 0) break
      }
      if (bestErr === 0) break
    }
    const o = b * PSX_BLOCK_BYTES
    bytes[o] = bestS | (bestF << 4)
    let flags = 0
    if (b === loopBlock) flags |= 4
    if (b === blocks - 1) flags |= loopBlock >= 0 ? 3 : 1
    bytes[o + 1] = flags
    for (let i = 0; i < PSX_BLOCK_SAMPLES; i += 2) bytes[o + 2 + (i >> 1)] = (bestNib[i]! & 15) | ((bestNib[i + 1]! & 15) << 4)
    for (let i = 0; i < PSX_BLOCK_SAMPLES; i++) decoded[base + i] = bestOut[i]!
    p1 = bestOut[PSX_BLOCK_SAMPLES - 1]!
    p2 = bestOut[PSX_BLOCK_SAMPLES - 2]!
  }
  return { bytes, decoded, blocks, ...(loopBlock >= 0 ? { loopStart: loopBlock * PSX_BLOCK_SAMPLES } : {}) }
}

export interface PsxDecoded {
  pcm: Int16Array
  /** Flags byte of every block (bit 0 end, bit 1 repeat, bit 2 loop start). */
  flags: number[]
}

/** Decode PS-X ADPCM bytes (whole blocks) linearly from the start, as the SPU does after key-on. */
export function decodePsx(bytes: Uint8Array): PsxDecoded {
  const blocks = Math.floor(bytes.length / PSX_BLOCK_BYTES)
  const pcm = new Int16Array(blocks * PSX_BLOCK_SAMPLES)
  const flags: number[] = []
  let p1 = 0
  let p2 = 0
  for (let b = 0; b < blocks; b++) {
    const o = b * PSX_BLOCK_BYTES
    let shift = bytes[o]! & 15
    if (shift > 12) shift = 9
    const filter = (bytes[o]! >> 4) & 7
    const c0 = filter < F0.length ? F0[filter]! : 0
    const c1 = filter < F1.length ? F1[filter]! : 0
    flags.push(bytes[o + 1]!)
    for (let i = 0; i < PSX_BLOCK_SAMPLES; i++) {
      const byte = bytes[o + 2 + (i >> 1)]!
      let nv = i & 1 ? byte >> 4 : byte & 15
      if (nv > 7) nv -= 16
      const v = clamp16(((nv << 12) >> shift) + ((p1 * c0 + p2 * c1 + 32) >> 6))
      pcm[b * PSX_BLOCK_SAMPLES + i] = v
      p2 = p1
      p1 = v
    }
  }
  return { pcm, flags }
}

/** Resample above this rate; the SPU pitch register (0x4000 = 4x) reaches far above, but 48 kHz is already beyond its native rate. */
const USER_RATE_LIMIT = 48000
const SPU_RATE = 44100

/** Catmull-Rom cubic through y1..y2 at t in [0, 1). */
function cubic(y0: number, y1: number, y2: number, y3: number, t: number): number {
  return ((((-0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3) * t + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * t + (-0.5 * y0 + 0.5 * y2)) * t) + y1
}

/** Resample one period of a loop to `n` samples with a wrapped (periodic) cubic, so the seam stays continuous. */
function resampleLoop(loop: Int16Array, n: number): Int16Array {
  const len = loop.length
  const out = new Int16Array(n)
  const at = (i: number): number => loop[((i % len) + len) % len]!
  for (let i = 0; i < n; i++) {
    const p = (i * len) / n
    const i0 = Math.floor(p)
    const v = cubic(at(i0 - 1), at(i0), at(i0 + 1), at(i0 + 2), p - i0)
    out[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v)
  }
  return out
}

function encodeToResult(src: Int16Array, rate: number, loopStart: number | undefined, baseNote: number): SampleResult {
  let pcm = src
  let loop = loopStart !== undefined && loopStart >= 0 && loopStart < pcm.length ? loopStart : undefined
  let outRate = rate
  if (loop !== undefined) {
    const B = PSX_BLOCK_SAMPLES
    const loopLen = pcm.length - loop
    const newLoopLen = Math.max(B, Math.round(loopLen / B) * B)
    // scale prefix and loop by the same factor (rate scaled to match) so the loop lands on whole blocks, pitch unchanged
    const f = newLoopLen / loopLen
    const newStart = Math.round((loop * f) / B) * B
    if (newLoopLen !== loopLen || newStart !== loop) {
      const prefix = newStart > 0 ? Int16Array.from(toInt16(resample(Float64Array.from(pcm.subarray(0, loop), (v) => v / 32768), Math.max(1, loop), newStart))) : new Int16Array(0)
      const body = resampleLoop(pcm.subarray(loop), newLoopLen)
      pcm = new Int16Array(newStart + newLoopLen)
      pcm.set(prefix.subarray(0, newStart), 0)
      pcm.set(body, newStart)
      loop = newStart
      outRate = Math.round(rate * f)
    }
  } else if (pcm.length < PSX_BLOCK_SAMPLES) {
    const padded = new Int16Array(PSX_BLOCK_SAMPLES)
    padded.set(pcm)
    pcm = padded
  }
  const enc = encodePsx(pcm, loop !== undefined ? { loopStart: loop } : {})
  return { pcm: enc.decoded, sampleRate: outRate, ...(enc.loopStart !== undefined ? { loopStart: enc.loopStart } : {}), baseNote }
}

/** Generated (recipe) PCM -> what the SPU plays: loop alignment to 28, then a real ADPCM encode + decode round trip. */
export function processForPsx(raw: SampleResult): SampleResult {
  return encodeToResult(raw.pcm, raw.sampleRate, raw.loopStart, raw.baseNote)
}

/** User PCM -> what the SPU plays: above 48 kHz resampled to 44.1 kHz (with a low-pass), then as `processForPsx`. */
export function processUserPcmForPsx(raw: SampleResult): SampleResult {
  if (raw.sampleRate <= USER_RATE_LIMIT) return processForPsx(raw)
  const f = Float64Array.from(raw.pcm, (v) => v / 32768)
  const r = resample(f, raw.sampleRate, SPU_RATE)
  const loop = raw.loopStart !== undefined ? Math.round((raw.loopStart * SPU_RATE) / raw.sampleRate) : undefined
  return encodeToResult(toInt16(r), SPU_RATE, loop, raw.baseNote)
}

registerSampleTarget('psx', { process: processForPsx, userPcm: processUserPcmForPsx, bytes: psxByteSize })
