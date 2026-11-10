// The gm chip (General MIDI SoundFont) through the synth core with a tiny generated SoundFont (CI has no GeneralUser GS):
// a note and a drum hit start on time, the render is deterministic and a missing SoundFont is a clear error.

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SOUNDFONT_URL, createSong, getPattern, renderSong, resolvePreset, setSoundFont, tickSeconds } from '../../src/core'
import type { Song } from '../../src/core'
import { addSongInstrument } from '../../src/core/codecs/songBuild'
import { buildMiniSoundFont } from './miniSf2'

const SR = 44100

function oneNoteSong(channel: 'M1' | 'D1', row: number): Song {
  const song = createSong({ chip: 'gm', bpm: 120, patternLength: 16 })
  const inst = addSongInstrument(song, resolvePreset('gm', channel === 'M1' ? 'gm.lead.clarinet' : 'gm.kick.kick'))
  getPattern(song, channel, 0).rows[row] = { note: channel === 'M1' ? 69 : 36, inst, vol: 15 }
  song.loop = null
  return song
}

/** Seconds of the first frame whose level exceeds the threshold, or -1. */
function onset(L: Float32Array, threshold = 0.01): number {
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i]!) > threshold) return i / SR
  return -1
}

describe('gm chip with a generated SoundFont', () => {
  beforeAll(() => setSoundFont(buildMiniSoundFont()))
  afterAll(() => setSoundFont(null))

  it('starts a melodic note and a drum hit within one tick of their row and renders the same bytes twice', () => {
    for (const [channel, row] of [['M1', 8], ['D1', 4]] as const) {
      const song = oneNoteSong(channel, row)
      const a = renderSong(song, { sampleRate: SR })
      const b = renderSong(song, { sampleRate: SR })
      const hash = (x: Float32Array): string => createHash('sha256').update(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex')
      expect(hash(a.L), channel).toBe(hash(b.L))
      expect(hash(a.R), channel).toBe(hash(b.R))
      const t = onset(a.L)
      expect(t, `${channel} is audible`).toBeGreaterThan(0)
      const rowSeconds = (60 / song.timing.bpm / song.timing.rowsPerBeat) * row
      expect(t, `${channel} onset`).toBeGreaterThanOrEqual(rowSeconds - 1e-3)
      expect(t, `${channel} onset`).toBeLessThanOrEqual(rowSeconds + tickSeconds(song.timing) + 2e-3)
    }
  })

  it('plays one mix stem named _gm and no sound without a SoundFont', () => {
    const r = renderSong(oneNoteSong('M1', 0), { sampleRate: SR, stems: true })
    expect(Object.keys(r.stems!)).toContain('_gm')
    setSoundFont(null)
    let message = ''
    try {
      renderSong(oneNoteSong('M1', 0), { sampleRate: SR })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('soundfonts')
    expect(message).toContain(SOUNDFONT_URL)
    setSoundFont(buildMiniSoundFont())
  })
})
