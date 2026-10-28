// The Dreamcast AICA sample targets: 'aica16' (PCM16), 'aica8' (PCM8) and 'aica-adpcm' (Yamaha 4-bit ADPCM). An
// aica-sample instrument's `format` ('pcm16' | 'pcm8' | 'adpcm') picks the target (see `aicaTargetFor`).
//
// Phase B0 scaffolding: the targets are registered with PASS-THROUGH processors (PCM16 at the sample's own rate, no
// quantization or codec) and the real RAM sizes (2, 1 and 0.5 bytes per sample), so the chip can be created,
// validated and saved. Phase C replaces `processForAica16` / `processForAica8` / `processForAicaAdpcm` with the
// bit-exact PCM16 path, the 8-bit quantizer and the ADPCM round trip.

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

/** Generated (recipe) PCM -> 16-bit PCM as the AICA plays it. Pass-through until Phase C. */
export function processForAica16(raw: SampleResult): SampleResult {
  return raw
}

/** Generated (recipe) PCM -> 8-bit PCM as the AICA plays it. Pass-through until Phase C. */
export function processForAica8(raw: SampleResult): SampleResult {
  return raw
}

/** Generated (recipe) PCM -> 4-bit ADPCM round trip as the AICA plays it. Pass-through until Phase C. */
export function processForAicaAdpcm(raw: SampleResult): SampleResult {
  return raw
}

registerSampleTarget('aica16', { process: processForAica16, bytes: (n) => aicaByteSize('pcm16', n) })
registerSampleTarget('aica8', { process: processForAica8, bytes: (n) => aicaByteSize('pcm8', n) })
registerSampleTarget('aica-adpcm', { process: processForAicaAdpcm, bytes: (n) => aicaByteSize('adpcm', n) })
