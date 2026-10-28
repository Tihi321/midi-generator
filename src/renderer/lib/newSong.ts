// Starter songs for File > New: the chip's channels plus a small set of preset instruments so the first note
// typed already makes a sound. Pure.

import {
  type ChannelKind,
  type ChipConfig,
  type ChipId,
  type Instrument,
  type PitchClass,
  type Song,
  DC_VOICE_COUNTS,
  PS1_VOICE_COUNTS,
  createSong,
  instrumentSlug,
  missingPresetSample,
  tryResolvePreset
} from '../../core'

export interface NewSongOptions {
  chip: ChipId
  name: string
  bpm: number
  key: PitchClass | string
  scale: string
  moods: string[]
  patternLength: number
  /** Voice count for the chips that have the choice (PS1 16/24, Dreamcast 16/32/64); ignored for the others. */
  voices?: number
}

/** Voice counts a chip offers when a song is created (empty = the chip has a fixed channel count). */
export function voiceChoices(chip: ChipId): readonly number[] {
  if (chip === 'ps1') return PS1_VOICE_COUNTS
  if (chip === 'dreamcast') return DC_VOICE_COUNTS
  return []
}

/** The voice count a new song gets by default (16 on both chips), 0 for chips without the choice. */
export function defaultVoices(chip: ChipId): number {
  return voiceChoices(chip)[0] ?? 0
}

/** `chipConfig` that sets the voice count (structural: only at creation or conversion); {} when the chip has no such choice or the count is not allowed. */
export function voicesConfig(chip: ChipId, voices: number | undefined): Partial<ChipConfig> {
  if (voices === undefined || !voiceChoices(chip).includes(voices)) return {}
  return { chip, voices } as Partial<ChipConfig>
}

/** Preset role to try for each channel kind (first match wins; duplicates are skipped). */
const STARTER_ROLES: Partial<Record<ChannelKind, string[]>> = {
  pulse: ['lead', 'arp'],
  triangle: ['bass'],
  wave: ['bass', 'pad'],
  fm: ['lead', 'bass'],
  'psg-square': ['lead'],
  'pce-wave': ['lead', 'bass'],
  sample: ['lead'],
  noise: ['hihat', 'snare', 'kick'],
  'psg-noise': ['hihat', 'snare'],
  dpcm: ['kick']
}

/** Instruments to start a song with: one per (channel kind, role) that a preset exists for. */
export function starterInstruments(song: Song): Instrument[] {
  const out: Instrument[] = []
  const seen = new Set<string>()
  const kinds = [...new Set(song.channels.map((c) => c.kind))]
  for (const kind of kinds) {
    for (const role of STARTER_ROLES[kind] ?? []) {
      const inst = tryResolvePreset(song.chip, role, kind)
      if (!inst) continue
      const slug = instrumentSlug(inst.name)
      if (seen.has(slug)) continue
      seen.add(slug)
      out.push(inst)
    }
  }
  return out
}

export function createStarterSong(opts: NewSongOptions): Song {
  const song = createSong({
    chip: opts.chip,
    name: opts.name.trim() || 'Untitled',
    bpm: opts.bpm,
    key: opts.key,
    scale: opts.scale,
    moods: opts.moods,
    patternLength: opts.patternLength,
    chipConfig: voicesConfig(opts.chip, opts.voices)
  })
  song.instruments = starterInstruments(song)
  // sample presets (SNES, Genesis DAC, NES DPCM) need their recipe slots
  for (const inst of song.instruments) {
    const slot = missingPresetSample(song, inst)
    if (slot) song.samples.push(slot)
  }
  return song
}
