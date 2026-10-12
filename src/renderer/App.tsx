import { useEffect } from 'react'
import { ChatPanel } from './components/ChatPanel'
import { NewSongDialog, OpenDialog, SaveDialog } from './components/Dialogs'
import { ExportDialog } from './components/ExportDialog'
import { InstrumentsPanel } from './components/InstrumentsPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { MenuBar } from './components/MenuBar'
import { OrderList } from './components/OrderList'
import { PianoRoll } from './components/PianoRoll'
import { SaveAssetDialog } from './components/SaveAssetDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { StatusBar } from './components/StatusBar'
import { TrackerView } from './components/TrackerView'
import { Transport } from './components/Transport'
import { useShortcuts } from './hooks/useShortcuts'
import { initChat, useChat } from './state/chat'
import { useUi } from './state/ui'

export function App() {
  const dialog = useUi((s) => s.dialog)
  const centerTab = useUi((s) => s.centerTab)
  const panelTab = useUi((s) => s.panelTab)
  const setUi = useUi((s) => s.set)
  const chatRunning = useChat((s) => s.running)
  useEffect(() => initChat(), [])
  useShortcuts()
  return (
    <div className="shell">
      <header className="region menu" data-testid="transport">
        <MenuBar />
        <Transport />
      </header>
      <aside className="region orders" data-testid="orders">
        <OrderList />
      </aside>
      <main className="region center" data-testid="center">
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={centerTab === 'tracker'} className={centerTab === 'tracker' ? 'active' : ''} onClick={() => setUi({ centerTab: 'tracker' })} data-testid="tab-tracker">
            Tracker
          </button>
          <button role="tab" aria-selected={centerTab === 'piano'} className={centerTab === 'piano' ? 'active' : ''} onClick={() => setUi({ centerTab: 'piano' })} data-testid="tab-piano">
            Piano Roll
          </button>
        </div>
        {/* both stay mounted (hidden) so scroll position and view state survive tab switches */}
        <div className="panel-body center-body" hidden={centerTab !== 'tracker'} data-testid="tracker">
          <TrackerView />
        </div>
        <div className="panel-body center-body" hidden={centerTab !== 'piano'} data-testid="piano-roll">
          <PianoRoll />
        </div>
      </main>
      <aside className="region panels" data-testid="panels">
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={panelTab === 'instruments'} className={panelTab === 'instruments' ? 'active' : ''} onClick={() => setUi({ panelTab: 'instruments' })} data-testid="tab-instruments">
            Instruments
          </button>
          <button role="tab" aria-selected={panelTab === 'library'} className={panelTab === 'library' ? 'active' : ''} onClick={() => setUi({ panelTab: 'library' })} data-testid="tab-library">
            Library
          </button>
          <button role="tab" aria-selected={panelTab === 'chat'} className={panelTab === 'chat' ? 'active' : ''} onClick={() => setUi({ panelTab: 'chat' })} data-testid="tab-chat">
            Chat{chatRunning ? ' ...' : ''}
          </button>
        </div>
        {/* all stay mounted (hidden) so the chat keeps its state and events while another tab is shown */}
        <div className="panel-body" hidden={panelTab !== 'instruments'} data-testid="instruments-panel">
          <InstrumentsPanel />
        </div>
        <div className="panel-body" hidden={panelTab !== 'library'} data-testid="library-panel">
          <LibraryPanel />
        </div>
        <div className="panel-body" hidden={panelTab !== 'chat'}>
          <ChatPanel />
        </div>
      </aside>
      <StatusBar />
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'new' && <NewSongDialog />}
      {dialog === 'open' && <OpenDialog />}
      {dialog === 'save' && <SaveDialog />}
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'saveAsset' && <SaveAssetDialog />}
    </div>
  )
}
