// The renderer's AudioService (tools: render_preview/export_wav/play/stop): offline renders run in the render
// Worker, playback runs on the live AudioWorklet engine that the UI also drives.

import type { AudioService } from '../tools/services'
import { renderOffline } from './audio/renderClient'
import { applyMutes, engine } from './state/audio'

export function createRendererAudio(): AudioService {
  return {
    render: (song, opts) => renderOffline(song, opts),
    play: async (from, opts) => {
      applyMutes()
      await engine.play(from, opts)
    },
    stop: async () => engine.stop(),
    position: async () => engine.position()
  }
}
