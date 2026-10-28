// compose_sfx: sound effects, stingers and ambience.

import { describe, expect, it } from 'vitest'
import { readWav, renderSong, serializeProject, songSeconds, validateSong } from '../../src/core'
import { SFX_SOUNDS, composeSfx } from '../../src/tools'
import type { SfxKind } from '../../src/tools'
import { resultText, songSetup } from './helpers'

const CHIPS = ['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast'] as const
const KINDS = ['sfx', 'stinger', 'ambience'] as const

function lastJson(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text!)
  return JSON.parse(texts[texts.length - 1]!) as Record<string, unknown>
}

function peak(L: Float32Array): number {
  let m = 0
  for (const v of L) m = Math.max(m, Math.abs(v))
  return m
}

describe('composeSfx', () => {
  it('every sound of every kind on every chip is a valid, audible song with the right shape', () => {
    for (const kind of KINDS) {
      for (const sound of SFX_SOUNDS[kind]) {
        for (const chip of CHIPS) {
          const where = `${kind}/${sound}/${chip}`
          const r = composeSfx({ kind, sound, chip, seed: 1, seconds: 8 })
          expect(validateSong(r.song).filter((i) => i.severity === 'error'), where).toEqual([])
          if (kind === 'ambience') {
            expect(r.song.loop, where).toEqual({ order: 0 })
            expect(r.loop, where).toEqual({ startBar: 0, endBar: r.song.orders.length * (r.song.patternLength / 16) })
          } else {
            expect(r.song.loop, where).toBeNull()
            expect(r.loop, where).toBeNull()
            expect(r.durationSec, where).toBeLessThan(kind === 'sfx' ? 3 : 6)
          }
          const out = renderSong(r.song)
          expect(peak(out.L), `${where} audible`).toBeGreaterThan(0.01)
          if (kind === 'ambience') {
            expect(out.loopEnd, where).toBe(out.L.length)
            expect(out.L.length / 44100, where).toBeCloseTo(r.durationSec, 1)
          }
        }
      }
    }
  }, 300000)

  it('ambience length follows seconds (whole bars) and clamps', () => {
    const a = composeSfx({ kind: 'ambience', sound: 'rain', seed: 1 })
    expect(a.durationSec).toBeCloseTo(16, 1)
    expect(composeSfx({ kind: 'ambience', sound: 'rain', seed: 1, seconds: 30 }).durationSec).toBeCloseTo(30, 0)
    expect(composeSfx({ kind: 'ambience', sound: 'rain', seed: 1, seconds: 1 }).durationSec).toBeCloseTo(4, 1)
  })

  it('is deterministic per seed, and the seed changes the sound', () => {
    const ser = (o: Parameters<typeof composeSfx>[0]) => {
      const r = composeSfx(o)
      r.song.id = 'x'
      return serializeProject(r.song)
    }
    for (const o of [{ kind: 'sfx', sound: 'magic' }, { kind: 'stinger', sound: 'success' }, { kind: 'ambience', sound: 'fire' }] as const) {
      expect(ser({ ...o, seed: 3 })).toBe(ser({ ...o, seed: 3 }))
      expect(ser({ ...o, seed: 3 })).not.toBe(ser({ ...o, seed: 4 }))
    }
  })

  it('pitch and key change the notes; unknown names list the valid ones', () => {
    const ser = (o: Parameters<typeof composeSfx>[0]) => {
      const r = composeSfx(o)
      r.song.id = 'x'
      return serializeProject(r.song)
    }
    expect(ser({ kind: 'sfx', sound: 'coin', seed: 0, pitch: 5 })).not.toBe(ser({ kind: 'sfx', sound: 'coin', seed: 0 }))
    expect(ser({ kind: 'stinger', sound: 'success', seed: 0, key: 'D' })).not.toBe(ser({ kind: 'stinger', sound: 'success', seed: 0 }))
    expect(() => composeSfx({ kind: 'sfx', sound: 'nope', seed: 1 })).toThrow(/coin, jump, hit/)
    expect(() => composeSfx({ kind: 'stinger' as SfxKind, sound: 'coin', seed: 1 })).toThrow(/success, fail/)
    expect(() => composeSfx({ kind: 'sfx', sound: 'coin', seed: 1, key: 'H' })).toThrow(/Invalid key/)
  })

  it('stingers hold their last chord and leave a beat of silence after it', () => {
    const r = composeSfx({ kind: 'stinger', sound: 'success', chip: 'nes', seed: 1 })
    expect(r.song.patternLength).toBe(36) // 2 bars + one beat
  })
})

describe('compose_sfx tool', () => {
  it('opens the sound as the current song and returns the JSON object last', async () => {
    const t = songSetup()
    const before = t.session.song.id
    const r = await t.ok('compose_sfx', { kind: 'sfx', sound: 'coin', seed: 2 })
    const j = lastJson(r)
    expect(j).toMatchObject({ kind: 'sfx', sound: 'coin', chip: 'nes', seed: 2, loop: null })
    expect(j['songId']).toBe(t.session.song.id)
    expect(j['durationSec']).toBeCloseTo(songSeconds(t.session.song), 2)
    expect(resultText(r)).toMatch(/Made sfx "coin"/)
    expect(t.session.song.id).not.toBe(before)
  })

  it('renders to a file with path: the one-shot gets its tail, the ambience loop ends at the file end', async () => {
    const t = songSetup()
    const a = lastJson(await t.ok('compose_sfx', { kind: 'sfx', sound: 'explosion', chip: 'snes', seed: 1, path: '/mem/out/boom.wav', format: 'wav' }))
    expect(a['path']).toBe('/mem/out/boom.wav')
    expect(a['loopStartSec']).toBeNull()
    const wavA = readWav(t.services.files.get('/mem/out/boom.wav')!)
    expect(wavA.length / 44100).toBeCloseTo(a['durationSec'] as number, 2)
    const b = lastJson(await t.ok('compose_sfx', { kind: 'ambience', sound: 'rain', chip: 'gb', seconds: 8, seed: 1, path: '/mem/out/rain.wav', format: 'wav' }))
    const wavB = readWav(t.services.files.get('/mem/out/rain.wav')!)
    expect(b).toMatchObject({ loopStartSec: 0, loopStartSample: 0 })
    expect(b['loopEndSample']).toBe(wavB.length)
    expect(wavB.length / 44100).toBeCloseTo(8, 1)
  })

  it('an unknown sound is an error result that lists the names; bad arguments are rejected', async () => {
    const t = songSetup()
    const r = await t.call('compose_sfx', { kind: 'ambience', sound: 'coin' })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/wind, rain, waves/)
    expect((await t.call('compose_sfx', { kind: 'music', sound: 'coin' })).isError).toBe(true)
    expect((await t.call('compose_sfx', { kind: 'sfx', sound: 'coin', pitch: 20 })).isError).toBe(true)
  })
})
