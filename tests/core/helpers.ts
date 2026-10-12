import { type ChipId, type Song, createSong } from '../../src/core/model'
import { createInstrumentCommand } from '../../src/core/commands'
import { resolvePreset } from '../../src/core/instruments'

/** Create a song and add preset instruments for the given refs (ids or roles); returns indices by ref. */
export function songWithPresets(chip: ChipId, refs: { ref: string; kind?: Parameters<typeof resolvePreset>[2]; name?: string }[], opts: Partial<Parameters<typeof createSong>[0]> = {}): { song: Song; idx: Record<string, number> } {
  const song = createSong({ chip, patternLength: 32, ...opts })
  const idx: Record<string, number> = {}
  for (const r of refs) {
    const inst = resolvePreset(chip, r.ref, r.kind)
    if (r.name) inst.name = r.name
    const cmd = createInstrumentCommand(song, { op: 'add', instrument: inst })
    cmd.apply(song)
    idx[r.name ?? inst.name] = cmd.createdIndex
  }
  return { song, idx }
}

/** Deterministic PRNG for randomized tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
