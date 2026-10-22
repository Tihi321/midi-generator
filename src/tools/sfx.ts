// Procedural sound effects, stingers and ambience behind compose_sfx: short songs built on the existing model and
// presets. Pure and deterministic: the same options (including the seed) give the same song. No DOM, no Electron,
// no node:*.
//
//   sfx       one-shot effects (coin, jump, laser, ...) written row by row at 300 BPM (a row is 50 ms), so pitch
//             slides are rows of notes and work on every chip. One tone voice (lead channel, other instrument per
//             note) plus the chip's drum channels as noise bursts. The song is exactly as long as the effect; the
//             renderer adds its own tail for the release.
//   stinger   1-2 bars on the chip's lead, pad and bass voices in a key, ending on a held chord, then one beat of silence.
//   ambience  a loop over the whole song (loop end == song end): noise bursts whose level follows one slow cycle per
//             loop (so both ends have the same level), sparse tones, an optional low drone in the key.

import {
  type Cell,
  type ChannelDef,
  type ChannelState,
  type ChipId,
  type Instrument,
  type Role,
  type Song,
  ROLE_CHANNELS,
  createSong,
  defaultDrumNote,
  degreeToMidi,
  listPresets,
  normalizePitchClass,
  requireChipId,
  requireScale,
  romanToChord,
  songChannelDefs,
  songSeconds,
  validateSong
} from '../core'
import { addSongInstrument, foldIntoRange, presetFor, snapVolume, writeChannelPatterns } from '../core/codecs/songBuild'
import { createRng } from './composer'

export type SfxKind = 'sfx' | 'stinger' | 'ambience'

export const SFX_SOUNDS: Record<SfxKind, string[]> = {
  sfx: ['coin', 'jump', 'hit', 'explosion', 'laser', 'powerup', 'blip', 'confirm', 'cancel', 'door', 'footstep', 'chime', 'magic', 'heal', 'alert', 'text', 'thunder'],
  stinger: ['success', 'fail', 'reveal', 'danger', 'sad', 'mystery', 'discovery', 'romance', 'level-up'],
  ambience: ['wind', 'rain', 'waves', 'cave', 'night', 'fire', 'drone', 'machine']
}

export interface SfxOptions {
  kind: SfxKind
  /** One of SFX_SOUNDS[kind]. */
  sound: string
  /** Default: nes for sfx, snes for stingers and ambience. */
  chip?: string
  /** Tonic of stingers and of drones (default C). */
  key?: string
  /** Ambience length (default 16, 4..120), rounded to whole bars. */
  seconds?: number
  /** Semitones added to the pitched notes of sfx and stingers (-12..12). */
  pitch?: number
  seed: number
  songName?: string
}

export interface SfxResult {
  song: Song
  kind: SfxKind
  sound: string
  chip: ChipId
  seed: number
  bpm: number
  durationSec: number
  loop: { startBar: number; endBar: number } | null
}

const ROWS_PER_BAR = 16
const DRUM_ORDER: Role[] = ['hihat', 'openhat', 'snare', 'crash', 'tom', 'kick', 'clap']

export function sfxSoundNames(kind: SfxKind): string[] {
  return SFX_SOUNDS[kind]
}

// ---------------------------------------------------------------------------------------------- builder

interface Builder {
  rng: () => number
  /** Semitones added to tone() / bass() notes (the pitch option plus the seeded variation). */
  shift: number
  /** A pitched note on the lead channel; `role` picks the preset (default lead). Released after `len` rows. */
  tone: (row: number, midi: number, len: number, vol: number, role?: Role) => void
  /** A noise burst (a drum preset on the chip's drum channels). */
  noise: (row: number, role: Role, vol: number) => void
  /** The low voice. */
  bass: (row: number, midi: number, len: number, vol: number) => void
  /** Chord voice k (0, 1); with one pad channel both land on it, the first wins. */
  pad: (k: number, row: number, midi: number, len: number, vol: number) => void
  hasPad2: boolean
}

function makeBuilder(song: Song, seed: number, shift: number): { b: Builder; cells: Map<number, Map<number, Cell>>; ends: () => number } {
  const chip = song.chip
  const table = ROLE_CHANNELS[chip]
  const defs: ChannelDef[] = songChannelDefs(song)
  const idxOf = (id: string): number => song.channels.findIndex((c: ChannelState) => c.id === id)
  const first = (roles: Role[]): number => {
    for (const r of roles) for (const id of table[r] ?? []) if (idxOf(id) >= 0) return idxOf(id)
    return -1
  }
  const leadCh = first(['lead'])
  const bassCh = first(['bass'])
  const padChs: number[] = []
  for (const r of ['pad', 'strings', 'organ'] as Role[]) {
    for (const id of table[r] ?? []) {
      const i = idxOf(id)
      if (i >= 0 && i !== leadCh && i !== bassCh && song.channels[i]!.kind !== 'noise' && !padChs.includes(i)) padChs.push(i)
    }
  }
  const drumCh = new Map<Role, number>()
  for (const role of DRUM_ORDER) {
    for (const id of table[role] ?? []) {
      const i = idxOf(id)
      if (i < 0 || i === leadCh || i === bassCh || padChs.includes(i)) continue
      if (listPresets(chip, { role, channelKind: song.channels[i]!.kind }).length === 0) continue
      drumCh.set(role, i)
      break
    }
  }
  const cells = new Map<number, Map<number, Cell>>()
  let last = 0
  const instCache = new Map<string, number>()
  const inst = (ch: number, role: Role): number => {
    const key = `${ch}:${role}`
    let n = instCache.get(key)
    if (n === undefined) {
      const i: Instrument = presetFor(chip, role, song.channels[ch]!.kind)
      n = addSongInstrument(song, i)
      instCache.set(key, n)
    }
    return n
  }
  const vol = (def: ChannelDef | undefined, v: number): number | undefined => {
    if (!def || !def.hasVolume) return undefined
    const x = Math.max(1, Math.min(15, Math.round(v)))
    return def.volumeSteps ? snapVolume(x, def) : x
  }
  const put = (ch: number, row: number, cell: Cell): void => {
    if (ch < 0 || row < 0) return
    let m = cells.get(ch)
    if (!m) cells.set(ch, (m = new Map()))
    m.set(row, cell)
    last = Math.max(last, row + 1)
  }
  const note = (ch: number, row: number, midi: number, len: number, v: number, role: Role, drum = false): void => {
    if (ch < 0) return
    const def = defs[ch]
    const n = drum ? defaultDrumNote(role, song.channels[ch]!.kind) : foldIntoRange(midi, def?.noteMin ?? 0, def?.noteMax ?? 127).note
    const vv = vol(def, v)
    put(ch, row, { note: n, inst: inst(ch, role), ...(vv !== undefined ? { vol: vv } : {}) })
    if (len > 0 && !drum) releases.push([ch, row + len])
  }
  const releases: [number, number][] = []
  const b: Builder = {
    rng: createRng(seed),
    shift,
    tone: (row, midi, len, v, role = 'lead') => note(leadCh, row, midi + shift, len, v, role),
    noise: (row, role, v) => {
      // a chip without that drum plays the nearest one it has
      const r = drumCh.has(role) ? role : DRUM_ORDER.find((x) => drumCh.has(x))
      if (r) note(drumCh.get(r)!, row, 0, 0, v, r, true)
    },
    bass: (row, midi, len, v) => note(bassCh, row, midi, len, v, 'bass'),
    pad: (k, row, midi, len, v) => {
      const ch = padChs[Math.min(k, padChs.length - 1)]
      if (ch !== undefined) note(ch, row, midi, len, v, k === 0 ? 'pad' : 'strings')
    },
    hasPad2: padChs.length >= 2
  }
  const ends = (): number => {
    for (const [ch, row] of releases) if (!cells.get(ch)?.has(row)) put(ch, row, { note: 'rel' })
    return last
  }
  return { b, cells, ends }
}

// ---------------------------------------------------------------------------------------------- sfx

const MAJ_PENT = [0, 2, 4, 7, 9]

const SFX: Record<string, (b: Builder) => void> = {
  coin: (b) => {
    b.tone(0, 83, 2, 13, 'bell')
    b.tone(2, 88, 10, 13, 'bell')
  },
  jump: (b) => {
    for (let i = 0; i < 7; i++) b.tone(i, 60 + i * 2, 1, 12, 'sfx')
    b.tone(7, 74, 2, 8, 'sfx')
  },
  hit: (b) => {
    b.noise(0, 'snare', 15)
    for (let i = 0; i < 4; i++) b.tone(i, 57 - i * 4, 1, 11 - i, 'sfx')
    b.noise(2, 'hihat', 8)
  },
  explosion: (b) => {
    b.noise(0, 'crash', 15)
    b.noise(4, 'openhat', 12)
    b.noise(7, 'snare', 11)
    b.noise(10, 'kick', 12)
    b.noise(14, 'openhat', 8)
    b.noise(19, 'kick', 7)
    for (let i = 0; i < 22; i++) b.tone(i, 52 - Math.floor(i * 1.1), 1, 11 - Math.floor(i / 3), 'bass')
  },
  laser: (b) => {
    for (let i = 0; i < 9; i++) b.tone(i, 96 - i * 5, 1, 13 - Math.floor(i / 3), 'sfx')
  },
  powerup: (b) => {
    ;[60, 64, 67, 72, 76, 79, 84].forEach((m, i) => b.tone(i * 2, m, 2, 12, 'lead'))
    b.tone(14, 88, 6, 13, 'bell')
  },
  blip: (b) => b.tone(0, 79, 2, 12),
  confirm: (b) => {
    b.tone(0, 72, 2, 12)
    b.tone(2, 79, 5, 13)
  },
  cancel: (b) => {
    b.tone(0, 67, 2, 12)
    b.tone(2, 60, 5, 12)
  },
  door: (b) => {
    for (let i = 0; i < 8; i++) b.tone(i, 40 + Math.floor(i * 0.9), 1, 7, 'sfx')
    b.noise(9, 'kick', 12)
    b.noise(9, 'hihat', 6)
    b.noise(11, 'tom', 6)
  },
  footstep: (b) => {
    b.noise(0, 'kick', 8)
    b.noise(1, 'hihat', 7)
    b.noise(3, 'hihat', 3)
  },
  chime: (b) => {
    b.tone(0, 84, 4, 12, 'bell')
    b.tone(3, 88, 4, 11, 'bell')
    b.tone(6, 91, 12, 11, 'bell')
  },
  magic: (b) => {
    for (let i = 0; i < 14; i++) {
      const deg = MAJ_PENT[Math.floor(b.rng() * 5)]! + 12 * (i % 2)
      b.tone(i, 76 + deg, 2, 11 - Math.floor(i / 4), 'bell')
    }
    b.tone(14, 100, 6, 8, 'bell')
  },
  heal: (b) => {
    ;[67, 71, 74, 79].forEach((m, i) => b.tone(i * 2, m, 3, 11, 'bell'))
    b.tone(8, 83, 10, 12, 'bell')
  },
  alert: (b) => {
    for (let i = 0; i < 3; i++) b.tone(i * 4, 84, 2, 13, 'sfx')
  },
  text: (b) => b.tone(0, 72 + Math.floor(b.rng() * 3) * 2, 1, 10),
  thunder: (b) => {
    b.noise(0, 'crash', 15)
    for (let i = 0; i < 9; i++) b.noise(2 + i * 3, i % 2 === 0 ? 'kick' : 'openhat', Math.max(3, 13 - i))
    for (let i = 0; i < 28; i++) b.tone(i, 46 - Math.floor(i / 2), 1, 10 - Math.floor(i / 4), 'bass')
  }
}

// ---------------------------------------------------------------------------------------------- stingers

/** [numeral, row, length] */
type ChordStep = [string, number, number]
/** [scale degree (0 = tonic, 7 = an octave up), row, length] */
type LeadStep = [number, number, number]
interface Stinger {
  scale: string
  bpm: number
  bars: number
  chords: ChordStep[]
  lead: LeadStep[]
}

const STINGERS: Record<string, Stinger> = {
  success: { scale: 'major', bpm: 132, bars: 2, chords: [['I', 0, 8], ['V', 8, 8], ['I', 16, 16]], lead: [[0, 0, 2], [2, 2, 2], [4, 4, 2], [7, 6, 6], [4, 12, 4], [7, 16, 16]] },
  fail: { scale: 'minor', bpm: 104, bars: 2, chords: [['i', 0, 8], ['iv', 8, 8], ['i', 16, 16]], lead: [[4, 0, 4], [3, 4, 4], [2, 8, 4], [0, 12, 4], [0, 16, 16]] },
  reveal: { scale: 'major', bpm: 112, bars: 2, chords: [['vi', 0, 8], ['IV', 8, 8], ['I', 16, 16]], lead: [[2, 0, 6], [4, 6, 2], [7, 8, 6], [9, 14, 2], [9, 16, 16]] },
  danger: { scale: 'phrygian', bpm: 140, bars: 2, chords: [['i', 0, 16], ['v', 16, 16]], lead: [[0, 0, 2], [0, 4, 2], [1, 8, 2], [0, 12, 2], [0, 16, 2], [1, 20, 2], [3, 24, 8]] },
  sad: { scale: 'minor', bpm: 104, bars: 2, chords: [['i', 0, 8], ['v', 8, 8], ['i', 16, 16]], lead: [[4, 0, 6], [3, 6, 2], [2, 8, 8], [2, 16, 6], [0, 22, 10]] },
  mystery: { scale: 'dorian', bpm: 108, bars: 2, chords: [['i', 0, 16], ['iv', 16, 16]], lead: [[0, 0, 2], [4, 4, 2], [2, 8, 2], [6, 12, 4], [3, 16, 16]] },
  discovery: { scale: 'lydian', bpm: 116, bars: 2, chords: [['I', 0, 8], ['IV', 8, 8], ['I', 16, 16]], lead: [[0, 0, 2], [2, 2, 2], [4, 4, 2], [6, 6, 2], [8, 8, 8], [7, 16, 16]] },
  romance: { scale: 'major', bpm: 100, bars: 2, chords: [['I', 0, 8], ['vi', 8, 8], ['IV', 16, 8], ['I', 24, 8]], lead: [[4, 0, 6], [5, 6, 2], [4, 8, 4], [2, 12, 4], [3, 16, 6], [2, 22, 2], [0, 24, 8]] },
  'level-up': { scale: 'major', bpm: 140, bars: 2, chords: [['I', 0, 8], ['IV', 8, 8], ['V', 16, 8], ['I', 24, 8]], lead: [[0, 0, 2], [2, 2, 2], [4, 4, 2], [7, 6, 2], [9, 8, 2], [11, 10, 2], [14, 12, 4], [7, 16, 2], [9, 18, 2], [11, 20, 2], [14, 22, 2], [16, 24, 8]] }
}

function buildStinger(b: Builder, st: Stinger, key: string): number {
  const end = st.bars * ROWS_PER_BAR
  const nearPitch = (pc: number, center: number): number => {
    let m = center + (((pc - center) % 12) + 12) % 12
    if (m - center > 6) m -= 12
    return m
  }
  for (const [numeral, row, len] of st.chords) {
    const c = romanToChord(numeral, key, 3)
    const iv = c.intervals
    const l = Math.min(len, end - row)
    b.bass(row, 36 + c.root + b.shift, l, 12)
    b.pad(0, row, nearPitch((c.root + iv[1]!) % 12, 62) + b.shift, l, 8)
    b.pad(1, row, nearPitch((c.root + (iv[2] ?? iv[1]!)) % 12, 68) + b.shift, l, 8)
  }
  for (const [deg, row, len] of st.lead) b.tone(row, degreeToMidi(key, st.scale, deg, 5), Math.min(len, end - row), row % 8 === 0 ? 12 : 11)
  return end + 4 // one beat of room for the release
}

// ---------------------------------------------------------------------------------------------- ambience

const AMB_BPM = 120

/** Slow cycle over the whole loop, 0..1, periodic so both ends of the loop have the same level. */
const swell = (row: number, total: number, phase = 0): number => 0.5 + 0.5 * Math.sin(2 * Math.PI * (row / total + phase))

function buildAmbience(b: Builder, sound: string, total: number, key: string): void {
  const rootPc = romanToChord('I', key, 3).root
  const drone = (low: number, v: number): void => {
    for (let row = 0; row < total; row += 4 * ROWS_PER_BAR) {
      b.bass(row, low + rootPc, 4 * ROWS_PER_BAR, v)
      b.pad(0, row, 48 + rootPc + 7, 4 * ROWS_PER_BAR, Math.max(2, v - 4))
    }
  }
  const lv = (base: number, amp: number, row: number, phase = 0): number => base + amp * swell(row, total, phase)
  switch (sound) {
    case 'rain':
      for (let row = 0; row < total; row++) if (row % 5 !== 4) b.noise(row, 'hihat', lv(3, 4, row) + b.rng() * 3)
      break
    case 'wind':
      for (let row = 0; row < total; row += 3) b.noise(row, 'openhat', lv(3, 6, row))
      break
    case 'waves':
      for (let row = 0; row < total; row += 16) {
        b.noise(row, 'crash', lv(5, 8, row))
        b.noise(row + 5, 'openhat', lv(3, 4, row))
        b.noise(row + 9, 'hihat', lv(2, 3, row))
      }
      break
    case 'cave':
      drone(24, 6)
      for (let row = 6; row < total; row += 10 + Math.floor(b.rng() * 14)) b.tone(row, 84 + MAJ_PENT[Math.floor(b.rng() * 5)]!, 3, 4 + Math.floor(b.rng() * 4), 'bell')
      break
    case 'night':
      drone(24, 4)
      for (let row = 0; row < total; row++) if (row % 16 < 6 && row % 2 === 0) b.tone(row, 93, 1, lv(2, 4, row), 'lead')
      break
    case 'fire':
      for (let row = 0; row < total; row++) {
        if (row % 4 === 0) b.noise(row, 'openhat', lv(2, 2, row))
        if (b.rng() < 0.4) b.noise(row, b.rng() < 0.5 ? 'hihat' : 'clap', 3 + Math.floor(b.rng() * 6))
      }
      break
    case 'drone':
      drone(36, 10)
      break
    case 'machine':
      drone(24, 6)
      for (let row = 0; row < total; row += 4) {
        b.noise(row, 'kick', 8)
        b.noise(row + 2, 'hihat', 5)
      }
      for (let row = 0; row < total; row += 16) b.tone(row + 8, 72 + rootPc, 1, 4, 'lead')
      break
  }
}

// ---------------------------------------------------------------------------------------------- compose

export function composeSfx(opts: SfxOptions): SfxResult {
  const names = SFX_SOUNDS[opts.kind]
  if (!names) throw new Error(`Unknown kind "${opts.kind}": use sfx, stinger or ambience.`)
  if (!names.includes(opts.sound)) throw new Error(`Unknown ${opts.kind} "${opts.sound}". The ${opts.kind} sounds are: ${names.join(', ')}.`)
  const chip = requireChipId(opts.chip ?? (opts.kind === 'sfx' ? 'nes' : 'snes'))
  const keyPc = normalizePitchClass(opts.key ?? 'C')
  if (!keyPc) throw new Error(`Invalid key "${opts.key}": use a note name such as C, F#, Bb.`)
  const pitch = Math.max(-12, Math.min(12, Math.round(opts.pitch ?? 0)))
  const rng = createRng((opts.seed ^ 0x9e3779b9) >>> 0)
  // the seed moves a one-shot by up to a semitone, so repeated effects do not sound identical
  const jitter = opts.kind === 'ambience' ? 0 : Math.round(rng() * 2) - 1
  const shift = opts.kind === 'ambience' ? 0 : pitch + jitter

  const stinger = opts.kind === 'stinger' ? STINGERS[opts.sound]! : undefined
  if (stinger) requireScale(stinger.scale)
  let bpm = stinger?.bpm ?? 300
  let bars = 1
  if (opts.kind === 'ambience') {
    bpm = AMB_BPM
    const barSec = (60 / bpm) * 4
    bars = Math.max(1, Math.min(128, Math.round(Math.max(4, Math.min(120, opts.seconds ?? 16)) / barSec)))
  }
  const loopBars = opts.kind === 'ambience'
  const patternBars = loopBars ? [4, 2, 1].find((n) => bars % n === 0)! : 1

  const song = createSong({
    chip,
    name: opts.songName ?? `${opts.sound} (${opts.kind}, ${chip.toUpperCase()})`,
    bpm,
    key: keyPc,
    scale: stinger?.scale ?? 'major',
    tags: [opts.kind === 'sfx' ? 'sfx' : opts.kind],
    patternLength: loopBars ? patternBars * ROWS_PER_BAR : 64
  })
  song.meta.notes = `Made by compose_sfx (${opts.kind} ${opts.sound}, seed ${opts.seed}).`

  const { b, cells, ends } = makeBuilder(song, opts.seed, shift)
  let totalRows = 0
  if (stinger) totalRows = buildStinger(b, stinger, keyPc)
  else if (loopBars) {
    totalRows = bars * ROWS_PER_BAR
    buildAmbience(b, opts.sound, totalRows, keyPc)
  } else SFX[opts.sound]!(b)
  const used = ends()
  if (!loopBars) totalRows = Math.max(totalRows, used)

  if (loopBars) {
    song.orders = Array.from({ length: bars / patternBars }, () => song.channels.map(() => 0))
    song.patternLength = patternBars * ROWS_PER_BAR
  } else {
    song.patternLength = Math.max(1, Math.min(256, totalRows))
    song.orders = [song.channels.map(() => 0)]
  }
  song.channels.forEach((_, i) => {
    const m = cells.get(i)
    const linear: (Cell | null)[] = new Array<Cell | null>(totalRows).fill(null)
    if (m) for (const [row, cell] of m) if (row < totalRows) linear[row] = cell
    writeChannelPatterns(song, i, linear)
  })
  song.loop = loopBars ? { order: 0 } : null

  const problems = validateSong(song).filter((x) => x.severity === 'error')
  if (problems.length > 0) throw new Error(`The ${opts.sound} ${opts.kind} breaks ${chip.toUpperCase()} limits: ${problems.map((p) => p.message).slice(0, 3).join(' ')}`)

  return {
    song,
    kind: opts.kind,
    sound: opts.sound,
    chip,
    seed: opts.seed,
    bpm,
    durationSec: Math.round(songSeconds(song) * 1000) / 1000,
    loop: song.loop ? { startBar: 0, endBar: bars } : null
  }
}
