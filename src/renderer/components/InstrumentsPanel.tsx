import { useState } from 'react'
import { type Role, ROLES, instrumentUsage, listPresets } from '../../core'
import { useSession } from '../hooks/useSession'
import { addInstrumentFromPreset, deleteInstrument, previewNote } from '../state/actions'
import { openSaveAsset } from '../state/assetActions'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { InstrumentEditor } from './InstrumentEditors'

/** Instruments tab: list, add from a preset (filtered by chip and role), delete, and the kind-specific editor. */
export function InstrumentsPanel() {
  useSession()
  const role = useUi((s) => s.presetRole)
  const setUi = useUi((s) => s.set)
  const song = session.song
  const presets = listPresets(song.chip, role ? { role: role as Role } : {})
  const [presetId, setPresetId] = useState('')
  const [confirm, setConfirm] = useState<number | null>(null)
  const chosen = presets.find((p) => p.id === presetId)?.id ?? presets[0]?.id ?? ''
  const current = session.currentInstrument
  const selected = song.instruments[current]
  return (
    <div className="instruments" data-testid="instruments">
      <div className="add-row">
        <select value={role} onChange={(e) => setUi({ presetRole: e.target.value })} title="Filter presets by role" data-testid="preset-role">
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={chosen} onChange={(e) => setPresetId(e.target.value)} disabled={presets.length === 0} title={presets.find((p) => p.id === chosen)?.description} data-testid="preset-select">
          {presets.length === 0 && <option value="">(no presets)</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!chosen} onClick={() => addInstrumentFromPreset(chosen)} data-testid="preset-add">
          Add
        </button>
      </div>
      {presets.length === 0 && (
        <p className="hint">
          {role ? `No ${song.chip} presets with the role "${role}".` : `No presets for ${song.chip} yet (they arrive in Phase 4). You can still edit instruments that exist.`}
        </p>
      )}
      <div className="inst-list" data-testid="instrument-list">
        {song.instruments.length === 0 && <p className="hint">No instruments yet. Add one from a preset above.</p>}
        {song.instruments.map((inst, i) => {
          const usage = confirm === i ? instrumentUsage(song, i).count : 0
          return (
            <div key={i} className={`inst-row${i === current ? ' current' : ''}`} data-testid={`instrument-row-${i}`}>
              <button className="inst-pick" onClick={() => session.setCurrentInstrument(i)} title="Use for note entry and edit" data-testid={`instrument-select-${i}`}>
                <span className="mono">{i.toString(16).toUpperCase().padStart(2, '0')}</span>
                <span className="inst-name">{inst.name}</span>
                <span className="muted">{inst.kind}</span>
              </button>
              <button onClick={() => previewNote(i, session.cursor.channel, (session.octave + 1) * 12)} title="Audition">
                Play
              </button>
              <button onClick={() => openSaveAsset('instrument', i)} title="Save this instrument to the library" data-testid={`instrument-save-${i}`}>
                Lib
              </button>
              {confirm === i ? (
                <span className="confirm">
                  {usage > 0 ? `Used by ${usage} cell(s). ` : 'Delete? '}
                  <button
                    className="danger"
                    onClick={() => {
                      deleteInstrument(i, true)
                      setConfirm(null)
                    }}
                    data-testid={`instrument-delete-confirm-${i}`}
                  >
                    {usage > 0 ? 'Force delete' : 'Delete'}
                  </button>
                  <button onClick={() => setConfirm(null)}>Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirm(i)} title="Delete this instrument" data-testid={`instrument-delete-${i}`}>
                  Del
                </button>
              )}
            </div>
          )
        })}
      </div>
      {selected && <InstrumentEditor key={`${session.song.id}-${current}`} index={current} inst={selected} />}
    </div>
  )
}
