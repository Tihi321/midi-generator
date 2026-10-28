// The Dreamcast AICA sample targets: 'aica16' (PCM16), 'aica8' (PCM8) and 'aica-adpcm' (Yamaha 4-bit ADPCM). An
// aica-sample instrument's `format` ('pcm16' | 'pcm8' | 'adpcm') picks the target (see `aicaTargetFor`).
//
//  - aica16: the generated PCM, bit-exact, at the sample's own rate (the AICA plays any rate through its OCT / FNS pitch).
//  - aica8:  the top 8 bits of each sample (the hardware stores PCM8 as a signed byte played as the high byte).
//  - aica-adpcm: a real encode + decode round trip of the Yamaha ADPCM the AICA decodes (the documented ADPCM-B step
//    table: 4-bit sign-magnitude codes, low nibble first, initial step 127, step multipliers 57 57 57 57 77 102 128 153
//    over 64, step range 127..24576). The encoder is closed loop: for every sample it picks the code whose DECODED
//    value is closest, so what you hear is what the chip decodes. The loop of a looped sample is played from the decoded
//    first pass (the hardware keeps its decoder state across the wrap, which changes the loop only by quantisation noise).
//
// RAM sizes are the real ones: 2, 1 and 0.5 bytes per sample.

import type { AicaSampleInstrument } from '../../types'
import { type SampleResult, type SampleTarget, registerSampleTarget } from './bank'

export type AicaFormat = AicaSampleInstrument['format']

/** Sample target id of an AICA sample format. */
export function aicaTargetFor(format: AicaFormat): SampleTarget {
  return format === 'pcm8' ? 'aica8' : format === 'adpcm' ? 'aica-adpcm' : 'aica16'
}

/** AICA RAM bytes of `samples` PCM samples in a format (2, 1 or 0.5 bytes per sample). */
export function aicaByteSize(format: AicaFormat, samples: number): number {
  return format === 'pcm8' ? samples : format === 'adpcm' ? Math.ceil(samples / 2) : samples * 2
}

/** At least two samples, so a loop or a one-shot always has something to read. */
function atLeast2(pcm: Int16Array): Int16Array {
  if (pcm.length >= 2) return pcm
  const out = new Int16Array(2)
  out.set(pcm)
  return out
}

function result(raw: SampleResult, pcm: Int16Array): SampleResult {
  return {
    pcm,
    sampleRate: raw.sampleRate,
    ...(raw.loopStart !== undefined && raw.loopStart < pcm.length ? { loopStart: raw.loopStart } : {}),
    baseNote: raw.baseNote
  }
}

/** Generated (recipe) PCM -> 16-bit PCM as the AICA plays it: unchanged. */
export function processForAica16(raw: SampleResult): SampleResult {
  return result(raw, atLeast2(raw.pcm))
}

/** Generated (recipe) PCM -> 8-bit PCM as the AICA plays it: each sample rounded to the nearest multiple of 256. */
export function processForAica8(raw: SampleResult): SampleResult {
  const src = atLeast2(raw.pcm)
  const pcm = new Int16Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const q = Math.round(src[i]! / 256)
    pcm[i] = (q > 127 ? 127 : q < -128 ? -128 : q) * 256
  }
  return result(raw, pcm)
}

// ---------------------------------------------------------------------------------------------
// Yamaha 4-bit ADPCM

export const ADPCM_STEP_START = 127
export const ADPCM_STEP_MIN = 127
export const ADPCM_STEP_MAX = 24576
/** Step multipliers (over 64) per 3-bit magnitude (the documented Yamaha ADPCM-B adaptation table). */
const STEP_MUL = [57, 57, 57, 57, 77, 102, 128, 153]

function nextStep(step: number, mag: number): number {
  const s = (step * STEP_MUL[mag]!) >> 6
  return s < ADPCM_STEP_MIN ? ADPCM_STEP_MIN : s > ADPCM_STEP_MAX ? ADPCM_STEP_MAX : s
}

function applyCode(sig: number, step: number, code: number): number {
  const delta = ((2 * (code & 7) + 1) * step) >> 3
  const v = code & 8 ? sig - delta : sig + delta
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v
}

export interface AicaAdpcmEncoded {
  /** Two 4-bit codes per byte, the first sample in the low nibble. */
  bytes: Uint8Array
  /** What the chip decodes from `bytes` (one value per input sample). */
  decoded: Int16Array
}

/** Decode `count` samples of 4-bit ADPCM (low nibble first). */
export function decodeAicaAdpcm(bytes: Uint8Array, count: number): Int16Array {
  const out = new Int16Array(count)
  let sig = 0
  let step = ADPCM_STEP_START
  for (let i = 0; i < count; i++) {
    const b = bytes[i >> 1] ?? 0
    const code = i & 1 ? b >> 4 : b & 15
    sig = applyCode(sig, step, code)
    step = nextStep(step, code & 7)
    out[i] = sig
  }
  return out
}

/** Closed-loop encoder: the code whose decoded value is nearest the source (ties go to the lower code). */
export function encodeAicaAdpcm(pcm: Int16Array): AicaAdpcmEncoded {
  const n = pcm.length
  const bytes = new Uint8Array(Math.ceil(n / 2))
  const decoded = new Int16Array(n)
  let sig = 0
  let step = ADPCM_STEP_START
  for (let i = 0; i < n; i++) {
    const x = pcm[i]!
    let best = 0
    let bestErr = Infinity
    let bestSig = sig
    for (let code = 0; code < 16; code++) {
      const v = applyCode(sig, step, code)
      const err = Math.abs(v - x)
      if (err < bestErr) {
        bestErr = err
        best = code
        bestSig = v
      }
    }
    bytes[i >> 1] = (bytes[i >> 1] ?? 0) | (i & 1 ? best << 4 : best)
    sig = bestSig
    step = nextStep(step, best & 7)
    decoded[i] = sig
  }
  return { bytes, decoded }
}

/** Generated (recipe) PCM -> 4-bit ADPCM round trip as the AICA plays it. */
export function processForAicaAdpcm(raw: SampleResult): SampleResult {
  return result(raw, encodeAicaAdpcm(atLeast2(raw.pcm)).decoded)
}

registerSampleTarget('aica16', { process: processForAica16, bytes: (n) => aicaByteSize('pcm16', n) })
registerSampleTarget('aica8', { process: processForAica8, bytes: (n) => aicaByteSize('pcm8', n) })
registerSampleTarget('aica-adpcm', { process: processForAicaAdpcm, bytes: (n) => aicaByteSize('adpcm', n) })
