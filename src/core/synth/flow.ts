// Song access and playback flow (Bxx / Cxx / Dxx / Fxx / groove), shared by the sequencer and the timeline.
// Kept private to the synth so it does not depend on model.ts.

import type { Cell, Pattern, Song } from '../types'

/** orders x channels -> pattern (or null when empty/missing). */
export function resolvePatterns(song: Song): (Pattern | null)[][] {
  const out: (Pattern | null)[][] = []
  for (const orderRow of song.orders) {
    const row: (Pattern | null)[] = []
    for (let c = 0; c < song.channels.length; c++) {
      const id = song.channels[c]!.id
      const n = orderRow[c]
      row.push(n === undefined ? null : (song.patterns.get(`${id}:${n}`) ?? null))
    }
    out.push(row)
  }
  return out
}

export interface RowFlow {
  /** Bxx target order, -1 = none. */
  jump: number
  /** Dxx row in the next order, -1 = none. */
  breakRow: number
  halt: boolean
  /** Fxx speed (1..31), 0 = none. */
  speed: number
  /** Fxx BPM (>= 32), 0 = none. */
  bpm: number
}

export function newRowFlow(): RowFlow {
  return { jump: -1, breakRow: -1, halt: false, speed: 0, bpm: 0 }
}

/** Scan one row of all channels for flow effects (later channels / columns win). */
export function scanRowFlow(patterns: readonly (Pattern | null)[], row: number, out: RowFlow): RowFlow {
  out.jump = -1
  out.breakRow = -1
  out.halt = false
  out.speed = 0
  out.bpm = 0
  for (let c = 0; c < patterns.length; c++) {
    const cell: Cell | null | undefined = patterns[c]?.rows[row]
    const fx = cell?.fx
    if (!fx) continue
    for (let i = 0; i < fx.length; i++) {
      const e = fx[i]!
      switch (e.code) {
        case 'B':
          out.jump = e.param
          break
        case 'C':
          out.halt = true
          break
        case 'D':
          out.breakRow = e.param
          break
        case 'F':
          if (e.param >= 0x20) out.bpm = e.param
          else if (e.param > 0) out.speed = e.param
          break
      }
    }
  }
  return out
}

export interface NextPos {
  order: number
  row: number
  end: boolean
}

/** Position after finishing (order,row), following B/C/D, the pattern length, the loop point or the end. */
export function nextPosition(song: Song, order: number, row: number, flow: RowFlow, out: NextPos): NextPos {
  out.end = false
  if (flow.halt) {
    out.end = true
    return out
  }
  const patLen = song.patternLength
  let nOrder = order
  let nRow = row + 1
  if (flow.jump >= 0) {
    nOrder = flow.jump
    nRow = flow.breakRow >= 0 ? flow.breakRow : 0
  } else if (flow.breakRow >= 0) {
    nOrder = order + 1
    nRow = flow.breakRow
  } else if (nRow >= patLen) {
    nOrder = order + 1
    nRow = 0
  }
  if (nOrder >= song.orders.length) {
    if (song.loop && song.loop.order < song.orders.length) nOrder = Math.max(0, song.loop.order)
    else {
      out.end = true
      return out
    }
  }
  if (nRow >= patLen) nRow = patLen - 1
  out.order = nOrder
  out.row = nRow
  return out
}

/** Ticks of a row given the speed state. */
export function rowTicksFor(song: Song, row: number, speed: number, grooveOn: boolean): number {
  const g = song.timing.groove
  if (grooveOn && g && g.length > 0) return Math.max(1, Math.round(g[row % g.length]!))
  return Math.max(1, Math.round(speed))
}

/** Samples per tick at `bpm`: tickHz = bpm * rowsPerBeat * baseSpeed / 60. */
export function samplesPerTick(song: Song, bpm: number, sampleRate: number): number {
  const t = song.timing
  return (sampleRate * 60) / (Math.max(1, bpm) * Math.max(1, t.rowsPerBeat) * Math.max(1, t.speed))
}
