import { useMemo, useState } from 'react'
import { type ChipId, listChips } from '../../core'
import { GRID_CHOICES, PATTERN_LENGTH_CHOICES, convertVoices, defaultImportSettings, readFileBytes, reportSummary, runImport, songNameFromFile, type ImportSettings } from '../lib/midiIo'
import { voiceChoices } from '../lib/newSong'
import { applyReplacementSong } from '../state/midiActions'
import { session } from '../state/session'
import { Modal } from './Controls'

/** Import a .mid file: pick it with the browser file picker, choose the chip and options, preview the report, import. */
export function ImportMidiDialog(props: { onClose: () => void }) {
  const chips = listChips()
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [s, setS] = useState<ImportSettings>(() => ({ ...defaultImportSettings(session.song.chip), voices: convertVoices(session.song, session.song.chip) }))
  const [readError, setReadError] = useState<string | null>(null)
  const patch = (p: Partial<ImportSettings>): void => setS((cur) => ({ ...cur, ...p }))
  const voiceOptions = voiceChoices(s.chip)

  const outcome = useMemo(() => (file ? runImport(file.bytes, s, session.song.authenticity) : null), [file, s])

  const pick = (f: File | undefined): void => {
    if (!f) return
    setReadError(null)
    void readFileBytes(f)
      .then((bytes) => {
        setFile({ name: f.name, bytes })
        setS((cur) => ({ ...cur, name: songNameFromFile(f.name) }))
      })
      .catch((e: unknown) => setReadError(e instanceof Error ? e.message : String(e)))
  }

  const run = (): void => {
    if (!outcome || !outcome.ok) return
    const status = `Imported ${file?.name ?? 'MIDI'} as ${outcome.song.chip.toUpperCase()} (${reportSummary(outcome.report)})`
    if (applyReplacementSong(outcome.song, `Import ${file?.name ?? 'MIDI'}`, status)) props.onClose()
  }

  return (
    <Modal title="Import MIDI" onClose={props.onClose} testId="dialog-import-midi" wide>
      <div className="form">
        <label className="file-btn block">
          {file ? `File: ${file.name} (choose another...)` : 'Choose a .mid file...'}
          <input
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            hidden
            data-testid="import-midi-file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              pick(f)
            }}
          />
        </label>
        <label>
          Chip
          <select value={s.chip} onChange={(e) => patch({ chip: e.target.value as ChipId, voices: convertVoices(session.song, e.target.value as ChipId) })} data-testid="import-midi-chip">
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
            <select value={s.voices ?? voiceOptions[0]} onChange={(e) => patch({ voices: Number(e.target.value) })} data-testid="import-midi-voices" title="Channels V1..Vn of the imported song (more voices keep more MIDI tracks)">
              {voiceOptions.map((n) => (
                <option key={n} value={n}>
                  {n} voices
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Song name
          <input value={s.name} onChange={(e) => patch({ name: e.target.value })} data-testid="import-midi-name" />
        </label>
        <label>
          Grid
          <select value={s.rowsPerBeat} onChange={(e) => patch({ rowsPerBeat: Number(e.target.value) })} data-testid="import-midi-grid">
            <option value={0}>Automatic (least timing error)</option>
            {GRID_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} rows per beat
              </option>
            ))}
          </select>
        </label>
        <label>
          Pattern length
          <select value={s.patternLength} onChange={(e) => patch({ patternLength: Number(e.target.value) })} data-testid="import-midi-length">
            <option value={0}>Automatic (whole bars, loop on an order)</option>
            {PATTERN_LENGTH_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
        </label>
        <label>
          Melodic channels
          <select value={s.maxChannels} onChange={(e) => patch({ maxChannels: Number(e.target.value) })} data-testid="import-midi-max">
            <option value={0}>As many as fit</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                At most {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.foldChords} onChange={(e) => patch({ foldChords: e.target.checked })} data-testid="import-midi-fold" />
          Fold chord tones into 0xy arpeggios (off: top voice only)
        </label>
        {s.chip === 'nes' && (
          <label className="check">
            <input type="checkbox" checked={s.dpcm} onChange={(e) => patch({ dpcm: e.target.checked })} data-testid="import-midi-dpcm" />
            Add the DPCM channel (kicks on DM)
          </label>
        )}
        {s.chip === 'genesis' && (
          <label className="check">
            <input type="checkbox" checked={s.fm6Dac} onChange={(e) => patch({ fm6Dac: e.target.checked })} data-testid="import-midi-dac" />
            FM 6 as DAC (kicks on F6)
          </label>
        )}
      </div>
      {readError && <pre className="result error">{readError}</pre>}
      {outcome && !outcome.ok && (
        <pre className="result error" data-testid="import-midi-error">
          {outcome.error}
        </pre>
      )}
      {outcome && outcome.ok && (
        <pre className="result ok" style={{ maxHeight: 220 }} data-testid="import-midi-report">
          {outcome.report.join('\n')}
        </pre>
      )}
      {!file && <p className="hint">MIDI notes are quantized to rows, drums (channel 10) go to the noise/drum channel, melodic tracks to bass, lead and harmony channels. The report lists every decision.</p>}
      <p className="hint">The current song is replaced; Undo brings it back.</p>
      <div className="modal-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" disabled={!outcome || !outcome.ok} onClick={run} data-testid="import-midi-run">
          Import
        </button>
      </div>
    </Modal>
  )
}
