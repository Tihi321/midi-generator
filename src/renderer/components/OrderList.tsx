import { useSession } from '../hooks/useSession'
import { channelColor } from '../lib/colors'
import { deleteOrder, duplicateOrder, insertOrder, moveOrder, setLoopOrder, setOrderPattern } from '../state/actions'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { HexField } from './Controls'

/** Order list: one row per order, one pattern number (hex) per channel; loop marker; add/dup/delete/move. */
export function OrderList() {
  useSession()
  const playhead = useUi((s) => s.playhead)
  const song = session.song
  const cur = session.cursor.order
  const playingOrder = playhead.playing ? playhead.order : -1
  return (
    <div className="orderlist" data-testid="order-list">
      <div className="order-tools">
        <button onClick={() => insertOrder(cur + 1)} title="Insert an empty order after the selected one" data-testid="order-insert">
          +
        </button>
        <button onClick={() => duplicateOrder(cur)} title="Duplicate the selected order (copies the patterns)" data-testid="order-dup">
          Dup
        </button>
        <button onClick={() => deleteOrder(cur)} title="Delete the selected order" data-testid="order-delete">
          Del
        </button>
        <button onClick={() => moveOrder(cur, -1)} title="Move up" data-testid="order-up">
          Up
        </button>
        <button onClick={() => moveOrder(cur, 1)} title="Move down" data-testid="order-down">
          Dn
        </button>
      </div>
      <div className="order-head">
        <span className="oidx" />
        {song.channels.map((c, i) => (
          <span key={c.id} className="ocell head" style={{ color: channelColor(i) }} title={c.name}>
            {c.id}
          </span>
        ))}
      </div>
      <div className="order-rows">
        {song.orders.map((row, o) => (
          <div key={o} className={`orow${o === cur ? ' current' : ''}${o === playingOrder ? ' playing' : ''}`} data-testid={`order-row-${o}`}>
            <button
              className={`oidx${song.loop?.order === o ? ' loop' : ''}`}
              onClick={() => session.setCursor({ order: o })}
              onDoubleClick={() => setLoopOrder(song.loop?.order === o ? null : o)}
              title={song.loop?.order === o ? 'Loop point (double-click to remove)' : 'Select (double-click to set the loop point)'}
            >
              {song.loop?.order === o ? 'L' : ''}
              {o.toString(16).toUpperCase().padStart(2, '0')}
            </button>
            {row.map((p, c) => (
              <HexField key={c} value={p} onCommit={(v) => setOrderPattern(o, c, v)} title={`${song.channels[c]!.id} pattern`} testId={`order-${o}-${c}`} className={o === cur && c === session.cursor.channel ? 'cur' : ''} />
            ))}
          </div>
        ))}
      </div>
      <p className="hint order-hint">Double-click an order number to set the loop point. Equal pattern numbers share the same pattern.</p>
    </div>
  )
}
