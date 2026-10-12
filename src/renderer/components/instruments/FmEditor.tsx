import { type FmInstrument, type FmOp, type Instrument, type Macro, type MacroName } from '../../../core'
import { NumberField } from '../Controls'
import { MacroEditor } from '../MacroEditor'
import { FM_ALGORITHMS, SK_H, SK_W, envelopePoints } from '../../lib/fmLayout'

type Commit = (next: Instrument, label?: string) => void

// ---------------------------------------------------------------- algorithm diagrams

/** Small SVG diagram of an algorithm; carriers are filled, OP1 shows its feedback loop. */
export function AlgDiagram(props: { alg: number; scale?: number }) {
  const a = FM_ALGORITHMS[Math.max(0, Math.min(7, props.alg))]!
  const s = props.scale ?? 1
  const NW = 20
  const NH = 14
  const DX = 30
  const DY = 18
  const X0 = 8
  const Y0 = 12
  const cx = (i: number): number => X0 + a.pos[i]![0] * DX + NW / 2
  const cy = (i: number): number => Y0 + a.pos[i]![1] * DY + NH / 2
  const maxCol = Math.max(...a.pos.map((p) => p[0]))
  const maxRow = Math.max(...a.pos.map((p) => p[1]))
  const w = X0 * 2 + maxCol * DX + NW + 16
  const h = Y0 + maxRow * DY + NH + 8
  return (
    <svg className="fm-alg" width={w * s} height={h * s} viewBox={`0 0 ${w} ${h}`} data-testid={`fm-alg-diagram-${props.alg}`}>
      {/* feedback loop on OP1 */}
      <path d={`M ${cx(0) - 5} ${cy(0) - NH / 2} q -2 -9 5 -9 q 7 0 5 9`} className="fm-line" fill="none" />
      {a.edges.map(([f, t], i) => (
        <line key={i} x1={cx(f) + (a.pos[t]![0] > a.pos[f]![0] ? NW / 2 : 0)} y1={cy(f) + (a.pos[t]![0] > a.pos[f]![0] ? 0 : NH / 2)} x2={cx(t) - (a.pos[t]![0] > a.pos[f]![0] ? NW / 2 : 0)} y2={cy(t) - (a.pos[t]![0] > a.pos[f]![0] ? 0 : NH / 2)} className="fm-line" />
      ))}
      {a.carriers.map((c) => (
        <line key={`o${c}`} x1={cx(c) + NW / 2} y1={cy(c)} x2={w - 4} y2={cy(c)} className="fm-line fm-out" />
      ))}
      {a.pos.map((_, i) => (
        <g key={i}>
          <rect x={cx(i) - NW / 2} y={cy(i) - NH / 2} width={NW} height={NH} rx={2} className={a.carriers.includes(i) ? 'fm-node fm-carrier' : 'fm-node'} />
          <text x={cx(i)} y={cy(i) + 3.5} textAnchor="middle" className="fm-node-text">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ---------------------------------------------------------------- envelope sketch

function EnvSketch(props: { op: FmOp }) {
  return (
    <svg className="fm-env" width={SK_W} height={SK_H} viewBox={`0 0 ${SK_W} ${SK_H}`}>
      <rect x={0} y={0} width={SK_W} height={SK_H} className="macro-bg" />
      <polyline points={envelopePoints(props.op)} className="fm-env-line" fill="none" />
    </svg>
  )
}

// ---------------------------------------------------------------- operator table

interface Field {
  key: 'ar' | 'dr' | 'sr' | 'rr' | 'sl' | 'tl' | 'ks' | 'ml' | 'dt' | 'ssg'
  label: string
  min: number
  max: number
  title: string
}

const FIELDS: Field[] = [
  { key: 'ar', label: 'AR', min: 0, max: 31, title: 'Attack rate 0..31 (31 = instant)' },
  { key: 'dr', label: 'DR', min: 0, max: 31, title: 'Decay rate 0..31: how fast the level falls to SL' },
  { key: 'sr', label: 'SR', min: 0, max: 31, title: 'Sustain rate 0..31: slow fall after SL (0 = hold)' },
  { key: 'rr', label: 'RR', min: 0, max: 15, title: 'Release rate 0..15 (15 = fast)' },
  { key: 'sl', label: 'SL', min: 0, max: 15, title: 'Sustain level 0..15 (3 dB steps below the peak)' },
  { key: 'tl', label: 'TL', min: 0, max: 127, title: 'Total level 0..127 = attenuation (0.75 dB steps): carriers are the volume, modulators the brightness' },
  { key: 'ks', label: 'KS', min: 0, max: 3, title: 'Key scaling 0..3: higher notes envelope faster' },
  { key: 'ml', label: 'ML', min: 0, max: 15, title: 'Frequency multiplier 0..15 (0 = x0.5)' },
  { key: 'dt', label: 'DT', min: -3, max: 3, title: 'Detune -3..3' },
  { key: 'ssg', label: 'SSG', min: 0, max: 15, title: 'SSG-EG 0..15 (0 = off, 8..15 = looping envelope shapes)' }
]

function OperatorTable(props: { inst: FmInstrument; commit: Commit }) {
  const { inst } = props
  const setOp = (i: number, patch: Partial<FmOp>, label: string): void => {
    const ops = inst.ops.map((o, k) => (k === i ? { ...o, ...patch } : o)) as FmInstrument['ops']
    props.commit({ ...inst, ops }, label)
  }
  const carriers = FM_ALGORITHMS[inst.alg]?.carriers ?? []
  return (
    <table className="fm-ops" data-testid="fm-ops">
      <thead>
        <tr>
          <th>Op</th>
          {FIELDS.map((f) => (
            <th key={f.key} title={f.title}>
              {f.label}
            </th>
          ))}
          <th title="Amplitude modulation by the LFO">AM</th>
          <th>Envelope</th>
        </tr>
      </thead>
      <tbody>
        {inst.ops.map((op, i) => (
          <tr key={i} className={carriers.includes(i) ? 'fm-carrier-row' : undefined}>
            <td title={carriers.includes(i) ? 'Carrier: heard directly' : 'Modulator: shapes the next operator'}>{`OP${i + 1}${carriers.includes(i) ? ' *' : ''}`}</td>
            {FIELDS.map((f) => (
              <td key={f.key}>
                <NumberField
                  value={op[f.key] ?? 0}
                  min={f.min}
                  max={f.max}
                  width={f.key === 'tl' ? 36 : 30}
                  title={f.title}
                  testId={`fm-op${i + 1}-${f.key}`}
                  onCommit={(v) => setOp(i, { [f.key]: v } as Partial<FmOp>, `Edit OP${i + 1} ${f.label}`)}
                />
              </td>
            ))}
            <td>
              <input type="checkbox" checked={!!op.am} onChange={(e) => setOp(i, { am: e.target.checked }, `Edit OP${i + 1} AM`)} data-testid={`fm-op${i + 1}-am`} />
            </td>
            <td>
              <EnvSketch op={op} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- macros

const FM_MACROS: { name: MacroName; label: string; min: number; max: number; limitMin?: number; limitMax?: number; initial: number }[] = [
  { name: 'vol', label: 'Volume (0..15, scales the carriers)', min: 0, max: 15, initial: 15 },
  { name: 'arp', label: 'Arpeggio / pitch offset', min: -24, max: 24, limitMin: -96, limitMax: 127, initial: 0 },
  { name: 'pitch', label: 'Pitch (1/16 semitone per tick)', min: -64, max: 64, limitMin: -128, limitMax: 127, initial: 0 }
]

function FmMacros(props: { inst: FmInstrument; commit: Commit }) {
  const { inst } = props
  const macros = inst.macros ?? {}
  const setMacro = (name: MacroName, m: Macro | undefined): void => {
    const next = { ...macros }
    if (m) next[name] = m
    else delete next[name]
    props.commit({ ...inst, macros: next }, `Edit ${name} macro`)
  }
  return (
    <div className="macro-section">
      {FM_MACROS.map((d) => (
        <MacroEditor
          key={d.name}
          label={d.label}
          macro={macros[d.name]}
          min={d.min}
          max={d.max}
          limitMin={d.limitMin}
          limitMax={d.limitMax}
          initial={d.initial}
          arpMode={d.name === 'arp'}
          onCommit={(m) => setMacro(d.name, m)}
          testId={`macro-${d.name}`}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- the editor

/** Editor for `fm` instruments: algorithm picker with diagrams, feedback / AMS / PMS, the 4-operator table and macros. */
export function FmEditor(props: { inst: FmInstrument; commit: Commit }) {
  const { inst, commit } = props
  return (
    <div className="editor-block" data-testid="fm-editor">
      <div className="group wrap" role="radiogroup" aria-label="Algorithm">
        <span className="label">Algorithm</span>
        {FM_ALGORITHMS.map((_, n) => (
          <button
            key={n}
            className={`fm-alg-btn${n === inst.alg ? ' primary' : ''}`}
            onClick={() => commit({ ...inst, alg: n }, `Algorithm ${n}`)}
            title={`Algorithm ${n}`}
            aria-checked={n === inst.alg}
            role="radio"
            data-testid={`fm-alg-${n}`}
          >
            <span className="fm-alg-num">{n}</span>
            <AlgDiagram alg={n} scale={0.7} />
          </button>
        ))}
      </div>
      <div className="group wrap">
        <span className="label">Selected</span>
        <AlgDiagram alg={inst.alg} scale={1.3} />
        <span className="hint">Filled boxes are carriers (heard); the others modulate. OP1 feeds back into itself.</span>
      </div>
      <div className="group wrap">
        <span className="label">Feedback</span>
        <NumberField value={inst.fb} min={0} max={7} width={30} title="OP1 self-feedback 0..7" testId="fm-fb" onCommit={(v) => commit({ ...inst, fb: v }, 'Edit feedback')} />
        <span className="label">AMS</span>
        <NumberField value={inst.ams} min={0} max={3} width={30} title="LFO amplitude-modulation depth 0..3 (operators with AM)" testId="fm-ams" onCommit={(v) => commit({ ...inst, ams: v }, 'Edit AMS')} />
        <span className="label">PMS</span>
        <NumberField value={inst.pms} min={0} max={7} width={30} title="LFO vibrato depth 0..7" testId="fm-pms" onCommit={(v) => commit({ ...inst, pms: v }, 'Edit PMS')} />
        <span className="hint">AMS and PMS only sound when the song's Genesis LFO (chipConfig.lfo 1..8) is on.</span>
      </div>
      <OperatorTable inst={inst} commit={commit} />
      <FmMacros inst={inst} commit={commit} />
    </div>
  )
}
