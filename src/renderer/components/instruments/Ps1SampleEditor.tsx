import { useMemo } from 'react'
import { type Instrument, type PsxAdsr, type PsxSampleInstrument, type SampleSlot, resolveSampleSlot, sampleTargetBytes, tryPeekSampleLength } from '../../../core'
import { useSession } from '../../hooks/useSession'
import { formatSeconds, psxAdsrTimes, psxEnvelopeCurve } from '../../lib/ps1Env'
import { session } from '../../state/session'
import { NumberField } from '../Controls'
import { MacroSection } from '../InstrumentEditors'
import { RecipeForm } from './SampleEditor'

type Commit = (next: Instrument, label?: string) => void

const W = 220
const H = 60

/** Small envelope graph (curve values 0..1): 1 s held, then the key-off. Shared by the PS1 and Dreamcast editors. */
export function CurveGraph(props: { curve: number[]; testId: string; holdSec?: number; releaseSec?: number }) {
  const { curve } = props
  const hold = props.holdSec ?? 1
  const total = hold + (props.releaseSec ?? 0.4)
  const pts = curve.map((v, i) => `${(i / (curve.length - 1)) * W},${H - 2 - v * (H - 4)}`).join(' ')
  const keyX = (hold / total) * W
  return (
    <svg className="env-graph" width={W} height={H} data-testid={props.testId} role="img" aria-label={`Envelope: ${hold} second held, then key-off`}>
      <rect x={0} y={0} width={W} height={H} className="macro-bg" />
      <line x1={keyX} y1={0} x2={keyX} y2={H} stroke="var(--border)" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  )
}

/** Sample slot picker that reports the slot's size for the chip's sample target (ADPCM, PCM16, ...). */
export function TargetSamplePicker(props: { value: string; onPick: (id: string) => void; target: string; unit: string }) {
  useSession()
  const slots = session.song.samples
  const current = slots.find((s) => s.id === props.value)
  return (
    <div className="group wrap">
      <span className="label">Sample</span>
      <select value={current ? current.id : ''} onChange={(e) => props.onPick(e.target.value)} data-testid="sample-select" title="Sample slot played by this instrument">
        {!current && <option value="">{props.value ? `(missing: ${props.value})` : '(none)'}</option>}
        {slots.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id}
          </option>
        ))}
      </select>
      <span className="hint" data-testid="sample-info">
        {current ? targetSampleInfo(current, props.target, props.unit) : 'No such sample slot: pick one or generate it below.'}
      </span>
    </div>
  )
}

/** "recipe strings; 8192 samples, ~4608 PS-X ADPCM bytes, loop from 0" for a slot under a sample target. */
export function targetSampleInfo(slot: SampleSlot, target: string, unit: string): string {
  const src = slot.source.kind === 'recipe' ? `recipe ${slot.source.recipe}` : `PCM ${slot.source.sampleRate} Hz`
  const len = tryPeekSampleLength(slot, target)
  if (len === undefined) return `${src}; cannot be generated`
  return `${src}; ${len} samples, ~${sampleTargetBytes(target, len)} ${unit} bytes${slot.loopStart !== undefined ? `, loop from ${slot.loopStart}` : ''}`
}

/** Editor for `psx-sample` instruments: sample, base note, ADSR with readable times and a graph, reverb, pitch mod, noise and macros. */
export function Ps1SampleEditor(props: { inst: PsxSampleInstrument; commit: Commit }) {
  const { inst, commit } = props
  const a = inst.adsr
  const setAdsr = (patch: Partial<PsxAdsr>, label = 'Edit envelope'): void => commit({ ...inst, adsr: { ...a, ...patch } }, label)
  const times = useMemo(() => psxAdsrTimes(a), [a])
  const curve = useMemo(() => psxEnvelopeCurve(a, { holdSec: 1, releaseSec: 0.4, points: W }), [a])
  const setFlag = (key: 'pmod', on: boolean, label: string): void => {
    const next = { ...inst }
    if (on) next[key] = true
    else delete next[key]
    commit(next, label)
  }
  return (
    <div className="editor-block" data-testid="ps1-editor">
      <TargetSamplePicker value={inst.sample} onPick={(id) => commit({ ...inst, sample: id }, 'Pick sample')} target="psx" unit="PS-X ADPCM" />
      <RecipeForm
        onGenerated={(slot) => {
          let baseNote = inst.baseNote
          try {
            baseNote = resolveSampleSlot(session.song, slot.id, 'psx')?.baseNote ?? baseNote
          } catch {
            // keep the old base note
          }
          commit({ ...inst, sample: slot.id, baseNote }, 'Generate sample')
        }}
      />
      <div className="group wrap">
        <span className="label">Base note</span>
        <NumberField value={inst.baseNote} min={0} max={127} onCommit={(v) => commit({ ...inst, baseNote: v }, 'Set base note')} width={40} title="MIDI note at which the sample plays at its native rate (60 = C-4)" testId="ps1-base-note" />
        <span className="label">Fine</span>
        <NumberField value={inst.fine ?? 0} min={-100} max={100} onCommit={(v) => commit({ ...inst, fine: v }, 'Set fine tune')} width={44} title="Fine tune in cents" testId="ps1-fine" />
        <label className="check">
          <input type="checkbox" checked={inst.reverb} onChange={(e) => commit({ ...inst, reverb: e.target.checked }, 'Toggle reverb')} data-testid="ps1-reverb" />
          Reverb (Exx overrides per channel)
        </label>
      </div>
      <div className="group wrap">
        <span className="label">Attack</span>
        <NumberField value={a.attack} min={0} max={127} onCommit={(v) => setAdsr({ attack: v })} width={36} title="Attack rate 0..127 (0 = fastest; shift = rate / 4, step = rate mod 4)" testId="ps1-adsr-a" />
        <label className="check" title="Exponential attack: the rise slows down above 75% level">
          <input type="checkbox" checked={a.attackExp} onChange={(e) => setAdsr({ attackExp: e.target.checked }, 'Toggle exponential attack')} data-testid="ps1-adsr-a-exp" />
          exp
        </label>
        <span className="label">Decay</span>
        <NumberField value={a.decay} min={0} max={15} onCommit={(v) => setAdsr({ decay: v })} width={30} title="Decay shift 0..15 (0 = fastest, always exponential)" testId="ps1-adsr-d" />
        <span className="label">SL</span>
        <NumberField value={a.sustainLevel} min={0} max={15} onCommit={(v) => setAdsr({ sustainLevel: v })} width={30} title="Sustain level 0..15 (15 = full level, level is (n + 1) / 16)" testId="ps1-adsr-sl" />
      </div>
      <div className="group wrap">
        <span className="label">Sustain</span>
        <NumberField value={a.sustainRate} min={0} max={127} onCommit={(v) => setAdsr({ sustainRate: v })} width={36} title="Sustain rate 0..127 (0 = fastest change, 127 = slowest)" testId="ps1-adsr-sr" />
        <select value={a.sustainDir} onChange={(e) => setAdsr({ sustainDir: e.target.value as PsxAdsr['sustainDir'] }, 'Set sustain direction')} title="Level moves down or up while the key is held" data-testid="ps1-adsr-dir">
          <option value="dec">fade out</option>
          <option value="inc">fade in</option>
        </select>
        <label className="check" title="Exponential sustain slope">
          <input type="checkbox" checked={a.sustainExp} onChange={(e) => setAdsr({ sustainExp: e.target.checked }, 'Toggle exponential sustain')} data-testid="ps1-adsr-sr-exp" />
          exp
        </label>
        <span className="label">Release</span>
        <NumberField value={a.release} min={0} max={31} onCommit={(v) => setAdsr({ release: v })} width={30} title="Release shift 0..31 (0 = fastest)" testId="ps1-adsr-r" />
        <label className="check" title="Exponential release">
          <input type="checkbox" checked={a.releaseExp} onChange={(e) => setAdsr({ releaseExp: e.target.checked }, 'Toggle exponential release')} data-testid="ps1-adsr-r-exp" />
          exp
        </label>
      </div>
      <span className="hint" data-testid="ps1-times">
        attack {formatSeconds(times.attackSec)}, decay {formatSeconds(times.decaySec)}, release {formatSeconds(times.releaseSec)}
      </span>
      <CurveGraph curve={curve} testId="ps1-env-graph" />
      <div className="group wrap">
        <label className="check" title="Pitch modulation: this voice's pitch follows the previous voice's output (not on V1)">
          <input type="checkbox" checked={!!inst.pmod} onChange={(e) => setFlag('pmod', e.target.checked, 'Toggle pitch modulation')} data-testid="ps1-pmod" />
          Pitch mod (not on V1)
        </label>
        <label className="check" title="Replace the sample by the global noise generator">
          <input
            type="checkbox"
            checked={!!inst.noise}
            onChange={(e) => {
              const next = { ...inst }
              if (e.target.checked) next.noise = { shift: 8, step: 0 }
              else delete next.noise
              commit(next, 'Toggle noise')
            }}
            data-testid="ps1-noise"
          />
          Noise
        </label>
        {inst.noise && (
          <>
            <span className="label">Shift</span>
            <NumberField value={inst.noise.shift} min={0} max={15} onCommit={(v) => commit({ ...inst, noise: { ...inst.noise!, shift: v } }, 'Set noise shift')} width={30} title="Noise clock shift 0..15 (higher = slower, lower pitch)" testId="ps1-noise-shift" />
            <span className="label">Step</span>
            <NumberField value={inst.noise.step} min={0} max={3} onCommit={(v) => commit({ ...inst, noise: { ...inst.noise!, step: v } }, 'Set noise step')} width={30} title="Noise clock step 0..3" testId="ps1-noise-step" />
          </>
        )}
      </div>
      <MacroSection inst={inst} commit={commit} />
    </div>
  )
}
