// The envelope times of a SNES envelope, in seconds, so the PS1 and Dreamcast baseline banks (presets/ps1.ts,
// presets/dreamcast.ts) can approximate each SNES preset's attack, decay and sustain with their own rate registers.
//
// Model (from the S-DSP envelope code in synth/chips/spc700.ts, which counts 32 kHz steps):
//  - attack:  the level climbs 32 of 2047 every `period` steps (64 steps), rate 31 (ADSR attack 15) is instant;
//  - decay and sustain: the level falls by 1/256 of itself every `period` steps, an exponential with the time
//    constant `256 * period / 32000` s;
//  - sustain rate 0 holds, `release` (^^^) is the voice's soft release: period 12.

import type { SnesEnvelope } from '../../types'

/** Steps between envelope updates for rate index 0..31 (0 = never); the same table as SNES_RATE_PERIODS in spc700.ts. */
const PERIODS: readonly number[] = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
  64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
]
const DSP_RATE = 32000

export interface SnesEnvTimes {
  /** Seconds from silence to full level (0 = instant). */
  attackSec: number
  /** Exponential time constant of the decay phase, seconds. */
  decayTauSec: number
  /** Level the decay stops at, 0..1 of full. */
  sustainLevel: number
  /** Exponential time constant of the sustain phase in seconds; null = the level is held. */
  sustainTauSec: number | null
  /** Exponential time constant of the release (^^^), seconds. */
  releaseTauSec: number
}

const tauOf = (period: number): number => (256 * period) / DSP_RATE
/** SNES soft release: an update every 12 steps. */
export const SNES_RELEASE_TAU_SEC = tauOf(12)

/** Times of an ADSR or GAIN envelope. */
export function snesEnvTimes(env: SnesEnvelope): SnesEnvTimes {
  const out: SnesEnvTimes = { attackSec: 0, decayTauSec: tauOf(PERIODS[16]!), sustainLevel: 1, sustainTauSec: null, releaseTauSec: SNES_RELEASE_TAU_SEC }
  if ('adsr' in env) {
    const [a, d, sl, sr] = env.adsr
    const attackRate = a * 2 + 1
    out.attackSec = attackRate >= 31 ? 0 : (64 * PERIODS[attackRate]!) / DSP_RATE
    out.decayTauSec = tauOf(PERIODS[d * 2 + 16]!)
    out.sustainLevel = (sl + 1) / 8
    out.sustainTauSec = sr === 0 ? null : tauOf(PERIODS[sr]!)
    return out
  }
  const { mode, rate } = env.gain
  if (mode === 'direct') {
    out.sustainLevel = Math.max(1 / 16, Math.min(1, (rate * 16) / 2047))
    return out
  }
  const period = PERIODS[rate] ?? 0
  if (mode === 'linear-inc' || mode === 'bent-inc') {
    out.attackSec = period > 0 ? (64 * period) / DSP_RATE : Infinity
    return out
  }
  // decay modes start from full level: a linear fall takes 64 updates, an exponential one has tau = 256 updates
  out.sustainTauSec = period > 0 ? (mode === 'exp-dec' ? tauOf(period) : (64 * period) / DSP_RATE / 3) : null
  return out
}
