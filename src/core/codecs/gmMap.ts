// General MIDI mapping for MIDI export and import: instrument role -> GM program, drum roles -> GM percussion
// notes (MIDI channel 10), and the reverse tables used when importing a .mid file.

import type { ChannelKind, Instrument, Role } from '../types'
import { ROLE_META } from '../instruments/roles'

/** GM percussion note per drum role (the defaults of ROLE_META). */
export const GM_DRUM_NOTES: Record<'kick' | 'snare' | 'hihat' | 'openhat' | 'crash' | 'tom' | 'clap', number> = {
  kick: 36,
  snare: 38,
  hihat: 42,
  openhat: 46,
  crash: 49,
  tom: 45,
  clap: 39
}

/** Channel kinds that play noise or samples: their notes become GM drum hits. */
export const DRUM_CHANNEL_KINDS: readonly ChannelKind[] = ['noise', 'psg-noise', 'dpcm']

const NOISE_KINDS = new Set(['nes-noise', 'gb-noise', 'psg-noise'])

/** Role of an instrument for export/convert purposes: the explicit role, or a guess from its kind. */
export function effectiveRole(inst: Instrument, channelKind?: ChannelKind): Role | undefined {
  if (inst.role) return inst.role
  if (NOISE_KINDS.has(inst.kind) || (inst.kind === 'pce-wave' && inst.noise)) return 'snare'
  if (inst.kind === 'sample' && (channelKind === 'dpcm' || channelKind === 'sample')) return channelKind === 'dpcm' ? 'kick' : undefined
  if (inst.kind === 'nes-tri') return 'bass'
  if (inst.kind === 'gb-wave') return 'bass'
  return undefined
}

/**
 * The GM percussion note an instrument plays on MIDI channel 10, or undefined when it is a melodic instrument.
 * Priority: `inst.gm.drumNote`, a drum role, then noise kinds (snare) and DPCM (kick). `note` is the tracker note
 * (used to pick the high or low tom).
 */
export function gmDrumNoteFor(inst: Instrument | undefined, channelKind?: ChannelKind, note?: number): number | undefined {
  if (!inst) return channelKind && DRUM_CHANNEL_KINDS.includes(channelKind) ? 38 : undefined
  const hint = inst.gm?.drumNote
  if (hint !== undefined) return hint
  if (inst.role && ROLE_META[inst.role].drum) {
    if (inst.role === 'tom' && note !== undefined) return note <= 47 ? 45 : note <= 52 ? 48 : 50
    return ROLE_META[inst.role].drumNote
  }
  if (inst.role) return undefined
  if (NOISE_KINDS.has(inst.kind) || (inst.kind === 'pce-wave' && inst.noise)) return 38
  if (inst.kind === 'sample' && channelKind === 'dpcm') return 36
  if (channelKind && DRUM_CHANNEL_KINDS.includes(channelKind)) return 38
  return undefined
}

/** GM program (0-based) for a melodic instrument. `meanPitch` (of the notes it plays) decides bass vs lead when there is no role. */
export function gmProgramFor(inst: Instrument | undefined, meanPitch = 60): number {
  if (inst?.gm?.program !== undefined) return clampProgram(inst.gm.program)
  if (inst?.role && !ROLE_META[inst.role].drum) return ROLE_META[inst.role].gmProgram ?? 80
  switch (inst?.kind) {
    case 'nes-pulse':
    case 'gb-pulse':
    case 'psg':
      return 80
    case 'nes-tri':
      return 38
    default:
      return meanPitch < 52 ? 38 : 80
  }
}

function clampProgram(p: number): number {
  return Math.max(0, Math.min(127, Math.round(p)))
}

// ---------------------------------------------------------------- import direction

/** GM program (0-based) to the instrument role it should get when importing. */
export function roleForGmProgram(program: number): Role {
  const p = clampProgram(program)
  if (p <= 7) return 'pluck' // pianos
  if (p <= 15) return 'bell' // chromatic percussion
  if (p <= 23) return 'organ'
  if (p <= 31) return 'pluck' // guitars
  if (p <= 39) return 'bass'
  if (p <= 47) return 'strings'
  if (p <= 51) return 'strings' // ensembles
  if (p <= 54) return 'choir'
  if (p === 55) return 'brass'
  if (p <= 63) return 'brass'
  if (p <= 71) return 'lead' // reeds
  if (p <= 79) return 'flute' // pipes
  if (p <= 87) return 'lead'
  if (p <= 95) return 'pad'
  if (p <= 103) return 'pad'
  if (p <= 111) return 'pluck'
  if (p <= 119) return 'bell'
  return 'sfx'
}

const DRUM_NOTE_ROLES: Record<number, Role> = {
  35: 'kick', 36: 'kick',
  37: 'snare', 38: 'snare', 40: 'snare',
  39: 'clap',
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
  42: 'hihat', 44: 'hihat', 54: 'hihat', 69: 'hihat', 70: 'hihat', 82: 'hihat',
  46: 'openhat',
  49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
  51: 'hihat', 53: 'hihat', 56: 'hihat', 59: 'hihat'
}

/** Drum role for a GM percussion note (channel 10), or undefined when it has no chip equivalent. */
export function roleForGmDrumNote(note: number): Role | undefined {
  return DRUM_NOTE_ROLES[note]
}
