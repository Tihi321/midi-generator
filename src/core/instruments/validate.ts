// Structural validation of instrument data (ranges, array lengths). Chip/channel rules live in chips/validate.ts.

import type { FmOp, GbEnvelope, Instrument, SnesEnvelope } from '../types'
import { INSTRUMENT_KINDS } from './types'
import { validateMacros } from './macros'

function intIn(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
}

function checkEnv(env: GbEnvelope | undefined, out: string[]): void {
  if (!env) {
    out.push('missing "env" {init 0..15, dir "up"|"down", pace 0..7}.')
    return
  }
  if (!intIn(env.init, 0, 15)) out.push(`env.init ${env.init} must be an integer 0..15.`)
  if (env.dir !== 'up' && env.dir !== 'down') out.push(`env.dir must be "up" or "down".`)
  if (!intIn(env.pace, 0, 7)) out.push(`env.pace ${env.pace} must be an integer 0..7 (0 = constant volume).`)
}

const FM_OP_RANGES: [keyof FmOp, number, number][] = [
  ['ar', 0, 31], ['dr', 0, 31], ['sr', 0, 31], ['rr', 0, 15], ['sl', 0, 15],
  ['tl', 0, 127], ['ks', 0, 3], ['ml', 0, 15], ['dt', -3, 3]
]

function checkSnesEnv(env: SnesEnvelope | undefined, out: string[]): void {
  if (!env) {
    out.push('missing "env" ({adsr:[attack 0..15, decay 0..7, sustainLevel 0..7, sustainRate 0..31]} or {gain:{mode, rate}}).')
    return
  }
  if ('adsr' in env) {
    const a = env.adsr
    if (!Array.isArray(a) || a.length !== 4) {
      out.push('env.adsr must be [attack, decay, sustainLevel, sustainRate].')
      return
    }
    const lim = [15, 7, 7, 31]
    const names = ['attack', 'decay', 'sustainLevel', 'sustainRate']
    a.forEach((v, i) => {
      if (!intIn(v, 0, lim[i]!)) out.push(`env.adsr ${names[i]} ${v} must be an integer 0..${lim[i]}.`)
    })
  } else if ('gain' in env) {
    const modes = ['direct', 'linear-dec', 'exp-dec', 'linear-inc', 'bent-inc']
    if (!modes.includes(env.gain.mode)) out.push(`env.gain.mode must be one of ${modes.join(', ')}.`)
    const max = env.gain.mode === 'direct' ? 127 : 31
    if (!intIn(env.gain.rate, 0, max)) out.push(`env.gain.rate ${env.gain.rate} must be an integer 0..${max} for mode "${env.gain.mode}".`)
  } else {
    out.push('env must contain "adsr" or "gain".')
  }
}

/** Problems with the instrument's own data (empty array = valid). Messages are LLM-readable. */
export function validateInstrument(inst: Instrument): string[] {
  const out: string[] = []
  if (!inst || typeof inst !== 'object') return ['instrument must be an object.']
  if (typeof inst.name !== 'string' || inst.name.trim() === '') out.push('name must be a non-empty string.')
  if (!INSTRUMENT_KINDS.includes(inst.kind)) {
    return [...out, `unknown kind "${(inst as { kind: string }).kind}"; use one of ${INSTRUMENT_KINDS.join(', ')}.`]
  }
  switch (inst.kind) {
    case 'nes-pulse':
    case 'nes-tri':
    case 'nes-noise':
    case 'psg':
    case 'psg-noise':
      if (!inst.macros || typeof inst.macros !== 'object') out.push('missing "macros" object (may be empty).')
      break
    case 'gb-pulse':
      checkEnv(inst.env, out)
      if (inst.duty !== undefined && !intIn(inst.duty, 0, 3)) out.push(`duty ${inst.duty} must be 0..3 (12.5%, 25%, 50%, 75%).`)
      if (inst.sweep) {
        if (!intIn(inst.sweep.pace, 0, 7)) out.push('sweep.pace must be 0..7.')
        if (!intIn(inst.sweep.step, 0, 7)) out.push('sweep.step must be 0..7.')
        if (inst.sweep.dir !== 'up' && inst.sweep.dir !== 'down') out.push('sweep.dir must be "up" or "down".')
      }
      break
    case 'gb-noise':
      checkEnv(inst.env, out)
      break
    case 'gb-wave':
      if (!Array.isArray(inst.wave) || inst.wave.length !== 32 || !inst.wave.every((v) => intIn(v, 0, 15))) {
        out.push('wave must be exactly 32 integers 0..15.')
      }
      if (!intIn(inst.level, 0, 3)) out.push(`level ${inst.level} must be 0 (mute), 1 (100%), 2 (50%) or 3 (25%).`)
      break
    case 'pce-wave':
      if (!Array.isArray(inst.waves) || inst.waves.length === 0) out.push('waves must be a non-empty array of 32-sample waves.')
      else {
        inst.waves.forEach((w, i) => {
          if (!Array.isArray(w) || w.length !== 32 || !w.every((v) => intIn(v, 0, 31))) {
            out.push(`waves[${i}] must be exactly 32 integers 0..31.`)
          }
        })
        if (inst.waves.length > 64) out.push('at most 64 waves per instrument.')
      }
      if (!inst.macros || typeof inst.macros !== 'object') out.push('missing "macros" object (may be empty).')
      break
    case 'fm':
      if (!intIn(inst.alg, 0, 7)) out.push(`alg ${inst.alg} must be 0..7.`)
      if (!intIn(inst.fb, 0, 7)) out.push(`fb ${inst.fb} must be 0..7.`)
      if (!intIn(inst.ams, 0, 3)) out.push(`ams ${inst.ams} must be 0..3.`)
      if (!intIn(inst.pms, 0, 7)) out.push(`pms ${inst.pms} must be 0..7.`)
      if (!Array.isArray(inst.ops) || inst.ops.length !== 4) out.push('ops must contain exactly 4 operators (OP1..OP4).')
      else {
        inst.ops.forEach((op, i) => {
          for (const [k, lo, hi] of FM_OP_RANGES) {
            if (!intIn(op[k], lo, hi)) out.push(`op${i + 1}.${k} ${String(op[k])} must be an integer ${lo}..${hi}.`)
          }
          if (op.ssg !== undefined && !intIn(op.ssg, 0, 15)) out.push(`op${i + 1}.ssg must be 0..15.`)
        })
      }
      break
    case 'snes-sample':
      if (typeof inst.sample !== 'string' || inst.sample === '') out.push('sample must be a sample slot id.')
      if (!intIn(inst.baseNote, 0, 127)) out.push(`baseNote ${inst.baseNote} must be a MIDI note 0..127.`)
      checkSnesEnv(inst.env, out)
      if (typeof inst.echo !== 'boolean') out.push('echo must be true or false.')
      break
    case 'sample':
      if (typeof inst.sample !== 'string' || inst.sample === '') out.push('sample must be a sample slot id.')
      if (inst.baseNote !== undefined && !intIn(inst.baseNote, 0, 127)) out.push(`baseNote ${inst.baseNote} must be a MIDI note 0..127.`)
      break
  }
  if ('macros' in inst) out.push(...validateMacros(inst.macros))
  if (inst.gm) {
    if (inst.gm.program !== undefined && !intIn(inst.gm.program, 0, 127)) out.push('gm.program must be 0..127.')
    if (inst.gm.drumNote !== undefined && !intIn(inst.gm.drumNote, 0, 127)) out.push('gm.drumNote must be 0..127.')
  }
  return out
}
