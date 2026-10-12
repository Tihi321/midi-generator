// End to end: compose a short song through the tools only, then export it and check the WAV.

import { describe, expect, it } from 'vitest'
import { readWav } from '../../src/core'
import { GUIDE } from '../../src/tools'
import { resultText, songSetup } from './helpers'

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

/** Calls in the guide's "complete NES example" code block, parsed from docs so the guide cannot rot. */
function guideExample(): Array<[string, unknown]> {
  const block = /### A complete NES example[\s\S]*?```\n([\s\S]*?)```/.exec(GUIDE)![1]!
  return block
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const m = /^(\w+)\s+(\{.*\})/.exec(l)!
      const json = m[2]!.replace(/\s+->.*$/, '')
      return [m[1]!, JSON.parse(json)] as [string, unknown]
    })
}

describe('compose a NES song with the tools', () => {
  it('runs the guide example: drums, bass, arpeggio, lead, orders, loop, analysis, export', async () => {
    const t = songSetup()
    for (const [name, args] of guideExample()) {
      if (name === 'export_wav') continue
      const r = await t.call(name, args)
      expect(r.isError, `${name}: ${resultText(r)}`).toBeFalsy()
    }
    expect(t.song.name).toBe('Hero Theme')
    expect(t.song.instruments.map((i) => i.name)).toEqual(['lead', 'arp', 'bass', 'kick', 'hat', 'snare'])
    const analysis = await t.text('analyze_song')
    expect(analysis).toMatch(/Chip rules: no violations for NES/)
    expect(analysis).toMatch(/Declared key: A minor/)
    expect(analysis).toMatch(/Chords per bar: 1:Am/)
    expect(await t.text('set_orders', { orders: [0, 1, 1], loop: 1 })).toMatch(/Loops back to order 1/)
    // second section: a varied copy of the first, a fourth higher
    await t.ok('copy_pattern', { fromOrder: 0, toOrder: 1, degrees: 3, channels: ['P1', 'P2', 'TR'] })
    await t.ok('copy_pattern', { fromOrder: 0, toOrder: 1, channels: ['NO'] })

    const res = await t.text('export_wav', { path: 'hero-theme', stems: true })
    expect(res).toMatch(/Loop points \(smpl chunk\)/)
    const wav = readWav(t.services.files.get('/mem/exports/hero-theme.wav')!)
    expect(wav.numChannels).toBe(2)
    expect(wav.bitsPerSample).toBe(16)
    expect(wav.loops).toHaveLength(1)
    expect(wav.loops[0]!.start).toBeGreaterThan(0)
    expect(wav.loops[0]!.end).toBeLessThanOrEqual(wav.length - 1)
    // 3 order rows of 4 bars at 132 BPM: 3 x 7.27 s, intro (order 0) + body (orders 1..2)
    expect(wav.length / wav.sampleRate).toBeGreaterThan(14)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.02)
    expect(rms(wav.channels[1]!)).toBeGreaterThan(0.02)
    for (const id of ['P1', 'P2', 'TR', 'NO']) {
      const stem = readWav(t.services.files.get(`/mem/exports/hero-theme_${id}.wav`)!)
      expect(rms(stem.channels[0]!), `stem ${id}`).toBeGreaterThan(0.005)
      expect(stem.loops).toHaveLength(1)
    }
    // one section later, undo still works step by step
    t.session.undo()
    expect(t.song.patterns.has('NO:1')).toBe(false)
  })

  it('every tool call of the example is a single undo step', async () => {
    const t = songSetup()
    let steps = 0
    for (const [name, args] of guideExample()) {
      if (name === 'export_wav' || name === 'analyze_song' || name === 'render_preview') continue
      await t.ok(name, args)
      steps++
      expect(t.session.history.undoDepth, name).toBe(steps)
    }
    for (let i = steps; i > 0; i--) expect(t.session.undo()).toBe(true)
    expect(t.song.instruments).toHaveLength(0)
  })
})

describe('compose a Game Boy song with the tools', () => {
  it('uses the wave channel for bass with 4 volume levels, pulse for lead, noise for drums', async () => {
    const t = songSetup({ chip: 'gb' })
    await t.ok('set_song_info', { bpm: 110, key: 'F', scale: 'major', moods: ['town'] })
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('add_instrument', { preset: 'arp', channel: 'P2' })
    const bass = await t.text('add_instrument', { preset: 'bass', channel: 'WV' })
    expect(bass).toMatch(/gb-wave/)
    await t.ok('write_drums', { legend: { K: 'kick', S: 'snare', h: 'hihat' }, steps: 'K.h.S.h.K.h.S.hh', repeat: 4 })
    await t.ok('write_pattern', {
      text: 'channels: WV | P2\n 0 | F-2 @bass v15 | F-3 @arp 047\n 8 | C-3 v8 | .\n16 | A#1 v15 | A#3 047\n24 | C-3 v8 | .\n32 | F-2 v15 | F-3 047\n48 | C-2 v15 | C-3 047'
    })
    await t.ok('write_melody', { channel: 'P1', melody: '@lead v12 A5:4 C6:2 A5:2 G5:4 F5:4 F5:4 A5:2 C6:2 D6:8 C6:16 r:16' })
    // the volume rule of the wave channel is a warning in the analysis, not an error
    await t.ok('set_cells', { cells: [{ channel: 'WV', row: 4, note: 'F-2', vol: 12 }] })
    expect(await t.text('analyze_song')).toMatch(/quantized.*v12 plays as v15|quantized/)
    expect(resultText(await t.call('write_pattern', { text: 'channels: P2\n0 | C-0 @arp' }))).toMatch(/below P2's lowest note C-2 on Game Boy; transpose \+/)
    await t.ok('set_loop', { order: 0 })

    const text = await t.text('export_wav', { path: 'town-gb', stems: true })
    expect(text).toMatch(/Loop points/)
    const wav = readWav(t.services.files.get('/mem/exports/town-gb.wav')!)
    expect(wav.loops).toHaveLength(1)
    expect(wav.loops[0]!.end).toBeLessThanOrEqual(wav.length - 1)
    expect(wav.length / wav.sampleRate).toBeGreaterThan(8)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.02)
    expect(rms(wav.channels[1]!)).toBeGreaterThan(0.02)
    for (const id of ['P1', 'P2', 'WV', 'NO']) {
      expect(rms(readWav(t.services.files.get(`/mem/exports/town-gb_${id}.wav`)!).channels[0]!), `stem ${id}`).toBeGreaterThan(0.002)
    }
  })

  it('exports the same bytes twice (deterministic render)', async () => {
    const t = songSetup({ chip: 'gb' })
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('write_melody', { channel: 'P1', melody: '@lead C5:4 E5:4 G5:8' })
    await t.ok('export_wav', { path: 'a' })
    await t.ok('export_wav', { path: 'b' })
    expect(Buffer.from(t.services.files.get('/mem/exports/a.wav')!).equals(Buffer.from(t.services.files.get('/mem/exports/b.wav')!))).toBe(true)
  })
})
