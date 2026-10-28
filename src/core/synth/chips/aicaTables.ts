// Dreamcast AICA register tables as data, taken from the AICA / SCSP register documentation (not from any emulator):
// the AEG rate-to-time tables, the LFO frequency / depth tables, the TL / IMXL / DIPAN attenuation steps and the
// filter resonance step. Pure and side-effect free, so the preset mapper (instruments/presets/dreamcast.ts), the voice
// (aica.ts) and the RAM budget can all import it.
//
// Values I could only recall approximately are marked "modelled" below; they are tuned to the documented ranges, not
// copied from a table.

/** The AICA runs its slots at 44.1 kHz. */
export const AICA_RATE = 44100

// ---------------------------------------------------------------------------------------------
// AEG: 10-bit attenuation, 0.09375 dB per unit (0 = full level, 1023 = -96 dB = silence)

export const AEG_MAX = 1023
export const AEG_DB_PER_UNIT = 0.09375

/**
 * The documented EG rate tables are indexed by a 6-bit rate: the 5-bit register value times 2 plus the key-rate-scaling
 * correction. Within a group of four rates the times run 6 : 7 : 8 : 10 (relative step sizes) and every group of four is
 * half as long as the one before. Attack from silence to full level takes 8.1 s at rate 2; a 96 dB decay or release takes
 * 118.2 s at rate 2 (the published table starts 118.2, 101.3, 88.6, 70.9, 59.1, 50.7 ... seconds). Rate 0 and 1 do not move.
 */
const GROUP_STEP = [6, 7, 8, 10]
const ATTACK_BASE_SEC = 8.1
const FALL_BASE_SEC = 118.2

function rateTime(base: number, rate6: number): number {
  if (rate6 < 2) return Infinity
  const k = rate6 - 2
  return base / ((GROUP_STEP[k & 3]! / 6) * 2 ** (k >> 2))
}

/** Seconds from silence to full level for a 6-bit attack rate (rates 62 and 63 are instant). */
export function aicaAttackTime6(rate6: number): number {
  return rate6 >= 62 ? 0 : rateTime(ATTACK_BASE_SEC, rate6)
}
/** Seconds for a 96 dB fall (decay or release) at a 6-bit rate. */
export function aicaFallTime6(rate6: number): number {
  return rateTime(FALL_BASE_SEC, rate6)
}

/** The 6-bit rate of a 5-bit AEG register value (0 stays 0 = no change) with a key-rate-scaling correction. */
export function aicaRate6(rate5: number, correction = 0): number {
  return rate5 <= 0 ? 0 : Math.min(63, rate5 * 2 + Math.max(0, correction))
}

/**
 * Key rate scaling correction in 6-bit rate steps: KRS 15 (or none) = no scaling; otherwise the envelope speeds up with
 * the octave of the note's pitch register (OCT -8..7): correction = max(0, OCT + 8 - KRS). Modelled: the manual gives
 * the scaling as a function of KRS and OCT but I do not have its exact table.
 */
export function aicaKeyScale(krs: number | undefined, oct: number): number {
  if (krs === undefined || krs >= 15) return 0
  return Math.max(0, Math.min(15, oct + 8 - krs))
}

/** Attenuation of an AEG unit as a linear gain (unit 1023 is treated as silence). */
export const AEG_GAIN: Float64Array = (() => {
  const t = new Float64Array(AEG_MAX + 1)
  for (let i = 0; i < AEG_MAX; i++) t[i] = 10 ** ((-i * AEG_DB_PER_UNIT) / 20)
  t[AEG_MAX] = 0
  return t
})()

// ---------------------------------------------------------------------------------------------
// Levels: TL (total level, 0.375 dB steps), IMXL / DISDL (3 dB steps), DIPAN (3 dB steps per side)

export const TL_DB_PER_STEP = 0.375

/** The linear gain of a cell volume as the 8-bit TL attenuation register plays it (0.375 dB steps, 255 = silent). */
export function aicaTlGain(vol: number): number {
  if (!(vol > 0)) return 0
  const tl = Math.round(-20 * Math.log10(vol) / TL_DB_PER_STEP)
  if (tl <= 0) return 1
  if (tl >= 255) return 0
  return 10 ** ((-tl * TL_DB_PER_STEP) / 20)
}

/** DSP send gain for IMXL 0..15: 0 = off, 15 = full, 3 dB per step in between. */
export const IMXL_GAIN: Float64Array = (() => {
  const t = new Float64Array(16)
  for (let i = 1; i < 16; i++) t[i] = 10 ** ((-(15 - i) * 3) / 20)
  return t
})()

/** Quantise a -1..1 pan to the 16 DIPAN steps per side (step 15 = the far side only). */
export function aicaQuantizePan(pan: number): number {
  const s = Math.round(Math.min(1, Math.abs(pan)) * 15) / 15
  return pan < 0 ? -s : s
}

// ---------------------------------------------------------------------------------------------
// LFO

/** LFOF 0..31 in Hz (the documented LFO frequency table: 0.17 Hz .. 172.3 Hz). */
export const LFO_HZ: readonly number[] = [
  0.17, 0.19, 0.23, 0.27, 0.34, 0.39, 0.45, 0.55, 0.68, 0.78, 0.92, 1.1, 1.39, 1.6, 1.87, 2.27,
  2.87, 3.31, 3.92, 4.79, 6.15, 7.18, 8.6, 10.8, 14.4, 17.2, 21.5, 28.7, 43.1, 57.4, 86.1, 172.3
]

/** PLFOS 0..7: peak pitch deviation in cents (modelled: doubling steps from 6 to 400 cents; the manual lists a ratio table). */
export const PLFO_CENTS: readonly number[] = [0, 6, 12, 25, 50, 100, 200, 400]

/** ALFOS 0..7: peak amplitude attenuation in dB (the documented 0, 0.4, 0.8, 1.5, 3, 6, 12, 24 dB). */
export const ALFO_DB: readonly number[] = [0, 0.4, 0.8, 1.5, 3, 6, 12, 24]

// ---------------------------------------------------------------------------------------------
// Filter (FEG)

export const FLV_MAX = 8191

/** The cutoff in Hz of a 13-bit FLV value (modelled: log scale, 20 Hz at 0 up to 20 kHz at 8191; the chip's own format is internal). */
export function flvToHz(flv: number): number {
  return 20 * 2 ** ((flv / FLV_MAX) * 9.965784)
}

/** Resonance Q 0..31: 0.75 dB per step, on a Butterworth base (Q factor 0.707 at Q = 0). */
export function aicaQFactor(q: number): number {
  return 0.7071 * 10 ** ((0.75 * q) / 20)
}
