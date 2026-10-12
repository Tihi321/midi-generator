import { describe, expect, it } from 'vitest'
import { readWav, writeWav } from '../../src/core/codecs/wav'

function ramp(n: number, mul: number): Int16Array {
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = ((i * mul) % 60000) - 30000
  return a
}

describe('wav codec', () => {
  it('round-trips stereo PCM16 with smpl loop and INFO', () => {
    const L = ramp(1000, 37)
    const R = ramp(1000, 91)
    const bytes = writeWav({
      sampleRate: 44100,
      channels: [L, R],
      loop: { start: 200, end: 1000 },
      title: 'Overworld',
      software: 'Chiptune Studio'
    })
    const w = readWav(bytes)
    expect(w.sampleRate).toBe(44100)
    expect(w.numChannels).toBe(2)
    expect(w.bitsPerSample).toBe(16)
    expect(w.length).toBe(1000)
    expect(Array.from(w.int16![0]!)).toEqual(Array.from(L))
    expect(Array.from(w.int16![1]!)).toEqual(Array.from(R))
    expect(w.loops).toEqual([{ type: 0, start: 200, end: 999, playCount: 0 }])
    expect(w.samplePeriod).toBe(22676)
    expect(w.midiUnityNote).toBe(60)
    expect(w.info).toEqual({ INAM: 'Overworld', ISFT: 'Chiptune Studio' })
  })

  it('writes a canonical header', () => {
    const bytes = writeWav({ sampleRate: 48000, channels: [new Int16Array(10), new Int16Array(10)] })
    const s = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4))
    const dv = new DataView(bytes.buffer)
    expect(s(0)).toBe('RIFF')
    expect(s(8)).toBe('WAVE')
    expect(s(12)).toBe('fmt ')
    expect(dv.getUint32(4, true)).toBe(bytes.length - 8)
    expect(dv.getUint16(20, true)).toBe(1)
    expect(dv.getUint16(22, true)).toBe(2)
    expect(dv.getUint32(24, true)).toBe(48000)
    expect(dv.getUint32(28, true)).toBe(48000 * 4)
    expect(s(36)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(40)
    expect(bytes.length).toBe(44 + 40)
    expect(readWav(bytes).loops).toEqual([])
  })

  it('mono, odd-length INFO strings and Float32 input', () => {
    const f = new Float32Array([0, 0.5, -0.5, 1, -1, 2])
    const bytes = writeWav({ sampleRate: 22050, channels: [f], title: 'abc', loop: { start: 1, end: 5 } })
    const w = readWav(bytes)
    expect(w.numChannels).toBe(1)
    expect(Array.from(w.int16![0]!)).toEqual([0, 16384, -16383, 32767, -32767, 32767])
    expect(w.info.INAM).toBe('abc')
    expect(w.loops[0]).toMatchObject({ start: 1, end: 4 })
    expect(bytes.length % 2).toBe(0)
  })

  it('odd data length is padded', () => {
    const bytes = writeWav({ sampleRate: 8000, channels: [new Int16Array([1, 2, 3])], title: 'x' })
    expect(bytes.length % 2).toBe(0)
    const w = readWav(bytes)
    expect(Array.from(w.int16![0]!)).toEqual([1, 2, 3])
    expect(w.info.INAM).toBe('x')
  })

  it('reads 8-bit, 24-bit and float32 files', () => {
    const mk = (fmt: number, bits: number, data: number[]): Uint8Array => {
      const bytesPer = bits / 8
      const out = new Uint8Array(44 + data.length * bytesPer)
      const dv = new DataView(out.buffer)
      const tag = (o: number, s: string): void => {
        for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i)
      }
      tag(0, 'RIFF')
      dv.setUint32(4, out.length - 8, true)
      tag(8, 'WAVE')
      tag(12, 'fmt ')
      dv.setUint32(16, 16, true)
      dv.setUint16(20, fmt, true)
      dv.setUint16(22, 1, true)
      dv.setUint32(24, 8000, true)
      dv.setUint32(28, 8000 * bytesPer, true)
      dv.setUint16(32, bytesPer, true)
      dv.setUint16(34, bits, true)
      tag(36, 'data')
      dv.setUint32(40, data.length * bytesPer, true)
      data.forEach((v, i) => {
        const o = 44 + i * bytesPer
        if (fmt === 3) dv.setFloat32(o, v, true)
        else if (bits === 8) out[o] = v
        else {
          const s = Math.round(v * 8388607)
          out[o] = s & 255
          out[o + 1] = (s >> 8) & 255
          out[o + 2] = (s >> 16) & 255
        }
      })
      return out
    }
    expect(Array.from(readWav(mk(1, 8, [128, 255, 0])).channels[0]!)).toEqual([0, 127 / 128, -1])
    const w24 = readWav(mk(1, 24, [0.5, -0.5])).channels[0]!
    expect(w24[0]!).toBeCloseTo(0.5, 5)
    expect(w24[1]!).toBeCloseTo(-0.5, 5)
    expect(Array.from(readWav(mk(3, 32, [0.25, -1])).channels[0]!)).toEqual([0.25, -1])
  })

  it('rejects non-WAV data', () => {
    expect(() => readWav(new Uint8Array(20))).toThrow(/RIFF/)
  })
})
