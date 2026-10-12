import { describe, expect, it } from 'vitest'
import { createCellsCommand, parseProject, readWav, renderSong } from '../../src/core'
import { DEFAULT_EXPORT, estimateExport, planProject, planWavExport, renderOptionsFor, sanitizeBaseName } from '../../src/renderer/lib/exporter'
import { createStarterSong } from '../../src/renderer/lib/newSong'

function demoSong() {
  const song = createStarterSong({ chip: 'nes', name: 'Demo Song', bpm: 150, key: 'C', scale: 'major', moods: [], patternLength: 16 })
  const cmd = createCellsCommand(song, [
    { channel: 0, pattern: 0, row: 0, cell: { note: 60, inst: 0, vol: 15 } },
    { channel: 0, pattern: 0, row: 4, cell: { note: 64, inst: 0, vol: 15 } },
    { channel: 0, pattern: 0, row: 8, cell: { note: 'off' } }
  ])
  cmd.apply(song)
  return song
}

describe('export planning', () => {
  it('sanitizes file names', () => {
    expect(sanitizeBaseName('my/song:1')).toBe('my_song_1')
    expect(sanitizeBaseName('a\\b')).toBe('a_b')
    expect(sanitizeBaseName('  ')).toBe('song')
    expect(sanitizeBaseName('..hidden')).toBe('hidden')
  })

  it('clamps render options', () => {
    const o = renderOptionsFor({ ...DEFAULT_EXPORT, loops: 99, fadeOutSec: -3, sampleRate: 48000 })
    expect(o).toEqual({ sampleRate: 48000, loops: 16, fadeOutSec: 0, stems: false })
    expect(renderOptionsFor({ ...DEFAULT_EXPORT, loops: Number.NaN }).loops).toBe(1)
  })

  it('estimates looping and one-shot songs', () => {
    const song = demoSong()
    const loop = estimateExport(song, { ...DEFAULT_EXPORT, stems: true })
    expect(loop.looping).toBe(true)
    expect(loop.loopPoints).toBe(true)
    expect(loop.files).toBe(1 + song.channels.length)
    expect(loop.seconds).toBeGreaterThan(0)
    expect(estimateExport(song, { ...DEFAULT_EXPORT, fadeOutSec: 2 }).loopPoints).toBe(false)
    song.loop = null
    const once = estimateExport(song, DEFAULT_EXPORT)
    expect(once.looping).toBe(false)
    expect(once.loopPoints).toBe(false)
  })

  it('plans a master WAV with loop points and one stem per channel', () => {
    const song = demoSong()
    const settings = { ...DEFAULT_EXPORT, baseName: 'Demo/Song', stems: true }
    const rendered = renderSong(song, renderOptionsFor(settings))
    const files = planWavExport(song, settings, rendered)
    expect(files.map((f) => f.name)).toEqual(['Demo_Song.wav', ...song.channels.map((c) => `Demo_Song_${c.id}.wav`)])
    const master = files[0]!.data as Uint8Array
    expect(String.fromCharCode(...master.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...master.subarray(8, 12))).toBe('WAVE')
    const parsed = readWav(master)
    expect(parsed.sampleRate).toBe(44100)
    expect(parsed.numChannels).toBe(2)
    expect(parsed.length).toBe(rendered.L.length)
    expect(parsed.loops).toHaveLength(1)
    expect(parsed.loops[0]!.start).toBe(rendered.loopStart)
    expect(parsed.loops[0]!.end).toBe(rendered.loopEnd! - 1)
    expect(parsed.info['INAM']).toBe('Demo Song')
    // the render is not silent
    expect(parsed.channels[0]!.some((v) => Math.abs(v) > 0.01)).toBe(true)
  })

  it('writes no loop chunk for a faded render', () => {
    const song = demoSong()
    const settings = { ...DEFAULT_EXPORT, fadeOutSec: 1 }
    const files = planWavExport(song, settings, renderSong(song, renderOptionsFor(settings)))
    expect(readWav(files[0]!.data as Uint8Array).loops).toHaveLength(0)
  })

  it('plans a .ctune project that parses back', () => {
    const song = demoSong()
    const file = planProject(song, 'My Song')
    expect(file.name).toBe('My Song.ctune')
    expect(planProject(song, 'x.ctune').name).toBe('x.ctune')
    const back = parseProject(file.data as string)
    expect(back.name).toBe('Demo Song')
    expect(back.patterns.get('P1:0')?.rows[4]).toEqual({ note: 64, inst: 0, vol: 15 })
  })
})
