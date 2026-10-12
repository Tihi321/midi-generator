// Standard MIDI File -> Song for a chosen chip.
//
// Pipeline: parse -> quantize onsets to a row grid (rowsPerBeat 2/3/4/6/8 with the least error) -> channel 10 becomes
// drum hits (GM note -> role) on the chip's drum channel(s) -> melodic tracks are ranked (note count + mean pitch) into
// bass / lead / harmony and assigned to channels -> each part is reduced to one voice (skyline, with <= 2 extra chord
// tones folded into a 0xy arpeggio) -> octave-shifted into the channel's range -> cut into patterns, duplicates removed.
// The returned report lists every assignment and every note or controller that could not be kept.

import type { Cell, ChannelKind, ChipConfig, ChipId, Effect, Song } from '../types'
import { defaultChipConfig, chipChannels, validateSong, formatIssues, type ChannelDef } from '../chips'
import { createSong } from '../model'
import { PITCH_CLASSES, formatNote } from '../notes'
import { detectKey } from '../theory/analyze'
import { defaultDrumNote } from './drumText'
import { roleForGmDrumNote, roleForGmProgram } from './gmMap'
import {
  META_KEY_SIGNATURE,
  META_MARKER,
  META_TEMPO,
  META_TIME_SIGNATURE,
  META_TRACK_NAME,
  type ParsedMidi,
  metaString,
  parseSmf
} from './midiFile'
import { DRUM_PRIORITY, chipSlots, isLowDrum } from './slots'
import { addSongInstrument, bestOctaveShift, foldIntoRange, presetFor, snapVolume, writeChannelPatterns } from './songBuild'
import type { Role } from '../types'

export interface MidiImportOptions {
  /** Target chip (default 'nes'). */
  chip?: ChipId
  /** Chip settings such as NES `{dpcm:true}` or Genesis `{fm6Dac:true}`. */
  chipConfig?: Partial<ChipConfig>
  /** Force the grid (2, 3, 4, 6 or 8 rows per beat) instead of picking the best fit. */
  rowsPerBeat?: number
  /** Rows per pattern (default: about 64, a whole number of bars; chosen so the loop point falls on an order boundary). */
  patternLength?: number
  /** Use at most this many melodic channels (drums excluded). */
  maxChannels?: number
  name?: string
  authenticity?: 'strict' | 'relaxed'
  /** Fold chord tones into 0xy arpeggios (default true). With false only the top voice is kept. */
  foldChords?: boolean
}

export interface MidiImportResult {
  song: Song
  report: string[]
}

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  return parseSmf(bytes)
}

interface PNote {
  start: number
  end: number
  pitch: number
  vel: number
}

interface RawPart {
  key: string
  track: number
  channel: number
  name: string
  notes: PNote[]
  programs: Map<number, number>
}

interface DrumHit {
  tick: number
  note: number
  vel: number
}

interface Seg {
  row: number
  end: number
  pitch: number
  vel: number
  arp?: [number, number]
}

const CANDIDATE_GRIDS = [2, 3, 4, 6, 8]
/** Preference for each grid (added to the mean off-grid error, measured in 1/16 beats). */
const GRID_PENALTY: Record<number, number> = { 2: 0.45, 3: 0.25, 4: 0, 6: 0.3, 8: 0.2 }

/** Pick rowsPerBeat for a set of onset ticks: the grid with the least mean quantization error (plus a small preference for 4). */
export function pickRowsPerBeat(onsets: readonly number[], ppq: number): { rowsPerBeat: number; error: number } {
  if (onsets.length === 0) return { rowsPerBeat: 4, error: 0 }
  const step = Math.max(1, Math.floor(onsets.length / 20000))
  const unit = ppq / 16
  let best = 4
  let bestCost = Infinity
  let bestErr = 0
  for (const r of CANDIDATE_GRIDS) {
    const g = ppq / r
    let sum = 0
    let n = 0
    for (let i = 0; i < onsets.length; i += step) {
      const t = onsets[i]!
      sum += Math.abs(t - Math.round(t / g) * g) / unit
      n++
    }
    const err = sum / Math.max(1, n)
    const cost = err + (GRID_PENALTY[r] ?? 0.3)
    if (cost < bestCost - 1e-9) {
      best = r
      bestCost = cost
      bestErr = err
    }
  }
  return { rowsPerBeat: best, error: bestErr }
}

const KEY_FROM_SHARPS_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
const KEY_FROM_FLATS_MAJOR = ['C', 'F', 'A#', 'D#', 'G#', 'C#', 'F#', 'B']

function keyFromSignature(sharps: number, minor: boolean): { key: string; scale: string } {
  const s = ((sharps << 24) >> 24) as number // signed byte
  const major = s >= 0 ? KEY_FROM_SHARPS_MAJOR[Math.min(7, s)]! : KEY_FROM_FLATS_MAJOR[Math.min(7, -s)]!
  if (!minor) return { key: major, scale: 'major' }
  const idx = (PITCH_CLASSES.indexOf(major as (typeof PITCH_CLASSES)[number]) + 9) % 12
  return { key: PITCH_CLASSES[idx]!, scale: 'minor' }
}

const noteName = (n: number): string => (n >= 12 && n <= 127 ? formatNote(n) : String(n))

/** Convert a MIDI file to a song for the target chip. */
export function importMidi(bytes: Uint8Array, opts: MidiImportOptions = {}): MidiImportResult {
  const report: string[] = []
  const parsed = parseSmf(bytes)
  for (const w of parsed.warnings) report.push(`Warning: ${w}`)
  const ppq = parsed.division
  const chip: ChipId = opts.chip ?? 'nes'
  const cfg = { ...defaultChipConfig(chip), ...(opts.chipConfig ?? {}), chip } as ChipConfig
  const defs = chipChannels(chip, cfg)
  const foldChords = opts.foldChords ?? true

  // ---- collect notes, tempo, meta
  const tempos: { tick: number; us: number }[] = []
  let timeSig: { num: number; den: number } | undefined
  let keySig: { sharps: number; minor: boolean } | undefined
  let loopStartTick = -1
  let loopEndTick = -1
  let cc111Tick = -1
  let bends = 0
  let volumeCcs = 0
  let sustainCcs = 0
  const parts = new Map<string, RawPart>()
  const drumHits: DrumHit[] = []
  const trackNames: string[] = []
  parsed.tracks.forEach((events, ti) => {
    const programs = new Map<number, number>()
    const open = new Map<string, PNote[]>()
    let lastTick = 0
    let trackName = ''
    for (const ev of events) {
      lastTick = Math.max(lastTick, ev.tick)
      switch (ev.kind) {
        case 'meta':
          if (ev.type === META_TEMPO && ev.data.length >= 3) tempos.push({ tick: ev.tick, us: (ev.data[0]! << 16) | (ev.data[1]! << 8) | ev.data[2]! })
          else if (ev.type === META_TIME_SIGNATURE && ev.data.length >= 2 && !timeSig) timeSig = { num: ev.data[0]!, den: 2 ** ev.data[1]! }
          else if (ev.type === META_KEY_SIGNATURE && ev.data.length >= 2 && !keySig) keySig = { sharps: ev.data[0]!, minor: ev.data[1] === 1 }
          else if (ev.type === META_TRACK_NAME && !trackName) trackName = metaString(ev).trim()
          else if (ev.type === META_MARKER || ev.type === 0x01) {
            const text = metaString(ev)
            if (/loop\s*[_-]?\s*start/i.test(text) && loopStartTick < 0) loopStartTick = ev.tick
            else if (/loop\s*[_-]?\s*end/i.test(text) && loopEndTick < 0) loopEndTick = ev.tick
          }
          break
        case 'program':
          programs.set(ev.channel, ev.program)
          break
        case 'cc':
          if (ev.controller === 111 && cc111Tick < 0) cc111Tick = ev.tick
          else if (ev.controller === 7 || ev.controller === 11) volumeCcs++
          else if (ev.controller === 64) sustainCcs++
          break
        case 'pitchBend':
          if (Math.abs(ev.value - 8192) > 64) bends++
          break
        case 'noteOn': {
          const vel = ev.velocity
          if (ev.channel === 9) {
            drumHits.push({ tick: ev.tick, note: ev.note, vel })
            break
          }
          const key = `${ti}:${ev.channel}`
          let part = parts.get(key)
          if (!part) {
            part = { key, track: ti, channel: ev.channel, name: '', notes: [], programs: new Map() }
            parts.set(key, part)
          }
          const program = programs.get(ev.channel) ?? 0
          part.programs.set(program, (part.programs.get(program) ?? 0) + 1)
          const n: PNote = { start: ev.tick, end: -1, pitch: ev.note, vel }
          part.notes.push(n)
          const k = `${key}:${ev.note}`
          const q = open.get(k)
          if (q) q.push(n)
          else open.set(k, [n])
          break
        }
        case 'noteOff': {
          if (ev.channel === 9) break
          const q = open.get(`${ti}:${ev.channel}:${ev.note}`)
          const n = q?.shift()
          if (n) n.end = ev.tick
          break
        }
      }
    }
    for (const q of open.values()) for (const n of q) if (n.end < 0) n.end = Math.max(lastTick, n.start + 1)
    trackNames[ti] = trackName
  })
  for (const part of parts.values()) part.name = trackNames[part.track] || `track ${part.track}`
  const title = parsed.format === 1 && trackNames[0] && ![...parts.values()].some((p) => p.track === 0) ? trackNames[0] : undefined

  const melodic = [...parts.values()].filter((p) => p.notes.length > 0)
  if (melodic.length === 0 && drumHits.length === 0) {
    throw new Error('The MIDI file contains no notes, so there is nothing to import. Check that it is a music file (not only controller or tempo data).')
  }
  for (const p of melodic) for (const n of p.notes) n.end = Math.max(n.end, n.start + 1)
  report.push(
    `Read ${parsed.tracks.length} track(s), ${ppq} ticks per quarter note: ${melodic.length} melodic part(s) with ${melodic.reduce((a, p) => a + p.notes.length, 0)} notes, ${drumHits.length} drum hit(s).`
  )

  // ---- grid
  const onsets = [...melodic.flatMap((p) => p.notes.map((n) => n.start)), ...drumHits.map((h) => h.tick)]
  let rowsPerBeat = opts.rowsPerBeat ?? 0
  if (rowsPerBeat) {
    if (!Number.isInteger(rowsPerBeat) || rowsPerBeat < 1 || rowsPerBeat > 16) throw new Error(`Invalid rowsPerBeat ${rowsPerBeat}: use an integer 1..16 (2, 3, 4, 6 or 8 are the usual grids).`)
    report.push(`Grid: ${rowsPerBeat} rows per beat (forced).`)
  } else {
    const pick = pickRowsPerBeat(onsets, ppq)
    rowsPerBeat = pick.rowsPerBeat
    report.push(`Grid: ${rowsPerBeat} rows per beat (chosen from 2/3/4/6/8 by least timing error; mean error ${pick.error.toFixed(2)} sixteenth-beats).`)
  }
  const g = ppq / rowsPerBeat
  const rowOf = (tick: number): number => Math.max(0, Math.round(tick / g))

  // ---- time signature, tempo
  let beatsPerBar = 4
  if (timeSig) beatsPerBar = Math.max(1, Math.min(16, Math.round((timeSig.num * 4) / Math.max(1, timeSig.den))))
  const barRows = beatsPerBar * rowsPerBeat
  tempos.sort((a, b) => a.tick - b.tick)
  const firstTempo = tempos.find((t) => t.tick === 0) ?? tempos[0]
  let bpm = firstTempo ? 60_000_000 / firstTempo.us : 120
  if (!firstTempo) report.push('No tempo in the file: assuming 120 BPM.')
  if (bpm < 20 || bpm > 400) {
    const clamped = Math.max(20, Math.min(400, bpm))
    report.push(`Tempo ${bpm.toFixed(1)} BPM is outside the 20..400 range: clamped to ${clamped.toFixed(0)}.`)
    bpm = clamped
  }
  bpm = Math.round(bpm * 100) / 100

  // ---- total length
  let totalRows = 1
  for (const p of melodic) for (const n of p.notes) totalRows = Math.max(totalRows, rowOf(n.end))
  for (const h of drumHits) totalRows = Math.max(totalRows, rowOf(h.tick) + 1)
  const loopStartRow = loopStartTick >= 0 ? rowOf(loopStartTick) : cc111Tick >= 0 ? rowOf(cc111Tick) : -1
  if (loopEndTick >= 0 && loopStartRow >= 0) {
    const endRow = rowOf(loopEndTick)
    if (endRow > loopStartRow && endRow < totalRows) {
      report.push(`The "loopEnd" marker is at row ${endRow}: the song is cut there (what follows is never played when looping).`)
      totalRows = endRow
    }
  }

  // ---- pattern length
  let patternLength = opts.patternLength ?? 0
  if (!patternLength) {
    patternLength = barRows * Math.max(1, Math.round(64 / barRows))
    if (loopStartRow > 0 && loopStartRow % patternLength !== 0) {
      // choose a pattern length that puts the loop start on an order boundary
      for (let p = Math.min(128, loopStartRow); p >= barRows; p--) {
        if (loopStartRow % p === 0 && p % barRows === 0) {
          patternLength = p
          break
        }
      }
    }
    patternLength = Math.max(1, Math.min(256, patternLength))
  } else if (!Number.isInteger(patternLength) || patternLength < 1 || patternLength > 256) {
    throw new Error(`Invalid patternLength ${patternLength}: use an integer 1..256.`)
  }
  const orderCount = Math.max(1, Math.ceil(totalRows / patternLength))
  if (orderCount > 256) {
    report.push(`The music is ${orderCount} patterns long; only the first 256 order rows fit. Use a larger patternLength to keep it all.`)
  }
  const orders = Math.min(256, orderCount)
  totalRows = Math.min(totalRows, orders * patternLength)

  // ---- key
  let key = 'C'
  let scale = 'major'
  if (keySig) {
    const k = keyFromSignature(keySig.sharps, keySig.minor)
    key = k.key
    scale = k.scale
    report.push(`Key: ${key} ${scale} (from the key signature).`)
  } else {
    const hist = new Array<number>(12).fill(0)
    for (const p of melodic) for (const n of p.notes) hist[n.pitch % 12]! += Math.max(1, n.end - n.start)
    if (hist.some((v) => v > 0)) {
      const top = detectKey(hist)[0]!
      key = top.key
      scale = top.mode
      report.push(`Key: ${key} ${scale} (detected from the notes; the file has no key signature).`)
    }
  }

  const song = createSong({
    chip,
    name: opts.name ?? title ?? 'Imported MIDI',
    bpm,
    key,
    scale,
    tags: ['midi-import'],
    patternLength,
    rowsPerBeat,
    beatsPerBar,
    authenticity: opts.authenticity ?? 'strict',
    chipConfig: cfg
  })
  song.orders = Array.from({ length: orders }, () => song.channels.map(() => 0))
  const linear = new Map<number, (Cell | null)[]>()
  const paddedRows = orders * patternLength
  const defOf = (id: string): ChannelDef => defs.find((d) => d.id === id)!
  const indexOf = (id: string): number => song.channels.findIndex((c) => c.id === id)

  // ---- drums
  const used: number[] = []
  const drumRoleCount = new Map<Role, number>()
  const unmapped = new Map<number, number>()
  const hitsByRow = new Map<number, Map<Role, number>>()
  for (const h of drumHits) {
    const role = roleForGmDrumNote(h.note)
    if (!role) {
      unmapped.set(h.note, (unmapped.get(h.note) ?? 0) + 1)
      continue
    }
    const row = rowOf(h.tick)
    if (row >= totalRows) continue
    let m = hitsByRow.get(row)
    if (!m) hitsByRow.set(row, (m = new Map()))
    m.set(role, Math.max(m.get(role) ?? 0, h.vel))
    drumRoleCount.set(role, (drumRoleCount.get(role) ?? 0) + 1)
  }
  if (unmapped.size > 0) {
    report.push(
      `Dropped drum notes with no chip equivalent: ${[...unmapped].map(([n, c]) => `GM ${n} x${c}`).join(', ')}.`
    )
  }
  const hasDrums = hitsByRow.size > 0
  const slots = chipSlots(chip, cfg, hasDrums)
  if (hasDrums) {
    const lowId = slots.drumLow
    const highId = slots.drumHigh
    const channelsUsed = [...new Set([lowId, highId])]
    const dropped = new Map<string, number>()
    for (const id of channelsUsed) linear.set(indexOf(id), new Array<Cell | null>(paddedRows).fill(null))
    let placed = 0
    for (const [row, hits] of [...hitsByRow].sort((a, b) => a[0] - b[0])) {
      const byChannel = new Map<string, [Role, number][]>()
      for (const [role, vel] of hits) {
        const id = channelsUsed.length === 1 ? lowId : isLowDrum(role) ? lowId : highId
        const arr = byChannel.get(id) ?? []
        arr.push([role, vel])
        byChannel.set(id, arr)
      }
      for (const [id, cands] of byChannel) {
        cands.sort((a, b) => (DRUM_PRIORITY[a[0]] ?? 9) - (DRUM_PRIORITY[b[0]] ?? 9))
        const [role, vel] = cands[0]!
        const def = defOf(id)
        const inst = addSongInstrument(song, presetFor(chip, role, def.kind))
        const cell: Cell = { note: defaultDrumNote(role, def.kind), inst }
        if (def.hasVolume) cell.vol = snapVolume(Math.max(1, Math.min(15, Math.round((vel / 127) * 15))), def)
        linear.get(indexOf(id))![row] = cell
        placed++
        for (const lost of cands.slice(1)) dropped.set(`${id}:${lost[0]}`, (dropped.get(`${id}:${lost[0]}`) ?? 0) + 1)
      }
    }
    for (const id of channelsUsed) used.push(indexOf(id))
    const roles = [...drumRoleCount].map(([r, c]) => `${r} x${c}`).join(', ')
    report.push(`Drums (GM channel 10): ${placed} hits placed on ${channelsUsed.join(' + ')} (${roles}); ${channelsUsed.length === 1 ? `${slots.drumLow} plays every drum` : `${lowId} plays kick/tom, ${highId} the rest`}.`)
    if (dropped.size > 0) {
      const total = [...dropped.values()].reduce((a, b) => a + b, 0)
      report.push(`Dropped ${total} simultaneous drum hit(s) that did not fit one note per channel: ${[...dropped].map(([k, c]) => `${k.split(':')[1]} on ${k.split(':')[0]} x${c}`).join(', ')}.`)
    }
  } else if (drumHits.length > 0) {
    report.push('None of the drum hits could be mapped.')
  }

  // ---- melodic parts: rank, assign
  const meanOf = (p: RawPart): number => p.notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, p.notes.length)
  const programOf = (p: RawPart): number => [...p.programs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const maxCount = Math.max(1, ...melodic.map((p) => p.notes.length))
  const pitches = melodic.map(meanOf)
  const minMean = Math.min(...pitches, 127)
  const maxMean = Math.max(...pitches, 0)
  const scoreOf = (p: RawPart): number => 0.6 * (p.notes.length / maxCount) + 0.4 * (maxMean === minMean ? 0.5 : (meanOf(p) - minMean) / (maxMean - minMean))
  const ranked = [...melodic].sort((a, b) => scoreOf(b) - scoreOf(a))
  let bassPart: RawPart | undefined
  const gmBass = ranked.filter((p) => roleForGmProgram(programOf(p)) === 'bass')
  if (gmBass.length > 0) bassPart = [...gmBass].sort((a, b) => meanOf(a) - meanOf(b))[0]
  else if (melodic.length > 1) {
    const lowest = [...melodic].sort((a, b) => meanOf(a) - meanOf(b))[0]!
    if (meanOf(lowest) <= 55) bassPart = lowest
  }
  const rest = ranked.filter((p) => p !== bassPart)
  const pool = [slots.lead, ...slots.harmony, ...(bassPart ? [] : [slots.bass])]
  const assignments: { part: RawPart; channel: string; role: Role }[] = []
  const limit = Math.max(0, opts.maxChannels ?? Infinity)
  const queue = [...(bassPart ? [bassPart] : []), ...rest]
  const dropped: RawPart[] = []
  let used_ = 0
  const poolLeft = [...pool]
  for (const part of queue) {
    if (used_ >= limit) {
      dropped.push(part)
      continue
    }
    let channel: string | undefined
    if (part === bassPart) channel = slots.bass
    else channel = poolLeft.shift()
    if (!channel) {
      dropped.push(part)
      continue
    }
    used_++
    assignments.push({ part, channel, role: 'lead' })
  }
  for (const d of dropped) {
    report.push(
      `Dropped part "${d.name}" (ch ${d.channel + 1}, ${d.notes.length} notes, mean ${noteName(Math.round(meanOf(d)))}): ${limit <= used_ && limit !== Infinity ? `maxChannels is ${limit}` : `${chip.toUpperCase()} has no free melodic channel`}.`
    )
  }

  for (const a of assignments) {
    const def = defOf(a.channel)
    const ci = indexOf(a.channel)
    const part = a.part
    const gmRole = roleForGmProgram(programOf(part))
    let role: Role
    const isBass = part === bassPart
    if (isBass) role = 'bass'
    else if (a.channel === slots.lead) role = ['lead', 'brass', 'flute', 'bell', 'pluck'].includes(gmRole) ? gmRole : 'lead'
    else role = gmRole === 'lead' ? 'arp' : gmRole === 'bass' ? 'pluck' : gmRole
    a.role = role
    const inst = presetFor(chip, role, def.kind)
    const instIdx = addSongInstrument(song, inst)

    // voices
    const red = reduceVoices(part.notes, rowOf, totalRows, foldChords)
    let segs = red.segs
    // octave fit
    const all = segs.flatMap((s) => [s.pitch, s.pitch + (s.arp ? Math.max(s.arp[0], s.arp[1]) : 0)])
    const shift = bestOctaveShift(all, def.noteMin, def.noteMax)
    let folded = 0
    let arpLost = 0
    segs = segs.map((s) => {
      const base = s.pitch + shift
      const span = s.arp ? Math.max(s.arp[0], s.arp[1]) : 0
      if (base >= def.noteMin && base + span <= def.noteMax) return { ...s, pitch: base }
      const f = foldIntoRange(base, def.noteMin, def.noteMax)
      folded++
      if (f.note + span > def.noteMax) {
        arpLost++
        const { arp: _arp, ...plain } = s
        void _arp
        return { ...plain, pitch: f.note }
      }
      return { ...s, pitch: f.note }
    })
    const lines: string[] = []
    lines.push(
      `Part "${part.name}" (ch ${part.channel + 1}, GM ${programOf(part)}, ${part.notes.length} notes, mean ${noteName(Math.round(meanOf(part)))}) -> ${a.channel} ${def.name} as ${role} (${inst.presetId ?? inst.name})${isBass ? ' [bass]' : a.channel === slots.lead ? ' [lead]' : ' [harmony]'}.`
    )
    if (shift !== 0) lines.push(`  transposed ${shift > 0 ? '+' : ''}${shift} semitones to fit ${a.channel}'s range ${noteName(def.noteMin)}..${noteName(def.noteMax)}.`)
    if (folded > 0) lines.push(`  ${folded} note(s) moved by octaves into range${arpLost ? `; ${arpLost} arpeggio(s) reduced to one tone` : ''}.`)
    if (red.folded > 0) lines.push(`  ${red.folded} chord(s) folded into 0xy arpeggios.`)
    if (red.dropped > 0) lines.push(`  ${red.dropped} chord tone(s) dropped (more than 2 extra tones or wider than 15 semitones, or fold disabled).`)
    if (red.overlaps > 0) lines.push(`  ${red.overlaps} overlapping note(s) cut by the next note (one voice per channel).`)
    report.push(...lines)
    linear.set(ci, buildLinear(segs, paddedRows, patternLength, instIdx, def))
    used.push(ci)
  }

  // ---- tempo changes (Fxx on the first used channel)
  const tempoHost = used.length > 0 ? Math.min(...used) : 0
  const tempoNote: string[] = []
  let currentBpm = bpm
  let tempoCount = 0
  for (const t of tempos) {
    if (t.tick === 0 || t === firstTempo) continue
    const row = rowOf(t.tick)
    if (row >= totalRows) continue
    const b = Math.round(60_000_000 / t.us)
    if (b === Math.round(currentBpm)) continue
    if (b < 32 || b > 255) {
      tempoNote.push(`${b} BPM at row ${row}`)
      continue
    }
    currentBpm = b
    let arr = linear.get(tempoHost)
    if (!arr) linear.set(tempoHost, (arr = new Array<Cell | null>(paddedRows).fill(null)))
    const cell: Cell = arr[row] ? { ...arr[row]! } : {}
    const fx: Effect[] = [...(cell.fx ?? [])]
    fx.push({ code: 'F', param: b })
    cell.fx = fx
    arr[row] = cell
    tempoCount++
  }
  if (tempoCount > 0) report.push(`${tempoCount} tempo change(s) written as Fxx effects on ${song.channels[tempoHost]!.id}.`)
  if (tempoNote.length > 0) report.push(`Tempo changes outside Fxx's 32..255 BPM range were ignored: ${tempoNote.slice(0, 5).join(', ')}.`)

  // ---- write patterns
  let uniqueTotal = 0
  let patternTotal = 0
  for (const [ci, cells] of [...linear].sort((a, b) => a[0] - b[0])) {
    const { unique } = writeChannelPatterns(song, ci, cells)
    uniqueTotal += unique
    patternTotal += orders
  }
  report.push(`Built ${orders} order row(s) of ${patternLength} rows (${barRows} rows per bar, ${beatsPerBar}/4); ${patternTotal} channel patterns reduced to ${uniqueTotal} unique ones.`)

  // ---- loop
  if (loopStartRow >= 0) {
    const order = Math.round(loopStartRow / patternLength)
    if (order < orders) {
      song.loop = { order }
      report.push(`Loop: back to order ${order}${loopStartRow % patternLength !== 0 ? ` (the loop start at row ${loopStartRow} was rounded to the nearest order row)` : ''}.`)
    } else {
      song.loop = null
      report.push(`The loop start (row ${loopStartRow}) is past the end of the song: no loop.`)
    }
  } else {
    song.loop = null
    report.push('No loop markers (loopStart / CC111) in the file: the song plays once. Use set_loop to loop it.')
  }

  // ---- ignored data
  if (bends > 0) report.push(`Ignored ${bends} pitch-bend event(s).`)
  if (volumeCcs > 0) report.push(`Ignored ${volumeCcs} volume/expression controller event(s); volume comes from note velocity.`)
  if (sustainCcs > 0) report.push(`Ignored ${sustainCcs} sustain-pedal event(s).`)

  // ---- chip rules
  const issues = validateSong(song)
  if (issues.length === 0) report.push(`The song passes the ${chip.toUpperCase()} chip rules.`)
  else report.push(`Remaining chip-rule findings:\n${formatIssues(issues, 8)}`)
  return { song, report }
}

// ---------------------------------------------------------------- voice reduction

function reduceVoices(
  notes: PNote[],
  rowOf: (tick: number) => number,
  maxRow: number,
  fold: boolean
): { segs: Seg[]; folded: number; dropped: number; overlaps: number } {
  const byRow = new Map<number, { er: number; pitch: number; vel: number }[]>()
  for (const n of notes) {
    const sr = rowOf(n.start)
    if (sr >= maxRow) continue
    const er = Math.min(maxRow, Math.max(sr + 1, rowOf(n.end)))
    const arr = byRow.get(sr) ?? []
    arr.push({ er, pitch: n.pitch, vel: n.vel })
    byRow.set(sr, arr)
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
  const segs: Seg[] = []
  let folded = 0
  let dropped = 0
  let overlaps = 0
  rows.forEach((row, i) => {
    const group = byRow.get(row)!
    const uniq = new Map<number, { er: number; pitch: number; vel: number }>()
    for (const n of group) {
      const cur = uniq.get(n.pitch)
      if (!cur || n.vel > cur.vel) uniq.set(n.pitch, { er: Math.max(n.er, cur?.er ?? 0), pitch: n.pitch, vel: n.vel })
    }
    const tones = [...uniq.values()].sort((a, b) => a.pitch - b.pitch)
    const top = tones[tones.length - 1]!
    const low = tones[0]!
    const extras = tones.length - 1
    const nextRow = rows[i + 1] ?? Infinity
    let seg: Seg
    if (fold && extras >= 1 && extras <= 2 && top.pitch - low.pitch <= 15) {
      const offs = tones.slice(1).map((t) => t.pitch - low.pitch)
      const arp: [number, number] = offs.length === 2 ? [offs[0]!, offs[1]!] : [offs[0]!, offs[0]!]
      const er = Math.max(...tones.map((t) => t.er))
      seg = { row, end: Math.min(er, nextRow), pitch: low.pitch, vel: top.vel, arp }
      folded++
      if (er > nextRow) overlaps++
    } else {
      dropped += extras
      seg = { row, end: Math.min(top.er, nextRow), pitch: top.pitch, vel: top.vel }
      if (top.er > nextRow) overlaps++
    }
    segs.push(seg)
  })
  return { segs, folded, dropped, overlaps }
}

// ---------------------------------------------------------------- segments -> cells

function buildLinear(segs: Seg[], paddedRows: number, patternLength: number, instIdx: number, def: ChannelDef): (Cell | null)[] {
  const linear = new Array<Cell | null>(paddedRows).fill(null)
  type Ev = { row: number; seg?: Seg }
  const events: Ev[] = []
  segs.forEach((s, i) => {
    events.push({ row: s.row, seg: s })
    const next = segs[i + 1]
    if (s.end < paddedRows && (!next || next.row > s.end)) events.push({ row: s.end })
  })
  events.sort((a, b) => a.row - b.row || (a.seg ? 1 : 0) - (b.seg ? 1 : 0))
  // a note at the same row as an 'off' wins: drop the off
  const final = events.filter((e, i) => e.seg || !events.some((o, j) => j !== i && o.seg && o.row === e.row))
  let arpParam: number | null = null
  let curPattern = -1
  let instWritten = false
  let localVol = -1
  for (const e of final) {
    const p = Math.floor(e.row / patternLength)
    if (p !== curPattern) {
      curPattern = p
      instWritten = false
      localVol = -1
    }
    if (e.seg) {
      const s = e.seg
      const cell: Cell = { note: s.pitch }
      if (!instWritten) {
        cell.inst = instIdx
        instWritten = true
      }
      if (def.hasVolume) {
        const v = snapVolume(Math.max(1, Math.min(15, Math.round((s.vel / 127) * 15))), def)
        if (v !== localVol) {
          cell.vol = v
          localVol = v
        }
      }
      if (s.arp) {
        arpParam = (s.arp[0] << 4) | s.arp[1]
        cell.fx = [{ code: '0', param: arpParam }]
      } else if (arpParam !== null) {
        cell.fx = [{ code: '0', param: 0 }]
        arpParam = null
      }
      linear[e.row] = cell
    } else {
      const cell: Cell = { note: 'off' }
      if (arpParam !== null) {
        cell.fx = [{ code: '0', param: 0 }]
        arpParam = null
      }
      linear[e.row] = cell
    }
  }
  // arpeggios that sound across a pattern boundary must be restated at the start of the next pattern
  for (const s of segs) {
    if (!s.arp) continue
    const param = (s.arp[0] << 4) | s.arp[1]
    for (let b = (Math.floor(s.row / patternLength) + 1) * patternLength; b < s.end && b < paddedRows; b += patternLength) {
      if (!linear[b]) linear[b] = { fx: [{ code: '0', param }] }
    }
  }
  return linear
}

/** Convenience for callers that only need the kind name of a channel. */
export function channelKindOf(defs: ChannelDef[], id: string): ChannelKind | undefined {
  return defs.find((d) => d.id === id)?.kind
}
