import { useMemo } from 'react'
import { type Instrument, type SnesEnvelope, type SnesSampleInstrument, resolveSampleSlot } from '../../../core'
import { snesAttackSeconds, snesEnvelopeCurve } from '../../lib/snesEnv'
import { session } from '../../state/session'
import { NumberField } from '../Controls'
import { MacroSection } from '../InstrumentEditors'
import { RecipeForm, SamplePicker } from './SampleEditor'

type Commit = (next: Instrument, label?: string) => void

const GAIN_MODES = ['direct', 'linear-dec', 'exp-dec', 'linear-inc', 'bent-inc'] as const

const W = 220
const H = 60

/** Small envelope graph: 1 s held, then the key-off. */
export function EnvelopeGraph(props: { env: SnesEnvelope }) {
  const curve = useMemo(() => snesEnvelopeCurve(props.env, { holdSec: 1, releaseSec: 0.4, points: W }), [props.env])
  const pts = curve.map((v, i) => `${(i / (curve.length - 1)) * W},${H - 2 - v * (H - 4)}`).join(' ')
  const keyX = (1 / 1.4) * W
  return (
    <svg className="env-graph" width={W} height={H} data-testid="snes-env-graph" role="img" aria-label="Envelope: 1 second held, then key-off">
      <rect x={0} y={0} width={W} height={H} className="macro-bg" />
      <line x1={keyX} y1={0} x2={keyX} y2={H} stroke="var(--border)" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  )
}

/** Editor for `snes-sample` instruments: sample, base note, ADSR/GAIN with a graph, echo and macros. */
export function SnesSampleEditor(props: { inst: SnesSampleInstrument; commit: Commit }) {
  const { inst, commit } = props
  const env = inst.env
  const isAdsr = 'adsr' in env
  const setEnv = (next: SnesEnvelope, label = 'Edit envelope'): void => commit({ ...inst, env: next }, label)
  const attack = snesAttackSeconds(env)
  return (
    <div className="editor-block" data-testid="snes-editor">
      <SamplePicker value={inst.sample} onPick={(id) => commit({ ...inst, sample: id }, 'Pick sample')} />
      <RecipeForm
        onGenerated={(slot) => {
          let baseNote = inst.baseNote
          try {
            baseNote = resolveSampleSlot(session.song, slot.id)?.baseNote ?? baseNote
          } catch {
            // keep the old base note
          }
          commit({ ...inst, sample: slot.id, baseNote }, 'Generate sample')
        }}
      />
      <div className="group wrap">
        <span className="label">Base note</span>
        <NumberField value={inst.baseNote} min={0} max={127} onCommit={(v) => commit({ ...inst, baseNote: v }, 'Set base note')} width={40} title="MIDI note at which the sample plays at its native rate (60 = C-4)" testId="snes-base-note" />
        <span className="label">Fine</span>
        <NumberField value={inst.fine ?? 0} min={-100} max={100} onCommit={(v) => commit({ ...inst, fine: v }, 'Set fine tune')} width={44} title="Fine tune in cents" testId="snes-fine" />
        <label className="check">
          <input type="checkbox" checked={inst.echo} onChange={(e) => commit({ ...inst, echo: e.target.checked }, 'Toggle echo')} data-testid="snes-echo" />
          Echo (Exx overrides per channel)
        </label>
      </div>
      <div className="group wrap">
        <span className="label">Envelope</span>
        <select
          value={isAdsr ? 'adsr' : 'gain'}
          onChange={(e) => setEnv(e.target.value === 'adsr' ? { adsr: [15, 7, 7, 0] } : { gain: { mode: 'exp-dec', rate: 20 } }, 'Switch envelope mode')}
          data-testid="snes-env-mode"
        >
          <option value="adsr">ADSR</option>
          <option value="gain">GAIN</option>
        </select>
        {'adsr' in env ? (
          <>
            <span className="label">A</span>
            <NumberField value={env.adsr[0]} min={0} max={15} onCommit={(v) => setEnv({ adsr: [v, env.adsr[1], env.adsr[2], env.adsr[3]] })} width={30} title="Attack 0..15 (15 = instant, 0 = 4.1 s)" testId="snes-adsr-a" />
            <span className="label">D</span>
            <NumberField value={env.adsr[1]} min={0} max={7} onCommit={(v) => setEnv({ adsr: [env.adsr[0], v, env.adsr[2], env.adsr[3]] })} width={30} title="Decay 0..7" testId="snes-adsr-d" />
            <span className="label">SL</span>
            <NumberField value={env.adsr[2]} min={0} max={7} onCommit={(v) => setEnv({ adsr: [env.adsr[0], env.adsr[1], v, env.adsr[3]] })} width={30} title="Sustain level 0..7 (7 = full level)" testId="snes-adsr-sl" />
            <span className="label">SR</span>
            <NumberField value={env.adsr[3]} min={0} max={31} onCommit={(v) => setEnv({ adsr: [env.adsr[0], env.adsr[1], env.adsr[2], v] })} width={34} title="Sustain rate 0..31 (0 = hold forever, higher = faster fade)" testId="snes-adsr-sr" />
          </>
        ) : (
          <>
            <select value={env.gain.mode} onChange={(e) => setEnv({ gain: { mode: e.target.value as (typeof GAIN_MODES)[number], rate: Math.min(env.gain.rate, e.target.value === 'direct' ? 127 : 31) } }, 'Set GAIN mode')} data-testid="snes-gain-mode">
              {GAIN_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <span className="label">Rate</span>
            <NumberField value={env.gain.rate} min={0} max={env.gain.mode === 'direct' ? 127 : 31} onCommit={(v) => setEnv({ gain: { ...env.gain, rate: v } })} width={40} title={env.gain.mode === 'direct' ? 'Level 0..127' : 'Rate 0..31 (0 = never changes)'} testId="snes-gain-rate" />
          </>
        )}
        <span className="hint">{Number.isFinite(attack) ? `attack ${(attack * 1000).toFixed(attack < 0.01 ? 2 : 0)} ms` : ''}</span>
      </div>
      <EnvelopeGraph env={env} />
      <MacroSection inst={inst} commit={commit} />
    </div>
  )
}
