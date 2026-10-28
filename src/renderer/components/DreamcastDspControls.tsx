import { DC_DSP_PRESETS, type DcDspPreset, type DreamcastConfig } from '../../core'
import { DC_DSP_LABELS, dcRamMeter } from '../lib/aicaEnv'
import { setSongInfo } from '../state/actions'
import { session } from '../state/session'
import { NumberField } from './Controls'

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Song-level Dreamcast AICA DSP settings (preset, mix, time, feedback, chorus, delay) and the AICA RAM meter. Shown in the transport bar for Dreamcast songs. */
export function DreamcastDspControls() {
  const song = session.song
  const cfg = song.chipConfig as DreamcastConfig
  if (cfg.chip !== 'dreamcast') return null
  const d = cfg.dsp
  const set = (patch: Partial<DreamcastConfig['dsp']>, label: string): void => {
    setSongInfo({ chipConfig: { dsp: patch } }, label)
  }
  const ram = dcRamMeter(song)
  return (
    <div className="group wrap dc-dsp" data-testid="dc-dsp-controls">
      <span className="label" title="AICA DSP effect: fixed reverb / chorus / delay presets (the real microcode is not emulated). Each slot sends to it by its instrument's send level (Exx switches it on or off).">
        DSP
      </span>
      <select value={d.preset} onChange={(ev) => set({ preset: ev.target.value as DcDspPreset }, `DSP ${ev.target.value}`)} title={DC_DSP_LABELS[d.preset]?.hint ?? 'DSP preset'} data-testid="dc-dsp-preset">
        {DC_DSP_PRESETS.map((p) => (
          <option key={p} value={p} title={DC_DSP_LABELS[p].hint}>
            {DC_DSP_LABELS[p].label}
          </option>
        ))}
      </select>
      <span className="label">Mix</span>
      <NumberField value={Math.round(d.mix * 100)} min={0} max={100} onCommit={(v) => set({ mix: v / 100 }, 'Set DSP mix')} width={36} title="Wet level in percent" testId="dc-dsp-mix" />
      <span className="label">Time</span>
      <NumberField value={Math.round(d.time * 100)} min={0} max={100} onCommit={(v) => set({ time: v / 100 }, 'Set DSP time')} width={36} title="Reverb time / size in percent" testId="dc-dsp-time" />
      <span className="label">Fb</span>
      <NumberField value={Math.round(d.feedback * 100)} min={0} max={95} onCommit={(v) => set({ feedback: v / 100 }, 'Set DSP feedback')} width={36} title="Delay feedback in percent (0..95)" testId="dc-dsp-feedback" />
      <span className="label">Delay</span>
      <NumberField value={d.delayMs} min={10} max={1000} onCommit={(v) => set({ delayMs: v }, 'Set DSP delay')} width={44} title="Delay time in ms (10..1000), for the delay and echo presets" testId="dc-dsp-delay" />
      <span className="label">Chorus</span>
      <NumberField value={Math.round(d.chorusRate * 100)} min={0} max={100} onCommit={(v) => set({ chorusRate: v / 100 }, 'Set chorus rate')} width={36} title="Chorus LFO rate in percent" testId="dc-dsp-chorus-rate" />
      <NumberField value={Math.round(d.chorusDepth * 100)} min={0} max={100} onCommit={(v) => set({ chorusDepth: v / 100 }, 'Set chorus depth')} width={36} title="Chorus depth in percent" testId="dc-dsp-chorus-depth" />
      <span
        className={`muted${ram.usedBytes > ram.totalBytes ? ' error' : ''}`}
        title={`AICA RAM: samples ${kb(ram.sampleBytes)} KB + DSP buffer ${kb(ram.effectBytes)} KB`}
        data-testid="aica-usage"
      >
        {ram.totalBytes >= 1024 * 1024 ? `${(ram.usedBytes / 1048576).toFixed(2)}/${ram.totalBytes / 1048576} MB` : `${kb(ram.usedBytes)}/${kb(ram.totalBytes)} KB`}
      </span>
    </div>
  )
}
