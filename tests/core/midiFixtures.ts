// Songs for the MIDI export tests: composed songs on every chip and hand-built songs with N melodic channels.

import { type ChipId, type Song, createSong, getPattern, resolvePreset } from '../../src/core'
import { composeSong } from '../../src/tools'

const ROLES = ['lead', 'pad', 'bass', 'arp', 'pluck', 'bell', 'brass', 'strings', 'choir', 'organ', 'flute'] as const

/** A PS1 (24 voices) or Dreamcast (64 slots) song with notes on V1..V<melodic> (each its own preset by role; `sameRole` gives every voice the lead preset). */
export function melodicSong(melodic: number, opts: { chip?: ChipId; sameRole?: boolean } = {}): Song {
  const chip = opts.chip ?? 'ps1'
  const song = createSong({ chip, name: `Melodic ${melodic}`, patternLength: 16, chipConfig: { voices: chip === 'ps1' ? 24 : 64 } as never })
  song.loop = null
  for (let i = 0; i < melodic; i++) {
    const role = opts.sameRole ? 'lead' : ROLES[i % ROLES.length]!
    const inst = resolvePreset(chip, role)
    inst.name = `${inst.name}-${i}`
    song.instruments.push(inst)
    const p = getPattern(song, `V${i + 1}`, 0)
    for (let r = 0; r < 4; r++) p.rows[r * 4] = { note: 48 + ((i * 3 + r * 2) % 24), inst: i, vol: 8 + ((i + r) % 8) }
    p.rows[15] = { note: 'off' }
  }
  return song
}

/** Songs whose exports must stay byte-identical (15 or fewer melodic channels). */
export function exportFixtures(): { name: string; song: Song }[] {
  const composed: [string, ChipId, number][] = [
    ['heroic', 'nes', 1],
    ['battle', 'gb', 2],
    ['chill', 'genesis', 3],
    ['ambient', 'snes', 1],
    ['overworld', 'pce', 4],
    ['synthwave', 'ps1', 1],
    ['outrun', 'dreamcast', 1],
    ['darkwave', 'ps1', 2]
  ]
  const out = composed.map(([mood, chip, seed]) => ({ name: `${mood} ${chip} ${seed}`, song: composeSong({ mood, chip, seed, bars: 8 }).song }))
  out.push({ name: 'melodic 15', song: melodicSong(15) }, { name: 'melodic 14 same program', song: melodicSong(14, { sameRole: true }) }, { name: 'melodic 15 dreamcast', song: melodicSong(15, { chip: 'dreamcast' }) })
  return out
}
