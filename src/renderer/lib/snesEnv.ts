// The SNES envelope as a curve for the editor graph: the same ADSR / GAIN rules the SPC700 voice runs
// (11-bit level, real rate table), sampled at the 32 kHz DSP rate. Pure.

import { type SnesEnvelope, SNES_RATE_PERIODS } from '../../core'

export interface EnvCurveOptions {
  /** Seconds the key is held before the release (default 1). */
  holdSec?: number
  /** Seconds shown after the key-off (default 0.4). */
  releaseSec?: number
  /** Number of points returned (default 160). */
  points?: number
}

const RATE = 32000

/** Envelope level 0..1 sampled over hold + release. The release is the hardware key-off ramp (8 per step). */
export function snesEnvelopeCurve(env: SnesEnvelope, opts: EnvCurveOptions = {}): number[] {
  const hold = Math.round((opts.holdSec ?? 1) * RATE)
  const total = hold + Math.round((opts.releaseSec ?? 0.4) * RATE)
  const points = Math.max(2, opts.points ?? 160)
  const out: number[] = []
  const stride = total / (points - 1)
  let next = 0
  let level = 0
  let mode: 'attack' | 'decay' | 'sustain' | 'gain' | 'release' = 'attack'
  let a = 0
  let d = 0
  let sl = 0
  let sr = 0
  let gm = 'direct'
  let gr = 0
  if ('adsr' in env) {
    ;[a, d, sl, sr] = env.adsr
  } else {
    mode = 'gain'
    gm = env.gain.mode
    gr = env.gain.rate
    level = gm === 'direct' ? Math.min(2047, gr * 16) : gm === 'linear-dec' || gm === 'exp-dec' ? 2047 : 0
  }
  const fire = (period: number, t: number): boolean => period > 0 && t % period === 0
  for (let t = 1; t <= total; t++) {
    if (t === hold) mode = 'release'
    switch (mode) {
      case 'attack': {
        const rate = a * 2 + 1
        if (fire(SNES_RATE_PERIODS[rate]!, t)) {
          level += rate === 31 ? 1024 : 32
          if (level >= 0x7e0) mode = 'decay'
          level = Math.min(level, 0x7ff)
        }
        break
      }
      case 'decay':
        if (fire(SNES_RATE_PERIODS[d * 2 + 16]!, t)) {
          level = Math.max(0, level - (((level - 1) >> 8) + 1))
          if (level >> 8 === sl) mode = 'sustain'
        }
        break
      case 'sustain':
        if (fire(SNES_RATE_PERIODS[sr]!, t)) level = Math.max(0, level - (((level - 1) >> 8) + 1))
        break
      case 'gain':
        if (gm === 'direct') level = Math.min(2047, gr * 16)
        else if (fire(SNES_RATE_PERIODS[gr]!, t)) {
          if (gm === 'linear-dec') level -= 32
          else if (gm === 'exp-dec') level -= ((level - 1) >> 8) + 1
          else if (gm === 'linear-inc') level += 32
          else level += level < 0x600 ? 32 : 8
          level = Math.max(0, Math.min(2047, level))
        }
        break
      default:
        level = Math.max(0, level - 8)
    }
    if (t >= next) {
      out.push(level / 2047)
      next += stride
    }
  }
  while (out.length < points) out.push(level / 2047)
  return out.slice(0, points)
}

/** Time in seconds for the attack to reach full level (for the editor's readout); Infinity for GAIN modes that never do. */
export function snesAttackSeconds(env: SnesEnvelope): number {
  if (!('adsr' in env)) return env.gain.mode === 'direct' ? 0 : Infinity
  const rate = env.adsr[0] * 2 + 1
  if (rate === 31) return 2 / RATE
  return (63 * SNES_RATE_PERIODS[rate]!) / RATE
}
