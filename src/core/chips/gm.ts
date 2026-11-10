// General MIDI SoundFont chip ("gm"): 12 melodic voices and 4 percussion voices played by a real SoundFont
// (GeneralUser GS) through the pure-TypeScript synth spessasynth_core. The sound is sampled instruments, not a chip,
// so there is no memory budget and no authenticity: pick the General MIDI program by role (flute, clarinet, harp, ...).
//
// Channel layout: M1..M12 are MIDI channels 0-8 and 10-12 (kind gm-melodic, one note at a time each: put the notes of a
// chord on separate channels), D1..D4 all play on MIDI channel 9 (kind gm-drums; an sf-drum instrument names the
// percussion key, so one drum channel can hold kick and hat presets in turn).

import type { ChipConfig, EffectCode, GmConfig } from '../types'
import { GM_DEFAULT_SOUNDFONT } from '../types'
import type { ChannelDef, Issue } from './types'
import { defineProfile } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
/** Melodic: pan, slides (pitch bend, range 12 semitones), vibrato (modulation), reverb send, note cut and delay. */
const MELODIC_FX: EffectCode[] = ['1', '2', '3', '4', 'S', 'G', 'X', 'E', ...FLOW]
const DRUM_FX: EffectCode[] = ['S', 'G', 'X', 'E', ...FLOW]

export const GM_MELODIC_CHANNELS = 12
export const GM_DRUM_CHANNELS = 4

/** MIDI channel (0..15) of a gm channel id: M1..M9 = 0..8, M10..M12 = 10..12, D1..D4 = 9. */
export function gmMidiChannel(channelId: string): number {
  if (channelId.startsWith('D')) return 9
  const n = Number(channelId.slice(1))
  return n <= 9 ? n - 1 : n
}

export function defaultGmConfig(): GmConfig {
  return { chip: 'gm', soundfont: GM_DEFAULT_SOUNDFONT, reverb: 0.3, chorus: 0.15 }
}

export function gmChannels(): ChannelDef[] {
  const out: ChannelDef[] = []
  for (let i = 1; i <= GM_MELODIC_CHANNELS; i++) {
    out.push({
      id: `M${i}`, name: `Melodic ${i}`, kind: 'gm-melodic', noteMin: 12, noteMax: 119, instKinds: ['sf-program'], hasVolume: true,
      pan: 'full', effects: MELODIC_FX, fxColumns: 2,
      description: 'General MIDI SoundFont voice (one note at a time): pick the instrument with a gm.<role>.<name> preset. Chords need one channel per note.'
    })
  }
  for (let i = 1; i <= GM_DRUM_CHANNELS; i++) {
    out.push({
      id: `D${i}`, name: `Drums ${i}`, kind: 'gm-drums', noteMin: 12, noteMax: 119, instKinds: ['sf-drum'], hasVolume: true,
      pan: 'full', effects: DRUM_FX, fxColumns: 1,
      description: 'General MIDI percussion (MIDI channel 10): the sf-drum instrument names the drum, the cell note is ignored. Kick, snare and hat presets can share one channel when they do not overlap.'
    })
  }
  return out
}

function gmConfigIssues(cfg: ChipConfig): Issue[] {
  if (cfg.chip !== 'gm') return []
  const out: Issue[] = []
  if (typeof cfg.soundfont !== 'string' || cfg.soundfont.trim() === '' || /[\\/]/.test(cfg.soundfont)) {
    out.push({ severity: 'error', message: `chipConfig.soundfont ${JSON.stringify(cfg.soundfont)} must be a file name in the soundfonts folder, such as "${GM_DEFAULT_SOUNDFONT}".` })
  }
  for (const k of ['reverb', 'chorus'] as const) {
    const v = cfg[k]
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) out.push({ severity: 'error', message: `chipConfig.${k} ${JSON.stringify(v)} must be a number 0..1.` })
  }
  return out
}

export const gmProfile = defineProfile({
  id: 'gm',
  label: 'GM SoundFont',
  name: 'General MIDI SoundFont (GeneralUser GS)',
  era: 'Sampled instruments',
  description: 'Real instruments from a General MIDI SoundFont: 12 melodic voices (piano, strings, flute, clarinet, harp, ...) and 4 percussion voices on MIDI channel 10, with reverb and chorus. Needs the SoundFont file in ~/ChiptuneStudio/soundfonts (see soundfont_status).',
  notes: [
    'Channels: M1..M12 melodic (MIDI channels 1-9 and 11-13), D1..D4 percussion (all MIDI channel 10). Each melodic channel plays one note at a time: put chord tones on separate channels (the arpeggio effect 0xy is not available).',
    'Instruments are presets named gm.<role>.<name> (gm.lead.clarinet, gm.bell.celesta, gm.pluck.harp, gm.strings.ensemble, gm.pad.warm, gm.bass.upright); list_presets shows them all. Percussion presets are sf-drum (gm.kick.kick, gm.snare.side-stick, gm.hihat.shaker).',
    'Effects: Xxx pan, 4xy vibrato, 1xx/2xx/3xx pitch slides (up to 12 semitones), Exx reverb send on/off, Sxx cut, Gxx delay, Fxx/Bxx/Dxx/C00 flow. Volume v0..v15 is the note velocity.',
    'The SoundFont file is not part of the song or the app: ~/ChiptuneStudio/soundfonts/GeneralUser-GS.sf2 (CHIPTUNE_STUDIO_HOME is respected). Without it render_audio and playback fail with the download address.',
    'All channels render as one mix (the stem export has a single "_gm" stem), and a gm song exports to MIDI with the program numbers as they are.'
  ],
  channels: () => gmChannels(),
  defaultConfig: () => defaultGmConfig(),
  extra: (song) => gmConfigIssues(song.chipConfig)
})
