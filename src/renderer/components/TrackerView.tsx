import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { patternAt } from '../../core'
import { useSession } from '../hooks/useSession'
import { channelColor } from '../lib/colors'
import { type GridLayout, fieldAt, formatCellParts, hex2, layoutForSong, rowHighlight, selectionBetween } from '../lib/trackerGrid'
import { currentSelection, gridCursor, setGridCursor, toggleMute, toggleSolo } from '../state/actions'
import { session } from '../state/session'
import { useUi } from '../state/ui'

export const ROW_H = 18
const HEAD_H = 24
const OVERSCAN = 6

function dimClass(text: string): string {
  return /^[.-]+$/.test(text) ? ' dim' : ''
}

/** Virtualised tracker grid: rows x channels with note / instrument / volume / effect columns. */
export function TrackerView() {
  useSession()
  const playhead = useUi((s) => s.playhead)
  const follow = useUi((s) => s.follow)
  const field = useUi((s) => s.field)
  const anchor = useUi((s) => s.anchor)
  const mutes = useUi((s) => s.mutes)
  const solo = useUi((s) => s.solo)
  const centerTab = useUi((s) => s.centerTab)

  const song = session.song
  const fxKey = song.channels.map((c) => c.fxColumns).join(',')
  const layout: GridLayout = useMemo(() => layoutForSong(song), [fxKey, song.channels.length])

  const scroller = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  const chPx = useRef(7)
  const dragging = useRef(false)

  const cur = session.cursor
  const playingView = playhead.playing && follow
  const viewOrder = playingView ? Math.min(playhead.order, song.orders.length - 1) : cur.order
  const rows = song.patternLength

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => {
      setViewH(el.clientHeight)
      if (probe.current) chPx.current = probe.current.getBoundingClientRect().width / 10 || 7
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the cursor row visible; while following playback keep the playhead row near the middle.
  const followRow = playingView && playhead.order === viewOrder ? playhead.row : null
  useEffect(() => {
    const el = scroller.current
    if (!el || centerTab !== 'tracker') return
    const bodyH = el.clientHeight - HEAD_H
    if (followRow !== null) {
      el.scrollTop = Math.max(0, followRow * ROW_H - bodyH / 2)
      return
    }
    const top = cur.row * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + bodyH) el.scrollTop = top + ROW_H - bodyH
  }, [followRow, cur.row, cur.order, centerTab])

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(rows - 1, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)

  const pats = song.channels.map((_, c) => patternAt(song, viewOrder, c))
  const beat = song.timing.rowsPerBeat
  const bar = song.timing.beatsPerBar

  const hit = useCallback(
    (e: { clientX: number; clientY: number }): { row: number; channel: number; field: number } | null => {
      const b = body.current
      if (!b) return null
      const rect = b.getBoundingClientRect()
      const row = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rect.top) / ROW_H)))
      const f = fieldAt(layout, (e.clientX - rect.left) / chPx.current)
      if (!f) return null
      return { row, channel: f.channel, field: f.field }
    },
    [layout, rows]
  )

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const h = hit(e)
    if (!h) return
    dragging.current = !e.shiftKey
    setGridCursor({ order: viewOrder, row: h.row, channel: h.channel, field: h.field }, { extend: e.shiftKey })
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const h = hit(e)
      if (!h) return
      const c = gridCursor()
      if (h.row === c.row && h.channel === c.channel) return
      setGridCursor({ order: viewOrder, row: h.row, channel: h.channel, field: h.field }, { extend: true })
    }
    const onUp = (): void => {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [hit, viewOrder])

  const sel = anchor ? selectionBetween(anchor, { order: cur.order, row: cur.row, channel: cur.channel }) : currentSelection()
  const cursorField = layout.channels[cur.channel]?.fields[Math.min(field, (layout.channels[cur.channel]?.fields.length ?? 1) - 1)]
  const showCursor = cur.order === viewOrder

  const rowEls: React.ReactNode[] = []
  for (let r = first; r <= last; r++) {
    const hl = rowHighlight(r, beat, bar)
    rowEls.push(
      <div key={r} className={`trow${hl ? ' ' + hl : ''}`} style={{ top: r * ROW_H, height: ROW_H }}>
        <span className="rnum"> {hex2(r)}</span>
        {song.channels.map((ch, c) => {
          const p = formatCellParts(pats[c]?.rows[r] ?? null, ch.fxColumns)
          return (
            <span className="tcell" key={c}>
              {' '}
              <span className={`n${dimClass(p.note)}`} style={dimClass(p.note) ? undefined : { color: channelColor(c) }}>
                {p.note}
              </span>{' '}
              <span className={`i${dimClass(p.inst)}`}>{p.inst}</span>{' '}
              <span className={`v${dimClass(p.vol)}`}>{p.vol}</span>
              {p.fx.map((fx, k) => (
                <span key={k} className={`f${dimClass(fx)}`}>
                  {' '}
                  {fx}
                </span>
              ))}{' '}
            </span>
          )
        })}
      </div>
    )
  }

  const selBox = sel && sel.order === viewOrder ? sel : null

  return (
    <div className="tracker" data-testid="tracker-view">
      <div className="tracker-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="tracker-head" style={{ width: `${layout.totalCh}ch`, height: HEAD_H }}>
          <span className="rnum head-gutter" style={{ width: `${layout.gutterCh}ch` }}>
            {String(viewOrder).padStart(2, '0')}
          </span>
          {song.channels.map((ch, c) => {
            const muted = mutes[c] || (solo !== null && solo !== c) || ch.muted
            return (
              <span key={ch.id} className={`chead${muted ? ' muted' : ''}${cur.channel === c ? ' current' : ''}`} style={{ width: `${layout.channels[c]!.widthCh}ch`, borderTopColor: channelColor(c) }} title={`${ch.name} (${ch.kind})`} data-testid={`chead-${ch.id}`}>
                <span className="cname" style={{ color: channelColor(c) }}>
                  {ch.id}
                </span>
                <button className={`ms${mutes[c] ? ' on' : ''}`} onClick={() => toggleMute(c)} title="Mute" data-testid={`mute-${ch.id}`}>
                  M
                </button>
                <button className={`ms${solo === c ? ' on' : ''}`} onClick={() => toggleSolo(c)} title="Solo" data-testid={`solo-${ch.id}`}>
                  S
                </button>
              </span>
            )
          })}
        </div>
        <div className="tracker-body" ref={body} style={{ width: `${layout.totalCh}ch`, height: rows * ROW_H }} onMouseDown={onMouseDown} data-testid="tracker-body">
          <span ref={probe} className="ch-probe" aria-hidden>
            0000000000
          </span>
          {showCursor && <div className="cursor-row" style={{ top: cur.row * ROW_H, height: ROW_H }} />}
          {rowEls}
          {selBox && (
            <div
              className="sel-box"
              style={{
                top: selBox.row1 * ROW_H,
                height: (selBox.row2 - selBox.row1 + 1) * ROW_H,
                left: `${layout.channels[selBox.ch1]!.startCh}ch`,
                width: `${layout.channels[selBox.ch2]!.startCh + layout.channels[selBox.ch2]!.widthCh - layout.channels[selBox.ch1]!.startCh}ch`
              }}
            />
          )}
          {playhead.playing && playhead.order === viewOrder && <div className="play-row" style={{ top: playhead.row * ROW_H, height: ROW_H }} data-testid="play-row" />}
          {showCursor && cursorField && (
            <div className="cursor-box" style={{ top: cur.row * ROW_H, height: ROW_H, left: `${cursorField.startCh}ch`, width: `${cursorField.widthCh}ch` }} data-testid="tracker-cursor" />
          )}
        </div>
      </div>
    </div>
  )
}
