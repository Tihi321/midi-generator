import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeWav } from '../../../src/core/codecs/wav'
import { SongPlayer } from '../../../src/core/synth/player'
import { renderSong, type RenderResult } from '../../../src/core/synth/render'
import { interleave, quantizeStereo } from '../../../src/core/synth/mixer'
import { buildTimeline } from '../../../src/core/synth/timeline'
import type { Song } from '../../../src/core/types'
import { makeSong, put, tinyGb, tinyNes } from './fixtures'

const SR = 44100

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
}

function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

describe('determinism and block-size parity', () => {
  it('two renders are bit-identical (NES and GB)', () => {
    for (const make of [tinyNes, tinyGb]) {
      const a = renderSong(make(), { sampleRate: SR })
      const b = renderSong(make(), { sampleRate: SR })
      expect(bytesEqual(a.L, b.L)).toBe(true)
      expect(bytesEqual(a.R, b.R)).toBe(true)
      expect(peak(a.L)).toBeGreaterThan(0.01)
    }
  })

  it('128-frame blocks give exactly the offline render (one-shot NES)', () => {
    const song = tinyNes()
    const ref = renderSong(song, { sampleRate: SR })
    const L = new Float32Array(ref.L.length)
    const R = new Float32Array(ref.R.length)
    const player = new SongPlayer(song, SR)
    for (let off = 0; off < L.length; off += 128) {
      const end = Math.min(L.length, off + 128)
      player.process(L.subarray(off, end), R.subarray(off, end))
    }
    expect(bytesEqual(L, ref.L)).toBe(true)
    expect(bytesEqual(R, ref.R)).toBe(true)
  })

  it('odd block sizes and different scratch sizes give the same output (GB, one-shot variant)', () => {
    const song = tinyGb()
    song.loop = null
    const ref = renderSong(song, { sampleRate: 48000 })
    const L = new Float32Array(ref.L.length)
    const R = new Float32Array(ref.R.length)
    const player = new SongPlayer(song, 48000, { maxBlock: 256 })
    let off = 0
    let size = 1
    while (off < L.length) {
      const end = Math.min(L.length, off + size)
      player.process(L.subarray(off, end), R.subarray(off, end))
      off = end
      size = (size * 7 + 3) % 1000 + 1
    }
    expect(bytesEqual(L, ref.L)).toBe(true)
    expect(bytesEqual(R, ref.R)).toBe(true)
  })
})

describe('SongPlayer', () => {
  it('reports position, seeks without rendering and mutes channels', () => {
    const song = tinyNes()
    const p = new SongPlayer(song, SR)
    p.process(new Float32Array(2000), new Float32Array(2000))
    expect(p.position().order).toBe(0)
    p.seek({ order: 1, row: 4 })
    const L = new Float32Array(500)
    p.process(L, new Float32Array(500))
    const pos = p.position()
    expect(pos).toMatchObject({ order: 1, row: 4, tick: 0 })
    expect(pos.seconds).toBeCloseTo((16 + 4) * 0.1, 6)

    const a = new SongPlayer(song, SR)
    const b = new SongPlayer(song, SR)
    for (let i = 0; i < 4; i++) b.setMute(i, true)
    const La = new Float32Array(4000)
    const Lb = new Float32Array(4000)
    a.process(La, new Float32Array(4000))
    b.process(Lb, new Float32Array(4000))
    expect(peak(La)).toBeGreaterThan(0.01)
    expect(peak(Lb)).toBe(0)
  })

  it('setSong hot-swaps the song keeping the position', () => {
    const song = tinyNes()
    const p = new SongPlayer(song, SR)
    p.process(new Float32Array(SR), new Float32Array(SR)) // 1 s = row 10
    const before = p.position()
    const edited = tinyNes()
    put(edited, 'P1', 0, 12, { note: 60 })
    p.setSong(edited)
    expect(p.position().row).toBe(before.row)
    p.process(new Float32Array(SR / 2), new Float32Array(SR / 2))
    expect(p.position().row).toBeGreaterThan(before.row)
    expect(p.currentSong).toBe(edited)
  })

  it('finishes one-shot songs and then outputs silence', () => {
    const song = makeSong('nes', { patternLength: 4 })
    put(song, 'P1', 0, 0, { note: 60, inst: 0 })
    const p = new SongPlayer(song, SR)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(p.finished).toBe(true)
    expect(peak(L.subarray(SR - 2000))).toBeLessThan(1e-4)
  })

  it('unknown channel kinds render silence', () => {
    const song = makeSong('nes')
    song.channels.push({ id: 'DM', name: 'DPCM', kind: 'dpcm', fxColumns: 1 })
    song.orders = [[0, 0, 0, 0, 0]]
    put(song, 'DM', 0, 0, { note: 60 })
    const L = new Float32Array(2000)
    new SongPlayer(song, SR).process(L, new Float32Array(2000))
    expect(peak(L)).toBe(0)
  })
})

describe('renderSong', () => {
  it('loop points are consistent with the timeline (loops = 1, 2)', () => {
    for (const sr of [44100, 48000]) {
      const song = tinyGb()
      const tl = buildTimeline(song)
      expect(tl.isLooping).toBe(true)
      for (const loops of [1, 2, 3]) {
        const b = tl.sampleBoundaries(sr, loops + 1)
        const r = renderSong(song, { sampleRate: sr, loops })
        expect(r.sampleRate).toBe(sr)
        expect(r.loopStart).toBe(b.introEnd + (b.bodyEnds[loops - 1]! - b.bodyEnds[0]!))
        expect(r.loopEnd).toBe(b.introEnd + (b.bodyEnds[loops]! - b.bodyEnds[0]!))
        expect(r.L.length).toBe(r.loopEnd)
        expect(r.R.length).toBe(r.loopEnd)
      }
      // 150 bpm: intro = 16 rows = 1.6 s
      const r1 = renderSong(song, { sampleRate: sr })
      expect(Math.abs(r1.loopStart! - 1.6 * sr)).toBeLessThanOrEqual(1)
      expect(Math.abs(r1.loopEnd! - r1.loopStart! - 1.6 * sr)).toBeLessThanOrEqual(1)
    }
  })

  it('the loop seam is crossfaded (no click larger than the signal itself)', () => {
    const song = tinyGb()
    const r = renderSong(song, { sampleRate: SR })
    const s = r.loopStart!
    let maxStep = 0
    for (let i = s - 300; i < s + 300; i++) maxStep = Math.max(maxStep, Math.abs(r.L[i]! - r.L[i - 1]!))
    expect(maxStep).toBeLessThan(2 * peak(r.L))
    expect(Number.isFinite(maxStep)).toBe(true)
  })

  it('fade-out produces intro + loops + fade without loop points', () => {
    const song = tinyGb()
    const tl = buildTimeline(song)
    const b = tl.sampleBoundaries(SR, 1)
    const r = renderSong(song, { sampleRate: SR, loops: 1, fadeOutSec: 1 })
    expect(r.loopStart).toBeNull()
    expect(r.loopEnd).toBeNull()
    expect(r.L.length).toBe(b.bodyEnds[0]! + SR)
    expect(Math.abs(r.L[r.L.length - 1]!)).toBeLessThan(1e-3)
    expect(peak(r.L.subarray(0, 4000))).toBeGreaterThan(0.01)
  })

  it('one-shot songs render until the end plus a tail', () => {
    const song = tinyNes()
    const tl = buildTimeline(song)
    const r = renderSong(song, { sampleRate: SR, tailSec: 0.25 })
    expect(r.loopStart).toBeNull()
    expect(r.L.length).toBe(tl.sampleBoundaries(SR, 0).introEnd + Math.round(0.25 * SR))
    expect(peak(r.L.subarray(r.L.length - 2000))).toBeLessThan(1e-3)
  })

  it('stems add up to the master with the linear mix model', () => {
    for (const song of [tinyNes(), tinyGb()]) {
      const r = renderSong(song, { sampleRate: SR, stems: true, mixModel: 'linear' })
      expect(Object.keys(r.stems!)).toEqual(song.channels.map((c) => c.id))
      expect(peak(r.L)).toBeLessThan(0.8) // below the soft limiter knee
      let maxDiff = 0
      for (let i = 0; i < r.L.length; i++) {
        let sl = 0
        let sr2 = 0
        for (const s of Object.values(r.stems!)) {
          sl += s.L[i]!
          sr2 += s.R[i]!
        }
        maxDiff = Math.max(maxDiff, Math.abs(sl - r.L[i]!), Math.abs(sr2 - r.R[i]!))
      }
      expect(maxDiff).toBeLessThan(1e-4)
    }
  })

  it('GB hard panning: Xxx 00 = left only, FF = right only', () => {
    const r = renderSong(tinyGb(), { sampleRate: SR, stems: true })
    const a = r.loopStart!
    const b = r.loopEnd!
    const p1 = r.stems!.P1!
    const p2 = r.stems!.P2!
    expect(peak(p1.L.subarray(a, b))).toBeGreaterThan(0.01)
    expect(peak(p1.R.subarray(a, b))).toBe(0)
    expect(peak(p2.R.subarray(a, b))).toBeGreaterThan(0.01)
    expect(peak(p2.L.subarray(a, b))).toBe(0)
  })

  it('NES nonlinear and linear models differ but both are audible', () => {
    const a = renderSong(tinyNes(), { sampleRate: SR, mixModel: 'nonlinear' })
    const b = renderSong(tinyNes(), { sampleRate: SR, mixModel: 'linear' })
    expect(bytesEqual(a.L, b.L)).toBe(false)
    expect(peak(a.L)).toBeGreaterThan(0.02)
    expect(peak(b.L)).toBeGreaterThan(0.02)
  })

  it('output never contains NaN and stays within +-1', () => {
    for (const song of [tinyNes(), tinyGb()]) {
      const r = renderSong(song, { sampleRate: 48000 })
      for (const v of r.L) expect(Number.isFinite(v) && Math.abs(v) <= 1).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// golden hashes

const goldenPath = join(__dirname, 'golden.json')

function hashOf(r: RenderResult): string {
  const q = quantizeStereo(r.L, r.R)
  const inter = interleave(q.L, q.R)
  return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
}

describe('golden output hashes', () => {
  const cases: [string, () => Song][] = [
    ['nes', tinyNes],
    ['gb', tinyGb]
  ]
  const update = process.env.UPDATE_GOLDEN === '1'
  const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
  for (const [name, make] of cases) {
    it(`${name} (UPDATE_GOLDEN=1 regenerates)`, () => {
      const r = renderSong(make(), { sampleRate: 44100 })
      const h = hashOf(r)
      if (update) {
        golden[name] = h
        writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
        return
      }
      if (golden[name] !== h) {
        const dir = join(process.cwd(), '.claude', 'temp')
        mkdirSync(dir, { recursive: true })
        const q = quantizeStereo(r.L, r.R)
        const file = join(dir, `golden-${name}-actual.wav`)
        writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
        throw new Error(`Golden hash mismatch for ${name}: expected ${golden[name]}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
      }
      expect(h).toBe(golden[name])
    })
  }
})

// ---------------------------------------------------------------------------------------------
// performance sanity

describe('performance', () => {
  it.skipIf(process.env.SKIP_PERF === '1')('renders 60 s of a 5-channel NES song in under 2 s', () => {
    const song = makeSong('nes', { patternLength: 64, dpcm: true, orders: Array.from({ length: 10 }, () => [0, 0, 0, 0, 0]) })
    for (let r = 0; r < 64; r++) {
      put(song, 'P1', 0, r, { note: 72 + (r % 7), inst: 3, vol: 14, fx: r % 8 === 0 ? [{ code: '4', param: 0x46 }] : undefined })
      put(song, 'P2', 0, r, { note: 60 + ((r * 3) % 12), inst: 0, vol: 10, fx: [{ code: '0', param: 0x47 }] })
      if (r % 2 === 0) put(song, 'TR', 0, r, { note: 36 + ((r >> 2) % 5), inst: 1 })
      put(song, 'NO', 0, r, { note: 60 + (r % 3), inst: 2 })
    }
    expect(buildTimeline(song).totalTicks / 60).toBeGreaterThanOrEqual(60)
    const t0 = performance.now()
    const r = renderSong(song, { sampleRate: 44100, tailSec: 0 })
    const ms = performance.now() - t0
    console.log(`perf: ${(r.L.length / 44100).toFixed(1)} s of 5-channel NES rendered in ${ms.toFixed(0)} ms`)
    expect(r.L.length / 44100).toBeGreaterThanOrEqual(60)
    expect(ms).toBeLessThan(2000)
  })
})
