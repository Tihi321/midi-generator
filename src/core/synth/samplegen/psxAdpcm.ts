// The PS1 SPU sample target ('psx'): PS-X ADPCM, 16-byte blocks of 28 samples.
//
// Phase B0 scaffolding: the target is registered with PASS-THROUGH processors (PCM16 at the sample's own rate, no
// codec) and the real RAM size (16 bytes per 28 samples), so the PS1 chip can be created, validated and saved.
// Phase B replaces `processForPsx` / `processUserPcmForPsx` with the closed-loop ADPCM encoder (loop start aligned to
// 28-sample blocks, user PCM above 48 kHz resampled to 44.1 kHz) and may set `userRate`.

import { type SampleResult, registerSampleTarget } from './bank'

export const PSX_BLOCK_SAMPLES = 28
export const PSX_BLOCK_BYTES = 16

/** SPU RAM bytes of `samples` PCM samples: ceil(n / 28) * 16. */
export function psxByteSize(samples: number): number {
  return Math.ceil(samples / PSX_BLOCK_SAMPLES) * PSX_BLOCK_BYTES
}

/** Generated (recipe) PCM -> what the SPU plays. Pass-through until Phase B. */
export function processForPsx(raw: SampleResult): SampleResult {
  return raw
}

/** User PCM -> what the SPU plays. Pass-through until Phase B. */
export function processUserPcmForPsx(raw: SampleResult): SampleResult {
  return raw
}

registerSampleTarget('psx', { process: processForPsx, userPcm: processUserPcmForPsx, bytes: psxByteSize })
