// Frequency / period tables and quantization helpers shared by the chip voices.
// Pure TypeScript, no allocation after module load.

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------------------------
// NES 2A03

export const NES_CPU_NTSC = 1789773
export const NES_CPU_PAL = 1662607

export function nesCpuHz(region: 'ntsc' | 'pal'): number {
  return region === 'pal' ? NES_CPU_PAL : NES_CPU_NTSC
}

/** Pulse timer reload value t (0..2047): f = cpu / (16 (t + 1)). */
export function nesPulsePeriod(freqHz: number, cpuHz: number): number {
  return clamp(Math.round(cpuHz / (16 * freqHz)) - 1, 0, 2047)
}
export function nesPulseFreq(period: number, cpuHz: number): number {
  return cpuHz / (16 * (period + 1))
}
/** Triangle timer reload value (32 steps per cycle): f = cpu / (32 (t + 1)). */
export function nesTriPeriod(freqHz: number, cpuHz: number): number {
  return clamp(Math.round(cpuHz / (32 * freqHz)) - 1, 0, 2047)
}
export function nesTriFreq(period: number, cpuHz: number): number {
  return cpuHz / (32 * (period + 1))
}

/** Noise timer periods in CPU cycles per LFSR clock, index 0 = fastest. */
export const NES_NOISE_PERIODS_NTSC: readonly number[] = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068
]
export const NES_NOISE_PERIODS_PAL: readonly number[] = [
  4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778
]

/**
 * Noise "pitch" to period index (FamiTracker style): the note number modulo 16 picks the period,
 * higher notes are faster. Index 0 = fastest.
 */
export function noisePeriodIndex(semis: number): number {
  return 15 - (Math.round(semis) & 15)
}

/** NES pulse duty sequences (8 steps). Index = duty 0..3 = 12.5%, 25%, 50%, 75% (inverted 25%). */
export const NES_DUTY: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1]
]

/** NES triangle 32-step sequence. */
export const NES_TRI_SEQ: readonly number[] = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
]

// ---------------------------------------------------------------------------------------------
// Game Boy DMG

export const GB_CLOCK = 4194304

/** Pulse period register x (0..2047): f = 131072 / (2048 - x). */
export function gbPulsePeriod(freqHz: number): number {
  return clamp(2048 - Math.round(131072 / freqHz), 0, 2047)
}
export function gbPulseFreq(x: number): number {
  return 131072 / (2048 - x)
}
/** Wave period register x (0..2047), 32 samples per cycle: f = 65536 / (2048 - x). */
export function gbWavePeriod(freqHz: number): number {
  return clamp(2048 - Math.round(65536 / freqHz), 0, 2047)
}
export function gbWaveFreq(x: number): number {
  return 65536 / (2048 - x)
}

/** GB pulse duty sequences, index 0..3 = 12.5%, 25%, 50%, 75%. */
export const GB_DUTY: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0]
]

/**
 * GB noise: LFSR clock periods in CPU clocks, index 0 = fastest (same ordering as the NES table).
 * Hardware: (r ? r * 16 : 8) << s clocks; we use 16 (r, s) pairs spread over the useful range.
 */
export const GB_NOISE_CLOCKS: readonly number[] = (() => {
  const out: number[] = []
  for (let i = 0; i < 16; i++) {
    const s = 3 + (i >> 1)
    const r = i & 1 ? 4 : 3
    out.push((r * 16) << s)
  }
  return out
})()

// ---------------------------------------------------------------------------------------------
// misc

/** dB to linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}
