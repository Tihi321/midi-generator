import { PS1_REVERB_PRESETS, type Ps1Config, type Ps1ReverbPreset } from '../../core'
import { PS1_REVERB_LABELS, ps1RamMeter } from '../lib/ps1Env'
import { setSongInfo } from '../state/actions'
import { session } from '../state/session'
import { NumberField } from './Controls'

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Song-level PS1 SPU reverb settings (preset, output depth, input level) and the SPU RAM meter. Shown in the transport bar for PS1 songs. */
export function Ps1ReverbControls() {
  const song = session.song
  const cfg = song.chipConfig as Ps1Config
  if (cfg.chip !== 'ps1') return null
  const r = cfg.reverb
  const set = (patch: Partial<Ps1Config['reverb']>, label: string): void => {
    setSongInfo({ chipConfig: { reverb: patch } }, label)
  }
  const ram = ps1RamMeter(song)
  return (
    <div className="group wrap ps1-reverb" data-testid="ps1-reverb-controls">
      <span className="label" title="SPU hardware reverb (psx-spx register sets, run at 22.05 kHz). Each voice sends to it when its instrument has reverb on (Exx overrides).">
        Reverb
      </span>
      <select value={r.preset} onChange={(ev) => set({ preset: ev.target.value as Ps1ReverbPreset }, `Reverb ${ev.target.value}`)} title={PS1_REVERB_LABELS[r.preset]?.hint ?? 'Reverb preset'} data-testid="ps1-reverb-preset">
        {PS1_REVERB_PRESETS.map((p) => (
          <option key={p} value={p} title={PS1_REVERB_LABELS[p].hint}>
            {PS1_REVERB_LABELS[p].label}
          </option>
        ))}
      </select>
      <span className="label">Depth</span>
      <NumberField value={Math.round(r.depth * 100)} min={0} max={100} onCommit={(v) => set({ depth: v / 100 }, 'Set reverb depth')} width={36} title="Reverb output volume in percent (vLOUT / vROUT)" testId="ps1-reverb-depth" />
      <span className="label">In</span>
      <NumberField value={Math.round(r.inputVol * 100)} min={0} max={100} onCommit={(v) => set({ inputVol: v / 100 }, 'Set reverb input')} width={36} title="Reverb input volume in percent (vLIN / vRIN)" testId="ps1-reverb-in" />
      <span
        className={`muted${ram.usedBytes > ram.totalBytes ? ' error' : ''}`}
        title={`SPU RAM: samples ${kb(ram.sampleBytes)} KB + reverb work area and reserved ${kb(ram.effectBytes)} KB`}
        data-testid="spu-usage"
      >
        {kb(ram.usedBytes)}/{kb(ram.totalBytes)} KB
      </span>
    </div>
  )
}
