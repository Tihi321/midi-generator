// Timeline: maps (order,row) <-> tick <-> seconds/samples by simulating the song flow (Bxx/Cxx/Dxx/Fxx,
// groove, the loop point) without rendering. It detects the loop as the first repeated
// (order,row,speed-state). Shared by the playhead, MIDI export and the WAV loop points.

import type { Song } from '../types'
import { type NextPos, newRowFlow, nextPosition, resolvePatterns, rowTicksFor, samplesPerTick, scanRowFlow } from './flow'

export interface TimelineRow {
  /** Index in `rows` (play order). */
  index: number
  order: number
  row: number
  /** Tick at which the row starts (from the start of the song). */
  startTick: number
  ticks: number
  bpm: number
  startSec: number
}

export interface SampleBoundaries {
  /** Sample index where the intro ends (= start of the first body); equals the one-shot length when there is no loop. */
  introEnd: number
  /** End sample of each simulated body pass (empty for one-shot songs). */
  bodyEnds: number[]
}

const MAX_ROWS = 200_000

export class Timeline {
  readonly rows: TimelineRow[] = []
  /** Index into `rows` where the loop body starts; -1 for a one-shot song. */
  loopIndex = -1
  totalTicks = 0
  /** Ticks before the loop (the whole song when one-shot). */
  introTicks = 0
  /** Ticks of one loop body (0 when one-shot). */
  loopTicks = 0
  introSeconds = 0
  loopSeconds = 0
  /** Why the walk stopped: a repeated state (loop), a halt/end of the song, or the safety limit. */
  stop: 'loop' | 'end' | 'limit' = 'end'
  private readonly firstIndex = new Map<number, number>()

  constructor(readonly song: Song) {
    this.build()
  }

  get isLooping(): boolean {
    return this.loopIndex >= 0
  }

  private tickSeconds(bpm: number): number {
    return samplesPerTick(this.song, bpm, 1)
  }

  private build(): void {
    const song = this.song
    if (song.orders.length === 0) return
    const patterns = resolvePatterns(song)
    const flow = newRowFlow()
    const next: NextPos = { order: 0, row: 0, end: false }
    const seen = new Map<string, number>()
    let order = 0
    let row = 0
    let speed = song.timing.speed
    let grooveOn = true
    let bpm = song.timing.bpm
    let tick = 0
    let sec = 0
    for (;;) {
      if (this.rows.length >= MAX_ROWS) {
        this.stop = 'limit'
        break
      }
      scanRowFlow(patterns[order] ?? [], row, flow)
      if (flow.speed > 0) {
        speed = flow.speed
        grooveOn = false
      }
      if (flow.bpm > 0) bpm = flow.bpm
      const key = `${order}|${row}|${speed}|${grooveOn ? 1 : 0}|${bpm}`
      const prev = seen.get(key)
      if (prev !== undefined) {
        this.loopIndex = prev
        this.stop = 'loop'
        break
      }
      const ticks = rowTicksFor(song, row, speed, grooveOn)
      const idx = this.rows.length
      seen.set(key, idx)
      this.rows.push({ index: idx, order, row, startTick: tick, ticks, bpm, startSec: sec })
      const pk = order * 65536 + row
      if (!this.firstIndex.has(pk)) this.firstIndex.set(pk, idx)
      tick += ticks
      sec += ticks * this.tickSeconds(bpm)
      nextPosition(song, order, row, flow, next)
      if (next.end) break
      order = next.order
      row = next.row
    }
    this.totalTicks = tick
    if (this.loopIndex >= 0) {
      const loopRow = this.rows[this.loopIndex]!
      this.introTicks = loopRow.startTick
      this.loopTicks = tick - loopRow.startTick
      this.introSeconds = loopRow.startSec
      this.loopSeconds = sec - loopRow.startSec
    } else {
      this.introTicks = tick
      this.introSeconds = sec
    }
  }

  /** Index of the first time (order,row) is played, or -1. */
  indexOf(order: number, row: number): number {
    return this.firstIndex.get(order * 65536 + row) ?? -1
  }

  tickAt(order: number, row: number): number {
    const i = this.indexOf(order, row)
    return i < 0 ? -1 : this.rows[i]!.startTick
  }

  /** Seconds at the start of (order,row) (+ `tick` ticks into it), first occurrence; -1 if never played. */
  secondsAt(order: number, row: number, tick = 0): number {
    const i = this.indexOf(order, row)
    if (i < 0) return -1
    const r = this.rows[i]!
    return r.startSec + tick * this.tickSeconds(r.bpm)
  }

  /** The row playing at `tick` of the first lap (the body repeats beyond the end when looping). */
  rowAtTick(tick: number): TimelineRow | undefined {
    if (this.rows.length === 0) return undefined
    let t = tick
    if (this.loopIndex >= 0 && t >= this.totalTicks && this.loopTicks > 0) {
      t = this.introTicks + ((t - this.introTicks) % this.loopTicks)
    }
    let lo = 0
    let hi = this.rows.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.rows[mid]!.startTick <= t) lo = mid
      else hi = mid - 1
    }
    return this.rows[lo]
  }

  /**
   * Sample positions of the intro end and of `bodies` consecutive loop bodies, using exactly the player's
   * per-tick accumulation (so they match what SongPlayer produces). For one-shot songs `introEnd` is the
   * length of the song and `bodyEnds` is empty.
   */
  sampleBoundaries(sampleRate: number, bodies: number): SampleBoundaries {
    let acc = 0
    const addRow = (i: number): void => {
      const r = this.rows[i]!
      const len = samplesPerTick(this.song, r.bpm, sampleRate)
      for (let t = 0; t < r.ticks; t++) acc += len
    }
    const end = this.loopIndex >= 0 ? this.loopIndex : this.rows.length
    for (let i = 0; i < end; i++) addRow(i)
    const introEnd = Math.round(acc)
    const bodyEnds: number[] = []
    if (this.loopIndex >= 0) {
      for (let b = 0; b < bodies; b++) {
        for (let i = this.loopIndex; i < this.rows.length; i++) addRow(i)
        bodyEnds.push(Math.round(acc))
      }
    }
    return { introEnd, bodyEnds }
  }
}

export function buildTimeline(song: Song): Timeline {
  return new Timeline(song)
}
