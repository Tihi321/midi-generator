// Audition: a tiny one-shot song that plays one note of one instrument, so the instrument editor and the
// tracker can preview sounds without touching the live song. Pure.

import { type Cell, type Pattern, type PatternKey, type Song, patternKey, songChannelDefs } from '../../core'

/** Channel index that can play `instIndex`: the preferred channel when it accepts the kind, else the first that does. */
export function auditionChannel(song: Song, instIndex: number, preferred: number): number {
  const inst = song.instruments[instIndex]
  if (!inst) return -1
  const defs = songChannelDefs(song)
  if (defs[preferred]?.instKinds.includes(inst.kind)) return preferred
  const i = defs.findIndex((d) => d.instKinds.includes(inst.kind))
  return i
}

/** Default audition pitch for a channel: middle of its range (noise channels use a fixed mid pitch index). */
export function auditionNote(song: Song, channel: number, wanted: number): number {
  const def = songChannelDefs(song)[channel]
  if (!def) return wanted
  return Math.max(def.noteMin, Math.min(def.noteMax, wanted))
}

/** Build the one-shot audition song, or null when no channel can play the instrument. Shares data with `song` (read-only use). */
export function buildAuditionSong(song: Song, instIndex: number, preferredChannel: number, wantedNote: number): Song | null {
  const ch = auditionChannel(song, instIndex, preferredChannel)
  if (ch < 0) return null
  const rows: (Cell | null)[] = new Array<Cell | null>(16).fill(null)
  rows[0] = { note: auditionNote(song, ch, wantedNote), inst: instIndex, vol: 15 }
  rows[6] = { note: 'rel' }
  rows[8] = { note: 'off' }
  const timing = { bpm: 120, speed: 6, rowsPerBeat: 4, beatsPerBar: song.timing.beatsPerBar }
  return {
    ...song,
    timing,
    patternLength: 16,
    orders: [song.channels.map(() => 0)],
    patterns: new Map<PatternKey, Pattern>([[patternKey(song.channels[ch]!.id, 0), { rows }]]),
    loop: null
  }
}
