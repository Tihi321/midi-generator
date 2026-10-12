import { useEffect, useState } from 'react'
import { type Instrument, type ParamSpec, type SampleInstrument, type SampleSlot, brrByteSize, getRecipe, listRecipes, peekSampleLength } from '../../../core'
import { useSession } from '../../hooks/useSession'
import { addSampleSlot } from '../../state/actions'
import { session } from '../../state/session'
import { NumberField } from '../Controls'
import { MacroSection } from '../InstrumentEditors'

type Commit = (next: Instrument, label?: string) => void

/** Decimal input that commits on Enter or blur (recipe parameters are often fractional). */
function ParamField(props: { spec: ParamSpec; value: number | string | boolean; onChange: (v: number | string | boolean) => void }) {
  const { spec, value } = props
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  if (spec.type === 'boolean') {
    return <input type="checkbox" checked={value === true} onChange={(e) => props.onChange(e.target.checked)} title={spec.description} />
  }
  if (spec.type === 'enum') {
    return (
      <select value={String(value)} onChange={(e) => props.onChange(e.target.value)} title={spec.description}>
        {spec.options!.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  const commit = (): void => {
    const n = Number(text)
    if (!Number.isFinite(n)) {
      setText(String(value))
      return
    }
    const v = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, n))
    setText(String(v))
    if (v !== value) props.onChange(v)
  }
  return (
    <input
      type="text"
      className="num"
      style={{ width: 60 }}
      value={text}
      title={`${spec.description} (${spec.min}..${spec.max})`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(String(value))
      }}
    />
  )
}

export function sampleInfo(slot: SampleSlot): string {
  const len = peekSampleLength(slot)
  const src = slot.source.kind === 'recipe' ? `recipe ${slot.source.recipe}` : `PCM ${slot.source.sampleRate} Hz`
  return `${src}; ${len} samples, ~${brrByteSize(len)} BRR bytes${slot.loopStart !== undefined ? `, loop from ${slot.loopStart}` : ''}`
}

/** Pick a sample from the song's slots. */
export function SamplePicker(props: { value: string; onPick: (id: string) => void }) {
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
        {current ? sampleInfo(current) : 'No such sample slot: pick one or generate it below.'}
      </span>
    </div>
  )
}

/** "Generate from recipe": recipe, its parameters and a name; adds a sample slot (one undo step) and reports its id. */
export function RecipeForm(props: { onGenerated: (slot: SampleSlot) => void; defaultRecipe?: string }) {
  const recipes = listRecipes()
  const [recipe, setRecipe] = useState(props.defaultRecipe && getRecipe(props.defaultRecipe) ? props.defaultRecipe : 'strings')
  const info = getRecipe(recipe) ?? recipes[0]!
  const [values, setValues] = useState<Record<string, number | string | boolean>>({})
  useEffect(() => setValues({}), [recipe])
  const [name, setName] = useState('')
  return (
    <div className="editor-block" data-testid="recipe-form">
      <div className="group wrap">
        <span className="label">Generate</span>
        <select value={recipe} onChange={(e) => setRecipe(e.target.value)} data-testid="recipe-select" title={info.description}>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({r.role})
            </option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={info.label} style={{ width: 110 }} aria-label="Sample name" data-testid="recipe-name" />
      </div>
      <div className="group wrap">
        {info.params
          .filter((p) => p.key !== 'seed')
          .map((p) => (
            <label key={p.key} className="check" title={p.description}>
              <span className="label">{p.key}</span>
              <ParamField spec={p} value={values[p.key] ?? p.default} onChange={(v) => setValues({ ...values, [p.key]: v })} />
            </label>
          ))}
        <button
          className="primary"
          onClick={() => {
            const label = name.trim() || info.label
            const params: Record<string, number | string | boolean> = {}
            for (const [k, v] of Object.entries(values)) params[k] = v
            const id = addSampleSlot({ name: label, source: { kind: 'recipe', recipe, params } })
            const slot = id ? session.song.samples.find((s) => s.id === id) : undefined
            if (slot) {
              props.onGenerated(slot)
              setName('')
            }
          }}
          data-testid="recipe-generate"
        >
          Generate
        </button>
      </div>
    </div>
  )
}

/** Editor for `sample` instruments (NES DPCM, Genesis F6 DAC): sample, base note, macros. */
export function SampleEditor(props: { inst: SampleInstrument; commit: Commit }) {
  const { inst, commit } = props
  const chip = session.song.chip
  const hint =
    chip === 'nes'
      ? 'NES DPCM: 1-bit delta samples; the note picks one of the 16 playback rates (C-4 = rate 12, 16.9 kHz; each semitone moves one rate step). No volume.'
      : chip === 'genesis'
        ? 'Genesis F6 DAC: 8-bit samples played with sample-and-hold; the note changes the playback rate (up to ~26 kHz).'
        : 'Sample playback; the note changes the playback rate.'
  return (
    <div className="editor-block" data-testid="sample-editor">
      <p className="hint">{hint}</p>
      <SamplePicker value={inst.sample} onPick={(id) => commit({ ...inst, sample: id }, 'Pick sample')} />
      <div className="group wrap">
        <span className="label">Base note</span>
        <NumberField value={inst.baseNote ?? 60} min={0} max={127} onCommit={(v) => commit({ ...inst, baseNote: v }, 'Set base note')} width={40} title="MIDI note that plays the sample at its native rate (60 = C-4)" testId="sample-base-note" />
      </div>
      <RecipeForm
        onGenerated={(slot) => commit({ ...inst, sample: slot.id }, 'Generate sample')}
        defaultRecipe={chip === 'nes' || chip === 'genesis' ? 'kick' : 'strings'}
      />
      <MacroSection inst={inst} commit={commit} />
    </div>
  )
}
