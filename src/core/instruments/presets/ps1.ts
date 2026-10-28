// PS1 preset bank. Phase B0 baseline: one preset per SNES preset (same recipe slots, so the same sounds), with the
// SNES envelope mapped to PS1 ADSR register values by `snesToPsxAdsr` and SNES echo becoming the reverb send. Ids are
// `ps1.<role>.<name>` (the SNES id with its prefix swapped). Phase B tunes the mapper by ear; Phase D1 appends the
// synthwave presets of the preset-id contract.
//
// PS1 envelope rates (psx-spx): every rate field counts from 0 = fastest. The linear attack of rate r (shift = r >> 2,
// step = 7 - (r & 3)) adds `step << max(0, 11 - shift)` to the 15-bit level every `1 << max(0, shift - 11)` samples;
// the exponential decay/sustain/release steps scale with the level, so they are exponentials with the time constants
// computed by `psxDecayTauSec` / `psxSustainTauSec`.

import type { PsxAdsr, PsxSampleInstrument, SnesEnvelope, SnesSampleInstrument } from '../../types'
import type { Preset } from './types'
import { SNES_PRESETS } from './snes'
import { snesEnvTimes } from './snesTimes'

const SPU_RATE = 44100

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

/** Seconds of the linear attack from silence to full level for an attack rate 0..127. */
export function psxAttackSeconds(rate: number): number {
  const shift = rate >> 2
  const step = 7 - (rate & 3)
  const perCycle = step * 2 ** Math.max(0, 11 - shift)
  return (32767 / perCycle) * 2 ** Math.max(0, shift - 11) / SPU_RATE
}

/** Time constant in seconds of the exponential decrease with a shift 0..31 and a step magnitude 5..8 (release: step 8). */
function expTauSec(shift: number, stepMagnitude: number): number {
  return (32768 / (stepMagnitude * 2 ** Math.max(0, 11 - shift))) * 2 ** Math.max(0, shift - 11) / SPU_RATE
}
/** Decay phase (shift 0..15, step 8, always exponential). */
export const psxDecayTauSec = (decay: number): number => expTauSec(decay, 8)
/** Sustain phase decreasing exponentially with a rate 0..127. */
export const psxSustainTauSec = (rate: number): number => expTauSec(rate >> 2, 8 - (rate & 3))
/** Release phase (shift 0..31, step 8, exponential). */
export const psxReleaseTauSec = (release: number): number => expTauSec(release, 8)

/** The rate in 0..hi whose time (from `seconds`) is closest to `target` in ratio. */
function nearestRate(target: number, hi: number, seconds: (rate: number) => number): number {
  if (!(target > 0)) return 0
  if (!Number.isFinite(target)) return hi
  let best = 0
  let bestErr = Infinity
  for (let r = 0; r <= hi; r++) {
    const err = Math.abs(Math.log(seconds(r) / target))
    if (err < bestErr) {
      bestErr = err
      best = r
    }
  }
  return best
}

/** Approximate a SNES ADSR/GAIN envelope with PS1 ADSR values: same attack time, decay, sustain level and release. */
export function snesToPsxAdsr(env: SnesEnvelope): PsxAdsr {
  const t = snesEnvTimes(env)
  return {
    attack: nearestRate(t.attackSec, 127, psxAttackSeconds),
    attackExp: false,
    decay: nearestRate(t.decayTauSec, 15, psxDecayTauSec),
    // PS1 sustain level (n + 1) / 16 of full against the SNES (sl + 1) / 8
    sustainLevel: clampInt(t.sustainLevel * 16 - 1, 0, 15),
    // rate 127 is the slowest decrease: it holds the level
    sustainRate: t.sustainTauSec === null ? 127 : nearestRate(t.sustainTauSec, 127, psxSustainTauSec),
    sustainDir: 'dec',
    sustainExp: true,
    release: nearestRate(t.releaseTauSec, 31, psxReleaseTauSec),
    releaseExp: true
  }
}

function fromSnes(p: Preset): Preset {
  const s = p.instrument as SnesSampleInstrument
  const instrument: PsxSampleInstrument = {
    kind: 'psx-sample',
    name: s.name,
    sample: s.sample,
    baseNote: s.baseNote,
    adsr: snesToPsxAdsr(s.env),
    reverb: s.echo
  }
  return {
    id: p.id.replace(/^snes\./, 'ps1.'),
    name: p.name,
    role: p.role,
    description: p.description.replace(/SNES/g, 'PS1').replace(/\bEcho\b/g, 'Reverb').replace(/\becho\b/g, 'reverb'),
    channelKinds: [...p.channelKinds],
    instrument,
    ...(p.sample ? { sample: structuredClone(p.sample) } : {})
  }
}

export const PS1_PRESETS: Preset[] = SNES_PRESETS.map(fromSnes)
