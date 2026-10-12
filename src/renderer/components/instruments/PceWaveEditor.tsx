import { useState } from 'react'
import { type Instrument, type PceWaveInstrument } from '../../../core'
import { MacroSection, WaveDrawer } from '../InstrumentEditors'

type Commit = (next: Instrument, label?: string) => void

const MAX_WAVES = 64

const sineWave = (): number[] => Array.from({ length: 32 }, (_, i) => Math.round(15.5 + 15.5 * Math.sin((2 * Math.PI * i) / 32)))

/** Shapes offered as one-click buttons; every value is an integer 0..31. */
export const PCE_SHAPES: Record<string, () => number[]> = {
  sine: sineWave,
  saw: () => Array.from({ length: 32 }, (_, i) => i),
  square: () => Array.from({ length: 32 }, (_, i) => (i < 16 ? 31 : 0)),
  triangle: () => Array.from({ length: 32 }, (_, i) => (i < 16 ? i * 2 : 62 - i * 2)),
  pulse: () => Array.from({ length: 32 }, (_, i) => (i < 8 ? 31 : 0))
}

/** Editor for `pce-wave` instruments: wave list, 32x32 wave drawer, noise toggle and macros. */
export function PceWaveEditor(props: { inst: PceWaveInstrument; commit: Commit }) {
  const { inst, commit } = props
  const [selected, setSelected] = useState(0)
  const waves = inst.waves
  const sel = Math.max(0, Math.min(waves.length - 1, selected))
  const current = waves[sel] ?? sineWave()
  const setWaves = (next: number[][], label: string): void => commit({ ...inst, waves: next }, label)
  const replace = (w: number[], label: string): void => setWaves(waves.map((x, i) => (i === sel ? w : x)), label)

  return (
    <div className="editor-block" data-testid="pce-editor">
      <div className="group wrap">
        <span className="label">Waves</span>
        {waves.map((_, i) => (
          <button key={i} className={i === sel ? 'primary' : undefined} onClick={() => setSelected(i)} title={`Wave ${i}: the timbre macro or Wxx = ${i} selects it`} data-testid={`pce-wave-${i}`}>
            {i}
          </button>
        ))}
        <button
          disabled={waves.length >= MAX_WAVES}
          onClick={() => {
            setWaves([...waves, sineWave()], 'Add wave')
            setSelected(waves.length)
          }}
          data-testid="pce-wave-add"
        >
          Add
        </button>
        <button
          disabled={waves.length >= MAX_WAVES}
          onClick={() => {
            const next = [...waves]
            next.splice(sel + 1, 0, [...current])
            setWaves(next, 'Duplicate wave')
            setSelected(sel + 1)
          }}
          data-testid="pce-wave-dup"
        >
          Duplicate
        </button>
        <button
          disabled={waves.length <= 1}
          onClick={() => {
            setWaves(waves.filter((_, i) => i !== sel), 'Delete wave')
            setSelected(Math.max(0, sel - 1))
          }}
          data-testid="pce-wave-del"
        >
          Delete
        </button>
      </div>
      <WaveDrawer values={current} max={31} onCommit={(w) => replace(w, 'Draw wave')} testId="pce-wave-drawer" />
      <div className="group wrap">
        <span className="label">Shape</span>
        {Object.entries(PCE_SHAPES).map(([name, make]) => (
          <button key={name} onClick={() => replace(make(), `Wave ${name}`)}>
            {name}
          </button>
        ))}
      </div>
      <div className="group wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={!!inst.noise}
            onChange={(e) => {
              const next = { ...inst }
              if (e.target.checked) next.noise = true
              else delete next.noise
              commit(next, 'Toggle noise')
            }}
            data-testid="pce-noise"
          />
          Noise (C5 / C6 only)
        </label>
        {inst.noise && <span className="hint">Noise works only on channels C5 and C6; the arp macro (fixed) sets the noise pitch 0..31. On other channels the wave plays instead.</span>}
      </div>
      <MacroSection inst={inst} commit={commit} />
    </div>
  )
}
