// Song fixtures built as plain object literals (no dependency on model.ts).
import type { Cell, ChannelState, Instrument, Pattern, Song } from '../../../src/core/types'

export function nesChannels(withDpcm = false): ChannelState[] {
  const ch: ChannelState[] = [
    { id: 'P1', name: 'Pulse 1', kind: 'pulse', fxColumns: 2 },
    { id: 'P2', name: 'Pulse 2', kind: 'pulse', fxColumns: 2 },
    { id: 'TR', name: 'Triangle', kind: 'triangle', fxColumns: 2 },
    { id: 'NO', name: 'Noise', kind: 'noise', fxColumns: 2 }
  ]
  if (withDpcm) ch.push({ id: 'DM', name: 'DPCM', kind: 'dpcm', fxColumns: 1 })
  return ch
}

export function gbChannels(): ChannelState[] {
  return [
    { id: 'P1', name: 'Pulse 1', kind: 'pulse', fxColumns: 2 },
    { id: 'P2', name: 'Pulse 2', kind: 'pulse', fxColumns: 2 },
    { id: 'WV', name: 'Wave', kind: 'wave', fxColumns: 2 },
    { id: 'NO', name: 'Noise', kind: 'noise', fxColumns: 2 }
  ]
}

export const NES_INSTRUMENTS: Instrument[] = [
  { kind: 'nes-pulse', name: 'plain', macros: {} },
  { kind: 'nes-tri', name: 'tri', macros: {} },
  { kind: 'nes-noise', name: 'hat', macros: { vol: { values: [12, 8, 4, 2, 0] }, arp: { values: [76], mode: 'fixed' } } },
  { kind: 'nes-pulse', name: 'decay', macros: { vol: { values: [15, 13, 11, 9, 7, 5, 3, 1, 0] }, timbre: { values: [1] } } }
]

export const GB_INSTRUMENTS: Instrument[] = [
  { kind: 'gb-pulse', name: 'lead', env: { init: 12, dir: 'down', pace: 3 }, duty: 2 },
  {
    kind: 'gb-wave',
    name: 'tri wave',
    wave: Array.from({ length: 32 }, (_, i) => (i < 16 ? i : 31 - i)),
    level: 1
  },
  { kind: 'gb-noise', name: 'snare', env: { init: 13, dir: 'down', pace: 2 } },
  { kind: 'gb-pulse', name: 'flat', env: { init: 15, dir: 'down', pace: 0 }, duty: 2 }
]

export interface SongOpts {
  patternLength?: number
  bpm?: number
  speed?: number
  rowsPerBeat?: number
  groove?: number[]
  /** orders[i][channel] = pattern number */
  orders?: number[][]
  loop?: { order: number } | null
  dpcm?: boolean
  mixModel?: 'nonlinear' | 'linear'
}

export function makeSong(chip: 'nes' | 'gb', opts: SongOpts = {}): Song {
  const channels = chip === 'nes' ? nesChannels(opts.dpcm) : gbChannels()
  return {
    format: 1,
    id: `test-${chip}`,
    name: `test ${chip}`,
    chip,
    chipConfig:
      chip === 'nes'
        ? { chip: 'nes', region: 'ntsc', dpcm: opts.dpcm ?? false, mixModel: opts.mixModel ?? 'nonlinear' }
        : { chip: 'gb' },
    authenticity: 'relaxed',
    meta: { key: 'C', scale: 'minor', moods: [], tags: [] },
    timing: {
      bpm: opts.bpm ?? 150,
      speed: opts.speed ?? 6,
      rowsPerBeat: opts.rowsPerBeat ?? 4,
      beatsPerBar: 4,
      ...(opts.groove ? { groove: opts.groove } : {})
    },
    patternLength: opts.patternLength ?? 16,
    channels,
    orders: opts.orders ?? [channels.map(() => 0)],
    patterns: new Map(),
    instruments: chip === 'nes' ? structuredClone(NES_INSTRUMENTS) : structuredClone(GB_INSTRUMENTS),
    samples: [],
    loop: opts.loop === undefined ? null : opts.loop,
    references: []
  }
}

/** Write a cell into pattern `pat` of channel `channelId` (creating the pattern when missing). */
export function put(song: Song, channelId: string, pat: number, row: number, cell: Cell): Song {
  const key = `${channelId}:${pat}` as const
  let p: Pattern | undefined = song.patterns.get(key)
  if (!p) {
    p = { rows: Array.from({ length: song.patternLength }, () => null) }
    song.patterns.set(key, p)
  }
  p.rows[row] = cell
  return song
}

/** Tiny NES song: lead, harmony, triangle bass and a noise beat, 2 orders, one-shot. */
export function tinyNes(): Song {
  const s = makeSong('nes', { patternLength: 16, orders: [[0, 0, 0, 0], [1, 1, 1, 1]] })
  const lead = [72, null, 75, null, 79, null, 75, null, 72, null, 67, null, 70, null, 'off', null] as const
  lead.forEach((n, r) => {
    if (n !== null) put(s, 'P1', 0, r, { note: n, inst: r === 0 ? 3 : undefined, vol: 14 })
  })
  put(s, 'P2', 0, 0, { note: 60, inst: 0, vol: 9, fx: [{ code: '0', param: 0x37 }] })
  put(s, 'P2', 0, 8, { note: 58, inst: 0 })
  put(s, 'TR', 0, 0, { note: 36, inst: 1 })
  put(s, 'TR', 0, 4, { note: 36 })
  put(s, 'TR', 0, 8, { note: 34 })
  put(s, 'TR', 0, 12, { note: 'off' })
  for (let r = 0; r < 16; r += 2) put(s, 'NO', 0, r, { note: 60 + (r % 4 === 0 ? 0 : 1), inst: 2 })
  put(s, 'P1', 1, 0, { note: 79, inst: 3, vol: 15, fx: [{ code: '4', param: 0x44 }] })
  put(s, 'P1', 1, 8, { note: 'off' })
  put(s, 'P2', 1, 0, { note: 55, inst: 0, vol: 8, fx: [{ code: 'W', param: 1 }] })
  put(s, 'TR', 1, 0, { note: 43, inst: 1 })
  put(s, 'TR', 1, 8, { note: 'rel' })
  put(s, 'NO', 1, 0, { note: 60, inst: 2 })
  put(s, 'NO', 1, 4, { note: 60, inst: 2 })
  return s
}

/** Tiny GB song, looping at order 1. */
export function tinyGb(): Song {
  const s = makeSong('gb', { patternLength: 16, orders: [[0, 0, 0, 0], [1, 1, 1, 1]], loop: { order: 1 } })
  put(s, 'P1', 0, 0, { note: 76, inst: 0 })
  put(s, 'P1', 0, 4, { note: 79 })
  put(s, 'P1', 0, 8, { note: 83, fx: [{ code: 'W', param: 1 }] })
  put(s, 'P1', 0, 12, { note: 'off' })
  put(s, 'P2', 0, 0, { note: 64, inst: 3, vol: 10 })
  put(s, 'WV', 0, 0, { note: 40, inst: 1 })
  put(s, 'WV', 0, 8, { note: 43 })
  put(s, 'NO', 0, 0, { note: 70, inst: 2 })
  put(s, 'NO', 0, 8, { note: 70, inst: 2 })
  put(s, 'P1', 1, 0, { note: 72, inst: 0, fx: [{ code: 'X', param: 0 }] })
  put(s, 'P1', 1, 6, { note: 67 })
  put(s, 'P2', 1, 0, { note: 60, inst: 3, vol: 10, fx: [{ code: 'X', param: 255 }] })
  put(s, 'P2', 1, 8, { note: 64 })
  put(s, 'WV', 1, 0, { note: 36, inst: 1 })
  put(s, 'WV', 1, 8, { note: 'rel' })
  put(s, 'NO', 1, 0, { note: 66, inst: 2 })
  put(s, 'NO', 1, 4, { note: 66, inst: 2 })
  put(s, 'NO', 1, 8, { note: 66, inst: 2 })
  put(s, 'NO', 1, 12, { note: 66, inst: 2 })
  return s
}
