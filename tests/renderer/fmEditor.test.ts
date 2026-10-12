import { describe, expect, it } from 'vitest'
import { resolvePreset } from '../../src/core'
import { FM_ALGORITHMS, envelopePoints } from '../../src/renderer/lib/fmLayout'

describe('FM editor helpers', () => {
  it('describes the 8 algorithms: valid edges, carriers include OP4 or all outputs', () => {
    expect(FM_ALGORITHMS).toHaveLength(8)
    expect(FM_ALGORITHMS.map((a) => a.carriers.length)).toEqual([1, 1, 1, 1, 2, 3, 3, 4])
    for (const a of FM_ALGORITHMS) {
      expect(a.pos).toHaveLength(4)
      for (const [f, t] of a.edges) {
        expect(f).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThan(4)
        expect(f).not.toBe(t)
        expect(a.carriers).not.toContain(f === t ? -1 : f) // a modulator never is a carrier in the same chain
      }
    }
  })

  it('envelope sketches are 5-point polylines inside the box', () => {
    const inst = resolvePreset('genesis', 'genesis.bass.slap')
    if (inst.kind !== 'fm') throw new Error('kind')
    for (const op of inst.ops) {
      const pts = envelopePoints(op).split(' ')
      expect(pts).toHaveLength(5)
      for (const p of pts) {
        const [x, y] = p.split(',').map(Number)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(70)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(24)
      }
    }
  })
})
