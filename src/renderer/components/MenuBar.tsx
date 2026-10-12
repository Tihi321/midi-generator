import { useState } from 'react'
import { useSession } from '../hooks/useSession'
import { ConvertChipDialog } from './ConvertChipDialog'
import { ImportMidiDialog } from './ImportMidiDialog'
import { redo, saveProject, undo } from '../state/actions'
import { openSaveAsset } from '../state/assetActions'
import { session } from '../state/session'
import { useUi } from '../state/ui'

/** File menu as a toolbar row, plus undo/redo and the history indicator. */
export function MenuBar() {
  useSession()
  const openDialog = useUi((s) => s.openDialog)
  const projectPath = useUi((s) => s.projectPath)
  const [midiDialog, setMidiDialog] = useState<'import' | 'convert' | null>(null)
  const h = session.history
  const song = session.song
  return (
    <div className="menubar" data-testid="menubar">
      <span className="app-name">Chiptune Studio</span>
      <div className="group">
        <button onClick={() => openDialog('new')} data-testid="btn-new">New</button>
        <button onClick={() => openDialog('open')} data-testid="btn-open">Open</button>
        <button onClick={() => (projectPath ? void saveProject() : openDialog('save'))} title={projectPath ?? 'Save as .ctune'} data-testid="btn-save">
          Save
        </button>
        <button onClick={() => openDialog('save')} data-testid="btn-save-as">Save As</button>
        <button onClick={() => openDialog('export')} data-testid="btn-export">Export</button>
        <button onClick={() => setMidiDialog('import')} title="Import a .mid file as a song for a chip" data-testid="btn-import-midi">Import MIDI</button>
        <button onClick={() => setMidiDialog('convert')} title="Convert the song to another chip" data-testid="btn-convert">Convert chip...</button>
        <button onClick={() => openSaveAsset()} title="Save a song, motif or instrument in the library" data-testid="btn-save-library">Save to library</button>
        <button onClick={() => openDialog('settings')} title="Providers, API keys and MCP server (Ctrl+,)" data-testid="btn-settings">
          Settings...
        </button>
      </div>
      <div className="group">
        <button onClick={undo} disabled={!session.canUndo()} title={session.undoLabel() ? `Undo ${session.undoLabel()} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} data-testid="btn-undo">
          Undo
        </button>
        <button onClick={redo} disabled={!session.canRedo()} title={session.redoLabel() ? `Redo ${session.redoLabel()} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} data-testid="btn-redo">
          Redo
        </button>
        <span className="history-indicator" data-testid="history-indicator" title="Undo steps / redo steps">
          {h.undoDepth} / {h.redoDepth}
          {session.undoLabel() ? ` - ${session.undoLabel()}` : ''}
        </span>
      </div>
      <span className="spacer" />
      <span className="doc-info" data-testid="doc-info">
        {song.name} [{song.chip.toUpperCase()}]
        {projectPath ? '' : ' (unsaved)'}
      </span>
      {midiDialog === 'import' && <ImportMidiDialog onClose={() => setMidiDialog(null)} />}
      {midiDialog === 'convert' && <ConvertChipDialog onClose={() => setMidiDialog(null)} />}
    </div>
  )
}
