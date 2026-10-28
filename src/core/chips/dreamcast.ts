// Sega Dreamcast AICA: 16, 32 or 64 sample slots (16-bit PCM, 8-bit PCM or Yamaha 4-bit ADPCM at up to 48 kHz), an AEG
// envelope per slot, an LFO for pitch and amplitude, a resonant low-pass with its own envelope, 2 MB of sound RAM and
// a DSP modelled as reverb / chorus / delay presets (the real microcode is not emulated).
//
// The AICA RAM budget (`dreamcastRamIssues`, `dreamcastRamUsage`) counts every used sample once per format (pcm16 2 bytes,
// pcm8 1 byte, adpcm 0.5 byte per sample, after the format's own pipeline) plus the DSP ring buffer of the preset.

import type { ChipConfig, DreamcastConfig, Instrument, Song } from '../types'
import { DC_DSP_PRESETS, DC_VOICE_COUNTS } from '../types'
import { instSampleId } from '../instruments/types'
import { registerInstrumentRule } from '../instruments/validate'
import { type AicaFormat, aicaByteSize, aicaTargetFor } from '../synth/samplegen/aicaAdpcm' // also registers the 'aica16' / 'aica8' / 'aica-adpcm' sample targets
import { dspRamBytes } from '../synth/chips/aicaDsp'
import { assertVoiceCount, sampleVoiceChannels } from './sampleVoices'
import type { ChannelDef, InstrumentOnChannelRule, Issue, ValidateScope } from './types'
import { defineProfile, estimateSampleLength } from './validate'

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

/** Total AICA sound RAM. */
export const AICA_RAM_BYTES = 2 * 1024 * 1024

export interface AicaRamUsage {
  /** Sample bytes by format (a sample used by instruments of two formats is stored twice). */
  sampleBytes: number
  /** The DSP ring buffer of the song's preset. */
  dspBytes: number
  total: number
  budget: number
  samples: { id: string; format: AicaFormat; length: number; bytes: number }[]
}

/** AICA RAM usage: the samples the instruments use (by format) plus the DSP ring buffer. */
export function aicaRamUsage(song: Song): AicaRamUsage {
  const used = new Map<string, { id: string; format: AicaFormat }>()
  for (const inst of song.instruments as Instrument[]) {
    if (inst.kind !== 'aica-sample') continue
    const id = instSampleId(inst)
    if (id !== undefined) used.set(`${inst.format}|${id}`, { id, format: inst.format })
  }
  const samples: AicaRamUsage['samples'] = []
  for (const { id, format } of used.values()) {
    const slot = song.samples.find((s) => s.id === id)
    if (!slot) continue
    // the SNES-pipeline sizes of ValidateScope.sampleSizes do not apply: each format has its own pipeline
    const length = estimateSampleLength(slot, undefined, aicaTargetFor(format))
    samples.push({ id, format, length, bytes: aicaByteSize(format, length) })
  }
  const sampleBytes = samples.reduce((a, s) => a + s.bytes, 0)
  const cfg = song.chipConfig
  const dspBytes = cfg.chip === 'dreamcast' && cfg.dsp && (DC_DSP_PRESETS as readonly string[]).includes(cfg.dsp.preset) ? dspRamBytes(cfg.dsp) : 0
  return { sampleBytes, dspBytes, total: sampleBytes + dspBytes, budget: AICA_RAM_BYTES, samples }
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`

/** AICA RAM budget: an error over 2 MB (with the fixes), a warning above 85%. */
function dreamcastRamIssues(song: Song, _scope: ValidateScope, rule: 'error' | 'warning'): Issue[] {
  const u = aicaRamUsage(song)
  const parts = `samples ${kb(u.sampleBytes)} + DSP ${kb(u.dspBytes)}`
  if (u.total > u.budget) {
    const fixes: string[] = []
    if (u.dspBytes > 0) fixes.push(`switch the DSP preset to "off" or "chorus" (saves up to ${kb(u.dspBytes)})`)
    const pcm = [...u.samples].filter((s) => s.format !== 'adpcm').sort((a, b) => b.bytes - a.bytes)[0]
    if (pcm) fixes.push(`set the largest ${pcm.format} sample "${pcm.id}" (~${kb(pcm.bytes)}) to format "adpcm" (a quarter of pcm16)`)
    const biggest = [...u.samples].sort((a, b) => b.bytes - a.bytes)[0]
    if (biggest && biggest !== pcm) fixes.push(`shorten "${biggest.id}" (~${kb(biggest.bytes)})`)
    if (fixes.length === 0) fixes.push('shorten or remove samples')
    return [{ severity: rule, message: `Dreamcast AICA RAM budget exceeded: ~${kb(u.total)} of ${kb(u.budget)} (${parts}), ${kb(u.total - u.budget)} over; ${fixes.join('; ')}.` }]
  }
  if (u.total > u.budget * 0.85) {
    return [{ severity: 'warning', message: `Dreamcast AICA RAM is nearly full: ~${kb(u.total)} of ${kb(u.budget)} (${parts}).` }]
  }
  return []
}

/** Channel rules of a Dreamcast instrument: none (every slot plays any aica-sample). */
const dreamcastInstrumentOnChannel: InstrumentOnChannelRule = (_song: Song, _def: ChannelDef, _inst: Instrument, _instIndex: number) => []

/** Extra checks of an aica-sample instrument beyond the shared range checks: none yet. */
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
