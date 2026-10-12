import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatNote, songChannelDefs } from '../../core'
import { useSession } from '../hooks/useSession'
import { channelColor } from '../lib/colors'
import {
  type RollGesture,
  DEFAULT_GEOMETRY,
  deleteNoteDiffs,
  deriveNotes,
  gestureDiffs,
  gesturePreview,
  hitZone,
  linearRow,
  noteAt,
  pitchRange,
  pitchToY,
  rowToX,
  splitRow,
  totalRows,
  xToRowF,
  yToPitch
} from '../lib/pianoRoll'
import { previewNote, writeCells } from '../state/actions'
import { engine } from '../state/audio'
import { session } from '../state/session'
import { useUi } from '../state/ui'

const BLACK = new Set([1, 3, 6, 8, 10])
const EDGE_PX = 6

/** Canvas piano roll: the whole song as one strip of rows (time across, pitch up). */
export function PianoRoll() {
  useSession()
  const playhead = useUi((s) => s.playhead)
  const follow = useUi((s) => s.follow)
  const rollChannel = useUi((s) => s.rollChannel)
  const selected = useUi((s) => s.rollSelected)
  const rollLen = useUi((s) => s.rollLen)
  const centerTab = useUi((s) => s.centerTab)
  const setUi = useUi((s) => s.set)

  const song = session.song
  const nch = song.channels.length
  const channels = useMemo(() => (rollChannel === 'all' || rollChannel >= nch ? song.channels.map((_, i) => i) : [rollChannel]), [rollChannel, nch, song.channels])
  const targetChannel = rollChannel === 'all' || rollChannel >= nch ? session.cursor.channel : rollChannel
  const version = session.history.version
  const total = totalRows(song)

  // Notes are derived from the cells: recompute only when the song (history) changes.
  const notes = useMemo(() => deriveNotes(song, channels), [version, song.id, channels, song.orders.length, song.patternLength])
  const range = useMemo(() => pitchRange(song, channels, notes), [song, channels, notes])
  const [rowW, setRowW] = useState(DEFAULT_GEOMETRY.rowW)
  const g = useMemo(() => ({ ...DEFAULT_GEOMETRY, rowW, maxPitch: range.max }), [rowW, range.max])
  const contentW = g.keysW + total * g.rowW
  const contentH = g.headerH + (range.max - range.min + 1) * g.noteH

  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState({ w: 600, h: 300 })
  const [scroll, setScroll] = useState({ x: 0, y: 0 })
  const [gesture, setGesture] = useState<RollGesture | null>(null)
  const gestureRef = useRef<RollGesture | null>(null)
  const startRef = useRef({ row: 0, pitch: 0 })

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setView({ w: Math.max(100, el.clientWidth), h: Math.max(80, el.clientHeight) })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Playhead follow.
  const playLin = playhead.playing ? linearRow(song, Math.min(playhead.order, song.orders.length - 1), playhead.row) : null
  useEffect(() => {
    const el = scroller.current
    if (!el || playLin === null || !follow || centerTab !== 'piano') return
    const x = rowToX(g, playLin) - g.keysW
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - g.keysW - 40) el.scrollLeft = Math.max(0, x - 80)
  }, [playLin, follow, g, centerTab])

  // Start with the notes in view (or the middle of the range).
  const didInit = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || didInit.current || centerTab !== 'piano') return
    didInit.current = true
    const mid = notes.length > 0 ? notes[0]!.pitch : Math.round((range.min + range.max) / 2)
    el.scrollTop = Math.max(0, pitchToY(g, mid) - el.clientHeight / 2)
  }, [centerTab, notes, range, g])

  const ghost = gesture ? gesturePreview(song, gesture) : null
  const def = songChannelDefs(song)[targetChannel]

  // ------------------------------------------------------------ drawing
  useEffect(() => {
    const cv = canvas.current
    if (!cv || centerTab !== 'piano') return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.floor(view.w * dpr)
    cv.height = Math.floor(view.h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#10121a'
    ctx.fillRect(0, 0, view.w, view.h)

    const sx = scroll.x
    const sy = scroll.y
    const r0 = Math.max(0, Math.floor(sx / g.rowW))
    const r1 = Math.min(total, Math.ceil((sx + view.w) / g.rowW))
    const bar = song.timing.rowsPerBeat * song.timing.beatsPerBar

    ctx.save()
    ctx.translate(-sx, -sy)
    // pitch rows
    for (let p = range.max; p >= range.min; p--) {
      const y = pitchToY(g, p)
      if (y + g.noteH < sy || y > sy + view.h) continue
      ctx.fillStyle = BLACK.has(p % 12) ? '#151822' : '#1a1d28'
      ctx.fillRect(g.keysW + r0 * g.rowW, y, (r1 - r0) * g.rowW, g.noteH)
      if (def && (p < def.noteMin || p > def.noteMax)) {
        ctx.fillStyle = 'rgba(224,100,92,0.13)'
        ctx.fillRect(g.keysW + r0 * g.rowW, y, (r1 - r0) * g.rowW, g.noteH)
      }
      ctx.fillStyle = p % 12 === 0 ? '#2e3342' : '#202431'
      ctx.fillRect(g.keysW + r0 * g.rowW, y + g.noteH - 1, (r1 - r0) * g.rowW, 1)
    }
    // time grid
    for (let r = r0; r <= r1; r++) {
      const x = rowToX(g, r)
      const inPat = r % song.patternLength
      let color = ''
      if (inPat === 0) color = '#6a7390'
      else if (r % bar === 0) color = '#3f4760'
      else if (r % song.timing.rowsPerBeat === 0) color = '#2b3042'
      else if (g.rowW >= 12) color = '#1f2330'
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x, sy, 1, view.h)
    }
    // notes
    for (const n of notes) {
      if (n.end < r0 || n.start > r1) continue
      const x = rowToX(g, n.start)
      const w = Math.max(3, (n.end - n.start) * g.rowW - 1)
      const y = pitchToY(g, n.pitch)
      const active = rollChannel !== 'all' || n.channel === targetChannel
      ctx.globalAlpha = active ? 0.95 : 0.55
      ctx.fillStyle = channelColor(n.channel)
      ctx.fillRect(x, y + 1, w, g.noteH - 2)
      ctx.globalAlpha = 1
      if (selected && selected.channel === n.channel && selected.start === n.start) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.strokeRect(x + 0.5, y + 1.5, w - 1, g.noteH - 3)
      }
      if (n.endsWith === 'rel') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(x + w - 3, y + 1, 3, g.noteH - 2)
      }
    }
    // gesture ghost
    if (ghost) {
      const x = rowToX(g, ghost.start)
      const w = Math.max(3, (ghost.end - ghost.start) * g.rowW - 1)
      const y = pitchToY(g, ghost.pitch)
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(x + 0.5, y + 1.5, w - 1, g.noteH - 3)
      ctx.setLineDash([])
    }
    // playhead
    if (playLin !== null) {
      ctx.fillStyle = '#ff5a5a'
      ctx.fillRect(rowToX(g, playLin), sy, 2, view.h)
    }
    // cursor row marker
    const cl = linearRow(song, session.cursor.order, session.cursor.row)
    ctx.fillStyle = 'rgba(79,140,255,0.6)'
    ctx.fillRect(rowToX(g, cl), sy + g.headerH, g.rowW, 2)
    ctx.restore()

    // ruler (sticky top)
    ctx.fillStyle = '#1c1f27'
    ctx.fillRect(0, 0, view.w, g.headerH)
    ctx.fillStyle = '#9aa1b5'
    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.textBaseline = 'middle'
    for (let r = r0; r <= r1; r++) {
      const x = rowToX(g, r) - sx
      if (r % bar !== 0 || r >= total) continue
      const { order, row } = splitRow(song, r)
      ctx.fillStyle = row === 0 ? '#e6e9f2' : '#7d8394'
      ctx.fillText(row === 0 ? `O${order}` : String(row / bar + 1), x + 3, g.headerH / 2)
    }
    // piano keys (sticky left)
    ctx.fillStyle = '#1c1f27'
    ctx.fillRect(0, 0, g.keysW, view.h)
    for (let p = range.max; p >= range.min; p--) {
      const y = pitchToY(g, p) - sy
      if (y + g.noteH < g.headerH || y > view.h) continue
      const black = BLACK.has(p % 12)
      ctx.fillStyle = black ? '#262a36' : '#d9dce6'
      ctx.fillRect(0, y, black ? g.keysW * 0.62 : g.keysW - 1, g.noteH - 1)
      if (p % 12 === 0) {
        ctx.fillStyle = '#10121a'
        ctx.fillText(formatNote(p), g.keysW - 26, y + g.noteH / 2)
      }
    }
    ctx.fillStyle = '#1c1f27'
    ctx.fillRect(0, 0, g.keysW, g.headerH)
    ctx.fillStyle = '#2a2e39'
    ctx.fillRect(g.keysW - 1, 0, 1, view.h)
    ctx.fillRect(0, g.headerH - 1, view.w, 1)
  }, [view, scroll, g, notes, range, selected, ghost, playLin, centerTab, def, song, total, rollChannel, targetChannel])

  // ------------------------------------------------------------ pointer interaction
  const world = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = canvas.current!.getBoundingClientRect()
      const lx = e.clientX - rect.left
      const ly = e.clientY - rect.top
      const wx = lx + scroll.x
      const wy = ly + scroll.y
      const rowF = xToRowF(g, wx)
      return { lx, ly, rowF, row: Math.floor(rowF), pitch: yToPitch(g, wy) }
    },
    [g, scroll]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    ;(document.activeElement as HTMLElement | null)?.blur?.() // keyboard shortcuts work again after using a select
    const w = world(e)
    if (w.lx < g.keysW && w.ly >= g.headerH) {
      const inst = session.currentInstrument
      if (inst >= 0) previewNote(inst, targetChannel, w.pitch)
      return
    }
    if (w.ly < g.headerH) {
      if (w.lx >= g.keysW && w.row >= 0 && w.row < total) {
        const { order, row } = splitRow(song, w.row)
        session.setCursor({ order, row })
        if (engine.playing) engine.seek(order, row)
      }
      return
    }
    if (w.row < 0 || w.row >= total || w.pitch < range.min || w.pitch > range.max) return
    canvas.current!.setPointerCapture(e.pointerId)
    const hit = noteAt(notes, w.row, w.pitch, channels)
    if (e.button === 2) {
      if (hit) writeCells(deleteNoteDiffs(song, hit), 'Delete note')
      return
    }
    if (e.button !== 0) return
    startRef.current = { row: w.row, pitch: w.pitch }
    let gst: RollGesture
    if (hit) {
      setUi({ rollSelected: { channel: hit.channel, start: hit.start } })
      gst = hitZone(hit, w.rowF, EDGE_PX / g.rowW) === 'resize' ? { kind: 'resize', note: hit, end: hit.end } : { kind: 'move', note: hit, dRows: 0, dPitch: 0 }
    } else {
      setUi({ rollSelected: null })
      const inst = session.currentInstrument >= 0 && session.currentInstrument < song.instruments.length ? session.currentInstrument : undefined
      gst = { kind: 'draw', channel: targetChannel, pitch: w.pitch, start: w.row, end: w.row + rollLen - 1, ...(inst !== undefined ? { inst } : {}) }
    }
    gestureRef.current = gst
    setGesture(gst)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const cur = gestureRef.current
    if (!cur) return
    const w = world(e)
    let next: RollGesture
    if (cur.kind === 'draw') next = { ...cur, end: Math.max(w.row, cur.start + rollLen - 1) }
    else if (cur.kind === 'move') next = { ...cur, dRows: w.row - startRef.current.row, dPitch: w.pitch - startRef.current.pitch }
    else next = { ...cur, end: Math.max(cur.note.start + 1, w.row + 1) }
    gestureRef.current = next
    setGesture(next)
  }

  const finish = (commit: boolean): void => {
    const g0 = gestureRef.current
    gestureRef.current = null
    setGesture(null)
    if (!g0 || !commit) return
    const diffs = gestureDiffs(song, g0)
    const label = g0.kind === 'draw' ? 'Draw note' : g0.kind === 'move' ? 'Move note' : 'Resize note'
    if (writeCells(diffs, label)) {
      const p = gesturePreview(song, g0)
      const inst = g0.kind === 'draw' ? g0.inst : g0.note.inst
      if (p && inst !== undefined && g0.kind !== 'resize') previewNote(inst, p.channel, p.pitch)
      if (g0.kind === 'draw') setUi({ rollSelected: { channel: g0.channel, start: Math.min(g0.start, g0.end) } })
      else if (g0.kind === 'move' && p) setUi({ rollSelected: { channel: p.channel, start: p.start } })
    }
  }

  // Test / debug hook: page coordinates of a (linear row, pitch) cell.
  useEffect(() => {
    const hooks = window.__chiptuneStudio
    if (!hooks) return
    hooks.pianoRoll = {
      pointFor: (lin: number, pitch: number) => {
        const rect = canvas.current!.getBoundingClientRect()
        const sx = scroller.current!.scrollLeft
        const sy = scroller.current!.scrollTop
        return { x: rect.left + rowToX(g, lin) + g.rowW / 2 - sx, y: rect.top + pitchToY(g, pitch) + g.noteH / 2 - sy }
      },
      centerPitch: () => yToPitch(g, scroller.current!.scrollTop + scroller.current!.clientHeight / 2),
      notes: () => notes.map((n) => ({ ...n }))
    }
  }, [g, notes])

  return (
    <div className="roll" data-testid="piano-roll-view">
      <div className="roll-bar">
        <label>
          Channel{' '}
          <select value={String(rollChannel)} onChange={(e) => setUi({ rollChannel: e.target.value === 'all' ? 'all' : Number(e.target.value) })} data-testid="roll-channel">
            <option value="all">All channels</option>
            {song.channels.map((c, i) => (
              <option key={c.id} value={i}>
                {c.id} {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          New note length{' '}
          <select value={rollLen} onChange={(e) => setUi({ rollLen: Number(e.target.value) })} data-testid="roll-len">
            {[1, 2, 4, 8, 16].map((n) => (
              <option key={n} value={n}>
                {n} row{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Zoom{' '}
          <input type="range" min={6} max={40} value={rowW} onChange={(e) => setRowW(Number(e.target.value))} aria-label="Zoom" />
        </label>
        <span className="hint">Drag to draw, drag a note to move, drag its right edge to resize, right-click or Delete to remove.</span>
      </div>
      <div className="roll-scroll" ref={scroller} onScroll={(e) => setScroll({ x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop })}>
        <div style={{ width: contentW, height: contentH, position: 'relative' }}>
          <canvas
            ref={canvas}
            data-testid="roll-canvas"
            style={{ position: 'sticky', top: 0, left: 0, width: view.w, height: view.h, display: 'block' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => finish(true)}
            onPointerCancel={() => finish(false)}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </div>
    </div>
  )
}

