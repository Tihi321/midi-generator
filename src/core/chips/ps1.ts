// PlayStation SPU: 16 or 24 ADPCM sample voices (PS-X ADPCM, 44.1 kHz), hardware ADSR per voice, pitch modulation, a
// global noise generator, 512 KB of sound RAM and the SPU hardware reverb with its classic presets.
//
// Phase B0 scaffolding: the profile, the config and the validation hooks exist; Phase B fills in the SPU RAM budget
// (`ps1RamIssues`), the pmod/noise channel rules (`ps1InstrumentOnChannel`) and any extra instrument checks
// (`ps1InstrumentRule`).

import type { ChipConfig, Instrument, Ps1Config, Song } from '../types'
import { PS1_REVERB_PRESETS, PS1_VOICE_COUNTS } from '../types'
import { registerInstrumentRule } from '../instruments/validate'
import '../synth/samplegen/psxAdpcm' // registers the 'psx' sample target used by the RAM budget
import { assertVoiceCount, sampleVoiceChannels } from './sampleVoices'
import type { ChannelDef, InstrumentOnChannelRule, Issue, ValidateScope } from './types'
import { defineProfile } from './validate'

/** Voices of a config (16 or 24); throws for anything else. */
export function ps1Voices(cfg: ChipConfig): number {
  return assertVoiceCount('PS1', cfg.chip === 'ps1' ? cfg.voices : 16, PS1_VOICE_COUNTS)
}

export function defaultPs1Config(): Ps1Config {
  return { chip: 'ps1', voices: 16, reverb: { preset: 'studio-large', depth: 0.5, inputVol: 1 } }
}

const VOICE_DESC = 'Sample voice: PS-X ADPCM sample with the SPU ADSR, full stereo pan, optional reverb send (Exx), pitch modulation (pmod) and noise.'

export function ps1Channels(cfg: ChipConfig = defaultPs1Config()): ChannelDef[] {
  return sampleVoiceChannels(ps1Voices(cfg), 'psx-sample', VOICE_DESC)
}

/** Config checks (reverb preset and levels); the voice count is checked by `channels`. */
function ps1ConfigIssues(song: Song): Issue[] {
  const cfg = song.chipConfig
  if (cfg.chip !== 'ps1') return []
  const out: Issue[] = []
  const r = cfg.reverb
  if (!r || !(PS1_REVERB_PRESETS as readonly string[]).includes(r.preset)) {
    out.push({ severity: 'error', message: `chipConfig.reverb.preset ${JSON.stringify(r?.preset)} is not a PS1 reverb preset; use ${PS1_REVERB_PRESETS.join(', ')}.` })
  }
  for (const k of ['depth', 'inputVol'] as const) {
    const v = r?.[k]
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) out.push({ severity: 'error', message: `chipConfig.reverb.${k} ${JSON.stringify(v)} must be a number 0..1.` })
  }
  return out
}

/** SPU RAM budget (samples + reverb work area + reserved against 512 KB). Phase B. */
function ps1RamIssues(_song: Song, _scope: ValidateScope, _rule: 'error' | 'warning'): Issue[] {
  return []
}

/** Channel rules of a PS1 instrument (a pmod voice on V1 ...). Phase B. */
const ps1InstrumentOnChannel: InstrumentOnChannelRule = (_song: Song, _def: ChannelDef, _inst: Instrument, _instIndex: number) => []

/** Extra checks of a psx-sample instrument beyond the shared range checks. Phase B. */
function ps1InstrumentRule(_inst: Instrument): string[] {
  return []
}
registerInstrumentRule('psx-sample', ps1InstrumentRule)

export const ps1Profile = defineProfile({
  id: 'ps1',
  label: 'PS1',
  name: 'Sony PlayStation (SPU)',
  era: '32-bit, 1994',
  description: 'Sixteen or twenty-four ADPCM sample voices at 44.1 kHz with a hardware ADSR per voice, pitch modulation, a noise generator and the SPU reverb (room, studio, hall, space echo, ...).',
  notes: [
    'Channels: V1..V16 (or V1..V24 with new_song chipConfig {"voices":24}); every voice plays a sample (instrument kind psx-sample); no synth waveforms: pick or generate samples.',
    'Memory: samples (4-bit PS-X ADPCM, 16 bytes per 28 samples) plus the reverb work area must fit in 512 KB of SPU RAM.',
    'Reverb (Exx per voice, preset/depth in the song config) is the SPU\'s signature: studio-large and hall suit pads and snares, space-echo and echo are long.',
    'Typical layout: V1 bass, V2/V3 lead, V4-V6 pads, V7 arp, V8 pluck, V9 bell, V10 brass, V11 sfx, V12 tom, V13 kick, V14 snare/clap, V15 hats, V16 crash.'
  ],
  channels: (cfg) => ps1Channels(cfg),
  defaultConfig: () => defaultPs1Config(),
  extra: (song, scope, rule) => [...ps1ConfigIssues(song), ...ps1RamIssues(song, scope, rule)],
  instrumentOnChannel: ps1InstrumentOnChannel
})
