// Applying an imported or converted song to the live session as ONE undoable step (history 'record'), so undo
// brings the previous song back. Errors become status-bar messages.

import type { Song } from '../../core'
import { engine } from './audio'
import { resetViewState } from './actions'
import { session } from './session'
import { useUi } from './ui'

export function applyReplacementSong(song: Song, label: string, status: string): boolean {
  try {
    engine.stop()
    session.replaceSong(song, { history: 'record', label })
    session.setCurrentInstrument(song.instruments.length > 0 ? 0 : -1)
    resetViewState()
    useUi.getState().set({ projectPath: null })
    useUi.getState().setStatus(status)
    return true
  } catch (e) {
    useUi.getState().setStatus(e instanceof Error ? e.message : String(e))
    return false
  }
}
