// PlayStation SPU: 16 or 24 ADPCM sample voices (PS-X ADPCM, 44.1 kHz), hardware ADSR per voice, pitch modulation, a
// global noise generator, 512 KB of sound RAM and the SPU hardware reverb with its classic presets.
//
// The profile, the config checks, the SPU RAM budget (`spuRamUsage`: samples + the reverb work area of the preset +
// reserved, against 512 KB) and the pmod channel rule (a pmod voice needs a previous voice, so not on V1).

import type { ChipConfig, Instrument, Ps1Config, SampleSlot, Song } from '../types'
import { PS1_REVERB_PRESETS, PS1_VOICE_COUNTS } from '../types'
import { instSampleId } from '../instruments/types'
import { registerInstrumentRule } from '../instruments/validate'
import { spuReverbBytes } from '../synth/chips/spuReverb'
import { psxByteSize } from '../synth/samplegen/psxAdpcm' // also registers the 'psx' sample target used by the RAM budget
import { assertVoiceCount, sampleVoiceChannels } from './sampleVoices'
import type { ChannelDef, InstrumentOnChannelRule, Issue, ValidateScope } from './types'
import { defineProfile, estimateSampleLength } from './validate'

/** SPU sound RAM: 512 KB (samples, the reverb work area and the SPU's own capture/decode area live here). */
export const SPU_RAM_BYTES = 512 * 1024
/** Reserved at the bottom of SPU RAM (the capture buffers and a silent first block). */
export const SPU_RESERVED_BYTES = 0x1000

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

export interface SpuRamUsage {
  /** PS-X ADPCM bytes of the samples used by instruments (16 bytes per 28 samples). */
  sampleBytes: number
  /** Work area of the song's reverb preset (0 for 'off'). */
  reverbBytes: number
  reservedBytes: number
  total: number
  budget: number
  samples: { id: string; length: number; bytes: number }[]
}

/** Samples of a slot after the 'psx' pipeline (cached generation for recipes; user PCM above 48 kHz is resampled to 44.1 kHz). */
function psxSlotLength(slot: SampleSlot): number {
  const n = estimateSampleLength(slot, undefined, 'psx')
  return slot.source.kind === 'pcm' && slot.source.sampleRate > 48000 ? Math.round((n * 44100) / slot.source.sampleRate) : n
}

/** SPU RAM usage of a song: ADPCM bytes of the samples its instruments use + the reverb work area + the reserved area. */
export function spuRamUsage(song: Song): SpuRamUsage {
  const used = new Set<string>()
  for (const inst of song.instruments as Instrument[]) {
    const id = instSampleId(inst)
    if (id !== undefined) used.add(id)
  }
  const samples: SpuRamUsage['samples'] = []
  for (const slot of song.samples) {
    if (!used.has(slot.id)) continue
    const length = psxSlotLength(slot)
    samples.push({ id: slot.id, length, bytes: psxByteSize(length) })
  }
  const sampleBytes = samples.reduce((a, s) => a + s.bytes, 0)
  const cfg = song.chipConfig
  const reverbBytes = cfg.chip === 'ps1' ? spuReverbBytes(cfg.reverb.preset) : 0
  return { sampleBytes, reverbBytes, reservedBytes: SPU_RESERVED_BYTES, total: sampleBytes + reverbBytes + SPU_RESERVED_BYTES, budget: SPU_RAM_BYTES, samples }
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`

/** SPU RAM budget: samples + reverb work area + reserved against 512 KB. */
function ps1RamIssues(song: Song, _scope: ValidateScope, rule: 'error' | 'warning'): Issue[] {
  if (song.chipConfig.chip !== 'ps1') return []
  const u = spuRamUsage(song)
  const parts = `samples ${kb(u.sampleBytes)} + reverb ${kb(u.reverbBytes)} + reserved ${kb(u.reservedBytes)}`
  if (u.total > u.budget) {
    const over = u.total - u.budget
    const preset = song.chipConfig.reverb.preset
    // the largest reverb preset that fixes the overflow (presets ordered by work area, smallest first)
    const smaller = [...PS1_REVERB_PRESETS]
      .filter((p) => spuReverbBytes(p) < u.reverbBytes)
      .sort((a, b) => spuReverbBytes(b) - spuReverbBytes(a))
    const fix = smaller.find((p) => u.reverbBytes - spuReverbBytes(p) >= over)
    const biggest = [...u.samples].sort((a, b) => b.bytes - a.bytes)[0]
    let msg = 'shorten or remove samples'
    if (fix) msg = `lower the reverb preset to ${fix} (saves ${kb(u.reverbBytes - spuReverbBytes(fix))}) or drop the largest sample`
    else if (preset !== 'off') msg = `set the reverb preset to off (saves ${kb(u.reverbBytes)}) and shorten or drop samples`
    if (biggest) msg += `; the largest sample is "${biggest.id}" (~${kb(biggest.bytes)})`
    return [{ severity: rule, message: `SPU RAM budget exceeded: ~${kb(u.total)} of ${kb(u.budget)} (${parts}); ${msg}.` }]
  }
  if (u.total > u.budget * 0.85) {
    return [{ severity: 'warning', message: `SPU RAM is nearly full: ~${kb(u.total)} of ${kb(u.budget)} (${parts}).` }]
  }
  return []
}

/** Channel rules of a PS1 instrument: pitch modulation reads the previous voice, so V1 cannot use it. */
const ps1InstrumentOnChannel: InstrumentOnChannelRule = (_song: Song, def: ChannelDef, inst: Instrument, instIndex: number) => {
  if (inst.kind === 'psx-sample' && inst.pmod && def.id === 'V1') {
    return [`instrument @${instIndex} "${inst.name}" uses pmod; V1 has no previous voice to modulate it; move it to V2 or later (voice n is modulated by voice n-1) or clear its pmod flag`]
  }
  return []
}

/** Extra checks of a psx-sample instrument beyond the shared range checks (none yet: pmod needs a channel, see above). */
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
