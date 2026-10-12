// Pointer -> macro value mapping for the macro bar graph. Pure.

export const GRAPH_H = 84

/** Index and value under a pointer (x, y in graph pixels) for `count` bars of width `barW`, value range min..max. */
export function graphPoint(x: number, y: number, count: number, barW: number, min: number, max: number, height = GRAPH_H): { index: number; value: number } {
  const index = Math.max(0, Math.min(count - 1, Math.floor(x / barW)))
  const value = Math.max(min, Math.min(max, Math.round(max - (y / height) * (max - min))))
  return { index, value }
}
