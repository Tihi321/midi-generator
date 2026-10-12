// Messages between the main thread (audioEngine.ts) and the AudioWorklet (worklet.ts), and between the main
// thread and the offline render worker (renderWorker.ts). Types only: no DOM, no worklet globals.

import type { Song } from '../../core/types'
import type { AudioRenderOptions } from '../../tools/services'

export const WORKLET_NAME = 'chiptune-song-player'

/** Main thread -> worklet. Songs travel by structured clone (the Song's Map survives it). */
export type ToWorklet =
  | { type: 'play'; song: Song; order: number; row: number; loop: boolean }
  | { type: 'song'; song: Song }
  | { type: 'stop' }
  | { type: 'seek'; order: number; row: number }
  | { type: 'loop'; loop: boolean }
  | { type: 'volume'; value: number }
  | { type: 'mute'; index: number; muted: boolean | undefined }
  | { type: 'audition'; song: Song }
  | { type: 'stopAudition' }

/** Worklet -> main thread. */
export type FromWorklet =
  | { type: 'pos'; playing: boolean; order: number; row: number; seconds: number }
  | { type: 'ended' }

/** Position reports per second. */
export const POSITION_HZ = 30

export type ToRenderWorker = { type: 'render'; id: number; song: Song; opts: AudioRenderOptions }

export type FromRenderWorker =
  | { type: 'progress'; id: number; fraction: number; label: string }
  | { type: 'done'; id: number; result: RenderPayload }
  | { type: 'error'; id: number; message: string }

export interface RenderPayload {
  sampleRate: number
  L: Float32Array
  R: Float32Array
  stems?: Record<string, { L: Float32Array; R: Float32Array }>
  loopStart: number | null
  loopEnd: number | null
}
