import { useMemo } from 'react'
import { formatIssues, songSeconds, validateSong } from '../../core'
import { useSession } from '../hooks/useSession'
import { session } from '../state/session'
import { useUi } from '../state/ui'

function clock(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${m}:${Math.floor(sec - m * 60).toString().padStart(2, '0')}`
}

/** Footer: status message, validation issue count, song size. */
export function StatusBar() {
  useSession()
  const status = useUi((s) => s.status)
  const song = session.song
  const version = session.history.version
  const issues = useMemo(() => validateSong(song), [version, song.id])
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  return (
    <footer className="statusbar region" data-testid="statusbar">
      <span className="status" data-testid="status">{status}</span>
      <span className="spacer" />
      <span
        className={`issues${errors > 0 ? ' has-errors' : warnings > 0 ? ' has-warnings' : ''}`}
        title={issues.length > 0 ? formatIssues(issues, 12) : 'No validation issues'}
        data-testid="issues"
      >
        {errors} error{errors === 1 ? '' : 's'}, {warnings} warning{warnings === 1 ? '' : 's'}
      </span>
      <span className="muted">
        {song.orders.length} order{song.orders.length === 1 ? '' : 's'} x {song.patternLength} rows, {clock(songSeconds(song))}
      </span>
    </footer>
  )
}
