import { useMemo, useState } from 'react'
import { renderOffline } from '../audio/renderClient'
import { DEFAULT_EXPORT, type ExportSettings, estimateExport, planWavExport, renderOptionsFor } from '../lib/exporter'
import { writeExportFiles } from '../lib/files'
import { ARP_MODES, DEFAULT_MIDI_EXPORT, type MidiExportSettings, describeMidiExport, planMidiExport } from '../lib/midiIo'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { Modal } from './Controls'

function clock(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

type Format = 'wav' | 'midi'

/** Export: WAV (rendered in the render Worker, with progress) or MIDI (written directly); files go through the main process. */
export function ExportDialog() {
  const close = () => useUi.getState().openDialog(null)
  const song = session.song
  const [format, setFormat] = useState<Format>('wav')
  const [s, setS] = useState<ExportSettings>({ ...DEFAULT_EXPORT, baseName: song.name })
  const [midi, setMidi] = useState<MidiExportSettings>(DEFAULT_MIDI_EXPORT)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const patch = (p: Partial<ExportSettings>): void => {
    setS((cur) => ({ ...cur, ...p }))
    setResult(null)
  }
  const patchMidi = (p: Partial<MidiExportSettings>): void => {
    setMidi((cur) => ({ ...cur, ...p }))
    setResult(null)
  }
  const est = useMemo(() => estimateExport(song, s), [song, s])
  const midiEst = useMemo(() => {
    if (format !== 'midi') return null
    try {
      return describeMidiExport(planMidiExport(song, s.baseName, midi).info)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [format, song, s.baseName, midi])

  const runWav = async (): Promise<void> => {
    setProgress({ fraction: 0, label: 'Starting' })
    const snapshot = session.song
    const rendered = await renderOffline(snapshot, renderOptionsFor(s), (fraction, label) => setProgress({ fraction, label }))
    setProgress({ fraction: 0.95, label: 'Writing files' })
    const files = planWavExport(snapshot, s, rendered)
    const paths = await writeExportFiles(files, s.dir)
    const loopNote = rendered.loopStart !== null ? ` (loop ${rendered.loopStart}..${rendered.loopEnd})` : ''
    setResult({ ok: true, text: `Exported${loopNote}:\n${paths.join('\n')}` })
    useUi.getState().setStatus(`Exported ${paths.length} file(s)`)
    setProgress({ fraction: 1, label: 'Done' })
  }

  const runMidi = async (): Promise<void> => {
    const plan = planMidiExport(session.song, s.baseName, { ...midi, loops: est.looping ? midi.loops : 1 })
    if (plan.info.notes === 0) throw new Error('The song has no notes, so the MIDI file would be empty.')
    const paths = await writeExportFiles([plan.file], s.dir)
    setResult({ ok: true, text: `Exported MIDI (${describeMidiExport(plan.info)}):\n${paths.join('\n')}` })
    useUi.getState().setStatus(`Exported ${paths.length} file(s)`)
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    setProgress(null)
    try {
      if (format === 'wav') await runWav()
      else await runMidi()
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={format === 'wav' ? 'Export WAV' : 'Export MIDI'} onClose={close} testId="dialog-export">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={format === 'wav'} className={format === 'wav' ? 'active' : ''} onClick={() => { setFormat('wav'); setResult(null) }} data-testid="export-tab-wav">
          WAV
        </button>
        <button role="tab" aria-selected={format === 'midi'} className={format === 'midi' ? 'active' : ''} onClick={() => { setFormat('midi'); setResult(null) }} data-testid="export-tab-midi">
          MIDI
        </button>
      </div>
      <div className="form">
        <label>
          File name
          <input value={s.baseName} onChange={(e) => patch({ baseName: e.target.value })} data-testid="export-name" />
        </label>
        <label>
          Folder
          <input value={s.dir} onChange={(e) => patch({ dir: e.target.value })} placeholder="default: ~/ChiptuneStudio/exports" data-testid="export-dir" />
        </label>
        {format === 'wav' && (
          <label>
            Sample rate
            <select value={s.sampleRate} onChange={(e) => patch({ sampleRate: Number(e.target.value) === 48000 ? 48000 : 44100 })} data-testid="export-rate">
              <option value={44100}>44100 Hz</option>
              <option value={48000}>48000 Hz</option>
            </select>
          </label>
        )}
        <label>
          Loops
          <input
            type="number"
            min={1}
            max={format === 'wav' ? 16 : 8}
            value={format === 'wav' ? s.loops : midi.loops}
            onChange={(e) => (format === 'wav' ? patch({ loops: Number(e.target.value) || 1 }) : patchMidi({ loops: Number(e.target.value) || 1 }))}
            data-testid="export-loops"
            disabled={!est.looping}
          />
        </label>
        {format === 'wav' && (
          <label>
            Fade out (s)
            <input type="number" min={0} max={60} step={0.5} value={s.fadeOutSec} onChange={(e) => patch({ fadeOutSec: Number(e.target.value) || 0 })} data-testid="export-fade" />
          </label>
        )}
        {format === 'wav' && (
          <label className="check">
            <input type="checkbox" checked={s.stems} onChange={(e) => patch({ stems: e.target.checked })} data-testid="export-stems" />
            Stems (one WAV per channel)
          </label>
        )}
        {format === 'midi' && (
          <label>
            Arpeggios (0xy)
            <select value={midi.arpMode} onChange={(e) => patchMidi({ arpMode: e.target.value as MidiExportSettings['arpMode'] })} data-testid="export-arp">
              {ARP_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {format === 'wav' ? (
        <p className="hint" data-testid="export-estimate">
          {est.looping ? 'Looping song' : 'One-shot song'}, about {clock(est.seconds)}, {est.files} file{est.files === 1 ? '' : 's'}
          {est.loopPoints ? ', with loop points (smpl chunk)' : est.looping ? ', no loop points (faded)' : ''}.
        </p>
      ) : (
        <p className="hint" data-testid="export-estimate">
          Standard MIDI File (type 1, 480 PPQ): tempo map, key and time signature, order markers, loopStart/loopEnd + CC111 for looping songs, drums on channel 10. {midiEst}
        </p>
      )}
      {progress && format === 'wav' && (
        <div className="progress-row" data-testid="export-progress">
          <progress value={progress.fraction} max={1} />
          <span className="muted">{progress.label}</span>
        </div>
      )}
      {result && (
        <pre className={result.ok ? 'result ok' : 'result error'} data-testid="export-result">
          {result.text}
        </pre>
      )}
      <div className="modal-actions">
        <button onClick={close}>Close</button>
        <button className="primary" disabled={busy} onClick={() => void run()} data-testid="export-run">
          {busy ? 'Exporting...' : 'Export'}
        </button>
      </div>
    </Modal>
  )
}
