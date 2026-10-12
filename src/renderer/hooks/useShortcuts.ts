import { useEffect } from 'react'
import { layoutForSong } from '../lib/trackerGrid'
import { type KeyInfo, trackerKeyAction } from '../lib/trackerKeys'
import { deleteSelectedRollNote, gridCursor, handleTrackerAction, redo, togglePlay, undo } from '../state/actions'
import { session } from '../state/session'
import { useUi } from '../state/ui'

/** True when keystrokes belong to a text control (chat textarea, name fields, hex fields, selects, sliders). */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button'].includes(type)
  }
  return false
}

function info(e: KeyboardEvent): KeyInfo {
  return { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat }
}

/**
 * Global keyboard shortcuts. Keys go to the tracker or piano roll only when no dialog is open and the focus is
 * not in a text control, so typing in the chat or a dialog never edits the song.
 */
export function useShortcuts(): void {
  useEffect(() => {
    let swallowSpaceUp = false
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        useUi.getState().openDialog(useUi.getState().dialog ? null : 'settings')
        return
      }
      const ui = useUi.getState()
      if (ui.dialog) return
      if (isTyping(e.target)) return
      const k = info(e)
      // Tab moves between channels only when nothing else has the focus (otherwise it navigates the UI).
      if (e.key === 'Tab' && document.activeElement !== document.body) return
      if (ui.centerTab === 'tracker') {
        const cur = gridCursor()
        const field = layoutForSong(session.song).channels[cur.channel]?.fields[cur.field]
        const action = trackerKeyAction(k, field?.kind ?? 'note', session.octave)
        if (!action) return
        e.preventDefault()
        if (e.code === 'Space') swallowSpaceUp = true
        handleTrackerAction(action)
        return
      }
      // Piano roll: only the transport, undo/redo, octave and delete shortcuts.
      const action = trackerKeyAction(k, 'fxlo', session.octave)
      if (!action) return
      switch (action.type) {
        case 'undo':
          undo()
          break
        case 'redo':
          redo()
          break
        case 'playToggle':
          togglePlay()
          swallowSpaceUp = true
          break
        case 'octave':
          session.setOctave(session.octave + action.delta)
          break
        case 'clear':
          deleteSelectedRollNote()
          break
        default:
          return
      }
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      // A focused button would otherwise "click" on Space release after we handled the key press.
      if (e.code === 'Space' && swallowSpaceUp) {
        swallowSpaceUp = false
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])
}
