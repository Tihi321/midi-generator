// End to end: compose a short PC Engine song through the tools only, then export it.

import { describe, expect, it } from 'vitest'
import { readWav } from '../../src/core'
import { resultText, songSetup } from './helpers'

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

describe('compose a PC Engine song with the tools', () => {
  it('new_song, presets, drums, melody, orders, export_wav with loop points and stems', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'pce', name: 'Wave Hero', bpm: 128, key: 'A', scale: 'minor' })
    expect(t.session.song.chip).toBe('pce')
    expect(t.session.song.channels.map((c) => c.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])

    const bass = resultText(await t.ok('add_instrument', { preset: 'pce.bass.sine', channel: 'C1' }))
    expect(bass).toMatch(/pce\.bass\.sine/)
    await t.ok('add_instrument', { preset: 'lead', channel: 'C2' })
    await t.ok('add_instrument', { preset: 'pad', channel: 'C3' })
    expect(t.session.song.instruments.map((i) => i.kind)).toEqual(['pce-wave', 'pce-wave', 'pce-wave'])

    const drums = await t.text('write_drums', { channel: 'C5', legend: { h: 'hat v8', o: 'openhat' }, steps: 'h.h.h.h.h.h.h.ho', repeat: 4 })
    expect(drums).toMatch(/Wrote .* drum hits/)
    await t.ok('write_drums', { channel: 'C6', legend: { S: 'snare', K: 'kick' }, steps: 'K...S...K..KS...', repeat: 4 })
    const roles = t.session.song.instruments.map((i) => i.role)
    expect(roles).toEqual(expect.arrayContaining(['hihat', 'openhat', 'snare', 'kick']))

    await t.ok('write_melody', { channel: 'C1', melody: '@bass-sine A2:4 A2:4 E3:4 E3:4 F2:4 F2:4 G2:4 G2:4' })
    await t.ok('write_melody', { channel: 'C2', melody: '@lead v13 A4:4 C5:2 E5:2 A5:8 G5:4 E5:4 D5:4 C5:4 B4:8', clear: true })
    await t.ok('write_pattern', { text: 'channels: C3\n 0 | A-3 @pad X30\n 8 | F-3\n16 | G-3' })
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)

    expect(await t.text('set_orders', { orders: [0], loop: 0 })).toMatch(/Loops back to order 0/)
    const res = await t.text('export_wav', { path: 'wave-hero', stems: true })
    expect(res).toMatch(/Loop points \(smpl chunk\)/)
    expect(res).not.toMatch(/refus|coming/i)
    const wav = readWav(t.services.files.get('/mem/exports/wave-hero.wav')!)
    expect(wav.numChannels).toBe(2)
    expect(wav.loops).toHaveLength(1)
    expect(wav.length / wav.sampleRate).toBeGreaterThan(7)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.01)
    expect(rms(wav.channels[1]!)).toBeGreaterThan(0.01)
    for (const id of ['C1', 'C2', 'C3', 'C5', 'C6']) {
      const stem = readWav(t.services.files.get(`/mem/exports/wave-hero_${id}.wav`)!)
      expect(rms(stem.channels[0]!) + rms(stem.channels[1]!), `stem ${id}`).toBeGreaterThan(0.003)
    }
    // C3 was panned left (X30): its left stem is louder than its right
    const c3 = readWav(t.services.files.get('/mem/exports/wave-hero_C3.wav')!)
    expect(rms(c3.channels[0]!)).toBeGreaterThan(rms(c3.channels[1]!))
  })

  it('strict songs refuse noise instruments on C1..C4 with the fix', async () => {
    const t = songSetup({ chip: 'pce' })
    await t.ok('add_instrument', { preset: 'hat.noise' })
    const err = await t.call('write_pattern', { text: 'channels: C1\n 0 | C-4 @0' })
    expect(err.isError).toBe(true)
    expect(resultText(err)).toMatch(/only works on C5 and C6/)
    await t.ok('write_pattern', { text: 'channels: C5\n 0 | C-4 @0' })
  })

  it('list_presets shows the pce bank and roles resolve per channel', async () => {
    const t = songSetup({ chip: 'pce' })
    const text = await t.text('list_presets')
    for (const id of ['pce.lead.bright', 'pce.bass.sine', 'pce.kick.drop', 'pce.snare.noise']) expect(text).toContain(id)
    expect(await t.text('list_chips')).not.toMatch(/pce - .*\[coming/)
  })
})
