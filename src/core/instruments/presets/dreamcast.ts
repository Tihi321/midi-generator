// Dreamcast preset bank. Phase B0 baseline: one preset per SNES preset (same recipe slots, so the same sounds), with the
// SNES envelope mapped to AICA AEG values by `snesToAicaAeg` and SNES echo becoming a DSP send. Ids are
// `dreamcast.<role>.<name>` (the SNES id with its prefix swapped). All baseline presets use pcm16. Phase C tunes the
// mapper by ear; Phase D1 appends the synthwave presets of the preset-id contract.
//
// AICA AEG rates run 0..31 (0 = no change, 31 = fastest). The times below are an APPROXIMATION of the documented rate
// table (attack from silence to full about 8.1 s at rate 1, halving every 2 rates; decay/release 96 dB in about
// 118 s at rate 1, halving every 4 rates, linear in dB); Phase C replaces `aicaAttackSeconds` / `aicaFallSeconds`
// with the documented table.

import type { AicaAeg, AicaSampleInstrument, SnesEnvelope, SnesSampleInstrument } from '../../types'
import type { Preset } from './types'
import { SNES_PRESETS } from './snes'
import { snesEnvTimes } from './snesTimes'

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

/** Seconds from silence to full level for an attack rate 1..31 (approximate). */
export function aicaAttackSeconds(rate: number): number {
  return 8.1 * 2 ** (-(rate - 1) / 2)
}
/** Seconds for a 96 dB fall at a decay/release rate 1..31 (approximate). */
export function aicaFallSeconds(rate: number): number {
  return 118.2 * 2 ** (-(rate - 1) / 4)
}

function nearestRate(target: number, seconds: (rate: number) => number): number {
  let best = 1
  let bestErr = Infinity
  for (let r = 1; r <= 31; r++) {
    const err = Math.abs(Math.log(seconds(r) / target))
    if (err < bestErr) {
      bestErr = err
      best = r
    }
  }
  return best
}

/** A SNES exponential time constant as an AICA fall rate (a linear-in-dB fall of the same slope near full level). */
function fallRate(tauSec: number): number {
  // exp(-t / tau) loses 8.686 / tau dB per second, so 96 dB take 11.05 * tau
  return nearestRate(11.05 * tauSec, aicaFallSeconds)
}

/** Approximate a SNES ADSR/GAIN envelope with AICA AEG values: same attack time, decay, sustain level and release. */
export function snesToAicaAeg(env: SnesEnvelope): AicaAeg {
  const t = snesEnvTimes(env)
  const levelDb = -20 * Math.log10(Math.max(t.sustainLevel, 1e-3))
  return {
    ar: t.attackSec <= 0.001 ? 31 : Number.isFinite(t.attackSec) ? nearestRate(t.attackSec, aicaAttackSeconds) : 1,
    d1r: fallRate(t.decayTauSec),
    // D2R 0 holds the level
    d2r: t.sustainTauSec === null ? 0 : fallRate(t.sustainTauSec),
    rr: fallRate(t.releaseTauSec),
    // DL is the attenuation where D1R hands over to D2R, in 3 dB steps (0 = full level)
    dl: clampInt(levelDb / 3, 0, 31)
  }
}

function fromSnes(p: Preset): Preset {
  const s = p.instrument as SnesSampleInstrument
  const instrument: AicaSampleInstrument = {
    kind: 'aica-sample',
    name: s.name,
    sample: s.sample,
    baseNote: s.baseNote,
    format: 'pcm16',
    aeg: snesToAicaAeg(s.env),
    send: s.echo ? 10 : 0
  }
  return {
    id: p.id.replace(/^snes\./, 'dreamcast.'),
    name: p.name,
    role: p.role,
    description: p.description.replace(/SNES/g, 'Dreamcast').replace(/\bEcho\b/g, 'Reverb').replace(/\becho\b/g, 'reverb'),
    channelKinds: [...p.channelKinds],
    instrument,
    ...(p.sample ? { sample: structuredClone(p.sample) } : {})
  }
}

export const DREAMCAST_PRESETS: Preset[] = SNES_PRESETS.map(fromSnes)
