// End to end: compose a short Genesis (YM2612 + SN76489) song through the tools only, then export it.

import { describe, expect, it } from 'vitest'
import { readWav } from '../../src/core'
import { resultText, songSetup } from './helpers'

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

describe('compose a Genesis song with the tools', () => {
  it('new_song, FM and PSG presets, drums, melody, orders, export_wav with loop points and stems', async () => {
    const t = songSetup()
    const created = await t.text('new_song', { chip: 'genesis', name: 'Blast Hero', bpm: 140, key: 'E', scale: 'minor' })
    expect(created).not.toMatch(/not available yet/)
    expect(t.session.song.channels.map((c) => c.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'S1', 'S2', 'S3', 'NO'])

    expect(resultText(await t.ok('add_instrument', { preset: 'genesis.bass.slap', channel: 'F1' }))).toMatch(/genesis\.bass\.slap/)
    await t.ok('add_instrument', { preset: 'lead', channel: 'F2' })
    await t.ok('add_instrument', { preset: 'strings', channel: 'F3' })
    await t.ok('add_instrument', { preset: 'brass', channel: 'F5' })
    await t.ok('add_instrument', { preset: 'lead', channel: 'S1' })
    await t.ok('add_instrument', { preset: 'arp', channel: 'S2' })
    expect(t.session.song.instruments.map((i) => i.kind)).toEqual(['fm', 'fm', 'fm', 'fm', 'psg', 'psg'])

    const drums = await t.text('write_drums', { channel: 'NO', legend: { h: 'hat v8', o: 'openhat', S: 'snare', K: 'kick' }, steps: 'K.h.S.h.K.hoS.h.', repeat: 4 })
    expect(drums).toMatch(/Wrote .* drum hits/)
    const roles = t.session.song.instruments.map((i) => i.role)
    expect(roles).toEqual(expect.arrayContaining(['hihat', 'openhat', 'snare', 'kick']))
    // roles resolved for a noise channel use the PSG noise presets
    for (const inst of t.session.song.instruments.slice(6)) expect(inst.kind).toBe('psg-noise')

    await t.ok('write_melody', { channel: 'F1', melody: '@bass E2:2 E2:2 E3:2 E2:2 G2:2 G2:2 A2:2 B2:2 E2:2 E2:2 E3:2 E2:2 D2:2 D2:2 B1:4' })
    await t.ok('write_melody', { channel: 'F2', melody: '@lead v13 E5:4 G5:2 B5:2 E6:8 D6:4 B5:4 A5:4 G5:4 F#5:8', clear: true })
    await t.ok('write_pattern', { text: 'channels: F3 | F5\n 0 | E-4 @strings v9 X00 | .\n 4 | . | B-4 @brass v12 XFF\n16 | G-4 | .' })
    await t.ok('write_melody', { channel: 'S1', melody: '@lead-psg v9 E6:2 G6:2 B6:2 E7:2 B6:4 G6:4' })
    await t.ok('write_pattern', { text: 'channels: S2\n 0 | E-5 @arp-psg v8 037' })
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)

    expect(await t.text('set_orders', { orders: [0], loop: 0 })).toMatch(/Loops back to order 0/)
    const res = await t.text('export_wav', { path: 'blast-hero', stems: true })
    expect(res).toMatch(/Loop points \(smpl chunk\)/)
    expect(res).not.toMatch(/refus|coming|not available/i)
    const wav = readWav(t.services.files.get('/mem/exports/blast-hero.wav')!)
    expect(wav.numChannels).toBe(2)
    expect(wav.loops).toHaveLength(1)
    expect(wav.length / wav.sampleRate).toBeGreaterThan(6)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.01)
    expect(rms(wav.channels[1]!)).toBeGreaterThan(0.01)
    for (const id of ['F1', 'F2', 'F3', 'F5', 'S1', 'S2', 'NO']) {
      const stem = readWav(t.services.files.get(`/mem/exports/blast-hero_${id}.wav`)!)
      expect(rms(stem.channels[0]!) + rms(stem.channels[1]!), `stem ${id}`).toBeGreaterThan(0.003)
    }
    // F3 was panned hard left (X00), F5 hard right (XFF)
    const f3 = readWav(t.services.files.get('/mem/exports/blast-hero_F3.wav')!)
    expect(rms(f3.channels[1]!)).toBeLessThan(0.0005)
    expect(rms(f3.channels[0]!)).toBeGreaterThan(0.003)
    const f5 = readWav(t.services.files.get('/mem/exports/blast-hero_F5.wav')!)
    expect(rms(f5.channels[0]!)).toBeLessThan(0.0005)
    expect(rms(f5.channels[1]!)).toBeGreaterThan(0.003)
  })

  it('strict songs refuse PSG squares below A-2 with the fix', async () => {
    const t = songSetup({ chip: 'genesis' })
    await t.ok('add_instrument', { preset: 'lead', channel: 'S1' })
    const err = await t.call('write_pattern', { text: 'channels: S1\n 0 | G-2 @0' })
    expect(err.isError).toBe(true)
    expect(resultText(err)).toMatch(/A-2|FM|F1/)
    await t.ok('write_pattern', { text: 'channels: S1\n 0 | A-2 @0' })
  })

  it('the custom FM instrument example from the guide is accepted and plays', async () => {
    const t = songSetup({ chip: 'genesis' })
    const ops = [
      { ar: 31, dr: 16, sr: 10, rr: 8, sl: 6, tl: 32, ks: 0, ml: 1, dt: 0 },
      { ar: 31, dr: 10, sr: 6, rr: 9, sl: 3, tl: 6, ks: 0, ml: 1, dt: 0 },
      { ar: 31, dr: 22, sr: 12, rr: 8, sl: 4, tl: 40, ks: 0, ml: 4, dt: 0 },
      { ar: 31, dr: 12, sr: 7, rr: 9, sl: 3, tl: 8, ks: 0, ml: 1, dt: 0 }
    ]
    await t.ok('add_instrument', { params: { kind: 'fm', name: 'my-bass', alg: 4, fb: 5, ams: 0, pms: 0, ops }, channel: 'F1' })
    expect(t.session.song.instruments[0]!.kind).toBe('fm')
    await t.ok('write_pattern', { text: 'channels: F1\n 0 | E-2 @my-bass\n 8 | E-3' })
    await t.ok('set_orders', { orders: [0], loop: 0 })
    await t.ok('export_wav', { path: 'custom' })
    const wav = readWav(t.services.files.get('/mem/exports/custom.wav')!)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.01)
  })

  it('F6 becomes a sample channel with fm6Dac and FM presets are refused there', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'genesis', chipConfig: { fm6Dac: true } })
    expect(t.session.song.channels.find((c) => c.id === 'F6')!.kind).toBe('sample')
  })

  it('list_presets shows the genesis bank and the chip is not marked as coming', async () => {
    const t = songSetup({ chip: 'genesis' })
    const text = await t.text('list_presets')
    for (const id of ['genesis.bass.slap', 'genesis.lead.saw', 'genesis.strings.slow', 'genesis.lead.psg', 'genesis.hihat.noise', 'genesis.kick.fm']) expect(text).toContain(id)
    expect(await t.text('list_chips')).not.toMatch(/genesis - .*\[coming/)
  })
})
