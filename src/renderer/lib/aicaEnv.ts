// The Dreamcast AICA amplitude envelope for the editor: AR / D1R / D2R / RR with the decay level DL, drawn from the
// rate-to-time functions the core uses (`aicaAttackSeconds`, `aicaFallSeconds`), so the readout follows the chip's
// table. The fall is linear in dB (96 dB over the rate's time), the attack a linear amplitude ramp: an approximate
// picture, not a register-exact curve. Also the DSP preset names for the transport. Pure.

import { type AicaAeg, type DcDspPreset, type Song, aicaAttackSeconds, aicaFallSeconds, aicaRamUsage } from '../../core'
import type { EnvCurveOptions, RamMeter } from './ps1Env'

/** Floor of the envelope in dB (the fall rates are per 96 dB). */
const FLOOR_DB = 96
/** DL steps are 3 dB of attenuation each (0 = full level). */
const DL_DB = 3

/** Seconds of the attack to full level; Infinity for rate 0 (no change). */
export function aicaAttackTime(rate: number): number {
  return rate <= 0 ? Infinity : aicaAttackSeconds(Math.min(31, rate))
}

/** Seconds a 96 dB fall takes at a D1R/D2R/RR rate; Infinity for rate 0 (no change). */
export function aicaFallTime(rate: number): number {
  return rate <= 0 ? Infinity : aicaFallSeconds(Math.min(31, rate))
}

export interface AicaEnvTimes {
  /** Silence to full level. */
  attackSec: number
  /** Full level down to the decay level DL with D1R (0 when DL = 0). */
  decay1Sec: number
  /** A full 96 dB fall at D2R after the decay level. */
  decay2Sec: number
  /** A full 96 dB fall at RR after the key-off. */
  releaseSec: number
}

export function aicaAegTimes(aeg: AicaAeg): AicaEnvTimes {
  const dlDb = Math.min(FLOOR_DB, aeg.dl * DL_DB)
  return {
    attackSec: aicaAttackTime(aeg.ar),
    decay1Sec: dlDb === 0 ? 0 : (dlDb / FLOOR_DB) * aicaFallTime(aeg.d1r),
    decay2Sec: aicaFallTime(aeg.d2r),
    releaseSec: aicaFallTime(aeg.rr)
  }
}

/** The decay level as a linear amplitude 0..1 (for the readout). */
export function aicaDecayLevel(aeg: AicaAeg): number {
  return 10 ** (-(aeg.dl * DL_DB) / 20)
}

/** Envelope amplitude 0..1 sampled over hold + release. */
export function aicaEnvelopeCurve(aeg: AicaAeg, opts: EnvCurveOptions = {}): number[] {
  const hold = opts.holdSec ?? 1
  const total = hold + (opts.releaseSec ?? 0.4)
  const points = Math.max(2, opts.points ?? 160)
  const attackSec = aicaAttackTime(aeg.ar)
  const d1 = aicaFallTime(aeg.d1r)
  const d2 = aicaFallTime(aeg.d2r)
  const rr = aicaFallTime(aeg.rr)
  const dlDb = Math.min(FLOOR_DB, aeg.dl * DL_DB)
  const dt = total / ((points - 1) * 8)
  const out: number[] = []
  let phase: 'attack' | 'decay1' | 'decay2' | 'release' = 'attack'
  let amp = 0 // attack
  let db = 0 // decay and release
  let t = 0
  const stepDb = (seconds: number): number => (Number.isFinite(seconds) ? (FLOOR_DB / seconds) * dt : 0)
  const level = (): number => (phase === 'attack' ? amp : db >= FLOOR_DB ? 0 : 10 ** (-db / 20))
  for (let k = 0; k < points; k++) {
    const target = (k / (points - 1)) * total
    while (t < target) {
      t += dt
      if (t >= hold && phase !== 'release') {
        if (phase === 'attack') db = amp > 0 ? Math.min(FLOOR_DB, -20 * Math.log10(amp)) : FLOOR_DB
        phase = 'release'
      }
      if (phase === 'attack') {
        amp = Number.isFinite(attackSec) ? Math.min(1, amp + dt / Math.max(attackSec, 1e-6)) : 0
        if (amp >= 1) {
          phase = dlDb > 0 ? 'decay1' : 'decay2'
          db = 0
        }
      } else if (phase === 'decay1') {
        db += stepDb(d1)
        if (db >= dlDb) {
          db = dlDb
          phase = 'decay2'
        }
      } else if (phase === 'decay2') {
        db += stepDb(d2)
      } else {
        db += stepDb(rr)
      }
    }
    out.push(level())
  }
  return out
}

/** AICA DSP effect presets for the transport: label and a short description (the real microcode is not emulated). */
export const DC_DSP_LABELS: Record<DcDspPreset, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'No effect (the slots still send, the bus stays silent)' },
  room: { label: 'Room', hint: 'Small room reverb' },
  hall: { label: 'Hall', hint: 'Large hall reverb' },
  plate: { label: 'Plate', hint: 'Bright plate reverb' },
  chorus: { label: 'Chorus', hint: 'Stereo chorus, no reverb' },
  'chorus-hall': { label: 'Chorus + hall', hint: 'Chorus into a hall reverb: the synthwave default' },
  delay: { label: 'Delay', hint: 'Stereo feedback delay (Delay ms, Feedback)' },
  echo: { label: 'Echo', hint: 'Ping-pong echo (Delay ms, Feedback)' },
  'chorus-delay': { label: 'Chorus + delay', hint: 'Chorus into a stereo delay' }
}

// ---------------------------------------------------------------- RAM meter

/** AICA RAM usage for the transport: samples by format + the DSP buffer against 2 MB (core `aicaRamUsage`). */
export function dcRamMeter(song: Song): RamMeter {
  const u = aicaRamUsage(song)
  return { usedBytes: u.total, totalBytes: u.budget, sampleBytes: u.sampleBytes, effectBytes: u.dspBytes }
}
