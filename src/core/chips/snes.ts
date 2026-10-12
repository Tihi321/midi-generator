// Super Nintendo: Sony SPC700 + S-DSP, 8 sample voices (BRR), ADSR/GAIN, echo with an 8-tap FIR.

import type { EffectCode, Instrument, SnesConfig, Song } from '../types'
import type { ChannelDef, Issue, ValidateScope } from './types'
import { defineProfile, estimateSampleLength } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const SNES_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'X', 'E', ...FLOW]

/** Total audio RAM of the SPC700 (program + samples + echo buffer all live here). */
export const ARAM_BYTES = 65536
/** Each echo delay step is 16 ms = 2048 bytes of buffer. */
export const ECHO_BYTES_PER_STEP = 2048

export const snesChannels: ChannelDef[] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
  id: `V${i}`,
  name: `Voice ${i}`,
  kind: 'sample' as const,
  noteMin: 12,
  noteMax: 119,
  instKinds: ['snes-sample' as const],
  hasVolume: true,
  pan: 'full' as const,
  effects: SNES_FX,
  fxColumns: 2 as const,
  description: 'Sample voice: BRR sample with ADSR or GAIN envelope, full stereo pan, optional echo (Exx).'
})) satisfies ChannelDef[]

export interface AramUsage {
  /** Approximate BRR bytes of the samples used by instruments. */
  sampleBytes: number
  echoBytes: number
  total: number
  budget: number
  samples: { id: string; length: number; bytes: number }[]
}

/** Approximate ARAM usage: BRR = ceil(samples/16)*9 bytes per sample, plus echo delay * 2048 bytes. */
export function snesAramUsage(song: Song, sampleSizes?: Record<string, number>): AramUsage {
  const used = new Set<string>()
  for (const inst of song.instruments as Instrument[]) {
    if (inst.kind === 'snes-sample' || inst.kind === 'sample') used.add(inst.sample)
  }
  const samples: AramUsage['samples'] = []
  for (const slot of song.samples) {
    if (!used.has(slot.id)) continue
    const length = estimateSampleLength(slot, sampleSizes)
    samples.push({ id: slot.id, length, bytes: Math.ceil(length / 16) * 9 })
  }
  const sampleBytes = samples.reduce((a, s) => a + s.bytes, 0)
  const cfg = song.chipConfig as SnesConfig
  const delay = cfg.chip === 'snes' ? cfg.echo.delay : 0
  const echoBytes = delay * ECHO_BYTES_PER_STEP
  return { sampleBytes, echoBytes, total: sampleBytes + echoBytes, budget: ARAM_BYTES, samples }
}

function aramIssues(song: Song, scope: ValidateScope, rule: 'error' | 'warning'): Issue[] {
  const u = snesAramUsage(song, scope.sampleSizes)
  if (u.total > u.budget) {
    const over = u.total - u.budget
    const delay = (song.chipConfig as SnesConfig).echo?.delay ?? 0
    const cut = Math.ceil(over / ECHO_BYTES_PER_STEP)
    const biggest = [...u.samples].sort((a, b) => b.bytes - a.bytes)[0]
    let fix = 'shorten or remove samples'
    if (delay > 0) fix = `lower the echo delay by ${Math.min(delay, cut)} step(s) (2048 bytes each)${over > delay * ECHO_BYTES_PER_STEP ? ' and shorten samples' : ''}`
    if (biggest) fix += `; the largest sample is "${biggest.id}" (~${biggest.bytes} bytes)`
    return [{ severity: rule, message: `SNES ARAM budget exceeded: ~${u.total} of ${u.budget} bytes (samples ${u.sampleBytes} + echo ${u.echoBytes}); ${fix}.` }]
  }
  if (u.total > u.budget * 0.85) {
    return [{ severity: 'warning', message: `SNES ARAM is nearly full: ~${u.total} of ${u.budget} bytes (samples ${u.sampleBytes} + echo ${u.echoBytes}).` }]
  }
  return []
}

export const snesProfile = defineProfile({
  id: 'snes',
  label: 'SNES',
  name: 'Super Nintendo (SPC700 + S-DSP)',
  era: '16-bit, 1990',
  description: 'Eight BRR sample voices with ADSR/GAIN envelopes, Gaussian interpolation, full stereo, and a global echo with an 8-tap FIR filter.',
  notes: [
    'Channels: V1..V8, every voice plays a sample (instrument kind snes-sample); no synth waveforms: pick or generate samples.',
    'Memory: samples (BRR, ~9 bytes per 16 samples) plus the echo buffer (delay x 2048 bytes) must fit in 64 KB of ARAM.',
    'Echo (Exx per voice, global delay/feedback/FIR in the song config) is what makes SNES music sound spacious.',
    'Typical layout: V1 bass, V2/V3 pads or strings, V4 lead, V5 counter, V6 arp/pluck, V7/V8 drums.'
  ],
  channels: () => snesChannels.map((c) => ({ ...c })),
  defaultConfig: () => defaultSnesConfig(),
  extra: aramIssues
})

export function defaultSnesConfig(): SnesConfig {
  return { chip: 'snes', echo: { delay: 4, feedback: 0.4, volL: 0.3, volR: 0.3, fir: [1, 0, 0, 0, 0, 0, 0, 0] } }
}
