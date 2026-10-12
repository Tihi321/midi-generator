// Starter songs for File > New: the chip's channels plus a small set of preset instruments so the first note
// typed already makes a sound. Pure.

import { type ChannelKind, type ChipId, type Instrument, type PitchClass, type Song, createSong, instrumentSlug, missingPresetSample, tryResolvePreset } from '../../core'

export interface NewSongOptions {
  chip: ChipId
  name: string
  bpm: number
  key: PitchClass | string
  scale: string
  moods: string[]
  patternLength: number
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
    patternLength: opts.patternLength
  })
  song.instruments = starterInstruments(song)
  // sample presets (SNES, Genesis DAC, NES DPCM) need their recipe slots
  for (const inst of song.instruments) {
    const slot = missingPresetSample(song, inst)
    if (slot) song.samples.push(slot)
  }
  return song
}
