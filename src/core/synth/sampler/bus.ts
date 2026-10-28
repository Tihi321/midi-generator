// The send bus contract for sample chips: a shared effect (SNES echo, PS1 reverb, Dreamcast DSP) that every voice
// adds its stereo send to, once per DSP step, and that the player renders after all voices as an aux stem.

import type { Song } from '../../types'
import type { AuxOutput, VoiceArgs } from '../chips/types'

export interface SendBus {
  /** Per-step stereo send accumulated by the voices for the current block (cleared by `render`). */
  readonly sendL: Float32Array
  readonly sendR: Float32Array
  /** Number of DSP steps in the current block (set by the voices). */
  steps: number
  /** Re-read the song's effect settings (cheap; called on construction and hot swaps). */
  configure(song: Song): void
  reset(): void
  /** Run `steps` DSP steps and resample the bus output to `n` frames (overwrites L/R[0..n)). */
  render(L: Float32Array, R: Float32Array, n: number): void
}

/** The aux output of a bus: the voice at channel index 0 exposes it so the player renders it after the voices. */
export function busAux(id: string, bus: SendBus): AuxOutput {
  return { id, render: (L, R, n) => bus.render(L, R, n) }
}

/**
 * One bus per player: every voice of a song gets the bus created for channel 0 (voices are created in channel
 * order), so a new player (or a re-created channel 0) starts a fresh bus.
 */
export class SharedBus<B extends SendBus> {
  private current: B | null = null

  constructor(private readonly make: (args: VoiceArgs) => B) {}

  get(args: VoiceArgs): B {
    if (!this.current || args.index === 0) this.current = this.make(args)
    return this.current
  }
}
