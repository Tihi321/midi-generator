// Role metadata: General MIDI hints, drum notes, which channels play a role on each chip.

import type { ChannelKind, ChipId, Role } from '../types'

export interface RoleMeta {
  role: Role
  description: string
  /** Percussion role (exported on MIDI channel 10 as a GM drum note). */
  drum: boolean
  /** Default GM program (0-based) for melodic roles. */
  gmProgram?: number
  /** GM percussion note for drum roles. */
  drumNote?: number
}

export const ROLE_META: Record<Role, RoleMeta> = {
  lead: { role: 'lead', description: 'Main melody voice', drum: false, gmProgram: 80 },
  bass: { role: 'bass', description: 'Bass line', drum: false, gmProgram: 38 },
  pad: { role: 'pad', description: 'Sustained harmony', drum: false, gmProgram: 89 },
  strings: { role: 'strings', description: 'Orchestral strings', drum: false, gmProgram: 48 },
  brass: { role: 'brass', description: 'Brass fanfare / stabs', drum: false, gmProgram: 61 },
  pluck: { role: 'pluck', description: 'Short plucked notes', drum: false, gmProgram: 45 },
  bell: { role: 'bell', description: 'Bells, glockenspiel, music box', drum: false, gmProgram: 14 },
  organ: { role: 'organ', description: 'Organ / sustained tone', drum: false, gmProgram: 19 },
  arp: { role: 'arp', description: 'Arpeggiated chords', drum: false, gmProgram: 81 },
  flute: { role: 'flute', description: 'Flute-like woodwind', drum: false, gmProgram: 73 },
  choir: { role: 'choir', description: 'Choir / voice pad', drum: false, gmProgram: 52 },
  kick: { role: 'kick', description: 'Bass drum', drum: true, drumNote: 36 },
  snare: { role: 'snare', description: 'Snare drum', drum: true, drumNote: 38 },
  hihat: { role: 'hihat', description: 'Closed hi-hat', drum: true, drumNote: 42 },
  openhat: { role: 'openhat', description: 'Open hi-hat', drum: true, drumNote: 46 },
  crash: { role: 'crash', description: 'Crash cymbal', drum: true, drumNote: 49 },
  tom: { role: 'tom', description: 'Tom drum', drum: true, drumNote: 45 },
  clap: { role: 'clap', description: 'Hand clap', drum: true, drumNote: 39 },
  sfx: { role: 'sfx', description: 'Sound effect / zap', drum: false, gmProgram: 120 }
}

export function isDrumRole(role: Role): boolean {
  return ROLE_META[role].drum
}

const ROLE_ALIASES: Record<string, Role> = {
  hat: 'hihat',
  hh: 'hihat',
  'hi-hat': 'hihat',
  closedhat: 'hihat',
  oh: 'openhat',
  'open-hat': 'openhat',
  ohat: 'openhat',
  cymbal: 'crash',
  bd: 'kick',
  bassdrum: 'kick',
  sd: 'snare',
  tom1: 'tom',
  melody: 'lead',
  arpeggio: 'arp',
  strings1: 'strings'
}

/** Resolve a role name or alias ("hat" -> "hihat"); undefined when it is not a role. */
export function parseRole(name: string): Role | undefined {
  const k = name.trim().toLowerCase()
  if ((ROLE_META as Record<string, RoleMeta>)[k]) return k as Role
  return ROLE_ALIASES[k]
}

/** Roles to try, in order, when a chip has no preset for the requested role. */
export const ROLE_FALLBACKS: Partial<Record<Role, Role[]>> = {
  lead: ['arp', 'pluck'],
  bass: ['kick'],
  pad: ['arp', 'lead'],
  strings: ['pad', 'arp', 'lead'],
  brass: ['lead'],
  pluck: ['arp', 'lead'],
  bell: ['pluck', 'arp', 'lead'],
  organ: ['pad', 'lead'],
  arp: ['lead', 'pluck'],
  flute: ['lead'],
  choir: ['pad', 'lead'],
  tom: ['kick', 'snare'],
  clap: ['snare'],
  openhat: ['hihat'],
  crash: ['openhat', 'hihat'],
  sfx: ['lead', 'snare']
}

/** Default channels that play each role on each chip, in order of preference (channel ids). */
export const ROLE_CHANNELS: Record<ChipId, Partial<Record<Role, string[]>>> = {
  nes: {
    lead: ['P1', 'P2'], arp: ['P2', 'P1'], pad: ['P2'], pluck: ['P2', 'P1'], bell: ['P1', 'P2'],
    strings: ['P2'], brass: ['P1'], organ: ['P2'], flute: ['P1'], choir: ['P2'], sfx: ['P1', 'P2'],
    bass: ['TR'], kick: ['NO', 'TR'], snare: ['NO'], hihat: ['NO'], openhat: ['NO'], crash: ['NO'], clap: ['NO'], tom: ['TR', 'NO']
  },
  gb: {
    lead: ['P1', 'P2'], arp: ['P2', 'P1'], pad: ['P2', 'WV'], pluck: ['P2', 'P1'], bell: ['P1', 'P2'],
    strings: ['WV', 'P2'], brass: ['P1'], organ: ['WV'], flute: ['P1', 'WV'], choir: ['WV'], sfx: ['P1', 'P2'],
    bass: ['WV'], kick: ['NO'], snare: ['NO'], hihat: ['NO'], openhat: ['NO'], crash: ['NO'], clap: ['NO'], tom: ['NO']
  },
  genesis: {
    lead: ['F2', 'F1', 'S1'], arp: ['F5', 'S3'], pad: ['F3', 'F4'], pluck: ['F5', 'F4'], bell: ['F4', 'F5'],
    strings: ['F3', 'F4'], brass: ['F2', 'F5'], organ: ['F4', 'F3'], flute: ['F2'], choir: ['F3'], sfx: ['S2', 'S3'],
    bass: ['F1'], kick: ['F6', 'NO'], snare: ['NO', 'F6'], hihat: ['NO'], openhat: ['NO'], crash: ['NO'], clap: ['NO'], tom: ['F6', 'NO']
  },
  snes: {
    lead: ['V4', 'V5'], arp: ['V6'], pad: ['V3', 'V2'], pluck: ['V6'], bell: ['V6'],
    strings: ['V3', 'V2'], brass: ['V4'], organ: ['V3'], flute: ['V4'], choir: ['V2', 'V3'], sfx: ['V8'],
    bass: ['V1'], kick: ['V7'], snare: ['V8'], hihat: ['V8'], openhat: ['V8'], crash: ['V8'], clap: ['V8'], tom: ['V7']
  },
  pce: {
    lead: ['C2', 'C1'], arp: ['C4'], pad: ['C3'], pluck: ['C4'], bell: ['C4'],
    strings: ['C3'], brass: ['C2'], organ: ['C3'], flute: ['C2'], choir: ['C3'], sfx: ['C4'],
    bass: ['C1'], kick: ['C5', 'C6'], snare: ['C6', 'C5'], hihat: ['C6', 'C5'], openhat: ['C6'], crash: ['C6'], clap: ['C6'], tom: ['C5']
  },
  // PS1 and Dreamcast share one layout in V1..V16 (extra voices of the 24/32/64-voice songs are free for doubling)
  ps1: {
    bass: ['V1'], lead: ['V2', 'V3'], pad: ['V4', 'V5', 'V6'], strings: ['V5', 'V4'], choir: ['V6'], organ: ['V5'], arp: ['V7'],
    pluck: ['V8', 'V7'], bell: ['V9'], brass: ['V10', 'V2'], flute: ['V2'], sfx: ['V11'], tom: ['V12'], kick: ['V13'],
    snare: ['V14'], clap: ['V14'], hihat: ['V15'], openhat: ['V15'], crash: ['V16']
  },
  dreamcast: {
    bass: ['V1'], lead: ['V2', 'V3'], pad: ['V4', 'V5', 'V6'], strings: ['V5', 'V4'], choir: ['V6'], organ: ['V5'], arp: ['V7'],
    pluck: ['V8', 'V7'], bell: ['V9'], brass: ['V10', 'V2'], flute: ['V2'], sfx: ['V11'], tom: ['V12'], kick: ['V13'],
    snare: ['V14'], clap: ['V14'], hihat: ['V15'], openhat: ['V15'], crash: ['V16']
  }
}

const SAMPLE_ROLE_KINDS: Partial<Record<Role, ChannelKind[]>> = { lead: ['sample'], bass: ['sample'], pad: ['sample'], kick: ['sample'], snare: ['sample'], hihat: ['sample'], openhat: ['sample'], crash: ['sample'], clap: ['sample'], tom: ['sample'], arp: ['sample'] }

/** Channel kinds that play a role by default on a chip, most preferred first. */
export const ROLE_CHANNEL_KINDS: Record<ChipId, Partial<Record<Role, ChannelKind[]>>> = {
  nes: { lead: ['pulse'], bass: ['triangle'], kick: ['noise', 'triangle'], snare: ['noise'], hihat: ['noise'], openhat: ['noise'], crash: ['noise'], clap: ['noise'], tom: ['triangle', 'noise'], pad: ['pulse'], arp: ['pulse'] },
  gb: { lead: ['pulse'], bass: ['wave'], kick: ['noise'], snare: ['noise'], hihat: ['noise'], openhat: ['noise'], crash: ['noise'], clap: ['noise'], tom: ['noise'], pad: ['wave', 'pulse'], arp: ['pulse'] },
  genesis: { lead: ['fm', 'psg-square'], bass: ['fm'], pad: ['fm'], kick: ['sample', 'psg-noise'], snare: ['psg-noise', 'sample'], hihat: ['psg-noise'], openhat: ['psg-noise'], crash: ['psg-noise'], clap: ['psg-noise'], tom: ['sample', 'psg-noise'], arp: ['fm', 'psg-square'] },
  snes: { lead: ['sample'], bass: ['sample'], pad: ['sample'], kick: ['sample'], snare: ['sample'], hihat: ['sample'], openhat: ['sample'], crash: ['sample'], clap: ['sample'], tom: ['sample'], arp: ['sample'] },
  pce: { lead: ['pce-wave'], bass: ['pce-wave'], pad: ['pce-wave'], kick: ['pce-wave'], snare: ['pce-wave'], hihat: ['pce-wave'], openhat: ['pce-wave'], crash: ['pce-wave'], clap: ['pce-wave'], tom: ['pce-wave'], arp: ['pce-wave'] },
  ps1: SAMPLE_ROLE_KINDS,
  dreamcast: SAMPLE_ROLE_KINDS
}

export function defaultChannelKinds(chip: ChipId, role: Role): ChannelKind[] {
  return ROLE_CHANNEL_KINDS[chip][role] ?? ROLE_CHANNEL_KINDS[chip].lead ?? []
}

export function defaultChannelIds(chip: ChipId, role: Role): string[] {
  return ROLE_CHANNELS[chip][role] ?? []
}

/** GM program or drum note to use for an instrument with this role (MIDI export hint). */
export function gmHint(role: Role): { program?: number; drumNote?: number } {
  const m = ROLE_META[role]
  return m.drum ? { drumNote: m.drumNote } : { program: m.gmProgram }
}
