// Macro data helpers: construction, text form and validation. Stepping a macro tick by tick is the
// synth's job (src/core/synth); this file is only data.
//
// Text form (FamiTracker style):  "15 12 9 | 6 3 / 0"
//   values are space separated integers; "|" marks the loop point (the sequence repeats from the next
//   value after the end), "/" marks the release point (playback continues there after note release).
// Noise instruments: a 'fixed' arp macro holds noise pitch indices 0..15 (15 = highest pitch) instead of notes.

import type { Macro, MacroName, Macros } from '../types'

export const MACRO_NAMES: readonly MacroName[] = ['vol', 'arp', 'pitch', 'timbre']

export const MACRO_RANGES: Record<MacroName, { min: number; max: number; unit: string }> = {
  vol: { min: 0, max: 15, unit: 'volume multiplier 0..15' },
  arp: { min: -96, max: 127, unit: 'semitones (rel) or MIDI note / noise index (fixed)' },
  pitch: { min: -128, max: 127, unit: '1/16 semitone per tick' },
  timbre: { min: 0, max: 255, unit: 'duty / wave index / noise mode' }
}

export const MAX_MACRO_LENGTH = 256

/** Build a macro; `hold` makes it sustain its last value until release. */
export function createMacro(values: number[], opts: { loop?: number; release?: number; mode?: 'rel' | 'fixed'; hold?: boolean } = {}): Macro {
  const m: Macro = { values: [...values] }
  if (opts.loop !== undefined) m.loop = opts.loop
  else if (opts.hold && values.length > 0) m.loop = values.length - 1
  if (opts.release !== undefined) m.release = opts.release
  if (opts.mode !== undefined) m.mode = opts.mode
  return m
}

export function parseMacro(text: string, mode?: 'rel' | 'fixed'): Macro {
  const values: number[] = []
  let loop: number | undefined
  let release: number | undefined
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    if (tok === '|') {
      if (loop !== undefined) throw new Error(`Macro "${text}" has two loop markers "|"; use at most one.`)
      loop = values.length
    } else if (tok === '/') {
      if (release !== undefined) throw new Error(`Macro "${text}" has two release markers "/"; use at most one.`)
      release = values.length
    } else {
      const n = Number(tok)
      if (!Number.isInteger(n)) throw new Error(`Macro value "${tok}" is not an integer (in "${text}").`)
      values.push(n)
    }
  }
  const m: Macro = { values }
  if (loop !== undefined) m.loop = loop
  if (release !== undefined) m.release = release
  if (mode) m.mode = mode
  return m
}

export function formatMacro(macro: Macro): string {
  const out: string[] = []
  macro.values.forEach((v, i) => {
    if (macro.loop === i) out.push('|')
    if (macro.release === i) out.push('/')
    out.push(String(v))
  })
  return out.join(' ')
}

/** Problems with a macro (empty array = valid). */
export function validateMacro(name: MacroName, macro: Macro): string[] {
  const out: string[] = []
  const range = MACRO_RANGES[name]
  if (!macro || !Array.isArray(macro.values) || macro.values.length === 0) {
    return [`${name} macro needs at least one value.`]
  }
  if (macro.values.length > MAX_MACRO_LENGTH) out.push(`${name} macro has ${macro.values.length} values (max ${MAX_MACRO_LENGTH}).`)
  const lo = name === 'arp' && macro.mode === 'fixed' ? 0 : range.min
  macro.values.forEach((v, i) => {
    if (!Number.isInteger(v) || v < lo || v > range.max) {
      out.push(`${name} macro value #${i} = ${v} is out of range ${lo}..${range.max} (${range.unit}).`)
    }
  })
  const n = macro.values.length
  if (macro.loop !== undefined && (!Number.isInteger(macro.loop) || macro.loop < 0 || macro.loop >= n)) {
    out.push(`${name} macro loop index ${macro.loop} must be 0..${n - 1}.`)
  }
  if (macro.release !== undefined && (!Number.isInteger(macro.release) || macro.release < 0 || macro.release >= n)) {
    out.push(`${name} macro release index ${macro.release} must be 0..${n - 1}.`)
  }
  if (macro.loop !== undefined && macro.release !== undefined && macro.release <= macro.loop && macro.release !== 0) {
    out.push(`${name} macro release index ${macro.release} should come after the loop index ${macro.loop}.`)
  }
  if (macro.mode !== undefined && macro.mode !== 'rel' && macro.mode !== 'fixed') {
    out.push(`${name} macro mode must be "rel" or "fixed".`)
  }
  if (macro.mode !== undefined && name !== 'arp') out.push(`${name} macro does not use "mode" (arp only).`)
  return out
}

export function validateMacros(macros: Macros | undefined): string[] {
  if (!macros) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(macros)) {
    if (!(MACRO_NAMES as readonly string[]).includes(k)) {
      out.push(`Unknown macro "${k}"; use ${MACRO_NAMES.join(', ')}.`)
      continue
    }
    if (v) out.push(...validateMacro(k as MacroName, v))
  }
  return out
}
