import { useState } from 'react'
import { ASSET_KINDS } from '../../shared/assets'
import type { AssetKind } from '../../tools'
import { useSession } from '../hooks/useSession'
import { motifRange } from '../lib/assetForm'
import { currentSelection } from '../state/actions'
import { saveAsAsset } from '../state/assetActions'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { Modal } from './Controls'

/** "Save to library": a whole song, a motif (the tracker selection or the current order) or an instrument. */
export function SaveAssetDialog() {
  useSession()
  const close = () => useUi.getState().openDialog(null)
  const draft = useUi.getState().assetDraft
  const song = session.song
  const [kind, setKind] = useState<AssetKind>(draft?.kind ?? 'song')
  const [name, setName] = useState(draft?.kind === 'instrument' ? (song.instruments[draft.instrument]?.name ?? '') : song.name === 'Untitled' ? '' : song.name)
  const [tags, setTags] = useState('')
  const [moods, setMoods] = useState(song.meta.moods.join(', '))
  const [notes, setNotes] = useState('')
  const [instrument, setInstrument] = useState(draft?.instrument ?? Math.max(0, session.currentInstrument))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const range = motifRange(song, currentSelection(), session.cursor.order)
  return (
    <Modal title="Save to library" onClose={close} testId="dialog-save-asset">
      <div className="form">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} data-testid="asset-kind-select">
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'song' ? 'song (the whole song)' : k === 'motif' ? 'motif (selection or order)' : 'instrument'}
              </option>
            ))}
          </select>
        </label>
        {kind === 'motif' && <p className="hint">{range.label}</p>}
        {kind === 'instrument' && (
          <label>
            Instrument
            <select value={instrument} onChange={(e) => setInstrument(Number(e.target.value))} data-testid="asset-instrument">
              {song.instruments.map((inst, i) => (
                <option key={i} value={i}>
                  @{i} {inst.name} ({inst.kind})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="heroic overworld" data-testid="asset-name" autoFocus />
        </label>
        <label>
          Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="boss, fast (comma separated)" data-testid="asset-tags" />
        </label>
        <label>
          Moods
          <input value={moods} onChange={(e) => setMoods(e.target.value)} placeholder="heroic, battle" data-testid="asset-moods" />
        </label>
        <label className="notes-field">
          Style notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Groove, harmony, instrumentation, what to imitate. The agent reads this when the asset is a style reference."
            data-testid="asset-notes"
          />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="primary"
          disabled={!name.trim() || busy || (kind === 'instrument' && song.instruments.length === 0)}
          data-testid="asset-save-confirm"
          onClick={() => {
            setBusy(true)
            setError('')
            void saveAsAsset({ kind, name, tags, moods, notes, instrument }).then((ok) => {
              setBusy(false)
              if (ok) close()
              else setError(useUi.getState().status)
            })
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}
