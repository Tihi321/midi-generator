import { describe, expect, it } from 'vitest'
import { Sequencer, type ChannelControl } from '../../../src/core/synth/sequencer'
import { buildTimeline } from '../../../src/core/synth/timeline'
import type { Instrument, Macros, Song } from '../../../src/core/types'
import { makeSong, put } from './fixtures'

function record(song: Song, ticks: number, ch = 0): ChannelControl[] {
  const seq = new Sequencer(song)
  const out: ChannelControl[] = []
  for (let i = 0; i < ticks; i++) {
    if (!seq.tick()) break
    out.push({ ...seq.controls[ch]! })
  }
  return out
}

const near = (a: number, b: number, eps = 1e-9): void => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('sequencer effects', () => {
  it('047 arpeggio at speed 6 gives C,E,G,C,E,G', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '0', param: 0x47 }] })
    const c = record(s, 6)
    expect(c.map((x) => Math.round(x.semis))).toEqual([60, 64, 67, 60, 64, 67])
    expect(c[0]!.trigger).toBe(true)
    expect(c.slice(1).every((x) => !x.trigger)).toBe(true)
  })

  it('1xx / 2xx slide xx/16 semitone per tick (not on tick 0)', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '1', param: 0x10 }] })
    const up = record(s, 6).map((x) => x.semis)
    up.forEach((v, t) => near(v, 60 + t))
    const d = makeSong('nes')
    put(d, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '2', param: 0x08 }] })
    record(d, 6).forEach((x, t) => near(x.semis, 60 - t * 0.5))
  })

  it('slides continue on following rows until 100 and a new note resets them', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '1', param: 0x10 }] })
    put(s, 'P1', 0, 1, { fx: [{ code: '1', param: 0 }] })
    put(s, 'P1', 0, 2, { note: 62 })
    const c = record(s, 18)
    near(c[5]!.semis, 65)
    near(c[6]!.semis, 65) // slide stopped by 100, tick 6 = row 1 tick 0
    near(c[11]!.semis, 65)
    near(c[12]!.semis, 62)
  })

  it('3xx portamento glides without retriggering and stops at the target', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    put(s, 'P1', 0, 1, { note: 67, fx: [{ code: '3', param: 0x20 }] })
    const c = record(s, 12)
    expect(c[6]!.trigger).toBe(false)
    expect(c.slice(6, 12).map((x) => x.semis)).toEqual([60, 62, 64, 66, 67, 67])
    expect(c[7]!.gate).toBe(true)
  })

  it('4xy vibrato swings +-y/16 semitone', () => {
    const amp = (param: number): number => {
      const s = makeSong('nes')
      put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '4', param }] })
      const c = record(s, 48)
      return Math.max(...c.map((x) => x.semis - 60))
    }
    near(amp(0x48), 0.5, 0.02)
    near(amp(0x44), 0.25, 0.02)
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: '4', param: 0x48 }] })
    const c = record(s, 48)
    near(c[0]!.semis, 60)
    expect(Math.min(...c.map((x) => x.semis))).toBeCloseTo(59.5, 1)
  })

  it('Gxx delays the note by xx ticks, dropping it when xx >= ticks per row', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: 'G', param: 3 }] })
    const c = record(s, 6)
    expect(c.map((x) => x.trigger)).toEqual([false, false, false, true, false, false])
    expect(c.map((x) => x.gate)).toEqual([false, false, false, true, true, true])
    const d = makeSong('nes')
    put(d, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: 'G', param: 6 }] })
    expect(record(d, 6).some((x) => x.gate)).toBe(false)
  })

  it('Sxx cuts the note after xx ticks', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: 'S', param: 2 }] })
    const c = record(s, 6)
    expect(c.map((x) => x.gate)).toEqual([true, true, false, false, false, false])
    expect(c[2]!.vol).toBe(0)
    expect(c[2]!.release).toBe(false)
  })

  it('Axy volume slide and cell volume', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, vol: 8 })
    put(s, 'P1', 0, 1, { fx: [{ code: 'A', param: 0x40 }] })
    const c = record(s, 12)
    near(c[0]!.rawVol, 8 / 15)
    near(c[6]!.rawVol, 8 / 15)
    near(c[7]!.rawVol, 9 / 15) // +1 per tick for A40
    near(c[11]!.rawVol, 13 / 15)
    const d = makeSong('nes')
    put(d, 'P1', 0, 0, { note: 60, inst: 0, vol: 15, fx: [{ code: 'A', param: 0x04 }] })
    const v = record(d, 6).map((x) => x.vol)
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeLessThan(v[i - 1]! + 1e-12)
    near(v[5]!, 10 / 15)
  })

  it('7xy tremolo modulates the volume', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, vol: 15, fx: [{ code: '7', param: 0x4f }] })
    const v = record(s, 48).map((x) => x.vol)
    expect(Math.max(...v)).toBeCloseTo(1, 5)
    expect(Math.min(...v)).toBeLessThan(0.1)
  })

  it('Pxx fine pitch, Qxy / Rxy note slides, Wxx timbre, Xxx pan, Exx echo', () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0, fx: [{ code: 'P', param: 0xc0 }, { code: 'W', param: 2 }] })
    put(s, 'P1', 0, 1, { note: 60, fx: [{ code: 'Q', param: 0xf4 }, { code: 'X', param: 0xff }, { code: 'E', param: 1 }] })
    put(s, 'P1', 0, 2, { note: 70, fx: [{ code: 'R', param: 0x72 }, { code: 'P', param: 0x80 }] })
    const c = record(s, 18)
    near(c[0]!.semis, 60.5)
    expect(c[0]!.timbre).toBe(2)
    near(c[0]!.pan, 0)
    // row 1: Qf4: 31/16 semitone per tick up to +4
    near(c[7]!.semis, 60.5 + 31 / 16)
    near(c[8]!.semis, 60.5 + 62 / 16)
    near(c[9]!.semis, 64.5)
    near(c[11]!.semis, 64.5)
    expect(c[11]!.pan).toBeGreaterThan(0.98)
    expect(c[11]!.echo).toBe(true)
    // row 2: R: 15/16 per tick down 2
    near(c[12]!.semis, 70)
    near(c[13]!.semis, 70 - 15 / 16)
    near(c[14]!.semis, 70 - 30 / 16)
    near(c[15]!.semis, 68)
    near(c[17]!.semis, 68)
  })

  it('groove alternates row lengths', () => {
    const s = makeSong('nes', { groove: [7, 5] })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    const seq = new Sequencer(s)
    const rows: number[] = []
    for (let i = 0; i < 24; i++) {
      seq.tick()
      rows.push(seq.position().row)
    }
    expect(rows.slice(0, 7).every((r) => r === 0)).toBe(true)
    expect(rows.slice(7, 12).every((r) => r === 1)).toBe(true)
    expect(rows.slice(12, 19).every((r) => r === 2)).toBe(true)
    expect(rows[19]).toBe(3)
  })

  it("Fxx changes speed (and drops the groove)", () => {
    const s = makeSong('nes', { groove: [7, 5] })
    put(s, 'P1', 0, 1, { fx: [{ code: 'F', param: 3 }] })
    const seq = new Sequencer(s)
    const rows: number[] = []
    for (let i = 0; i < 20; i++) {
      seq.tick()
      rows.push(seq.position().row)
    }
    // row 0 = 7 ticks (groove), then speed 3 for every row
    expect(rows.slice(0, 7).every((r) => r === 0)).toBe(true)
    expect(rows.slice(7, 10)).toEqual([1, 1, 1])
    expect(rows.slice(10, 13)).toEqual([2, 2, 2])
  })
})

describe('macros and note-off', () => {
  const inst = (macros: Macros): Instrument => ({ kind: 'nes-pulse', name: 'm', macros })

  it('volume macro loops from the loop point', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({ vol: { values: [15, 12, 9, 6], loop: 2 } })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    const v = record(s, 8).map((x) => Math.round(x.vol * 15))
    expect(v).toEqual([15, 12, 9, 6, 9, 6, 9, 6])
  })

  it('without a loop the last value is held', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({ vol: { values: [15, 8, 4] } })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    expect(record(s, 6).map((x) => Math.round(x.vol * 15))).toEqual([15, 8, 4, 4, 4, 4])
  })

  it('release point: held at the release point until ^^^, then the tail plays', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({ vol: { values: [15, 12, 9, 6, 3, 0], release: 4 } })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    put(s, 'P1', 0, 1, { note: 'rel' })
    const c = record(s, 14)
    expect(c.slice(0, 6).map((x) => Math.round(x.vol * 15))).toEqual([15, 12, 9, 6, 6, 6]) // held at idx 3
    expect(c[6]!.gate).toBe(false)
    expect(c[6]!.release).toBe(true)
    expect(c.slice(6, 10).map((x) => Math.round(x.vol * 15))).toEqual([3, 0, 0, 0])
  })

  it("'off' is silent immediately, 'rel' without a release macro silences with release=true", () => {
    const s = makeSong('nes')
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    put(s, 'P1', 0, 1, { note: 'off' })
    put(s, 'P1', 0, 2, { note: 62 })
    put(s, 'P1', 0, 3, { note: 'rel' })
    const c = record(s, 24)
    expect(c[5]!.gate).toBe(true)
    expect(c[6]).toMatchObject({ gate: false, release: false, vol: 0 })
    expect(c[12]!.trigger).toBe(true)
    expect(c[18]).toMatchObject({ gate: false, release: true, vol: 0 })
  })

  it('release makes arp / timbre macros jump to their release point', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({
      vol: { values: [15, 15, 15, 15], release: 2 },
      arp: { values: [0, 7, 12, 5], release: 2 }
    })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    put(s, 'P1', 0, 1, { note: 'rel' })
    const c = record(s, 9)
    expect(c.slice(0, 6).map((x) => x.semis)).toEqual([60, 67, 67, 67, 67, 67])
    expect(c[6]!.semis).toBe(72)
    expect(c[7]!.semis).toBe(65)
    expect(c[6]!.vol).toBeGreaterThan(0)
  })

  it('fixed arp macros give absolute notes; pitch macro accumulates 1/16 semitone per tick', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({ arp: { values: [72, 60], mode: 'fixed' } })
    s.instruments[1] = inst({ pitch: { values: [16, 16, 0] } })
    put(s, 'P1', 0, 0, { note: 40, inst: 0 })
    put(s, 'P2', 0, 0, { note: 60, inst: 1 })
    expect(record(s, 3, 0).map((x) => x.semis)).toEqual([72, 60, 60])
    expect(record(s, 4, 1).map((x) => x.semis)).toEqual([61, 62, 62, 62])
  })

  it('timbre macro sets the timbre, Wxx overrides it', () => {
    const s = makeSong('nes')
    s.instruments[0] = inst({ timbre: { values: [0, 1, 2, 3] } })
    put(s, 'P1', 0, 0, { note: 60, inst: 0 })
    put(s, 'P1', 0, 1, { fx: [{ code: 'W', param: 1 }] })
    const c = record(s, 12).map((x) => x.timbre)
    expect(c.slice(0, 4)).toEqual([0, 1, 2, 3])
    expect(c.slice(6, 12)).toEqual([1, 1, 1, 1, 1, 1])
  })
})

describe('timeline', () => {
  it('detects the loop point from song.loop', () => {
    const s = makeSong('nes', { patternLength: 8, orders: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], loop: { order: 1 } })
    const tl = buildTimeline(s)
    expect(tl.isLooping).toBe(true)
    expect(tl.rows).toHaveLength(24)
    expect(tl.loopIndex).toBe(8)
    expect(tl.introTicks).toBe(8 * 6)
    expect(tl.loopTicks).toBe(16 * 6)
    expect(tl.stop).toBe('loop')
    // 150 bpm, 4 rows/beat, speed 6 = 60 ticks/s
    near(tl.introSeconds, 0.8, 1e-9)
    near(tl.loopSeconds, 1.6, 1e-9)
  })

  it('one-shot songs end after the last order', () => {
    const s = makeSong('nes', { patternLength: 4, orders: [[0, 0, 0, 0], [0, 0, 0, 0]] })
    const tl = buildTimeline(s)
    expect(tl.isLooping).toBe(false)
    expect(tl.rows).toHaveLength(8)
    expect(tl.stop).toBe('end')
  })

  it('Dxx breaks to a row of the next order, Bxx jumps, Cxx halts', () => {
    const s = makeSong('nes', { patternLength: 8, orders: [[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0]] })
    put(s, 'P1', 0, 3, { fx: [{ code: 'D', param: 5 }] })
    put(s, 'P1', 1, 6, { fx: [{ code: 'B', param: 0 }, { code: 'D', param: 2 }] })
    let tl = buildTimeline(s)
    expect(tl.rows.slice(0, 5).map((r) => [r.order, r.row])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 5]])
    // B00 + D02 at order 1 row 6 jumps to order 0 row 2, which is the repeat of an earlier state
    expect(tl.rows).toHaveLength(6)
    expect(tl.rows[5]).toMatchObject({ order: 1, row: 6 })
    expect(tl.isLooping).toBe(true)
    expect(tl.loopIndex).toBe(2)
    expect(tl.indexOf(0, 2)).toBe(2)

    put(s, 'P1', 1, 6, { fx: [{ code: 'C', param: 0 }] })
    tl = buildTimeline(s)
    expect(tl.isLooping).toBe(false)
    expect(tl.rows.at(-1)).toMatchObject({ order: 1, row: 6 })
  })

  it('Bxx to the start makes the whole song the loop', () => {
    const s = makeSong('nes', { patternLength: 4, orders: [[0, 0, 0, 0], [0, 0, 0, 0]] })
    put(s, 'P1', 0, 3, { fx: [{ code: 'B', param: 0 }] })
    const tl = buildTimeline(s)
    expect(tl.loopIndex).toBe(0)
    expect(tl.introTicks).toBe(0)
    expect(tl.rows).toHaveLength(4)
  })

  it('Fxx speed / bpm change row lengths and seconds', () => {
    const s = makeSong('nes', { patternLength: 8 })
    put(s, 'P1', 0, 2, { fx: [{ code: 'F', param: 3 }] })
    put(s, 'P1', 0, 4, { fx: [{ code: 'F', param: 120 }] })
    const tl = buildTimeline(s)
    expect(tl.rows.map((r) => r.ticks)).toEqual([6, 6, 3, 3, 3, 3, 3, 3])
    expect(tl.rows[4]!.bpm).toBe(120)
    expect(tl.rows[3]!.bpm).toBe(150)
    // 150 bpm: 60 ticks/s, 120 bpm: 48 ticks/s
    near(tl.secondsAt(0, 4), 18 / 60, 1e-9)
    near(tl.secondsAt(0, 5), 18 / 60 + 3 / 48, 1e-9)
  })

  it('groove sets alternating row lengths', () => {
    const s = makeSong('nes', { patternLength: 4, groove: [7, 5] })
    expect(buildTimeline(s).rows.map((r) => r.ticks)).toEqual([7, 5, 7, 5])
  })

  it('sample boundaries use the player accumulation (integer tick lengths)', () => {
    const s = makeSong('nes', { patternLength: 8, orders: [[0, 0, 0, 0], [0, 0, 0, 0]], loop: { order: 1 }, bpm: 120 })
    const tl = buildTimeline(s)
    // 120 bpm, 4 rpb, speed 6: 48000 * 60 / (120 * 24) = 1000 samples per tick
    const b = tl.sampleBoundaries(48000, 3)
    expect(b.introEnd).toBe(8 * 6 * 1000)
    expect(b.bodyEnds).toEqual([96000, 144000, 192000])
  })
})

describe('sequencer position and seek', () => {
  it('seek fast-forwards state without playing', () => {
    const s = makeSong('nes', { patternLength: 8, orders: [[0, 0, 0, 0], [0, 0, 0, 0]] })
    put(s, 'P1', 0, 0, { note: 60, inst: 0, vol: 7 })
    put(s, 'P1', 0, 1, { fx: [{ code: '4', param: 0x44 }] })
    const seq = new Sequencer(s)
    seq.seek(1, 2)
    expect(seq.upcoming()).toEqual({ order: 1, row: 2 })
    seq.tick()
    expect(seq.position()).toEqual({ order: 1, row: 2, tick: 0 })
    expect(seq.controls[0]!.rawVol).toBeCloseTo(7 / 15)
    expect(seq.controls[0]!.gate).toBe(true)
  })
})
