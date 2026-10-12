// The app's single audio engine, wired to the session (hot-swap of edits) and the UI store (playhead).

import { AudioEngine } from '../audio/audioEngine'
import { session } from './session'
import { useUi } from './ui'

export const engine = new AudioEngine()
engine.bind(session)

let wasPlaying = false
engine.subscribe((p) => {
  const ui = useUi.getState()
  ui.setPlayhead(p)
  // When playback ends while following, leave the cursor where the playhead stopped so the view stays put.
  if (wasPlaying && !p.playing && ui.follow) session.setCursor({ order: p.order, row: p.row })
  wasPlaying = p.playing
})

/** Push the effective mute state of every channel to the player (solo wins over mute). */
export function applyMutes(): void {
  const { mutes, solo } = useUi.getState()
  session.song.channels.forEach((_, i) => {
    const muted = solo !== null ? i !== solo : mutes[i] ? true : undefined
    engine.setMute(i, muted)
  })
}
