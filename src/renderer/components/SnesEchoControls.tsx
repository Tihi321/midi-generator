import { type SnesConfig, ARAM_BYTES, snesAramUsage } from '../../core'
import { SNES_FIR_PRESETS, firPresetName } from '../lib/snesEcho'
import { setSongInfo } from '../state/actions'
import { session } from '../state/session'
import { NumberField } from './Controls'

/** Song-level SNES echo settings (delay x 16 ms, feedback, echo volumes, FIR). Shown in the transport bar for SNES songs. */
export function SnesEchoControls() {
  const song = session.song
  const cfg = song.chipConfig as SnesConfig
  if (cfg.chip !== 'snes') return null
  const e = cfg.echo
  const set = (patch: Partial<SnesConfig['echo']>, label: string): void => {
    setSongInfo({ chipConfig: { echo: patch } }, label)
  }
  const usage = snesAramUsage(song)
  const fir = firPresetName(e.fir)
  return (
    <div className="group snes-echo" data-testid="snes-echo-controls">
      <span className="label" title="Global SNES echo: delay in 16 ms steps, feedback and volume in percent, 8-tap FIR filter. Each voice sends to it when its instrument has echo on (Exx overrides).">
        Echo
      </span>
      <span className="label">Delay</span>
      <NumberField value={e.delay} min={0} max={15} onCommit={(v) => set({ delay: v }, 'Set echo delay')} width={30} title="Echo delay in 16 ms steps (0..15); every step uses 2 KB of the 64 KB ARAM" testId="echo-delay" />
      <span className="label">Fb</span>
      <NumberField value={Math.round(e.feedback * 100)} min={-100} max={100} onCommit={(v) => set({ feedback: v / 100 }, 'Set echo feedback')} width={38} title="Feedback in percent (-100..100)" testId="echo-feedback" />
      <span className="label">Vol L/R</span>
      <NumberField value={Math.round(e.volL * 100)} min={0} max={100} onCommit={(v) => set({ volL: v / 100 }, 'Set echo volume')} width={34} title="Echo volume left, percent" testId="echo-vol-l" />
      <NumberField value={Math.round(e.volR * 100)} min={0} max={100} onCommit={(v) => set({ volR: v / 100 }, 'Set echo volume')} width={34} title="Echo volume right, percent" testId="echo-vol-r" />
      <select
        value={fir}
        onChange={(ev) => {
          const taps = SNES_FIR_PRESETS[ev.target.value]
          if (taps) set({ fir: [...taps] }, `Echo filter ${ev.target.value}`)
        }}
        title="Echo FIR filter"
        data-testid="echo-fir"
      >
        {fir === 'custom' && <option value="custom">custom</option>}
        {Object.keys(SNES_FIR_PRESETS).map((n) => (
          <option key={n} value={n}>
            FIR {n}
          </option>
        ))}
      </select>
      <span className={`muted${usage.total > ARAM_BYTES ? ' error' : ''}`} title="Approximate ARAM use: samples that instruments play plus the echo buffer" data-testid="aram-usage">
        {Math.round(usage.total / 1024)}/{ARAM_BYTES / 1024} KB
      </span>
    </div>
  )
}
