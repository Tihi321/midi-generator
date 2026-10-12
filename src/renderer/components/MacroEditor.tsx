import { useEffect, useRef, useState } from 'react'
import { type Macro, formatMacro, parseMacro } from '../../core'
import { GRAPH_H, graphPoint } from '../lib/macroGraph'

const H = GRAPH_H
const MAX_W = 300

/**
 * Macro graph editor: draw bars with the mouse, Shift+click sets the loop point, Alt+click the release point.
 * The text box under it ("15 12 9 | 6 3 / 0": "|" loop, "/" release) is the exact way to edit. One gesture or
 * one text commit is one onCommit call (one undo step).
 */
export function MacroEditor(props: {
  label: string
  macro: Macro | undefined
  /** Graph (drawing) range. */
  min: number
  max: number
  /** Accepted range for typed values (default: the graph range). */
  limitMin?: number
  limitMax?: number
  /** Value used when the macro is first created. */
  initial: number
  arpMode?: boolean
  onCommit: (m: Macro | undefined) => void
  testId?: string
}) {
  const { macro, min, max } = props
  const [draft, setDraft] = useState<Macro | null>(null)
  const draftRef = useRef<Macro | null>(null)
  const [text, setText] = useState(macro ? formatMacro(macro) : '')
  const [error, setError] = useState('')
  const dragging = useRef(false)
  const last = useRef(-1)
  useEffect(() => {
    setText(macro ? formatMacro(macro) : '')
    setError('')
  }, [macro])

  const shown = draft ?? macro
  const n = shown?.values.length ?? 0
  const barW = n > 0 ? Math.max(3, Math.min(16, MAX_W / n)) : 0
  const w = Math.max(60, n * barW)
  const yOf = (v: number): number => ((max - v) / (max - min)) * H
  const zeroY = yOf(Math.max(min, Math.min(max, 0)))

  const setValue = (m: Macro, index: number, value: number): Macro => {
    const values = [...m.values]
    values[index] = value
    return { ...m, values }
  }

  const apply = (e: React.PointerEvent<SVGSVGElement>, start: boolean): void => {
    if (!shown || n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const p = graphPoint(e.clientX - rect.left, e.clientY - rect.top, n, barW, min, max)
    if (start && (e.shiftKey || e.altKey)) {
      const next: Macro = { ...shown }
      if (e.shiftKey) {
        if (next.loop === p.index) delete next.loop
        else next.loop = p.index
      } else if (next.release === p.index) delete next.release
      else next.release = p.index
      props.onCommit(next)
      return
    }
    let cur = draftRef.current ?? shown
    // fill the bars between the previous and the current pointer index so fast drags leave no gaps
    const from = last.current < 0 ? p.index : last.current
    const lo = Math.min(from, p.index)
    const hi = Math.max(from, p.index)
    for (let i = lo; i <= hi; i++) cur = setValue(cur, i, p.value)
    last.current = p.index
    draftRef.current = cur
    setDraft(cur)
  }

  const commitDraft = (): void => {
    dragging.current = false
    last.current = -1
    const d = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (d && macro && JSON.stringify(d.values) !== JSON.stringify(macro.values)) props.onCommit(d)
  }

  const commitText = (): void => {
    const t = text.trim()
    if (t === '') {
      setError('')
      if (macro) props.onCommit(undefined)
      return
    }
    try {
      const m = parseMacro(t, props.arpMode ? macro?.mode : undefined)
      if (m.values.length === 0) throw new Error('A macro needs at least one value.')
      const lo = props.limitMin ?? min
      const hi = props.limitMax ?? max
      const bad = m.values.find((v) => v < lo || v > hi)
      if (bad !== undefined) throw new Error(`Value ${bad} is outside ${lo}..${hi}.`)
      setError('')
      if (!macro || formatMacro(macro) !== formatMacro(m) || macro.mode !== m.mode) props.onCommit(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="macro-editor" data-testid={props.testId}>
      <div className="macro-head">
        <span className="label">{props.label}</span>
        {props.arpMode && macro && (
          <select value={macro.mode ?? 'rel'} onChange={(e) => props.onCommit({ ...macro, mode: e.target.value as 'rel' | 'fixed' })} title="Arp values are semitone offsets (rel) or absolute notes / noise indices (fixed)">
            <option value="rel">relative</option>
            <option value="fixed">fixed</option>
          </select>
        )}
        <span className="spacer" />
        {macro ? (
          <button onClick={() => props.onCommit(undefined)} title="Remove this macro">
            Remove
          </button>
        ) : (
          <button onClick={() => props.onCommit({ values: [props.initial] })}>Add</button>
        )}
      </div>
      {macro && (
        <>
          <svg
            className="macro-graph"
            width={w}
            height={H}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              dragging.current = true
              apply(e, true)
            }}
            onPointerMove={(e) => dragging.current && apply(e, false)}
            onPointerUp={commitDraft}
            onPointerCancel={commitDraft}
            data-testid={props.testId ? `${props.testId}-graph` : undefined}
          >
            <rect x={0} y={0} width={w} height={H} className="macro-bg" />
            <line x1={0} x2={w} y1={zeroY} y2={zeroY} className="macro-zero" />
            {shown!.values.map((v, i) => {
              const y = yOf(v)
              const top = Math.min(y, zeroY)
              const h = Math.max(1, Math.abs(y - zeroY))
              const looped = shown!.loop !== undefined && i >= shown!.loop
              return <rect key={i} x={i * barW + 0.5} y={top} width={Math.max(1, barW - 1)} height={h} className={looped ? 'macro-bar loop' : 'macro-bar'} />
            })}
            {shown!.loop !== undefined && (
              <g>
                <line x1={shown!.loop * barW} x2={shown!.loop * barW} y1={0} y2={H} className="macro-marker loop" />
                <text x={shown!.loop * barW + 2} y={10} className="macro-tag">
                  L
                </text>
              </g>
            )}
            {shown!.release !== undefined && (
              <g>
                <line x1={shown!.release * barW} x2={shown!.release * barW} y1={0} y2={H} className="macro-marker release" />
                <text x={shown!.release * barW + 2} y={22} className="macro-tag">
                  R
                </text>
              </g>
            )}
          </svg>
          <input
            type="text"
            className="macro-text mono"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setText(formatMacro(macro))
                setError('')
              }
            }}
            spellCheck={false}
            title={`${props.limitMin ?? min}..${props.limitMax ?? max}; "|" marks the loop point, "/" the release point`}
            data-testid={props.testId ? `${props.testId}-text` : undefined}
          />
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  )
}
