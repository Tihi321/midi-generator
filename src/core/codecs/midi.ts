// Song -> Standard MIDI File (type 1, 480 PPQ). The timing comes from the shared timeline (Bxx/Dxx/Fxx/groove/loop),
// so the MIDI plays at the same speed as the audio. Import lives in midiImport.ts (re-exported here).
//
// Layout
//  - track 0: tempo map (FF51), time signature (FF58), key signature (FF59), an "order N" marker per order row,
//    "loopStart"/"loopEnd" markers and CC111 at the loop start (RPG Maker convention) when the song loops.
//  - one track per channel with notes: track name, program change (gmMap), RPN 0 pitch-bend range of +-12 semitones,
//    notes, CC11 expression for volume changes under a held note, pitch bend for slides/portamento/vibrato/note slides.
//  - noise, DPCM, DAC and drum-role instruments become GM percussion on MIDI channel 10 (one extra track per channel).
//  - MIDI has 15 melodic channels (1-9, 11-16). Songs with more melodic channels (PS1 and Dreamcast with 24 to 64 voices)
//    share them by GM program (see shareMelodicChannels).
//
// Not exported: instrument macros (envelopes, pitch macros), tremolo, duty/timbre and echo effects, Pxx fine pitch.

import type { Cell, ChannelState, Instrument, Song } from '../types'
import { buildTimeline } from '../synth/timeline'
import { songChannelDefs } from '../chips'
import { gmDrumNoteFor, gmProgramFor } from './gmMap'
import {
  META_MARKER,
  META_TRACK_NAME,
  MIDI_PPQ,
  type MidiEvent,
  encodeSmf,
  metaKeySignature,
  metaTempo,
  metaText,
  metaTimeSignature
} from './midiFile'

export { MIDI_PPQ } from './midiFile'
export { importMidi, parseMidi, type MidiImportOptions, type MidiImportResult } from './midiImport'

export type ArpMode = 'notes' | 'chord' | 'ignore'

export interface MidiExportOptions {
  /** 0xy arpeggios: 'notes' = fast notes like the chip plays them (default), 'chord' = the tones sound together, 'ignore' = base note only. */
  arpMode?: ArpMode
  /** Times the loop body is present after the intro (default 1; a one-shot song ignores it). */
  loops?: number
}

export interface MidiExport {
  data: Uint8Array
  /** Number of tracks in the file (including the tempo track). */
  tracks: number
  notes: number
  /** Length in MIDI ticks and in seconds. */
  ticks: number
  seconds: number
  loop?: { startTick: number; endTick: number }
  tempoChanges: number
  trackNames: string[]
  /** Only when the song has more melodic channels than MIDI has: the tracks that were merged onto another track's MIDI channel. */
  merged?: { track: string; into: string; midiChannel: number; sameProgram: boolean }[]
}

// Pitch class (sharp spelling) -> sharps (+) / flats (-) of the major key with that tonic.
const MAJOR_SHARPS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]
const MINOR_SCALES = new Set(['minor', 'dorian', 'phrygian', 'locrian', 'harmonic-minor', 'melodic-minor', 'minor-pentatonic', 'blues'])
const PC_INDEX: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }

/** Key signature (sharps count, minor flag) for the song's key and scale. */
export function keySignatureFor(key: string, scale: string): { sharps: number; minor: boolean } {
  const tonic = PC_INDEX[key] ?? 0
  const minor = MINOR_SCALES.has(scale)
  return { sharps: minor ? MAJOR_SHARPS[(tonic + 3) % 12]! : MAJOR_SHARPS[tonic]!, minor }
}

const PRI_OFF = 0
const PRI_CTRL = 1
const PRI_ON = 2

interface Timed {
  tick: number
  pri: number
  seq: number
  ev: MidiEvent
}

interface NoteRec {
  start: number
  end: number
  pitch: number
  vel: number
  drum: boolean
  inst: number
}

interface CtrlRec {
  tick: number
  kind: 'expr' | 'bend' | 'pan'
  value: number
}

const volToVel = (vol: number): number => Math.max(1, Math.min(127, Math.round((vol * 127) / 15)))
const DRUM_MAX_TICKS = MIDI_PPQ / 4
const BEND_STEP = 24

interface RowInfo {
  order: number
  row: number
  ticks: number
  /** MIDI tick at the start of the row (rounded) and its exact length. */
  start: number
  len: number
  bpm: number
}

/** The 15 melodic MIDI channels (0-based; channel 10 is the drum channel). */
const MELODIC_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]

export interface SharedChannel {
  /** 0-based MIDI channel. */
  midiCh: number
  /** A guest plays on the MIDI channel of an earlier track: it writes notes only (no program change, setup or controllers), so it does not disturb its host. */
  guest: boolean
  /** Index (in the melodic list) of the track that owns the MIDI channel. */
  host: number
}

/**
 * Give every melodic track a MIDI channel. Up to 15 tracks get their own, in order (0-8, 10-15): the plain layout, so
 * exports stay byte-identical. With more tracks, MIDI channels are shared by GM program: each distinct program gets a
 * channel of its own first (in order of first use, while that is possible), spare channels go to the next tracks in song
 * order, and the rest become guests on the channel with the same program that has the fewest notes. When there are more
 * programs than channels, a guest goes onto the least-used channel whatever its program is (it follows that channel's program).
 */
export function shareMelodicChannels(programs: number[], notes: number[]): SharedChannel[] {
  if (programs.length <= MELODIC_SLOTS.length) return programs.map((_, i) => ({ midiCh: MELODIC_SLOTS[i]!, guest: false, host: i }))
  const first = new Map<number, number>()
  programs.forEach((p, i) => {
    if (!first.has(p)) first.set(p, i)
  })
  const load: number[] = [] // notes per slot in use
  const hostOf: number[] = [] // melodic index owning each slot in use
  const slotProgram: number[] = []
  const out: SharedChannel[] = []
  const fewest = (slots: number[]): number => slots.reduce((best, s) => (load[s]! < load[best]! ? s : best), slots[0]!)
  programs.forEach((p, i) => {
    const free = MELODIC_SLOTS.length - load.length
    const reserved = [...first.values()].filter((at) => at > i).length // programs still to appear need a slot each
    let slot: number
    let guest = true
    const same = load.map((_, s) => s).filter((s) => slotProgram[s] === p)
    if (same.length === 0 ? free > 0 : free > reserved) {
      slot = load.length
      load.push(0)
      hostOf.push(i)
      slotProgram.push(p)
      guest = false
    } else slot = fewest(same.length > 0 ? same : load.map((_, s) => s))
    load[slot]! += notes[i]!
    out.push({ midiCh: MELODIC_SLOTS[slot]!, guest, host: hostOf[slot]! })
  })
  return out
}

/** Convert a song to a Standard MIDI File. */
export function exportMidi(song: Song, opts: MidiExportOptions = {}): MidiExport {
  const arpMode: ArpMode = opts.arpMode ?? 'notes'
  const loops = Math.max(1, Math.min(32, Math.floor(opts.loops ?? 1)))
  const tl = buildTimeline(song)
  const baseSpeed = Math.max(1, song.timing.speed)
  const rpb = Math.max(1, song.timing.rowsPerBeat)
  const nominal = MIDI_PPQ / rpb
  const groove = song.timing.groove && song.timing.groove.length > 0 ? song.timing.groove : undefined

  // ---- rows: the timeline's intro + one body, plus extra bodies for `loops`
  const src = [...tl.rows]
  const bodyStart = tl.loopIndex
  if (tl.isLooping && loops > 1) {
    const body = tl.rows.slice(bodyStart)
    for (let i = 1; i < loops; i++) src.push(...body)
  }
  const rows: RowInfo[] = []
  let frac = 0
  const tempoAt: { tick: number; us: number }[] = []
  let loopStartTick = -1
  for (let i = 0; i < src.length; i++) {
    const r = src[i]!
    const grooveTicks = groove ? Math.max(1, Math.round(groove[r.row % groove.length]!)) : -1
    const proportional = groove !== undefined && r.ticks === grooveTicks
    const len = proportional ? (nominal * r.ticks) / baseSpeed : nominal
    const bpm = proportional ? r.bpm : (r.bpm * baseSpeed) / r.ticks
    const start = Math.round(frac)
    if (i === bodyStart && tl.isLooping) loopStartTick = start
    rows.push({ order: r.order, row: r.row, ticks: r.ticks, start, len, bpm })
    const us = Math.round(60_000_000 / Math.max(1, bpm))
    if (tempoAt.length === 0 || tempoAt[tempoAt.length - 1]!.us !== us) tempoAt.push({ tick: start, us })
    frac += len
  }
  const endTick = Math.round(frac)
  const rowTick = (r: RowInfo, t: number): number => Math.round(r.start + (t / r.ticks) * r.len)

  // ---- conductor track
  const conductor: Timed[] = []
  let seq = 0
  const add = (list: Timed[], tick: number, pri: number, ev: MidiEvent): void => {
    list.push({ tick, pri, seq: seq++, ev: { ...ev, tick } as MidiEvent })
  }
  add(conductor, 0, PRI_CTRL, metaText(0, META_TRACK_NAME, song.name || 'Chiptune Studio song'))
  if (tempoAt.length === 0) tempoAt.push({ tick: 0, us: Math.round(60_000_000 / Math.max(1, song.timing.bpm)) })
  for (const t of tempoAt) add(conductor, t.tick, PRI_CTRL, metaTempo(t.tick, t.us))
  add(conductor, 0, PRI_CTRL, metaTimeSignature(0, song.timing.beatsPerBar, 2))
  const ks = keySignatureFor(song.meta.key, song.meta.scale)
  add(conductor, 0, PRI_CTRL, metaKeySignature(0, ks.sharps, ks.minor))
  for (const r of rows) if (r.row === 0) add(conductor, r.start, PRI_CTRL, metaText(r.start, META_MARKER, `order ${r.order}`))
  let loop: MidiExport['loop']
  if (tl.isLooping && loopStartTick >= 0) {
    loop = { startTick: loopStartTick, endTick }
    add(conductor, loopStartTick, PRI_CTRL, metaText(loopStartTick, META_MARKER, 'loopStart'))
    add(conductor, loopStartTick, PRI_CTRL, { tick: loopStartTick, kind: 'cc', channel: 0, controller: 111, value: 0 })
    add(conductor, endTick, PRI_CTRL, metaText(endTick, META_MARKER, 'loopEnd'))
  }
  conductor.push({ tick: endTick, pri: 9, seq: seq++, ev: { tick: endTick, kind: 'meta', type: 0x2f, data: new Uint8Array(0) } })

  // ---- channels
  const defs = songChannelDefs(song)
  const trackLists: { name: string; drum: boolean; list: Timed[]; channelIndex: number }[] = []
  let noteCount = 0
  const sims = song.channels.map((chan, ci) => {
    const def = defs.find((d) => d.id === chan.id)
    const sim = simulateChannel(song, chan, ci, rows, rowTick, endTick, arpMode, def?.kind)
    const melodic = sim.notes.filter((n) => !n.drum)
    const mean = melodic.length > 0 ? melodic.reduce((a, n) => a + n.pitch, 0) / melodic.length : 0
    return { sim, melodic, drums: sim.notes.filter((n) => n.drum), mean }
  })

  // the melodic tracks (in channel order) and their MIDI channels
  const melodicAt = sims.flatMap((s, ci) => (s.melodic.length > 0 ? [ci] : []))
  const programOf = (ci: number): number => gmProgramFor(song.instruments[sims[ci]!.melodic[0]!.inst], sims[ci]!.mean)
  const shared = shareMelodicChannels(melodicAt.map(programOf), melodicAt.map((ci) => sims[ci]!.melodic.length))
  const merged: NonNullable<MidiExport['merged']> = []

  song.channels.forEach((chan, ci) => {
    const { sim, melodic, drums, mean } = sims[ci]!
    if (sim.notes.length === 0) return
    if (melodic.length > 0) {
      const slot = shared[melodicAt.indexOf(ci)]!
      const midiCh = slot.midiCh
      const list: Timed[] = []
      add(list, 0, PRI_CTRL, metaText(0, META_TRACK_NAME, chan.name || chan.id))
      const cc = (tick: number, controller: number, value: number): void => {
        add(list, tick, PRI_CTRL, { tick, kind: 'cc', channel: midiCh, controller, value: Math.max(0, Math.min(127, Math.round(value))) })
      }
      if (!slot.guest) {
        cc(0, 7, 100)
        cc(0, 10, Math.round(64 + (chan.pan ?? 0) * 63))
        cc(0, 101, 0)
        cc(0, 100, 0)
        cc(0, 6, 12) // RPN 0: pitch bend range +-12 semitones
        cc(0, 38, 0)
        cc(0, 101, 127)
        cc(0, 100, 127)
      }
      let program = -1
      for (const n of melodic) {
        const p = gmProgramFor(song.instruments[n.inst], mean)
        if (p !== program) {
          program = p
          if (!slot.guest) add(list, n.start, PRI_CTRL, { tick: n.start, kind: 'program', channel: midiCh, program: p })
        }
        add(list, n.start, PRI_ON, { tick: n.start, kind: 'noteOn', channel: midiCh, note: n.pitch, velocity: n.vel })
        add(list, n.end, PRI_OFF, { tick: n.end, kind: 'noteOff', channel: midiCh, note: n.pitch, velocity: 0 })
        noteCount++
      }
      if (!slot.guest) {
        for (const c of sim.ctrls) {
          if (c.kind === 'bend') add(list, c.tick, PRI_CTRL, { tick: c.tick, kind: 'pitchBend', channel: midiCh, value: c.value })
          else if (c.kind === 'expr') cc(c.tick, 11, c.value)
          else cc(c.tick, 10, c.value)
        }
      } else {
        const hostCi = melodicAt[slot.host]!
        const host = song.channels[hostCi]!
        merged.push({ track: chan.name || chan.id, into: host.name || host.id, midiChannel: midiCh + 1, sameProgram: programOf(ci) === programOf(hostCi) })
      }
      list.push({ tick: endTick, pri: 9, seq: seq++, ev: { tick: endTick, kind: 'meta', type: 0x2f, data: new Uint8Array(0) } })
      trackLists.push({ name: chan.name || chan.id, drum: false, list, channelIndex: ci })
    }
    if (drums.length > 0) {
      const list: Timed[] = []
      const name = `${chan.name || chan.id}${melodic.length > 0 ? ' (drums)' : ''}`
      add(list, 0, PRI_CTRL, metaText(0, META_TRACK_NAME, name))
      for (const n of drums) {
        add(list, n.start, PRI_ON, { tick: n.start, kind: 'noteOn', channel: 9, note: n.pitch, velocity: n.vel })
        add(list, n.end, PRI_OFF, { tick: n.end, kind: 'noteOff', channel: 9, note: n.pitch, velocity: 0 })
        noteCount++
      }
      list.push({ tick: endTick, pri: 9, seq: seq++, ev: { tick: endTick, kind: 'meta', type: 0x2f, data: new Uint8Array(0) } })
      trackLists.push({ name, drum: true, list, channelIndex: ci })
    }
  })

  const sortTrack = (list: Timed[]): MidiEvent[] =>
    list.sort((a, b) => a.tick - b.tick || a.pri - b.pri || a.seq - b.seq).map((t) => t.ev)
  const tracks: MidiEvent[][] = [sortTrack(conductor), ...trackLists.map((t) => sortTrack(t.list))]
  const data = encodeSmf(tracks, MIDI_PPQ)
  let seconds = 0
  for (let i = 0; i < tempoAt.length; i++) {
    const from = tempoAt[i]!.tick
    const to = i + 1 < tempoAt.length ? tempoAt[i + 1]!.tick : endTick
    seconds += ((to - from) / MIDI_PPQ) * (tempoAt[i]!.us / 1_000_000)
  }
  return {
    data,
    tracks: tracks.length,
    notes: noteCount,
    ticks: endTick,
    seconds,
    ...(loop ? { loop } : {}),
    tempoChanges: Math.max(0, tempoAt.length - 1),
    trackNames: trackLists.map((t) => t.name),
    ...(merged.length > 0 ? { merged } : {})
  }
}

/** The .mid bytes of a song. */
export function writeMidi(song: Song, opts: MidiExportOptions = {}): Uint8Array {
  return exportMidi(song, opts).data
}

// ---------------------------------------------------------------- channel simulation

interface Sim {
  notes: NoteRec[]
  ctrls: CtrlRec[]
}

function simulateChannel(
  song: Song,
  chan: ChannelState,
  ci: number,
  rows: RowInfo[],
  rowTick: (r: RowInfo, t: number) => number,
  endTick: number,
  arpMode: ArpMode,
  kind: ChannelState['kind'] | undefined
): Sim {
  const notes: NoteRec[] = []
  const ctrls: CtrlRec[] = []
  const channelKind = kind ?? chan.kind
  const open = new Map<number, NoteRec>()

  let inst = -1
  let vol = 15
  let trigVol = 15
  let gate = false
  let base = 60
  let drumNow = false
  let drumNote = 38
  let arpX = 0
  let arpY = 0
  let slide = 0 // semitones per tick
  let portaRate = 0
  let portaTarget = Number.NaN
  let vibSpeed = 0
  let vibDepth = 0
  let vibPhase = 0
  let volSlide = 0
  let qrTarget = Number.NaN
  let qrRate = 0
  let pitchOff = 0 // accumulated slide / portamento / note slide, semitones
  let bendCur = 8192
  let exprCur = 127
  let panCur = -1
  let volF = 15

  const closeNote = (n: NoteRec, tick: number): void => {
    n.end = n.drum ? Math.min(Math.max(tick, n.start + 1), n.start + DRUM_MAX_TICKS) : tick
    if (n.end > n.start) notes.push(n)
  }
  const closeAll = (tick: number): void => {
    for (const n of open.values()) closeNote(n, tick)
    open.clear()
  }
  const reconcile = (desired: number[], tick: number): void => {
    for (const [p, n] of [...open]) {
      if (!desired.includes(p)) {
        closeNote(n, tick)
        open.delete(p)
      }
    }
    for (const p of desired) {
      if (open.has(p)) continue
      if (trigVol <= 0) continue
      open.set(p, { start: tick, end: tick, pitch: p, vel: volToVel(trigVol), drum: drumNow, inst })
    }
  }
  const desiredSet = (t: number): number[] => {
    if (drumNow) return [drumNote]
    const arpOn = arpX !== 0 || arpY !== 0
    if (!arpOn || arpMode === 'ignore') return [clampNote(base)]
    if (arpMode === 'chord') return [...new Set([base, base + arpX, base + arpY].map(clampNote))]
    return [clampNote(base + [0, arpX, arpY][t % 3]!)]
  }
  const emitBend = (tick: number, semis: number, force = false): void => {
    if (drumNow) return
    const clamped = Math.max(-12, Math.min(12, semis))
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (clamped / 12) * 8192)))
    if (force ? v === bendCur : Math.abs(v - bendCur) < BEND_STEP) return
    bendCur = v
    ctrls.push({ tick, kind: 'bend', value: v })
  }
  const emitExpr = (tick: number, value: number): void => {
    const v = Math.max(0, Math.min(127, Math.round(value)))
    if (Math.abs(v - exprCur) < 2 && v !== 127 && v !== 0) return
    if (v === exprCur) return
    exprCur = v
    ctrls.push({ tick, kind: 'expr', value: v })
  }

  const rowCount = rows.length
  for (let ri = 0; ri < rowCount; ri++) {
    const row = rows[ri]!
    const n = song.orders[row.order]?.[ci]
    const pat = n === undefined ? undefined : song.patterns.get(`${chan.id}:${n}`)
    const cell: Cell | null = pat?.rows[row.row] ?? null
    const ticks = row.ticks
    const fx = cell?.fx
    const note = cell?.note
    const hasNote = typeof note === 'number'
    let portaParam = portaRate * 16
    if (fx) for (const e of fx) if (e.code === '3') portaParam = e.param
    const legato = hasNote && portaParam > 0 && gate
    let delay = -1
    let cut = -1
    let qrDir = 0
    let qrX = 0
    let qrY = 0
    if (hasNote && !legato) {
      slide = 0
      qrTarget = Number.NaN
      portaTarget = Number.NaN
    }
    if (fx) {
      for (const e of fx) {
        const p = e.param
        switch (e.code) {
          case '0':
            arpX = p >> 4
            arpY = p & 15
            break
          case '1':
            slide = p / 16
            break
          case '2':
            slide = -p / 16
            break
          case '3':
            portaRate = p / 16
            if (p === 0) portaTarget = Number.NaN
            break
          case '4':
            vibSpeed = p >> 4
            vibDepth = p & 15
            break
          case 'A':
            volSlide = ((p >> 4) - (p & 15)) / 4
            break
          case 'G':
            delay = p
            break
          case 'S':
            cut = p
            break
          case 'Q':
            qrDir = 1
            qrX = p >> 4
            qrY = p & 15
            break
          case 'R':
            qrDir = -1
            qrX = p >> 4
            qrY = p & 15
            break
          case 'X': {
            const pan = Math.round((p / 255) * 127)
            if (pan !== panCur) {
              panCur = pan
              ctrls.push({ tick: row.start, kind: 'pan', value: pan })
            }
            break
          }
          default:
            break
        }
      }
    }

    // the row's note action: when (in ticks) a new note starts, or a release/off at tick 0
    let noteTick = -1
    if (hasNote) {
      if (legato) {
        portaTarget = note
      } else if (delay > 0 && delay >= ticks) {
        noteTick = -1 // delayed past the end of the row: never plays
      } else {
        noteTick = delay > 0 ? delay : 0
      }
    } else if (note === 'off' || note === 'rel') {
      closeAll(row.start)
      gate = false
    }
    if (cell && !hasNote) {
      if (cell.inst !== undefined) inst = cell.inst
      if (cell.vol !== undefined) {
        vol = cell.vol
        volF = vol
        if (gate && !drumNow && trigVol > 0) emitExpr(row.start, (127 * vol) / trigVol)
      }
    }
    if (qrDir !== 0 && gate && noteTick < 0) {
      qrTarget = pitchOff + qrDir * qrY
      qrRate = (2 * qrX + 1) / 16
    }

    for (let t = 0; t < ticks; t++) {
      const mt = rowTick(row, t)
      if (t === noteTick && hasNote) {
        // trigger
        closeAll(mt)
        if (cell!.inst !== undefined) inst = cell!.inst
        if (cell!.vol !== undefined) vol = cell!.vol
        volF = vol
        trigVol = vol
        base = note
        gate = true
        pitchOff = 0
        vibPhase = 0
        const instrument: Instrument | undefined = song.instruments[inst]
        const dn = gmDrumNoteFor(instrument, channelKind, note)
        drumNow = dn !== undefined
        if (dn !== undefined) drumNote = dn
        if (!drumNow && bendCur !== 8192) emitBend(mt, 0, true)
        if (exprCur !== 127) {
          exprCur = 127
          ctrls.push({ tick: mt, kind: 'expr', value: 127 })
        }
        if (qrDir !== 0) {
          qrTarget = qrDir * qrY
          qrRate = (2 * qrX + 1) / 16
        }
        reconcile(desiredSet(t), mt)
      }
      if (cut >= 0 && t === cut) {
        closeAll(mt)
        gate = false
      }
      if (!gate) continue
      // per-tick evolution (everything except tick 0 of the row, like the sequencer)
      if (t > 0) {
        pitchOff += slide
        if (!Number.isNaN(portaTarget)) {
          const target = portaTarget - base
          const step = portaRate
          if (pitchOff < target) pitchOff = Math.min(target, pitchOff + step)
          else if (pitchOff > target) pitchOff = Math.max(target, pitchOff - step)
        }
        if (!Number.isNaN(qrTarget) && qrRate > 0) {
          if (pitchOff < qrTarget) pitchOff = Math.min(qrTarget, pitchOff + qrRate)
          else if (pitchOff > qrTarget) pitchOff = Math.max(qrTarget, pitchOff - qrRate)
        }
        if (volSlide !== 0) {
          volF = Math.max(0, Math.min(15, volF + volSlide))
          if (!drumNow && trigVol > 0) emitExpr(mt, (127 * volF) / trigVol)
        }
      }
      let vib = 0
      if (vibSpeed > 0 && vibDepth > 0) {
        vib = Math.sin((2 * Math.PI * vibPhase) / 64) * (vibDepth / 16)
        vibPhase = (vibPhase + vibSpeed) % 64
      }
      if (!drumNow) {
        reconcile(desiredSet(t), mt)
        emitBend(mt, pitchOff + vib)
      }
    }
  }
  closeAll(endTick)
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return { notes, ctrls }
}

function clampNote(n: number): number {
  return Math.max(0, Math.min(127, Math.round(n)))
}
