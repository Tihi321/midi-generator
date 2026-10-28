// Sega Dreamcast AICA: 16, 32 or 64 sample slots (16-bit PCM, 8-bit PCM or Yamaha 4-bit ADPCM at up to 48 kHz), an AEG
// envelope per slot, an LFO for pitch and amplitude, a resonant low-pass with its own envelope, 2 MB of sound RAM and
// a DSP modelled as reverb / chorus / delay presets (the real microcode is not emulated).
//
// Phase B0 scaffolding: the profile, the config and the validation hooks exist; Phase C fills in the AICA RAM budget
// (`dreamcastRamIssues`), the channel rules (`dreamcastInstrumentOnChannel`) and any extra instrument checks
// (`dreamcastInstrumentRule`).

import type { ChipConfig, DreamcastConfig, Instrument, Song } from '../types'
import { DC_DSP_PRESETS, DC_VOICE_COUNTS } from '../types'
import { registerInstrumentRule } from '../instruments/validate'
import '../synth/samplegen/aicaAdpcm' // registers the 'aica16' / 'aica8' / 'aica-adpcm' sample targets used by the RAM budget
import { assertVoiceCount, sampleVoiceChannels } from './sampleVoices'
import type { ChannelDef, InstrumentOnChannelRule, Issue, ValidateScope } from './types'
import { defineProfile } from './validate'

/** Voices of a config (16, 32 or 64); throws for anything else. */
export function dreamcastVoices(cfg: ChipConfig): number {
  return assertVoiceCount('Dreamcast', cfg.chip === 'dreamcast' ? cfg.voices : 16, DC_VOICE_COUNTS)
}

export function defaultDreamcastConfig(): DreamcastConfig {
  return {
    chip: 'dreamcast',
    voices: 16,
    dsp: { preset: 'chorus-hall', mix: 0.35, time: 0.5, feedback: 0.35, chorusRate: 0.3, chorusDepth: 0.4, delayMs: 300 }
  }
}

const VOICE_DESC = 'Sample slot: PCM16, PCM8 or ADPCM sample with an AEG envelope, optional resonant filter and LFO, full stereo pan, DSP send (Exx).'

export function dreamcastChannels(cfg: ChipConfig = defaultDreamcastConfig()): ChannelDef[] {
  return sampleVoiceChannels(dreamcastVoices(cfg), 'aica-sample', VOICE_DESC)
}

const DSP_RANGES: [keyof DreamcastConfig['dsp'], number, number][] = [
  ['mix', 0, 1], ['time', 0, 1], ['feedback', 0, 0.95], ['chorusRate', 0, 1], ['chorusDepth', 0, 1], ['delayMs', 10, 1000]
]

/** Config checks (DSP preset and parameter ranges); the voice count is checked by `channels`. */
function dreamcastConfigIssues(song: Song): Issue[] {
  const cfg = song.chipConfig
  if (cfg.chip !== 'dreamcast') return []
  const out: Issue[] = []
  const d = cfg.dsp
  if (!d || !(DC_DSP_PRESETS as readonly string[]).includes(d.preset)) {
    out.push({ severity: 'error', message: `chipConfig.dsp.preset ${JSON.stringify(d?.preset)} is not a Dreamcast DSP preset; use ${DC_DSP_PRESETS.join(', ')}.` })
  }
  for (const [k, lo, hi] of DSP_RANGES) {
    const v = d?.[k]
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) out.push({ severity: 'error', message: `chipConfig.dsp.${k} ${JSON.stringify(v)} must be a number ${lo}..${hi}.` })
  }
  return out
}

/** AICA RAM budget (samples by format + the DSP ring buffer against 2 MB). Phase C. */
function dreamcastRamIssues(_song: Song, _scope: ValidateScope, _rule: 'error' | 'warning'): Issue[] {
  return []
}

/** Channel rules of a Dreamcast instrument. Phase C. */
const dreamcastInstrumentOnChannel: InstrumentOnChannelRule = (_song: Song, _def: ChannelDef, _inst: Instrument, _instIndex: number) => []

/** Extra checks of an aica-sample instrument beyond the shared range checks. Phase C. */
function dreamcastInstrumentRule(_inst: Instrument): string[] {
  return []
}
registerInstrumentRule('aica-sample', dreamcastInstrumentRule)

export const dreamcastProfile = defineProfile({
  id: 'dreamcast',
  label: 'Dreamcast',
  name: 'Sega Dreamcast (AICA)',
  era: '128-bit, 1998',
  description: 'Sixteen to sixty-four sample slots with clean 16-bit PCM, 8-bit PCM or 4-bit ADPCM, an AEG envelope, LFO and a resonant filter per slot, and a DSP with reverb, chorus and delay presets.',
  notes: [
    'Channels: V1..V16 (or V1..V32 / V1..V64 with new_song chipConfig {"voices":32}); every slot plays a sample (instrument kind aica-sample); no synth waveforms: pick or generate samples.',
    'Memory: samples (pcm16 2 bytes, pcm8 1 byte, adpcm 0.5 byte per sample) plus the DSP ring buffer must fit in 2 MB of AICA RAM.',
    'The filter (q, flv, far/fd1r/fd2r/frr) and LFO (vibrato/tremolo) are per slot: use the filter envelope for brass swells and bass plucks.',
    'DSP (Exx per slot, preset/mix in the song config): chorus-hall and chorus-delay are the synthwave staples; the real DSP microcode is not emulated.',
    'Typical layout: V1 bass, V2/V3 lead, V4-V6 pads, V7 arp, V8 pluck, V9 bell, V10 brass, V11 sfx, V12 tom, V13 kick, V14 snare/clap, V15 hats, V16 crash.'
  ],
  channels: (cfg) => dreamcastChannels(cfg),
  defaultConfig: () => defaultDreamcastConfig(),
  extra: (song, scope, rule) => [...dreamcastConfigIssues(song), ...dreamcastRamIssues(song, scope, rule)],
  instrumentOnChannel: dreamcastInstrumentOnChannel
})
