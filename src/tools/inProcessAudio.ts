// AudioService that renders in the calling thread with the pure-TS synth core (renderSong). Used where there is no
// audio engine: the headless MCP server (Node main process) and tests. It cannot play. The app window uses the
// render Worker + AudioWorklet instead (src/renderer/audioService.ts), which runs the same core.

import { renderSong } from '../core'
import type { AudioService } from './services'

export function createInProcessAudio(): AudioService {
  return {
    render: async (song, opts = {}) => {
      const r = renderSong(song, { sampleRate: opts.sampleRate ?? 44100, loops: opts.loops ?? 1, fadeOutSec: opts.fadeOutSec ?? 0, stems: opts.stems ?? false })
      return { sampleRate: r.sampleRate, L: r.L, R: r.R, stems: r.stems, loopStart: r.loopStart, loopEnd: r.loopEnd }
    },
    play: async () => {
      throw new Error('Playback is not available here: there is no audio output (headless mode). Use render_audio to get a file.')
    },
    stop: async () => undefined,
    position: async () => ({ playing: false, order: 0, row: 0, seconds: 0 })
  }
}
