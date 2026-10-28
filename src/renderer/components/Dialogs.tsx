import { useState } from 'react'
import { type ChipId, PITCH_CLASSES, SCALES, listChips, listMoods } from '../../core'
import { defaultVoices, voiceChoices } from '../lib/newSong'
import { newSong, openProjectFromPath, openProjectText, saveProject } from '../state/actions'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { Modal } from './Controls'

const PATTERN_LENGTHS = [16, 32, 48, 64, 96, 128]

export function NewSongDialog() {
  const close = () => useUi.getState().openDialog(null)
  const chips = listChips()
  const moods = listMoods()
  const [chip, setChip] = useState<ChipId>('nes')
  const [name, setName] = useState('Untitled')
  const [bpm, setBpm] = useState('120')
  const [key, setKey] = useState('C')
  const [scale, setScale] = useState('major')
  const [mood, setMood] = useState('')
  const [length, setLength] = useState(64)
  const [voices, setVoices] = useState(0)
  const info = chips.find((c) => c.id === chip)
  const voiceOptions = voiceChoices(chip)
  const shownVoices = voiceOptions.includes(voices) ? voices : defaultVoices(chip)
  const create = (): void => {
    const m = moods.find((x) => x.id === mood)
    const tempo = Math.max(20, Math.min(400, Math.round(Number(bpm)) || 120))
    if (newSong({ chip, name, bpm: tempo, key, scale, moods: m ? [m.id] : [], patternLength: length, voices: shownVoices || undefined })) close()
  }
  return (
    <Modal title="New song" onClose={close} testId="dialog-new">
      <div className="form">
        <label>
          Chip
          <select value={chip} onChange={(e) => setChip(e.target.value as ChipId)} data-testid="new-chip">
            {chips.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.era})
              </option>
            ))}
          </select>
        </label>
        {voiceOptions.length > 0 && (
          <label>
            Voices
            <select value={shownVoices} onChange={(e) => setVoices(Number(e.target.value))} data-testid="new-voices" title="Channels V1..Vn; set when the song is created (the default role layout uses V1..V16, extra voices are free for doubling)">
              {voiceOptions.map((n) => (
                <option key={n} value={n}>
                  {n} voices
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="new-name" />
        </label>
        <label>
          BPM
          <input type="text" inputMode="numeric" value={bpm} onChange={(e) => setBpm(e.target.value)} data-testid="new-bpm" />
        </label>
        <label>
          Key
          <select value={key} onChange={(e) => setKey(e.target.value)} data-testid="new-key">
            {PITCH_CLASSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scale
          <select value={scale} onChange={(e) => setScale(e.target.value)} data-testid="new-scale">
            {Object.values(SCALES).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mood
          <select
            value={mood}
            onChange={(e) => {
              setMood(e.target.value)
              const m = moods.find((x) => x.id === e.target.value)
              if (m) setBpm(String(Math.round((m.bpm[0] + m.bpm[1]) / 2)))
            }}
            data-testid="new-mood"
          >
            <option value="">(none)</option>
            {moods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pattern length
          <select value={length} onChange={(e) => setLength(Number(e.target.value))} data-testid="new-length">
            {PATTERN_LENGTHS.map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
        </label>
      </div>
      {info && (
        <p className="hint" data-testid="new-chip-info">
          {info.channels.map((c) => c.id).join(' ')}
          {shownVoices > info.channels.length ? ` ... V${shownVoices}` : ''}: {info.description}
        </p>
      )}
      <p className="hint">The current song and its undo history are discarded.</p>
      <div className="modal-actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={create} data-testid="new-create">
          Create
        </button>
      </div>
    </Modal>
  )
}

export function OpenDialog() {
  const close = () => useUi.getState().openDialog(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Open project" onClose={close} testId="dialog-open">
      <div className="form">
        <label className="file-btn block">
          Browse for a .ctune file...
          <input
            type="file"
            accept=".ctune,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              void f.text().then((text) => {
                if (openProjectText(text, null)) close()
              })
            }}
          />
        </label>
        <label>
          Or file name / full path
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-song.ctune (looked up in ~/ChiptuneStudio/projects)" data-testid="open-name" />
        </label>
      </div>
      <div className="modal-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="primary"
          disabled={!name.trim() || busy}
          onClick={() => {
            setBusy(true)
            void openProjectFromPath(name.trim()).then((ok) => {
              setBusy(false)
              if (ok) close()
            })
          }}
          data-testid="open-confirm"
        >
          Open
        </button>
      </div>
    </Modal>
  )
}

export function SaveDialog() {
  const close = () => useUi.getState().openDialog(null)
  const [name, setName] = useState(session.song.name)
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Save project" onClose={close} testId="dialog-save">
      <div className="form">
        <label>
          File name / full path
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="save-name" />
        </label>
      </div>
      <p className="hint">Relative names are saved in ~/ChiptuneStudio/projects as .ctune.</p>
      <div className="modal-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="primary"
          disabled={!name.trim() || busy}
          data-testid="save-confirm"
          onClick={() => {
            setBusy(true)
            void saveProject(name.trim()).then((ok) => {
              setBusy(false)
              if (ok) close()
            })
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}
