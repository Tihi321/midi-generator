// compose_track without the MDI-05 options (intro, motif, variation) must give the very same song as before they existed.
// The hashes were taken from the composer before those options were added.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { serializeProject } from '../../src/core'
import { composeSong } from '../../src/tools'
import type { ComposeOptions } from '../../src/tools'

const CASES: Array<[ComposeOptions, string]> = [
  [{ mood: 'ambient', chip: 'snes', seed: 42, bars: 8 }, 'bc414d57a3a475e2337501c1'],
  [{ mood: 'lullaby', chip: 'gb', seed: 7, bars: 16 }, '7308129da06f8912c654c608'],
  [{ mood: 'peaceful', chip: 'nes', seed: 1, seconds: 30 }, '760a5e1c682ea7c6155329d4'],
  [{ mood: 'mysterious-calm', chip: 'genesis', seed: 9, bars: 12, loop: false }, '7dfa403c950d315ddbea4f0f'],
  [{ mood: 'heroic', seed: 3, bars: 16 }, '7a50387417ecc5185914da0c'],
  [{ mood: 'chill', chip: 'pce', seed: 11, bars: 8, key: 'D', scale: 'dorian' }, '9b3b7e31aaeb8cb95e398f33'],
  [{ mood: 'title', seed: 5, bars: 32 }, '4eac9d770e13895e1f28eb2e']
]

describe('composer backward compatibility', () => {
  it.each(CASES)('%j keeps its song', (opts, hash) => {
    const r = composeSong(opts)
    r.song.id = 'x'
    const h = createHash('sha256').update(serializeProject(r.song)).digest('hex').slice(0, 24)
    expect(h).toBe(hash)
  })
})
