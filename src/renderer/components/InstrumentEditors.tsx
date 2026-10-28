import { useEffect, useState } from 'react'
import {
  type GbEnvelope,
  type GbNoiseInstrument,
  type GbPulseInstrument,
  type GbWaveInstrument,
  type Instrument,
  type Macro,
  type MacroName,
  GB_WAVES,
  MACRO_NAMES,
  ROLES
} from '../../core'
import { previewNote, renameInstrument, updateInstrument } from '../state/actions'
import { session } from '../state/session'
import { NumberField } from './Controls'
import { MacroEditor } from './MacroEditor'
import { DreamcastSampleEditor } from './instruments/DreamcastSampleEditor'
import { FmEditor } from './instruments/FmEditor'
import { PceWaveEditor } from './instruments/PceWaveEditor'
import { Ps1SampleEditor } from './instruments/Ps1SampleEditor'
import { SampleEditor } from './instruments/SampleEditor'
import { SnesSampleEditor } from './instruments/SnesSampleEditor'

type Commit = (next: Instrument, label?: string) => void

// ---------------------------------------------------------------- macros

function timbreRange(inst: Instrument): { min: number; max: number } {
  switch (inst.kind) {
    case 'nes-pulse':
    case 'gb-pulse':
      return { min: 0, max: 3 }
    case 'nes-noise':
    case 'gb-noise':
    case 'psg-noise':
      return { min: 0, max: 1 }
    case 'pce-wave':
      return { min: 0, max: Math.max(1, inst.waves.length - 1) }
    default:
      return { min: 0, max: 7 }
  }
}

function isNoiseKind(inst: Instrument): boolean {
  return inst.kind === 'nes-noise' || inst.kind === 'gb-noise' || inst.kind === 'psg-noise'
}

const MACRO_TITLES: Record<MacroName, string> = {
  vol: 'Volume (0..15)',
  arp: 'Arpeggio / pitch offset',
  pitch: 'Pitch (1/16 semitone per tick)',
  timbre: 'Timbre (duty / noise mode / wave)'
}

export function MacroSection(props: { inst: Instrument; commit: Commit }) {
  const { inst } = props
  const macros = ('macros' in inst ? inst.macros : undefined) ?? {}
  const setMacro = (name: MacroName, m: Macro | undefined): void => {
    const next = { ...macros }
    if (m) next[name] = m
    else delete next[name]
    props.commit({ ...inst, macros: next } as Instrument, `Edit ${name} macro`)
  }
  return (
    <div className="macro-section">
      {MACRO_NAMES.map((name) => {
        let min = 0
        let max = 15
        let limitMin: number | undefined
        let limitMax: number | undefined
        let initial = 15
        if (name === 'arp') {
          const fixed = macros.arp?.mode === 'fixed'
          const noise = isNoiseKind(inst) && inst.kind !== 'psg-noise' // PSG noise: fixed arp holds MIDI notes
          if (fixed) {
            min = 0
            max = noise ? 15 : 127
          } else {
            min = -24
            max = 24
            limitMin = -96
            limitMax = 127
          }
          initial = 0
        } else if (name === 'pitch') {
          min = -64
          max = 64
          limitMin = -128
          limitMax = 127
          initial = 0
        } else if (name === 'timbre') {
          const r = timbreRange(inst)
          min = r.min
          max = r.max
          initial = r.min
        }
        return (
          <MacroEditor key={name} label={MACRO_TITLES[name]} macro={macros[name]} min={min} max={max} limitMin={limitMin} limitMax={limitMax} initial={initial} arpMode={name === 'arp'} onCommit={(m) => setMacro(name, m)} testId={`macro-${name}`} />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- Game Boy parts

function EnvelopeEditor(props: { env: GbEnvelope; onChange: (e: GbEnvelope) => void }) {
  const { env } = props
  return (
    <div className="group wrap">
      <span className="label">Env</span>
      <NumberField value={env.init} min={0} max={15} onCommit={(v) => props.onChange({ ...env, init: v })} width={36} title="Initial volume 0..15" testId="gb-env-init" />
      <select value={env.dir} onChange={(e) => props.onChange({ ...env, dir: e.target.value as 'up' | 'down' })} title="Envelope direction">
        <option value="down">fade out</option>
        <option value="up">fade in</option>
      </select>
      <span className="label">Pace</span>
      <NumberField value={env.pace} min={0} max={7} onCommit={(v) => props.onChange({ ...env, pace: v })} width={30} title="0 = constant volume, 1..7 = step every pace/64 s" testId="gb-env-pace" />
    </div>
  )
}

function GbPulseEditor(props: { inst: GbPulseInstrument; commit: Commit }) {
  const { inst } = props
  const sweep = inst.sweep
  return (
    <div className="editor-block">
      <EnvelopeEditor env={inst.env} onChange={(env) => props.commit({ ...inst, env }, 'Edit envelope')} />
      <div className="group">
        <span className="label">Duty</span>
        <select value={inst.duty ?? 2} onChange={(e) => props.commit({ ...inst, duty: Number(e.target.value) as 0 | 1 | 2 | 3 }, 'Set duty')} data-testid="gb-duty">
          <option value={0}>12.5%</option>
          <option value={1}>25%</option>
          <option value={2}>50%</option>
          <option value={3}>75%</option>
        </select>
      </div>
      <div className="group wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={!!sweep}
            onChange={(e) => {
              const next = { ...inst }
              if (e.target.checked) next.sweep = { pace: 3, dir: 'up', step: 2 }
              else delete next.sweep
              props.commit(next, 'Toggle sweep')
            }}
          />
          Sweep (P1 only)
        </label>
        {sweep && (
          <>
            <span className="label">Pace</span>
            <NumberField value={sweep.pace} min={0} max={7} onCommit={(v) => props.commit({ ...inst, sweep: { ...sweep, pace: v } }, 'Edit sweep')} width={30} />
            <select value={sweep.dir} onChange={(e) => props.commit({ ...inst, sweep: { ...sweep, dir: e.target.value as 'up' | 'down' } }, 'Edit sweep')}>
              <option value="up">up</option>
              <option value="down">down</option>
            </select>
            <span className="label">Step</span>
            <NumberField value={sweep.step} min={0} max={7} onCommit={(v) => props.commit({ ...inst, sweep: { ...sweep, step: v } }, 'Edit sweep')} width={30} />
          </>
        )}
      </div>
    </div>
  )
}

function GbNoiseEditor(props: { inst: GbNoiseInstrument; commit: Commit }) {
  const { inst } = props
  return (
    <div className="editor-block">
      <EnvelopeEditor env={inst.env} onChange={(env) => props.commit({ ...inst, env }, 'Edit envelope')} />
      <label className="check">
        <input type="checkbox" checked={!!inst.short} onChange={(e) => props.commit({ ...inst, short: e.target.checked }, 'Toggle 7-bit noise')} />
        7-bit LFSR (metallic)
      </label>
    </div>
  )
}

const CELL = 9

/** Wave drawer: 32 columns x (max+1) rows; drag to draw; one pointer gesture = one commit. */
export function WaveDrawer(props: { values: number[]; max: number; onCommit: (v: number[]) => void; testId?: string }) {
  const { values, max } = props
  const [draft, setDraft] = useState<number[] | null>(null)
  const shown = draft ?? values
  const w = shown.length * CELL
  const h = (max + 1) * CELL
  const [dragging, setDragging] = useState(false)
  const set = (e: React.PointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(shown.length - 1, Math.floor((e.clientX - rect.left) / CELL)))
    const v = Math.max(0, Math.min(max, max - Math.floor((e.clientY - rect.top) / CELL)))
    setDraft((cur) => {
      const next = [...(cur ?? values)]
      next[i] = v
      return next
    })
  }
  const end = (): void => {
    setDragging(false)
    if (draft && JSON.stringify(draft) !== JSON.stringify(values)) props.onCommit(draft)
    setDraft(null)
  }
  return (
    <svg
      className="wave-drawer"
      width={w}
      height={h}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
        set(e)
      }}
      onPointerMove={(e) => dragging && set(e)}
      onPointerUp={end}
      onPointerCancel={end}
      data-testid={props.testId}
    >
      <rect x={0} y={0} width={w} height={h} className="macro-bg" />
      {shown.map((v, i) => (
        <rect key={i} x={i * CELL + 0.5} y={(max - v) * CELL + 0.5} width={CELL - 1} height={(v + 1) * CELL - 1} className="wave-cell" />
      ))}
    </svg>
  )
}

function GbWaveEditor(props: { inst: GbWaveInstrument; commit: Commit }) {
  const { inst } = props
  return (
    <div className="editor-block">
      <WaveDrawer values={inst.wave} max={15} onCommit={(wave) => props.commit({ ...inst, wave }, 'Draw wave')} testId="gb-wave-drawer" />
      <div className="group wrap">
        <span className="label">Level</span>
        <select value={inst.level} onChange={(e) => props.commit({ ...inst, level: Number(e.target.value) as 0 | 1 | 2 | 3 }, 'Set wave level')} data-testid="gb-wave-level">
          <option value={1}>100%</option>
          <option value={2}>50%</option>
          <option value={3}>25%</option>
          <option value={0}>mute</option>
        </select>
        <span className="label">Shape</span>
        {Object.entries(GB_WAVES).map(([name, wave]) => (
          <button key={name} onClick={() => props.commit({ ...inst, wave: [...wave] }, `Wave ${name}`)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- generic fallback

/** JSON editor for kinds without a dedicated editor yet (fm, snes-sample, pce-wave, sample). Replaced in Phase 4. */
function GenericEditor(props: { inst: Instrument; commit: Commit; hint?: string }) {
  const json = JSON.stringify(props.inst, null, 1)
  const [text, setText] = useState(json)
  const [error, setError] = useState('')
  useEffect(() => {
    setText(json)
    setError('')
  }, [json])
  return (
    <div className="editor-block">
      <p className="hint">{props.hint ?? `No dedicated editor for ${props.inst.kind} instruments yet: edit the data as JSON.`}</p>
      <textarea className="json-edit mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={12} data-testid="instrument-json" />
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button
          onClick={() => {
            setText(json)
            setError('')
          }}
        >
          Revert
        </button>
        <button
          className="primary"
          onClick={() => {
            try {
              const parsed = JSON.parse(text) as Instrument
              setError('')
              props.commit(parsed, 'Edit instrument')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
          data-testid="instrument-json-apply"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

/** The JSON editor under a dedicated editor: every field, including ones the form does not show. */
function AdvancedJson(props: { inst: Instrument; commit: Commit }) {
  return (
    <details className="advanced-json" data-testid="instrument-advanced">
      <summary>Advanced (JSON)</summary>
      <GenericEditor inst={props.inst} commit={props.commit} hint="All fields of the instrument as JSON; Apply validates it and replaces the instrument." />
    </details>
  )
}

// ---------------------------------------------------------------- the editor

export function InstrumentEditor(props: { index: number; inst: Instrument }) {
  const { index, inst } = props
  const [name, setName] = useState(inst.name)
  useEffect(() => setName(inst.name), [inst.name, index])
  const commit: Commit = (next, label) => {
    updateInstrument(index, next, label)
  }
  const commitName = (): void => {
    const n = name.trim()
    if (n && n !== inst.name) renameInstrument(index, n)
    else setName(inst.name)
  }
  const octaveC = (session.octave + 1) * 12
  let body: React.ReactNode
  switch (inst.kind) {
    case 'nes-pulse':
    case 'nes-tri':
    case 'psg':
      body = <MacroSection inst={inst} commit={commit} />
      break
    case 'nes-noise':
    case 'psg-noise':
      body = (
        <>
          <div className="group">
            <span className="label">Noise</span>
            <select value={inst.noiseMode ?? 'white'} onChange={(e) => commit({ ...inst, noiseMode: e.target.value as 'white' | 'periodic' }, 'Set noise mode')}>
              <option value="white">white</option>
              <option value="periodic">periodic</option>
            </select>
          </div>
          <MacroSection inst={inst} commit={commit} />
        </>
      )
      break
    case 'gb-pulse':
      body = (
        <>
          <GbPulseEditor inst={inst} commit={commit} />
          <MacroSection inst={inst} commit={commit} />
        </>
      )
      break
    case 'gb-noise':
      body = (
        <>
          <GbNoiseEditor inst={inst} commit={commit} />
          <MacroSection inst={inst} commit={commit} />
        </>
      )
      break
    case 'gb-wave':
      body = (
        <>
          <GbWaveEditor inst={inst} commit={commit} />
          <MacroSection inst={inst} commit={commit} />
        </>
      )
      break
    case 'fm':
      body = <FmEditor inst={inst} commit={commit} />
      break
    case 'pce-wave':
      body = <PceWaveEditor inst={inst} commit={commit} />
      break
    case 'snes-sample':
      body = <SnesSampleEditor inst={inst} commit={commit} />
      break
    case 'psx-sample':
      body = (
        <>
          <Ps1SampleEditor inst={inst} commit={commit} />
          <AdvancedJson inst={inst} commit={commit} />
        </>
      )
      break
    case 'aica-sample':
      body = (
        <>
          <DreamcastSampleEditor inst={inst} commit={commit} />
          <AdvancedJson inst={inst} commit={commit} />
        </>
      )
      break
    case 'sample':
      body = <SampleEditor inst={inst} commit={commit} />
      break
    default:
      body = <GenericEditor inst={inst} commit={commit} />
  }
  return (
    <div className="instrument-editor" data-testid="instrument-editor">
      <div className="inst-head">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid="instrument-name" aria-label="Instrument name" />
        <select
          value={inst.role ?? ''}
          onChange={(e) => {
            const next = { ...inst } as Instrument
            if (e.target.value) next.role = e.target.value as Instrument['role']
            else delete next.role
            commit(next, 'Set role')
          }}
          title="Role (used for presets, MIDI export and the style context)"
        >
          <option value="">(no role)</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button onClick={() => previewNote(index, session.cursor.channel, octaveC)} title="Play a note with this instrument" data-testid="instrument-audition">
          Audition
        </button>
      </div>
      <div className="hint">
        {inst.kind}
        {inst.presetId ? ` - from ${inst.presetId}` : ''}
      </div>
      {body}
    </div>
  )
}
