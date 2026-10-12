// Pure helpers of the FM instrument editor: algorithm diagram layouts and the envelope sketch.

import type { FmOp } from '../../core'

export interface AlgLayout {
  /** [col, row] of OP1..OP4. */
  pos: [number, number][]
  /** modulation edges (from OP index, to OP index, 0-based). */
  edges: [number, number][]
  /** carriers (operators that feed the output). */
  carriers: number[]
}

/** The 8 YM2612 algorithms. Operators are numbered OP1..OP4 in diagram order; OP1 has the feedback loop. */
export const FM_ALGORITHMS: AlgLayout[] = [
  { pos: [[0, 0], [1, 0], [2, 0], [3, 0]], edges: [[0, 1], [1, 2], [2, 3]], carriers: [3] },
  { pos: [[0, 0], [0, 2], [1, 1], [2, 1]], edges: [[0, 2], [1, 2], [2, 3]], carriers: [3] },
  { pos: [[0, 0], [0, 2], [1, 2], [2, 1]], edges: [[1, 2], [0, 3], [2, 3]], carriers: [3] },
  { pos: [[0, 0], [1, 0], [1, 2], [2, 1]], edges: [[0, 1], [1, 3], [2, 3]], carriers: [3] },
  { pos: [[0, 0], [1, 0], [0, 2], [1, 2]], edges: [[0, 1], [2, 3]], carriers: [1, 3] },
  { pos: [[0, 1], [1, 0], [1, 1], [1, 2]], edges: [[0, 1], [0, 2], [0, 3]], carriers: [1, 2, 3] },
  { pos: [[0, 0], [1, 0], [1, 1], [1, 2]], edges: [[0, 1]], carriers: [1, 2, 3] },
  { pos: [[0, 0], [1, 0], [2, 0], [3, 0]], edges: [], carriers: [0, 1, 2, 3] }
]

export const SK_W = 70
export const SK_H = 24

/** Tiny sketch of an operator envelope (attack, decay to SL, sustain slope, release); shape only, not to scale. */
export function envelopePoints(op: FmOp): string {
  const top = (Math.min(op.tl, 127) / 127) * SK_H * 0.9
  const slY = Math.min(SK_H, top + (op.sl / 15) * (SK_H - top))
  const attW = op.ar === 0 ? SK_W * 0.3 : 2 + (1 - op.ar / 31) * SK_W * 0.25
  const decW = op.dr === 0 ? 0 : 2 + (1 - op.dr / 31) * SK_W * 0.25
  const susW = SK_W * 0.25
  const susDrop = (op.sr / 31) * (SK_H - slY)
  const relW = 2 + (1 - op.rr / 15) * SK_W * 0.2
  const x1 = attW
  const x2 = x1 + decW
  const x3 = x2 + susW
  const pts: [number, number][] = [[0, SK_H], [x1, top], [x2, op.dr === 0 ? top : slY], [x3, (op.dr === 0 ? top : slY) + susDrop], [Math.min(SK_W, x3 + relW), SK_H]]
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}
