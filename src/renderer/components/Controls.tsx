import { useEffect, useState } from 'react'

/** Range input that shows live feedback while dragging but commits ONE value on release (one undo step). */
export function CommitSlider(props: { value: number; min: number; max: number; onCommit: (v: number) => void; label?: string; testId?: string }) {
  const [local, setLocal] = useState(props.value)
  useEffect(() => setLocal(props.value), [props.value])
  const commit = (): void => {
    if (local !== props.value) props.onCommit(local)
  }
  return (
    <input
      type="range"
      aria-label={props.label}
      data-testid={props.testId}
      min={props.min}
      max={props.max}
      value={local}
      onChange={(e) => setLocal(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  )
}

/** Number input that commits on Enter or blur (not on every keystroke). */
export function NumberField(props: {
  value: number
  min?: number
  max?: number
  onCommit: (v: number) => void
  width?: number
  title?: string
  testId?: string
}) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = (): void => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n)) {
      setText(String(props.value))
      return
    }
    const v = Math.max(props.min ?? -Infinity, Math.min(props.max ?? Infinity, n))
    setText(String(v))
    if (v !== props.value) props.onCommit(v)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      className="num"
      style={{ width: props.width ?? 52 }}
      title={props.title}
      data-testid={props.testId}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(String(props.value))
      }}
    />
  )
}

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; testId?: string; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-label={props.title} data-testid={props.testId}>
        <div className="modal-title">
          <span>{props.title}</span>
          <button className="x" onClick={props.onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  )
}

/** Two-digit hex input (pattern numbers); commits on Enter or blur. */
export function HexField(props: { value: number; max?: number; onCommit: (v: number) => void; title?: string; testId?: string; className?: string }) {
  const show = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0')
  const [text, setText] = useState(show(props.value))
  useEffect(() => setText(show(props.value)), [props.value])
  const commit = (): void => {
    const n = parseInt(text, 16)
    if (!Number.isFinite(n)) {
      setText(show(props.value))
      return
    }
    const v = Math.max(0, Math.min(props.max ?? 255, n))
    setText(show(v))
    if (v !== props.value) props.onCommit(v)
  }
  return (
    <input
      type="text"
      className={`hex ${props.className ?? ''}`}
      maxLength={2}
      title={props.title}
      data-testid={props.testId}
      value={text}
      onChange={(e) => setText(e.target.value.toUpperCase())}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(show(props.value))
      }}
    />
  )
}
