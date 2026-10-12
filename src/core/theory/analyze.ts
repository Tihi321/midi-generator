// Song analysis for the LLM: key detection, chord per bar, clashes, out-of-scale notes, per-channel stats.
// Works on the pattern data in order (jump/break effects are ignored; rows run orders[0].. in sequence).

import type { Song } from '../types'
import { PITCH_CLASSES, describeNote, pitchClassOf } from '../notes'
import { rowsPerBar } from '../model'
import { isDrumRole } from '../instruments/roles'
import { validateSong } from '../chips'
import type { Issue } from '../chips/types'
import { identifyChord } from './chords'
import { findScale, isInScale } from './scales'
import type { PitchClass } from '../types'

// ---------------------------------------------------------------- key detection (Krumhansl-Schmuckler)

export const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
export const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface KeyCandidate {
  key: PitchClass
  mode: 'major' | 'minor'
  /** Pearson correlation -1..1. */
  correlation: number
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((x, y) => x + y, 0) / n
  const mb = b.reduce((x, y) => x + y, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

/** All 24 keys ranked by correlation with a pitch-class histogram (12 entries, any weights). */
export function detectKey(histogram: number[]): KeyCandidate[] {
  const out: KeyCandidate[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = histogram.map((_, i) => histogram[(i + tonic) % 12]!)
    out.push({ key: PITCH_CLASSES[tonic]!, mode: 'major', correlation: pearson(rotated, KRUMHANSL_MAJOR) })
    out.push({ key: PITCH_CLASSES[tonic]!, mode: 'minor', correlation: pearson(rotated, KRUMHANSL_MINOR) })
  }
  return out.sort((a, b) => b.correlation - a.correlation)
}

// ---------------------------------------------------------------- event collection

export interface NoteEvent {
  channel: string
  order: number
  row: number
  /** Row index from the start of the song. */
  absRow: number
  midi: number
  /** Rows the note sounds (until the next note, off or release; capped at the song end). */
  length: number
  percussion: boolean
}

export interface NoteTimeline {
  rows: number
  channels: string[]
  /** sounding[channel][absRow] = MIDI note or -1. */
  sounding: Int16Array[]
  /** Chord tones added by an active arpeggio effect (0xy), per channel and row (0 = none). */
  arp: Uint8Array[]
  /** True where the channel plays percussion (noise channel kind or a drum-role instrument). */
  percussion: Uint8Array[]
  events: NoteEvent[]
}

const PERCUSSION_KINDS = new Set(['noise', 'psg-noise', 'dpcm'])

export function buildNoteTimeline(song: Song): NoteTimeline {
  const rows = song.orders.length * song.patternLength
  const channels = song.channels.map((c) => c.id)
  const sounding = channels.map(() => new Int16Array(rows).fill(-1))
  const arp = channels.map(() => new Uint8Array(rows))
  const percussion = channels.map(() => new Uint8Array(rows))
  const events: NoteEvent[] = []

  song.channels.forEach((ch, ci) => {
    let current = -1
    let currentEvent: NoteEvent | undefined
    let arpParam = 0
    let inst: number | undefined
    for (let o = 0; o < song.orders.length; o++) {
      const n = song.orders[o]?.[ci]
      const pat = n === undefined ? undefined : song.patterns.get(`${ch.id}:${n}`)
      for (let r = 0; r < song.patternLength; r++) {
        const abs = o * song.patternLength + r
        const cell = pat?.rows[r]
        if (cell) {
          if (cell.inst !== undefined) inst = cell.inst
          for (const fx of cell.fx ?? []) if (fx.code === '0') arpParam = fx.param
          if (cell.note === 'off' || cell.note === 'rel') {
            current = -1
            currentEvent = undefined
          } else if (typeof cell.note === 'number') {
            current = cell.note
            const role = inst !== undefined ? song.instruments[inst]?.role : undefined
            const perc = PERCUSSION_KINDS.has(ch.kind) || (role !== undefined && isDrumRole(role))
            currentEvent = { channel: ch.id, order: o, row: r, absRow: abs, midi: cell.note, length: 0, percussion: perc }
            events.push(currentEvent)
          }
        }
        sounding[ci]![abs] = current
        arp[ci]![abs] = current >= 0 ? arpParam : 0
        const role = inst !== undefined ? song.instruments[inst]?.role : undefined
        percussion[ci]![abs] = PERCUSSION_KINDS.has(ch.kind) || (role !== undefined && isDrumRole(role)) ? 1 : 0
        if (currentEvent) currentEvent.length++
      }
    }
  })
  return { rows, channels, sounding, arp, percussion, events }
}

// ---------------------------------------------------------------- results

export interface BarChord {
  bar: number
  order: number
  /** First row of the bar within the order's pattern. */
  row: number
  name: string | null
  roman: string | null
  /** 0..1 match quality. */
  confidence: number
  /** Bass note (lowest sounding) of the bar, if any. */
  bass: string | null
}

export interface Clash {
  order: number
  row: number
  rows: number
  channels: [string, string]
  notes: [string, string]
  message: string
}

export interface OutOfScaleGroup {
  channel: string
  count: number
  notes: string[]
  first: { order: number; row: number; note: string }
}

export interface ChannelStats {
  id: string
  percussion: boolean
  notes: number
  distinctNotes: number
  lowest: string | null
  highest: string | null
  rangeSemitones: number
  /** Notes per bar. */
  density: number
  /** Share of rows with a sounding note (0..1). */
  activity: number
}

export interface Analysis {
  rows: number
  bars: number
  declared: { key: PitchClass; scale: string }
  detected: KeyCandidate[]
  /** True when the best detected key shares its tonic and relative mode/relative key with the declared key. */
  keyAgrees: boolean
  chords: BarChord[]
  clashes: Clash[]
  clashTotal: number
  outOfScale: OutOfScaleGroup[]
  outOfScaleTotal: number
  channels: ChannelStats[]
  /** Chip-rule violations (same as validate). */
  chipIssues: Issue[]
  /** Short hints for the LLM. */
  hints: string[]
}

const ROMAN = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII']

export function romanNumeral(rootPc: number, quality: string, tonicPc: number): string {
  const base = ROMAN[(((rootPc - tonicPc) % 12) + 12) % 12]!
  const minor = quality === 'min' || quality === 'min7' || quality === 'dim' || quality === 'm7b5' || quality === 'dim7'
  let r = minor ? base.toLowerCase() : base
  if (quality === 'dim' || quality === 'dim7') r += '°'
  if (quality === 'm7b5') r += 'ø'
  if (quality === 'dom7' || quality === 'min7') r += '7'
  if (quality === 'maj7') r += 'maj7'
  if (quality === 'sus2') r += 'sus2'
  if (quality === 'sus4') r += 'sus4'
  if (quality === 'aug') r += '+'
  return r
}

export interface AnalyzeOptions {
  maxClashes?: number
  maxOutOfScale?: number
  /** Skip the chip validation pass. */
  skipChip?: boolean
}

export function analyzeSong(song: Song, opts: AnalyzeOptions = {}): Analysis {
  const tl = buildNoteTimeline(song)
  const rpb = rowsPerBar(song.timing)
  const hist = new Array<number>(12).fill(0)
  for (const e of tl.events) if (!e.percussion) hist[pitchClassOf(e.midi)]! += e.length

  const detected = hist.some((v) => v > 0) ? detectKey(hist).slice(0, 5) : []
  const declared = { key: song.meta.key, scale: song.meta.scale }
  const best = detected[0]
  const declaredTonic = PITCH_CLASSES.indexOf(declared.key)
  const intervals = findScale(declared.scale)?.intervals ?? []
  const declaredMinor = intervals.includes(3) && !intervals.includes(4)
  let keyAgrees = true
  if (best) {
    const bt = PITCH_CLASSES.indexOf(best.key)
    const sameMode = (best.mode === 'minor') === declaredMinor
    const relative = sameMode ? bt === declaredTonic : best.mode === 'major' ? (bt + 9) % 12 === declaredTonic : (bt + 3) % 12 === declaredTonic
    keyAgrees = relative
  }

  // chords per bar
  const tonicForRoman = best ? PITCH_CLASSES.indexOf(best.key) : declaredTonic
  const chords: BarChord[] = []
  const bars = Math.ceil(tl.rows / rpb)
  for (let b = 0; b < bars; b++) {
    const start = b * rpb
    const end = Math.min(tl.rows, start + rpb)
    const w = new Array<number>(12).fill(0)
    const bassCount = new Array<number>(12).fill(0)
    let any = false
    for (let r = start; r < end; r++) {
      let low = 1000
      for (let ci = 0; ci < tl.channels.length; ci++) {
        if (tl.percussion[ci]![r]) continue
        const n = tl.sounding[ci]![r]!
        if (n < 0) continue
        any = true
        w[pitchClassOf(n)]! += 1
        const p = tl.arp[ci]![r]!
        if (p) {
          const x = (p >> 4) & 15
          const y = p & 15
          if (x) w[pitchClassOf(n + x)]! += 1
          if (y) w[pitchClassOf(n + y)]! += 1
        }
        if (n < low) low = n
      }
      if (low < 1000) {
        bassCount[pitchClassOf(low)]! += 1
        w[pitchClassOf(low)]! += 0.5
      }
    }
    const order = Math.floor(start / song.patternLength)
    const row = start % song.patternLength
    if (!any) {
      chords.push({ bar: b, order, row, name: null, roman: null, confidence: 0, bass: null })
      continue
    }
    let bassPc = 0
    bassCount.forEach((v, i) => {
      if (v > bassCount[bassPc]!) bassPc = i
    })
    const id = identifyChord(w, bassPc)
    chords.push({
      bar: b,
      order,
      row,
      name: id ? id.name : null,
      roman: id ? romanNumeral(id.root, id.quality, tonicForRoman) : null,
      confidence: id ? Number(id.score.toFixed(2)) : 0,
      bass: PITCH_CLASSES[bassPc]!
    })
  }

  // clashes (minor second / minor ninth between melodic channels sounding together)
  const maxClashes = opts.maxClashes ?? 40
  const clashes: Clash[] = []
  let clashTotal = 0
  const open = new Map<string, Clash>()
  for (let r = 0; r < tl.rows; r++) {
    const active = new Set<string>()
    for (let a = 0; a < tl.channels.length; a++) {
      const na = tl.sounding[a]![r]!
      if (na < 0 || tl.percussion[a]![r]) continue
      for (let b = a + 1; b < tl.channels.length; b++) {
        const nb = tl.sounding[b]![r]!
        if (nb < 0 || tl.percussion[b]![r]) continue
        const d = Math.abs(na - nb)
        if (d !== 1 && d !== 13) continue
        const id = `${a}-${b}-${na}-${nb}`
        active.add(id)
        const cur = open.get(id)
        if (cur) cur.rows++
        else {
          const lo = Math.min(na, nb)
          const hi = Math.max(na, nb)
          const c: Clash = {
            order: Math.floor(r / song.patternLength),
            row: r % song.patternLength,
            rows: 1,
            channels: [tl.channels[a]!, tl.channels[b]!],
            notes: [describeNote(na), describeNote(nb)],
            message: `${tl.channels[a]} ${describeNote(na)} and ${tl.channels[b]} ${describeNote(nb)} are a ${d === 1 ? 'minor second' : 'minor ninth'} apart (${describeNote(lo)}/${describeNote(hi)}); move one by a semitone or an octave, or shorten one note.`
          }
          open.set(id, c)
          clashTotal++
          if (clashes.length < maxClashes) clashes.push(c)
        }
      }
    }
    for (const id of [...open.keys()]) if (!active.has(id)) open.delete(id)
  }

  // out-of-scale notes (note starts only)
  const maxOut = opts.maxOutOfScale ?? 20
  const groups = new Map<string, OutOfScaleGroup>()
  let outTotal = 0
  const chromatic = declared.scale === 'chromatic'
  if (!chromatic && findScale(declared.scale)) {
    for (const e of tl.events) {
      if (e.percussion || isInScale(e.midi, declared.key, declared.scale)) continue
      outTotal++
      const g = groups.get(e.channel)
      const name = describeNote(e.midi)
      if (g) {
        g.count++
        if (!g.notes.includes(name) && g.notes.length < 8) g.notes.push(name)
      } else {
        groups.set(e.channel, { channel: e.channel, count: 1, notes: [name], first: { order: e.order, row: e.row, note: name } })
      }
    }
  }
  const outOfScale = [...groups.values()].slice(0, maxOut)

  // channel stats
  const channelStats: ChannelStats[] = tl.channels.map((id, ci) => {
    const evs = tl.events.filter((e) => e.channel === id)
    const perc = tl.percussion[ci]!.some((v) => v === 1) || song.channels[ci]!.kind === 'noise'
    const melodic = evs.map((e) => e.midi)
    const lo = melodic.length ? Math.min(...melodic) : null
    const hi = melodic.length ? Math.max(...melodic) : null
    let sounding = 0
    for (let r = 0; r < tl.rows; r++) if (tl.sounding[ci]![r]! >= 0) sounding++
    return {
      id,
      percussion: perc,
      notes: evs.length,
      distinctNotes: new Set(melodic).size,
      lowest: lo === null ? null : describeNote(lo),
      highest: hi === null ? null : describeNote(hi),
      rangeSemitones: lo === null || hi === null ? 0 : hi - lo,
      density: bars > 0 ? Number((evs.length / bars).toFixed(2)) : 0,
      activity: tl.rows > 0 ? Number((sounding / tl.rows).toFixed(2)) : 0
    }
  })

  const hints: string[] = []
  if (best && !keyAgrees) {
    hints.push(`Detected key ${best.key} ${best.mode} differs from the declared ${declared.key} ${declared.scale}; update set_song_info or fix stray notes.`)
  }
  if (clashTotal > 0) hints.push(`${clashTotal} minor-second clash(es) between channels; see clashes.`)
  if (outTotal > 0) hints.push(`${outTotal} note(s) outside ${declared.key} ${declared.scale}; fine as passing notes, otherwise fix.`)
  for (const s of channelStats) {
    if (s.notes === 0 && !song.channels.find((c) => c.id === s.id)?.muted) hints.push(`${s.id} is empty.`)
  }

  return {
    rows: tl.rows,
    bars,
    declared,
    detected,
    keyAgrees,
    chords,
    clashes,
    clashTotal,
    outOfScale,
    outOfScaleTotal: outTotal,
    channels: channelStats,
    chipIssues: opts.skipChip ? [] : validateSong(song),
    hints
  }
}
