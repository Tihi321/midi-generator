// SNES BRR (Bit Rate Reduction) codec: 9-byte blocks of 16 samples (1 header byte + 16 four-bit residuals).
// Header: shift (bits 7..4), filter (3..2), loop flag (bit 1), end flag (bit 0).
// The encoder is closed-loop: for each block it tries the 4 predictor filters x the shift range and keeps the
// combination whose DECODED output is closest to the source, so what you hear is exactly what the DSP decodes.
// Accuracy note: decoded values are clamped to the 15-bit range (the hardware wraps the doubled 16-bit value).

export const BRR_BLOCK_SAMPLES = 16
export const BRR_BLOCK_BYTES = 9

/** BRR bytes for a sample of `samples` PCM samples (padded to whole blocks). */
export function brrByteSize(samples: number): number {
  return Math.ceil(Math.max(0, samples) / BRR_BLOCK_SAMPLES) * BRR_BLOCK_BYTES
}

function clamp15(v: number): number {
  return v < -16384 ? -16384 : v > 16383 ? 16383 : v
}

/** Predictor for filter 0..3 from the two previous decoded (15-bit) samples. */
function predict(filter: number, p1: number, p2: number): number {
  switch (filter) {
    case 1:
      return p1 + ((-p1) >> 4)
    case 2:
      return (p1 << 1) + ((-((p1 << 1) + p2)) >> 5) - p2 + (p2 >> 4)
    case 3:
      return (p1 << 1) + ((-(p1 + (p1 << 1))) >> 6) - p2 + (((p2 << 1) + p2) >> 4)
    default:
      return 0
  }
}

/** Residual for a signed nibble at a shift (hardware formula incl. the invalid shifts 13..15). */
function residual(n: number, shift: number): number {
  if (shift <= 12) return (n << shift) >> 1
  return n < 0 ? -2048 : 0
}

export interface BrrEncodeOptions {
  /** Loop start in samples (rounded down to a multiple of 16); absent = no loop. */
  loopStart?: number
  /** Restrict the predictor filters (default all four). */
  filters?: number[]
}

export interface BrrEncoded {
  bytes: Uint8Array
  /** What the DSP decodes from `bytes` (16-bit, blocks * 16 samples). */
  decoded: Int16Array
  blocks: number
  /** Loop start in samples after alignment (multiple of 16), or undefined. */
  loopStart?: number
}

/** Encode PCM16 to BRR. The input is zero-padded to a multiple of 16 samples. */
export function encodeBrr(pcm: Int16Array | Float32Array | number[], opts: BrrEncodeOptions = {}): BrrEncoded {
  const n = pcm.length
  const blocks = Math.max(1, Math.ceil(n / BRR_BLOCK_SAMPLES))
  const bytes = new Uint8Array(blocks * BRR_BLOCK_BYTES)
  const decoded = new Int16Array(blocks * BRR_BLOCK_SAMPLES)
  const loopBlock = opts.loopStart !== undefined && opts.loopStart >= 0 ? Math.min(blocks - 1, Math.floor(opts.loopStart / BRR_BLOCK_SAMPLES)) : -1
  const allowed = opts.filters && opts.filters.length > 0 ? opts.filters : [0, 1, 2, 3]
  const target = new Float64Array(BRR_BLOCK_SAMPLES)
  const out = new Int32Array(BRR_BLOCK_SAMPLES)
  const bestOut = new Int32Array(BRR_BLOCK_SAMPLES)
  const nib = new Int32Array(BRR_BLOCK_SAMPLES)
  const bestNib = new Int32Array(BRR_BLOCK_SAMPLES)
  let p1 = 0
  let p2 = 0

  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BRR_BLOCK_SAMPLES; i++) target[i] = (pcm[b * BRR_BLOCK_SAMPLES + i] ?? 0) / 2
    const filters = b === loopBlock ? [0] : allowed
    let bestErr = Infinity
    let bestF = 0
    let bestS = 0
    for (const f of filters) {
      for (let shift = 0; shift <= 12; shift++) {
        let q1 = p1
        let q2 = p2
        let err = 0
        const step = (1 << shift) / 2
        for (let i = 0; i < BRR_BLOCK_SAMPLES; i++) {
          const pred = predict(f, q1, q2)
          let nv = Math.round((target[i]! - pred) / step)
          if (nv < -8) nv = -8
          else if (nv > 7) nv = 7
          const o = clamp15(pred + residual(nv, shift))
          const d = o - target[i]!
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
      }
    }
    const o = b * BRR_BLOCK_BYTES
    let header = (bestS << 4) | (bestF << 2)
    if (b === blocks - 1) header |= 1
    if (loopBlock >= 0 && b === blocks - 1) header |= 2
    bytes[o] = header
    for (let i = 0; i < BRR_BLOCK_SAMPLES; i += 2) bytes[o + 1 + (i >> 1)] = ((bestNib[i]! & 15) << 4) | (bestNib[i + 1]! & 15)
    for (let i = 0; i < BRR_BLOCK_SAMPLES; i++) decoded[b * BRR_BLOCK_SAMPLES + i] = bestOut[i]! * 2
    p1 = bestOut[BRR_BLOCK_SAMPLES - 1]!
    p2 = bestOut[BRR_BLOCK_SAMPLES - 2]!
  }
  return { bytes, decoded, blocks, ...(loopBlock >= 0 ? { loopStart: loopBlock * BRR_BLOCK_SAMPLES } : {}) }
}

export interface BrrDecoded {
  pcm: Int16Array
  /** Loop flag of the last block. */
  loops: boolean
}

/** Decode BRR bytes (whole blocks) linearly from the start, as the DSP does after key-on. */
export function decodeBrr(bytes: Uint8Array): BrrDecoded {
  const blocks = Math.floor(bytes.length / BRR_BLOCK_BYTES)
  const pcm = new Int16Array(blocks * BRR_BLOCK_SAMPLES)
  let p1 = 0
  let p2 = 0
  let loops = false
  for (let b = 0; b < blocks; b++) {
    const o = b * BRR_BLOCK_BYTES
    const header = bytes[o]!
    const shift = header >> 4
    const filter = (header >> 2) & 3
    loops = (header & 2) !== 0
    for (let i = 0; i < BRR_BLOCK_SAMPLES; i++) {
      const byte = bytes[o + 1 + (i >> 1)]!
      let nv = i & 1 ? byte & 15 : byte >> 4
      if (nv > 7) nv -= 16
      const v = clamp15(predict(filter, p1, p2) + residual(nv, shift))
      pcm[b * BRR_BLOCK_SAMPLES + i] = v * 2
      p2 = p1
      p1 = v
    }
  }
  return { pcm, loops }
}

/** Encode then decode: the audio the SNES would actually play (plus the byte size). */
export function brrRoundTrip(pcm: Int16Array | Float32Array | number[], opts: BrrEncodeOptions = {}): { pcm: Int16Array; bytes: number; loopStart?: number } {
  const e = encodeBrr(pcm, opts)
  return { pcm: e.decoded, bytes: e.bytes.length, ...(e.loopStart !== undefined ? { loopStart: e.loopStart } : {}) }
}

/** Signal-to-noise ratio in dB of `test` against `ref` (over the shorter length). */
export function snrDb(ref: ArrayLike<number>, test: ArrayLike<number>): number {
  const n = Math.min(ref.length, test.length)
  let s = 0
  let e = 0
  for (let i = 0; i < n; i++) {
    const r = ref[i]!
    const d = r - test[i]!
    s += r * r
    e += d * d
  }
  if (e === 0) return Infinity
  return 10 * Math.log10(s / e)
}
