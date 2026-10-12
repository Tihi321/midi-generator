import { useMemo, useState } from 'react'
import type { ChipId } from '../../core'
import { convertChoices, defaultConvertTarget, reportSummary, runConvert, type ConvertSettings } from '../lib/midiIo'
import { applyReplacementSong } from '../state/midiActions'
import { session } from '../state/session'
import { Modal } from './Controls'

/** Convert the open song to another chip: channels by role, presets by role, ranges and effects adapted. */
export function ConvertChipDialog(props: { onClose: () => void }) {
  const song = session.song
  const choices = convertChoices(song)
  const [s, setS] = useState<ConvertSettings>(() => ({ chip: defaultConvertTarget(song), dpcm: false, fm6Dac: false }))
  const outcome = useMemo(() => runConvert(song, s), [song, s])
  const patch = (p: Partial<ConvertSettings>): void => setS((cur) => ({ ...cur, ...p }))

  const run = (): void => {
    if (!outcome.ok || outcome.noop) return
    const status = `Converted to ${outcome.song.chip.toUpperCase()} (${reportSummary(outcome.report)})`
    if (applyReplacementSong(outcome.song, `Convert to ${outcome.song.chip.toUpperCase()}`, status)) props.onClose()
  }

  return (
    <Modal title="Convert chip" onClose={props.onClose} testId="dialog-convert" wide>
      <div className="form">
        <label>
          Target chip
          <select value={s.chip} onChange={(e) => patch({ chip: e.target.value as ChipId })} data-testid="convert-chip">
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.current ? ' - current' : ''}
              </option>
            ))}
          </select>
        </label>
        {s.chip === 'nes' && (
          <label className="check">
            <input type="checkbox" checked={s.dpcm} onChange={(e) => patch({ dpcm: e.target.checked })} data-testid="convert-dpcm" />
            Add the DPCM channel (kicks on DM)
          </label>
        )}
        {s.chip === 'genesis' && (
          <label className="check">
            <input type="checkbox" checked={s.fm6Dac} onChange={(e) => patch({ fm6Dac: e.target.checked })} data-testid="convert-dac" />
            FM 6 as DAC (kicks on F6)
          </label>
        )}
      </div>
      {!outcome.ok && (
        <pre className="result error" data-testid="convert-error">
          {outcome.error}
        </pre>
      )}
      {outcome.ok && (
        <pre className={outcome.noop ? 'result' : 'result ok'} style={{ maxHeight: 240 }} data-testid="convert-report">
          {outcome.report.join('\n')}
        </pre>
      )}
      <p className="hint">Instruments are replaced by the target chip&apos;s presets for the same role; macros and hand-made patches are not carried over. Undo brings the old song back.</p>
      <div className="modal-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" disabled={!outcome.ok || outcome.noop} onClick={run} data-testid="convert-run">
          Convert
        </button>
      </div>
    </Modal>
  )
}
