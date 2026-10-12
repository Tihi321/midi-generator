// Drum pattern library: 16-step lanes per drum role, plus a helper that folds the lanes into one
// string for a single drum channel (write_drums format).

import type { Role } from '../types'

export type DrumRole = 'kick' | 'snare' | 'hihat' | 'openhat' | 'crash' | 'tom' | 'clap'
export const DRUM_ROLES: readonly DrumRole[] = ['kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'clap']

export interface DrumStyle {
  id: string
  name: string
  description: string
  moods: string[]
  /** Suggested BPM range. */
  bpm: [number, number]
  /** One bar of 16 sixteenth-note steps per role; 'x' = hit, '.' = rest. Missing roles are silent. */
  lanes: Partial<Record<DrumRole, string>>
  /** One-bar fill that replaces the snare/tom lanes on the last bar of a phrase. */
  fill?: Partial<Record<DrumRole, string>>
}

const FILL_SNARE: Partial<Record<DrumRole, string>> = { snare: '........xxxxxxxx', kick: 'x.......' + '........' }
const FILL_TOM: Partial<Record<DrumRole, string>> = { snare: '........x.x.x.x.', tom: '............xxxx', kick: 'x...x...' + '........' }

const S = (
  id: string, name: string, description: string, moods: string[], bpm: [number, number],
  lanes: Partial<Record<DrumRole, string>>, fill: Partial<Record<DrumRole, string>> = FILL_SNARE
): DrumStyle => ({ id, name, description, moods, bpm, lanes, fill })

export const DRUM_STYLES: DrumStyle[] = [
  S('rock', 'Rock', 'Straight rock beat: kick on 1 and 3, snare on 2 and 4, eighth-note hats.', ['heroic', 'overworld', 'battle'], [100, 150], {
    kick: 'x.......x.x.....', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.'
  }),
  S('driving', 'Driving eighths', 'Kick pushes on the off-beats; relentless forward motion.', ['battle', 'overworld', 'heroic'], [130, 170], {
    kick: 'x.x.x.x.x.x.x.x.', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.'
  }),
  S('four-floor', 'Four on the floor', 'Kick on every beat, open hat on the off-beat: dance/chase energy.', ['battle', 'boss', 'overworld'], [120, 160], {
    kick: 'x...x...x...x...', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.', openhat: '..x...x...x...x.'
  }),
  S('halftime', 'Half-time', 'Snare only on beat 3: heavy, slow-feeling.', ['boss', 'dungeon', 'sad'], [120, 160], {
    kick: 'x.........x.....', snare: '........x.......', hihat: 'x.x.x.x.x.x.x.x.'
  }),
  S('breakbeat', 'Breakbeat', 'Syncopated kick with a ghosted snare.', ['battle', 'boss'], [130, 170], {
    kick: 'x.....x...x.....', snare: '....x.......x..x', hihat: 'x.x.x.x.x.x.x.x.'
  }),
  S('march', 'March', 'Snare roll-feel on every 8th with a kick on 1 and 3.', ['castle', 'heroic', 'victory'], [100, 130], {
    kick: 'x.......x.......', snare: 'x.x.x.x.x.x.x.x.', hihat: '................'
  }),
  S('gallop', 'Gallop', 'Kick gallop (1 e-and a) with a backbeat snare: urgent.', ['battle', 'boss'], [150, 190], {
    kick: 'x.xx.xx.x.xx.xx.', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.', crash: 'x...............'
  }),
  S('double-kick', 'Double kick', 'Dense kick pattern under a snare backbeat: boss-fight intensity.', ['boss', 'battle'], [150, 190], {
    kick: 'x.xxx.xxx.xxx.x.', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.', crash: 'x...............'
  }),
  S('lofi', 'Lo-fi chill', 'Lazy kick and snare with light hats and a ghost note.', ['chill', 'shop', 'town'], [70, 100], {
    kick: 'x......x..x.....', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.xx'
  }, FILL_TOM),
  S('bossa', 'Bossa', 'Latin-flavoured kick with clap on the off-beats: shop and lounge.', ['shop', 'chill', 'town'], [90, 130], {
    kick: 'x..x..x...x..x..', clap: '..x..x...x..x...', hihat: 'x.x.x.x.x.x.x.x.'
  }, FILL_TOM),
  S('ballad', 'Ballad', 'Sparse: kick on 1 and 3, snare on 3, long space.', ['sad', 'chill', 'game-over'], [60, 90], {
    kick: 'x.......x.......', snare: '........x.......', hihat: 'x...x...x...x...'
  }, FILL_TOM),
  S('dungeon-sparse', 'Sparse toms', 'Slow kick and answering toms: tension without a groove.', ['dungeon', 'spooky', 'underwater'], [70, 100], {
    kick: 'x.......x.......', tom: '....x.......x.x.'
  }, FILL_TOM),
  S('heartbeat', 'Heartbeat', 'Double kick like a pulse: unease.', ['spooky', 'dungeon'], [60, 90], {
    kick: 'x.x.........x.x.', hihat: '................'
  }, FILL_TOM),
  S('arcade-rush', 'Arcade rush', 'Fast kick and sixteenth hats: speed-run energy.', ['battle', 'overworld'], [160, 200], {
    kick: 'x.xx.xx.x.xx.xx.', snare: '..x...x...x...x.', hihat: 'xxxxxxxxxxxxxxxx'
  }),
  S('funk', 'Funk', 'Syncopated kick and snare ghosts over sixteenth hats.', ['town', 'shop', 'overworld'], [90, 120], {
    kick: 'x..x..x...x..x..', snare: '....x..x.x..x...', hihat: 'xxxxxxxxxxxxxxxx'
  }),
  S('fanfare', 'Fanfare', 'Four-on-the-floor kick with snare build and a crash on the downbeat.', ['victory', 'heroic', 'title'], [110, 150], {
    kick: 'x...x...x...x...', snare: '..x...x...x...xx', crash: 'x...............', hihat: 'x.x.x.x.x.x.x.x.'
  }),
  S('town-skip', 'Town skip', 'Bouncy kick, off-beat hats and claps: friendly.', ['town', 'overworld'], [100, 130], {
    kick: 'x...x...x...x...', clap: '....x.......x...', hihat: '..x...x...x...x.'
  }, FILL_TOM),
  S('underwater', 'Underwater', 'Slow kick, rare hat: watery drift.', ['underwater', 'chill'], [60, 90], {
    kick: 'x...............', hihat: '..x.......x.....', tom: '..........x.....'
  }, FILL_TOM),
  S('darbuka', 'Darbuka', 'Hand-drum feel: kick/tom pattern with syncopation.', ['desert'], [90, 130], {
    kick: 'x..x....x...x...', tom: '..x...x...x.x...', hihat: 'x.x.x.x.x.x.x.x.'
  }, FILL_TOM),
  S('castle-march', 'Castle march', 'Stately kick and a snare that leans into beat 4.', ['castle', 'boss'], [90, 130], {
    kick: 'x.......x.......', snare: '....x.......x.x.', hihat: 'x...x...x...x...', crash: 'x...............'
  }),
  S('title-pulse', 'Title pulse', 'Gentle kick with offbeat hats for a title screen.', ['title', 'overworld'], [90, 120], {
    kick: 'x.......x.......', hihat: '..x...x...x...x.', snare: '....x.......x...'
  })
]

export function findDrumStyle(id: string): DrumStyle | undefined {
  const k = id.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return DRUM_STYLES.find((s) => s.id === k)
}

export function requireDrumStyle(id: string): DrumStyle {
  const s = findDrumStyle(id)
  if (!s) throw new Error(`Unknown drum style "${id}". Valid styles: ${DRUM_STYLES.map((x) => x.id).join(', ')}.`)
  return s
}

export function drumStylesForMood(mood: string): DrumStyle[] {
  const k = mood.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return DRUM_STYLES.filter((s) => s.moods.includes(k))
}

/** One character per role in a combined single-channel string, with the role it stands for. */
export const DRUM_LEGEND: Record<DrumRole, string> = { kick: 'K', snare: 'S', hihat: 'h', openhat: 'o', crash: 'C', tom: 'T', clap: 'c' }

/** When several drums hit on the same step but the channel plays one sound, the first role in this list wins. */
export const DRUM_PRIORITY: DrumRole[] = ['crash', 'snare', 'clap', 'kick', 'tom', 'openhat', 'hihat']

/** Merge lanes (any length) into a single step string using the DRUM_LEGEND characters. */
export function combineLanes(lanes: Partial<Record<DrumRole, string>>): { steps: string; legend: Record<string, string> } {
  const len = Math.max(0, ...Object.values(lanes).map((l) => l?.length ?? 0))
  let steps = ''
  const used = new Set<DrumRole>()
  for (let i = 0; i < len; i++) {
    let ch = '.'
    for (const role of DRUM_PRIORITY) {
      if (lanes[role]?.[i] === 'x') {
        ch = DRUM_LEGEND[role]
        used.add(role)
        break
      }
    }
    steps += ch
  }
  const legend: Record<string, string> = {}
  for (const role of DRUM_ROLES) if (used.has(role)) legend[DRUM_LEGEND[role]] = role
  return { steps, legend }
}

export interface DrumPatternOptions {
  /** Bars to produce (default 1). */
  bars?: number
  /** Replace the last bar with the style's fill (only when bars > 1). */
  fill?: boolean
}

export interface DrumPattern {
  style: string
  bars: number
  /** Per-role lanes over all bars ('x' hits), for songs with separate drum channels. */
  lanes: Partial<Record<DrumRole, string>>
  /** Single-channel form: steps + legend ready for write_drums. */
  steps: string
  legend: Record<string, string>
}

export function getDrumPattern(styleId: string, opts: DrumPatternOptions = {}): DrumPattern {
  const style = requireDrumStyle(styleId)
  const bars = Math.max(1, Math.floor(opts.bars ?? 1))
  const lanes: Partial<Record<DrumRole, string>> = {}
  for (const role of DRUM_ROLES) {
    const base = style.lanes[role]
    const fill = style.fill?.[role]
    if (!base && !(opts.fill && bars > 1 && fill)) continue
    let s = ''
    for (let b = 0; b < bars; b++) {
      const isFill = !!opts.fill && bars > 1 && b === bars - 1
      s += isFill && style.fill ? (fill ?? (role === 'snare' || role === 'tom' ? '.'.repeat(16) : (base ?? '.'.repeat(16)))) : (base ?? '.'.repeat(16))
    }
    lanes[role] = s
  }
  const combined = combineLanes(lanes)
  return { style: style.id, bars, lanes, steps: combined.steps, legend: combined.legend }
}

/** True for roles that make sense as drum hits. */
export function isDrumLaneRole(role: Role): role is DrumRole {
  return (DRUM_ROLES as readonly string[]).includes(role)
}
