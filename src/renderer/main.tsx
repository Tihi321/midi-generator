import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createStarterSong } from './lib/newSong'
import { engine } from './state/audio'
import { session } from './state/session'
import { useUi } from './state/ui'
import { createDefaultRegistry } from '../tools'
import { IPC, type OpenSongRequest } from '../shared/ipc'
import { getToolServices, openSongRequest } from './state/actions'
import { startToolBridge } from './toolBridgeClient'
import './styles.css'

// Start with an NES song that already has a few preset instruments, so the first note typed makes a sound.
session.replaceSong(createStarterSong({ chip: 'nes', name: 'Untitled', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 64 }), { history: 'clear' })
session.setCurrentInstrument(0)

// The tool bridge drives the same session the UI edits, so LLM/MCP edits and manual edits
// share one undo history.
if (window.chiptuneStudio) {
  startToolBridge(createDefaultRegistry(), session, getToolServices())
  // `--open <file>` on the command line or from a second launch: open the song (and export its audio on save)
  window.chiptuneStudio.on(IPC.appOpen, (req) => void openSongRequest(req as OpenSongRequest))
  void window.chiptuneStudio.invoke<OpenSongRequest | null>(IPC.appRendererReady).then((req) => (req ? openSongRequest(req) : undefined))
}
window.__chiptuneStudio = { session, ui: useUi, audio: engine }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
