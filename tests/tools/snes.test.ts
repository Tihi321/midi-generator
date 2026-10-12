// End to end: compose SNES, Genesis F6 DAC and NES DPCM songs through the tools only, then export them.

import { describe, expect, it } from 'vitest'
import { readWav } from '../../src/core'
import { resultText, songSetup } from './helpers'

function rms(ch: Float32Array): number {
  let s = 0
  for (const v of ch) s += v * v
  return Math.sqrt(s / Math.max(1, ch.length))
}

describe('compose a SNES song with the tools', () => {
  it('new_song, presets, drums, melody, echo config, export_wav with loop points, stems and the echo stem', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'snes', name: 'Echo Keep', bpm: 100, key: 'D', scale: 'minor' })
    expect(t.session.song.channels.map((c) => c.id)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'])

    expect(resultText(await t.ok('add_instrument', { preset: 'bass', channel: 'V1' }))).toMatch(/snes\.bass\.synth.*Added sample "bass"/)
    await t.ok('add_instrument', { preset: 'strings', channel: 'V2' })
    await t.ok('add_instrument', { preset: 'snes.pluck.harp', channel: 'V3' })
    await t.ok('add_instrument', { preset: 'lead', channel: 'V4' })
    expect(t.session.song.instruments.map((i) => i.kind)).toEqual(['snes-sample', 'snes-sample', 'snes-sample', 'snes-sample'])
    expect(t.session.song.samples.map((s) => s.id)).toEqual(['bass', 'strings', 'harp', 'lead-saw'])

    await t.ok('write_drums', { channel: 'V7', legend: { K: 'kick' }, steps: 'K...K..KK...K...', repeat: 4 })
    await t.ok('write_drums', { channel: 'V8', legend: { S: 'snare', h: 'hat' }, steps: '..S...h...S...h.', repeat: 4 })
    await t.ok('write_melody', { channel: 'V1', melody: '@bass D2:4 D2:4 A1:4 A1:4 Bb1:4 Bb1:4 C2:4 C2:4' })
    await t.ok('write_pattern', { text: 'channels: V2\n 0 | D-4 @strings v11 X30\n 8 | C-4\n16 | Bb3\n24 | A-3 E01' })
    await t.ok('write_melody', { channel: 'V3', melody: '@harp v10 D5:2 F5:2 A5:2 F5:2 C5:2 E5:2 G5:2 E5:2' })
    await t.ok('write_melody', { channel: 'V4', melody: '@lead v12 A5:8 G5:4 F5:4 E5:8 D5:8', clear: true })
    await t.ok('set_song_info', { chipConfig: { echo: { delay: 3, feedback: 0.45, volL: 0.35, volR: 0.35, fir: [0, 0, 0, 0, 0, 0, 0.5, 0.5] } } })
    expect(t.session.song.chipConfig).toMatchObject({ chip: 'snes', echo: { delay: 3, feedback: 0.45, fir: [0, 0, 0, 0, 0, 0, 0.5, 0.5] } })
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)

    expect(await t.text('set_orders', { orders: [0], loop: 0 })).toMatch(/Loops back to order 0/)
    const res = await t.text('export_wav', { path: 'echo-keep', stems: true })
    expect(res).toMatch(/Loop points \(smpl chunk\)/)
    expect(res).not.toMatch(/refus|coming/i)
    const wav = readWav(t.services.files.get('/mem/exports/echo-keep.wav')!)
    expect(wav.numChannels).toBe(2)
    expect(wav.loops).toHaveLength(1)
    expect(wav.length / wav.sampleRate).toBeGreaterThan(8)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.01)
    expect(rms(wav.channels[1]!)).toBeGreaterThan(0.01)
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V7', 'V8']) {
      const stem = readWav(t.services.files.get(`/mem/exports/echo-keep_${id}.wav`)!)
      expect(rms(stem.channels[0]!) + rms(stem.channels[1]!), `stem ${id}`).toBeGreaterThan(0.002)
    }
    // V2 was panned left (X30): its left stem is louder than its right
    const v2 = readWav(t.services.files.get('/mem/exports/echo-keep_V2.wav')!)
    expect(rms(v2.channels[0]!)).toBeGreaterThan(rms(v2.channels[1]!))
    // the echo bus is its own stem and is audible (instrument echo is on for strings/harp/lead)
    const echo = readWav(t.services.files.get('/mem/exports/echo-keep_echo.wav')!)
    expect(echo.loops).toHaveLength(1)
    expect(rms(echo.channels[0]!) + rms(echo.channels[1]!)).toBeGreaterThan(0.002)
  })

  it('refuses non-sample instruments and reports an over-full ARAM with a fix', async () => {
    const t = songSetup({ chip: 'snes' })
    for (let i = 0; i < 3; i++) {
      await t.ok('generate_sample', { recipe: 'crash', params: { seconds: 2, seed: i + 1 }, name: `big ${i}` })
      await t.ok('add_instrument', { params: { kind: 'snes-sample', name: `big${i}`, sample: `big-${i}`, baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: false } })
    }
    const report = await t.text('analyze_song')
    expect(report).toMatch(/SNES ARAM budget exceeded/)
    expect(report).toMatch(/lower the echo delay|shorten/)
    const bad = await t.call('add_instrument', { preset: 'nes.lead.duty25' })
    expect(bad.isError).toBe(true)
  })
})

describe('Genesis F6 DAC and NES DPCM drums', () => {
  it('Genesis: F6 DAC kick + snare render on the F6 stem', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'genesis', name: 'Dac Beat', bpm: 120, chipConfig: { fm6Dac: true } })
    expect(t.session.song.channels.find((c) => c.id === 'F6')!.kind).toBe('sample')
    await t.ok('write_drums', { channel: 'F6', legend: { K: 'kick', S: 'snare' }, steps: 'K...S...K.K.S...', repeat: 4 })
    expect(t.session.song.instruments.map((i) => i.kind)).toEqual(['sample', 'sample'])
    expect(t.session.song.samples.map((s) => s.id).sort()).toEqual(['dac-kick', 'dac-snare'])
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)
    const res = await t.text('export_wav', { path: 'dac-beat', stems: true })
    expect(res).not.toMatch(/Warning: the render is silent/)
    const wav = readWav(t.services.files.get('/mem/exports/dac-beat.wav')!)
    expect(rms(wav.channels[0]!)).toBeGreaterThan(0.01)
    const f6 = readWav(t.services.files.get('/mem/exports/dac-beat_F6.wav')!)
    expect(rms(f6.channels[0]!) + rms(f6.channels[1]!)).toBeGreaterThan(0.01)
  })

  it('NES: DM channel DPCM kick + snare render on the DM stem', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'nes', name: 'Dpcm Beat', bpm: 120, chipConfig: { dpcm: true } })
    expect(t.session.song.channels.map((c) => c.id)).toEqual(['P1', 'P2', 'TR', 'NO', 'DM'])
    await t.ok('write_drums', { channel: 'DM', legend: { K: 'kick', S: 'snare' }, steps: 'K...S...K.K.S...', repeat: 4 })
    expect(t.session.song.instruments.map((i) => i.kind)).toEqual(['sample', 'sample'])
    expect(await t.text('analyze_song')).toMatch(/Chip rules: no violations/)
    const res = await t.text('export_wav', { path: 'dpcm-beat', stems: true })
    expect(res).not.toMatch(/Warning: the render is silent/)
    const dm = readWav(t.services.files.get('/mem/exports/dpcm-beat_DM.wav')!)
    expect(rms(dm.channels[0]!)).toBeGreaterThan(0.003)
  })
})
