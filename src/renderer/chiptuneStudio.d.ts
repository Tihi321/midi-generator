import type { ChiptuneStudioApi } from '../shared/ipc'
import type { SongSession } from '../tools/session'
import type { AudioEngine } from './audio/audioEngine'
import type { RollNote } from './lib/pianoRoll'
import type { useUi } from './state/ui'

declare global {
  interface Window {
    chiptuneStudio: ChiptuneStudioApi
    /** Debug / test hook: the live session, the UI store and the audio engine. */
    __chiptuneStudio?: {
      session: SongSession
      ui: typeof useUi
      audio: AudioEngine
      /** Set by the piano roll: page coordinates of a (linear row, pitch) cell, and the derived notes. */
      pianoRoll?: {
        pointFor(lin: number, pitch: number): { x: number; y: number }
        /** Pitch at the vertical middle of the visible roll. */
        centerPitch(): number
        notes(): RollNote[]
      }
    }
  }
}

export {}
