// The contract between the sequencer and the chip voices, plus the voice registry.
//
// A voice renders ONE channel into a mono buffer in the chip's native "DAC units" (e.g. 0..15 for the NES
// and GB channels). The mixer applies the chip's mix model, filters, trim and pan afterwards.
//
// Adding a chip voice (Phase 4): write a factory and register it at module load time, then import the module
// from `chips/index.ts`:
//
//   registerVoice('pce', 'pce-wave', ({ song, channel, sampleRate, maxBlock }) => new PceWaveVoice(...))
//   registerVoice('*', 'fm', factory)            // '*' = any chip
//
// Lookup order is `${song.chip}:${channel.kind}` then `*:${channel.kind}`; with no match the channel is silent.

import type { ChannelKind, ChannelState, ChipId, Instrument, Song } from '../../types'
import type { ChannelControl } from '../sequencer'

/** How the mixer combines a voice. 'pulse'/'tri'/'noise'/'dpcm' feed the NES nonlinear model; 'direct' just sums. */
export type MixGroup = 'pulse' | 'tri' | 'noise' | 'dpcm' | 'direct'

export interface ChipVoice {
  readonly mixGroup: MixGroup
  /** Multiplier from raw voice output to linear mix level (1.0 = full scale of one channel). */
  readonly linearGain: number
  /**
   * Called at every sequencer tick boundary, i.e. exactly between two `render` calls (so the new control takes
   * effect at the voice's current frame). `inst` is `song.instruments[c.inst]` or undefined.
   */
  control(c: ChannelControl, inst: Instrument | undefined): void
  /** Overwrite buf[from..to) with the channel output. `to - from` never exceeds `maxBlock`. */
  render(buf: Float32Array, from: number, to: number): void
  /** Back to the power-on state (silent, deterministic seeds restored). */
  reset(): void
  /** Optional: the song was hot-swapped (same channel layout); re-read sample slots / chip config. */
  setSong?(song: Song): void
  /** Optional: the mixer muted/unmuted this channel (voices that feed shared buses, e.g. the SNES echo send). */
  setMuted?(muted: boolean): void
  /**
   * Optional: a shared stereo bus rendered AFTER all voices of a block (the SNES echo). At most one voice per
   * player exposes it; its output is added to the master and exported as an extra stem named `id`.
   */
  readonly aux?: AuxOutput
}

export interface AuxOutput {
  /** Stem id, e.g. '_echo'. */
  readonly id: string
  /** Overwrite L/R[0..n) with the bus output (pre output-gain, same units as the voices' stems). */
  render(L: Float32Array, R: Float32Array, n: number): void
}

export interface VoiceArgs {
  song: Song
  channel: ChannelState
  /** Channel index in song.channels. */
  index: number
  sampleRate: number
  /** Largest `to - from` ever passed to render(). */
  maxBlock: number
}

export type VoiceFactory = (args: VoiceArgs) => ChipVoice | null

const registry = new Map<string, VoiceFactory>()

export function registerVoice(chip: ChipId | '*', kind: ChannelKind, factory: VoiceFactory): void {
  registry.set(`${chip}:${kind}`, factory)
}

export class SilentVoice implements ChipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 1
  control(): void {}
  render(buf: Float32Array, from: number, to: number): void {
    buf.fill(0, from, to)
  }
  reset(): void {}
}

/** Creates the voice for a channel; unknown kinds render silence (TODO(Phase 4): fm, sample, pce-wave, psg-*, dpcm). */
export function createVoice(args: VoiceArgs): ChipVoice {
  const f = registry.get(`${args.song.chip}:${args.channel.kind}`) ?? registry.get(`*:${args.channel.kind}`)
  return f?.(args) ?? new SilentVoice()
}
