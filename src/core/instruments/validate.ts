// Structural validation of instrument data (ranges, array lengths). Chip/channel rules live in chips/validate.ts.

import type { AicaSampleInstrument, FmOp, GbEnvelope, Instrument, InstrumentKind, PsxSampleInstrument, SnesEnvelope } from '../types'
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

const PSX_ADSR_RANGES: [string, number, number][] = [
  ['attack', 0, 127], ['decay', 0, 15], ['sustainLevel', 0, 15], ['sustainRate', 0, 127], ['release', 0, 31]
]
const AICA_FORMATS = ['pcm16', 'pcm8', 'adpcm']
const AICA_LFO_WAVES = ['saw', 'square', 'tri', 'noise']

function checkBool(v: unknown, name: string, out: string[]): void {
  if (typeof v !== 'boolean') out.push(`${name} must be true or false.`)
}

function checkSampleRef(inst: { sample: unknown; baseNote: unknown; fine?: unknown }, out: string[]): void {
  if (typeof inst.sample !== 'string' || inst.sample === '') out.push('sample must be a sample slot id.')
  if (!intIn(inst.baseNote, 0, 127)) out.push(`baseNote ${String(inst.baseNote)} must be a MIDI note 0..127.`)
  if (inst.fine !== undefined && (typeof inst.fine !== 'number' || !Number.isFinite(inst.fine))) out.push('fine must be a number of cents.')
}

function checkPsx(inst: PsxSampleInstrument, out: string[]): void {
  checkSampleRef(inst, out)
  const a = inst.adsr
  if (!a || typeof a !== 'object') {
    out.push('missing "adsr" {attack 0..127, attackExp, decay 0..15, sustainLevel 0..15, sustainRate 0..127, sustainDir "dec"|"inc", sustainExp, release 0..31, releaseExp}.')
  } else {
    for (const [k, lo, hi] of PSX_ADSR_RANGES) {
      const v = (a as unknown as Record<string, unknown>)[k]
      if (!intIn(v, lo, hi)) out.push(`adsr.${k} ${String(v)} must be an integer ${lo}..${hi}${lo === 0 && k !== 'sustainLevel' ? ' (0 = fastest)' : ''}.`)
    }
    if (a.sustainDir !== 'dec' && a.sustainDir !== 'inc') out.push('adsr.sustainDir must be "dec" or "inc".')
    for (const k of ['attackExp', 'sustainExp', 'releaseExp'] as const) checkBool(a[k], `adsr.${k}`, out)
  }
  checkBool(inst.reverb, 'reverb', out)
  if (inst.pmod !== undefined) checkBool(inst.pmod, 'pmod', out)
  if (inst.noise !== undefined) {
    if (!inst.noise || typeof inst.noise !== 'object') out.push('noise must be {shift 0..15, step 0..3}.')
    else {
      if (!intIn(inst.noise.shift, 0, 15)) out.push(`noise.shift ${String(inst.noise.shift)} must be an integer 0..15.`)
      if (!intIn(inst.noise.step, 0, 3)) out.push(`noise.step ${String(inst.noise.step)} must be an integer 0..3.`)
    }
  }
}

function checkAica(inst: AicaSampleInstrument, out: string[]): void {
  checkSampleRef(inst, out)
  if (!AICA_FORMATS.includes(inst.format)) out.push(`format must be one of ${AICA_FORMATS.join(', ')}.`)
  const g = inst.aeg
  if (!g || typeof g !== 'object') out.push('missing "aeg" {ar, d1r, d2r, rr 0..31 (31 = fastest), dl 0..31, krs? 0..15}.')
  else {
    for (const k of ['ar', 'd1r', 'd2r', 'rr', 'dl'] as const) {
      if (!intIn(g[k], 0, 31)) out.push(`aeg.${k} ${String(g[k])} must be an integer 0..31.`)
    }
    if (g.krs !== undefined && !intIn(g.krs, 0, 15)) out.push(`aeg.krs ${String(g.krs)} must be an integer 0..15.`)
  }
  const f = inst.filter
  if (f !== undefined) {
    if (!f || typeof f !== 'object') out.push('filter must be {q 0..31, flv [5 x 0..8191], far, fd1r, fd2r, frr 0..31}.')
    else {
      if (!intIn(f.q, 0, 31)) out.push(`filter.q ${String(f.q)} must be an integer 0..31.`)
      if (!Array.isArray(f.flv) || f.flv.length !== 5 || !f.flv.every((v) => intIn(v, 0, 8191))) out.push('filter.flv must be exactly 5 integers 0..8191 (FLV0..FLV4).')
      for (const k of ['far', 'fd1r', 'fd2r', 'frr'] as const) {
        if (!intIn(f[k], 0, 31)) out.push(`filter.${k} ${String(f[k])} must be an integer 0..31.`)
      }
    }
  }
  const l = inst.lfo
  if (l !== undefined) {
    if (!l || typeof l !== 'object') out.push('lfo must be {freq 0..31, pitchWave, pitchDepth 0..7, ampWave, ampDepth 0..7, reset}.')
    else {
      if (!intIn(l.freq, 0, 31)) out.push(`lfo.freq ${String(l.freq)} must be an integer 0..31.`)
      for (const k of ['pitchWave', 'ampWave'] as const) {
        if (!AICA_LFO_WAVES.includes(l[k])) out.push(`lfo.${k} must be one of ${AICA_LFO_WAVES.join(', ')}.`)
      }
      for (const k of ['pitchDepth', 'ampDepth'] as const) {
        if (!intIn(l[k], 0, 7)) out.push(`lfo.${k} ${String(l[k])} must be an integer 0..7.`)
      }
      checkBool(l.reset, 'lfo.reset', out)
    }
  }
  if (!intIn(inst.send, 0, 15)) out.push(`send ${String(inst.send)} must be an integer 0..15 (DSP send level).`)
}

// ---------------------------------------------------------------------------------------------
// Chip-specific instrument rules: a chip module (chips/ps1.ts, chips/dreamcast.ts) registers extra checks for its
// own kind here, so the shared range checks above never need to change.

export type InstrumentRule = (inst: Instrument) => string[]
const kindRules = new Map<InstrumentKind, InstrumentRule[]>()

/** Add a check run by validateInstrument after the shared checks of `kind` (returns LLM-readable problems). */
export function registerInstrumentRule(kind: InstrumentKind, rule: InstrumentRule): void {
  const list = kindRules.get(kind) ?? []
  list.push(rule)
  kindRules.set(kind, list)
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
    case 'psx-sample':
      checkPsx(inst, out)
      break
    case 'aica-sample':
      checkAica(inst, out)
      break
  }
  for (const rule of kindRules.get(inst.kind) ?? []) out.push(...rule(inst))
  if ('macros' in inst) out.push(...validateMacros(inst.macros))
  if (inst.gm) {
    if (inst.gm.program !== undefined && !intIn(inst.gm.program, 0, 127)) out.push('gm.program must be 0..127.')
    if (inst.gm.drumNote !== undefined && !intIn(inst.gm.drumNote, 0, 127)) out.push('gm.drumNote must be 0..127.')
  }
  return out
}
