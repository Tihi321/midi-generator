// Several songs in one session. The live song (`session.song`, one stable object) is always "current"; the others are
// parked as project text in `session.held`. compose_track and open_song park the song they replace, open_song and
// delete_song can bring one back. No DOM, no Electron, no node:*.

import { type Song, createSong, parseProject, serializeProject } from '../core'
import type { SongSession } from './session'

export interface SongInfo {
  songId: string
  name: string
  path: string | null
  chip: string
  bpm: number
  current: boolean
}

/** A song worth keeping when it gets replaced: it has notes or instruments. */
export function hasContent(song: Song): boolean {
  return song.patterns.size > 0 || song.instruments.length > 0
}

/** Park the live song in `held` (skipped when it is empty). */
export function stashCurrent(session: SongSession): void {
  const song = session.song
  if (!hasContent(song)) return
  session.held.set(song.id, { project: serializeProject(song, false), path: session.songPaths.get(song.id) ?? null })
}

/** Replace the live song with `next` (undoable); the replaced one is parked. */
export function activateSong(session: SongSession, next: Song, path: string | null, label: string): void {
  if (next.id !== session.song.id) stashCurrent(session)
  session.held.delete(next.id)
  session.replaceSong(next, { history: 'record', label })
  if (path) session.songPaths.set(next.id, path)
}

export function listSongs(session: SongSession): SongInfo[] {
  const cur = session.song
  const out: SongInfo[] = [
    { songId: cur.id, name: cur.name, path: session.songPaths.get(cur.id) ?? null, chip: cur.chip, bpm: cur.timing.bpm, current: true }
  ]
  for (const [id, h] of session.held) {
    if (id === cur.id) continue
    const s = parseProject(h.project)
    out.push({ songId: id, name: s.name, path: h.path ?? session.songPaths.get(id) ?? null, chip: s.chip, bpm: s.timing.bpm, current: false })
  }
  return out
}

/** The song with this id (default: the live one) without switching to it. Throws with the known ids. */
export function resolveSong(session: SongSession, id?: string): { song: Song; current: boolean } {
  if (!id || id === session.song.id) return { song: session.song, current: true }
  const h = session.held.get(id)
  if (!h) {
    const known = listSongs(session).map((s) => `${s.songId} ("${s.name}")`).join(', ')
    throw new Error(`No song "${id}" in this session. Known songs: ${known}. (list_songs shows them.)`)
  }
  return { song: parseProject(h.project), current: false }
}

/** Remove a song from the session. The live song is replaced by the most recently parked one, or by an empty song. */
export function deleteSong(session: SongSession, id: string): void {
  if (id === session.song.id) {
    const last = [...session.held.keys()].pop()
    const next = last ? parseProject(session.held.get(last)!.project) : createSong({ chip: 'nes', name: 'Untitled' })
    if (last) session.held.delete(last)
    session.replaceSong(next, { history: 'record', label: 'Delete song' })
    session.songPaths.delete(id)
    session.exportTarget = null
    return
  }
  if (!session.held.delete(id)) throw new Error(`No song "${id}" in this session (list_songs shows them).`)
  session.songPaths.delete(id)
}
