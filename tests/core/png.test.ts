import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, decodePng, encodePng, hasPngSignature, scaleImage } from '../../src/core'

const px = (r: number, g: number, b: number, a = 255): number => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0

describe('png codec', () => {
  const img = { width: 3, height: 2, data: Uint32Array.from([px(255, 0, 0), px(0, 255, 0), px(0, 0, 255), px(10, 20, 30, 128), px(0, 0, 0, 0), px(255, 255, 255)]) }

  it('round-trips RGBA pixels', () => {
    const bytes = encodePng(img)
    expect(hasPngSignature(bytes)).toBe(true)
    const back = decodePng(bytes)
    expect(back.width).toBe(3)
    expect(back.height).toBe(2)
    expect(Array.from(back.data)).toEqual(Array.from(img.data))
  })

  it('scales with nearest neighbour and encodes the scaled size', () => {
    const s = scaleImage(img, 2)
    expect([s.width, s.height]).toEqual([6, 4])
    expect(s.data[0]).toBe(img.data[0])
    expect(s.data[1]).toBe(img.data[0])
    expect(s.data[6]).toBe(img.data[0])
    expect(decodePng(encodePng(img, { scale: 3 })).width).toBe(9)
  })

  it('base64 helpers round-trip arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('rejects data that is not a PNG', () => {
    expect(hasPngSignature(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow()
  })
})
